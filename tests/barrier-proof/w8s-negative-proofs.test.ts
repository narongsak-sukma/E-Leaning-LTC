/**
 * 8s — negatives รวมสามตระกูล (r30 §2-D89-4 CC: "access-log negatives คง r26 ·
 * manifest/opKey/session negatives คง r27 · settle decision negatives คง r27/
 * r25 · waiter-attribution negatives (ก)/(ข) คง r28 · run-id override ปฏิเสธ ·
 * audit self-test")
 *
 * access-log fence (r26): หา line {ua_nonce + method + path-normalized + status}
 *   หนึ่งต่อหนึ่งใน window — พิสูจน์เชิงลบจริงทั้งสี่ทาง: nonce เดียวสอง line
 *   (กำกวม) · nonce ไม่มี line (ไม่มี terminal ต้นทาง) · cursor เสีย · rest
 *   restart กลาง window (หลักฐานขาดความต่อเนื่อง) — ทั้งหมดต้องปฏิเสธ settle
 * manifest (r26/r30): kong-path 500 มีสิทธิ์ evidence-settle เฉพาะ op ใน
 *   EVIDENCE_SETTLE_MANIFEST — เขียนมือลอยไม่มีสิทธิ์ ('settle-refused-op-not-eligible')
 * opKey (r27): hint ของ caller เป็นแค่ hint — ผิด = note 'op-key-mismatch' +
 *   ใช้ค่า transport-derived เสมอ (limitation 23)
 * session (r27-r28): identity = nonce+pid+backend_start — pid ผิด/nonce ผิด =
 *   ไม่เจอ (pid-reuse ตีเป็น unresolved → poison ไม่ใช่ invocation ของเรา)
 * settle decision (r25/r27): fabricated-500 (อ้าง evidenced ไม่มี response จริง)
 *   + no-attribution = 'settle-refused-no-terminal-link' — scan+การตัดสินคู่กัน
 *   ใน decision row เดียวเสมอ
 * waiter-attribution (r28): (ก) ไม่มี waiter จริง = deadline FAIL · (ข) waiter
 *   สองตัว = ambiguous FAIL ทันที "ไม่ terminate ใคร" (F57-ข exactly-one)
 * run-id: env ถูกเปลี่ยนกลางวิ่ง = override → ledgerWrite ปฏิเสธ (run เดียวต่อ process)
 * audit self-test: สคริปต์ audit-lifecycle-ledger ตรวจจับจริงสองทิศ — run สะอาด
 *   ผ่าน · run มี 'running' ค้าง = exit 1 พร้อมระบุ (sentinel rows สร้าง/ลบเอง)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { psql, psqlScalar, ANON_KEY, REPO_ROOT, REST_URL } from "../integration/helpers.js";
import {
  accessLogFence,
  attemptBegin,
  captureLogCursor,
  currentRunId,
  httpWrite,
  invocationClose,
  invocationState,
  kong500Decision,
  ledgerRead,
  ledgerWrite,
  manualClearPoison,
  mintUaNonce,
  readAccessLogWindow,
  settleHttpWithEvidence,
  startPsqlSession,
  findBackendByNonce,
  type LogCursor,
} from "../integration/test-io.js";
import { awaitStuckWaiter } from "./barrier-harness.js";
import { APP_URL } from "./qb-patch-fixture.js";

function compose(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", ...args], { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** รอ PostgREST กลับมาสุขภาพดี — Kong → /rest/v1/ ตอบ 200 (root OpenAPI) */
async function waitRestHealthy(deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${REST_URL}/rest/v1/`, { headers: { apikey: ANON_KEY } });
      if (response.status === 200) return true;
    } catch {
      // ยังไม่กลับมา — วนต่อ
    }
    await sleep(500);
  }
  return false;
}

describe("8s negatives — fence/opKey/session/settle-decision/waiter/run-id/audit-self-test", () => {
  it(
    "(1) opKeyHint ผิด → note op-key-mismatch + invocation ลงทะเบียนที่ derived เสมอ",
    async () => {
      const derived = "app:GET:/api/v1/courses";
      const res = await httpWrite("GET", `${APP_URL}/api/v1/courses`, undefined, {
        transportTarget: "app-direct",
        opKeyHint: "app:GET:/wrong-hint",
        label: "h8s-opkey-hint-negative",
      });
      expect(res.status).toBeLessThan(500);
      expect(res.opKey, "ใช้ค่า derived เสมอ — hint เป็นแค่ hint (limitation 23)").toBe(derived);

      const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
      const mismatch = notes.find(
        (n) => n.payload["event"] === "op-key-mismatch" && n.payload["derived"] === derived,
      );
      expect(mismatch, "ต้องมี note op-key-mismatch จริง").toBeDefined();
      expect(mismatch?.payload["hint"]).toBe("app:GET:/wrong-hint");
      expect(await invocationState("app:GET:/wrong-hint"), "hint ไม่มีสิทธิ์สร้าง invocation").toBeNull();
      expect((await invocationState(derived))?.status).toBe("settled");
    },
    30_000,
  );

  it(
    "(2) kong500Decision — restart/ambiguous/no-line/op-ไม่อยู่-manifest ปฏิเสธ · ครบเท่านั้นที่ evidenced",
    () => {
      const manifestOp = "rpc:admin_revoke_role:POST";
      expect(kong500Decision({ matches: 1, restRestartedInWindow: false }, manifestOp)).toEqual({
        settledAs: "completed-evidenced(rejected|state-changed)",
        terminal: true,
      });
      expect(kong500Decision({ matches: 2, restRestartedInWindow: false }, manifestOp)).toEqual({
        settledAs: "settle-refused-ambiguous",
        terminal: false,
      });
      expect(kong500Decision({ matches: 0, restRestartedInWindow: false }, manifestOp)).toEqual({
        settledAs: "settle-refused-no-upstream-terminal",
        terminal: false,
      });
      expect(kong500Decision({ matches: 1, restRestartedInWindow: true }, manifestOp)).toEqual({
        settledAs: "settle-refused-rest-restart-in-window",
        terminal: false,
      });
      expect(
        kong500Decision({ matches: 1, restRestartedInWindow: false }, "kong:POST:/auth/v1/token"),
        "op นอก manifest = เขียนมือลอย ไม่มีสิทธิ์ evidence-settle (limitation 22)",
      ).toEqual({ settledAs: "settle-refused-op-not-eligible", terminal: false });
    },
    10_000,
  );

  it(
    "(3) fence จริงบน log จริง — nonce เดียวสอง line = กำกวม · nonce ไม่มี = ไม่มี terminal",
    async () => {
      const cursor = await captureLogCursor();
      // สอง request จริงด้วย UA-nonce เดียวกัน (read-only GET root — ปลอดภัย ไม่ผ่าน transport
      // เพราะจุดพิสูจน์คือ "การนับ line ของ fence" ไม่ใช่การเขียน)
      const nonce = mintUaNonce();
      for (let i = 0; i < 2; i += 1) {
        const r = await fetch(`${REST_URL}/rest/v1/`, { headers: { apikey: ANON_KEY, "user-agent": nonce } });
        expect(r.status).toBe(200);
      }
      await sleep(1_000); // รอ PostgREST เขียน access line (info ไม่ buffer)
      const fenceTwo = await accessLogFence(cursor, { uaNonce: nonce, method: "GET", pathNorm: "/", status: 200 });
      expect(fenceTwo.matches, "nonce เดียว >1 line = กำกวม").toBe(2);
      expect(kong500Decision(fenceTwo, "rpc:admin_revoke_role:POST").settledAs).toBe("settle-refused-ambiguous");

      const fenceNone = await accessLogFence(cursor, {
        uaNonce: `${mintUaNonce()}absent`,
        method: "GET",
        pathNorm: "/",
        status: 200,
      });
      expect(fenceNone.matches, "nonce ที่ไม่เคย dispatch = 0 line").toBe(0);
      expect(kong500Decision(fenceNone, "rpc:admin_revoke_role:POST").settledAs).toBe(
        "settle-refused-no-upstream-terminal",
      );
    },
    30_000,
  );

  it("(4) cursor เสีย (lineCount เกินจริง) = ปฏิเสธทันที ห้ามอ่าน window แบบเดา", async () => {
    const real = await captureLogCursor();
    const broken: LogCursor = {
      capturedAt: real.capturedAt,
      lineCount: 999_999_999,
      restStartedAt: real.restStartedAt,
    };
    let threw: unknown = null;
    try {
      await readAccessLogWindow(broken);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect(String(threw)).toContain("cursor เสีย");
  }, 15_000);

  it(
    "(5) rest restart กลาง window = หลักฐานขาดความต่อเนื่อง — ปฏิเสธแม้ line ตรง",
    async () => {
      const cursor = await captureLogCursor();
      const restart = await compose(["restart", "rest"]);
      expect(restart.code, `docker compose restart rest ล้ม: ${restart.stderr.slice(0, 200)}`).toBe(0);
      expect(await waitRestHealthy(30_000), "rest ต้องกลับมาก่อนอ่าน window").toBe(true);

      const fence = await accessLogFence(cursor, {
        uaNonce: mintUaNonce(),
        method: "GET",
        pathNorm: "/",
        status: 200,
      });
      expect(fence.restRestartedInWindow, "StartedAt ของ container ใหม่กว่า cursor = restart ใน window").toBe(true);
      const decision = kong500Decision(fence, "rpc:admin_revoke_role:POST");
      expect(decision.terminal).toBe(false);
      expect(decision.settledAs).toBe("settle-refused-rest-restart-in-window");
    },
    90_000,
  );

  it(
    "(6) session identity — nonce+pid ผิดพลาด = ไม่เจอ (pid-reuse/ไม่ใช่ session ของเรา)",
    async () => {
      const s = await startPsqlSession("h8s-session-negative");
      try {
        const hit = await findBackendByNonce(s.identity.nonce, s.identity.pid);
        expect(hit.found).toBe(true);
        expect(hit.backendStart).toBe(s.identity.backendStart);

        expect(await findBackendByNonce(s.identity.nonce, s.identity.pid + 900_000).then((f) => f.found)).toBe(false);
        expect(await findBackendByNonce("ltc_test_no_such_nonce", s.identity.pid).then((f) => f.found)).toBe(false);

        // ledger 'session' row ผูก identity จริง (nonce+pid+backend_start)
        const sessions = await ledgerRead({ runId: currentRunId(), kinds: ["session"] });
        const mine = sessions.find((r) => r.payload["nonce"] === s.identity.nonce);
        expect(mine, "session row ต้องมีจริง").toBeDefined();
        expect(mine?.payload["pid"]).toBe(s.identity.pid);
        expect(mine?.payload["backendStart"]).toBe(s.identity.backendStart);
      } finally {
        await s.end();
      }
    },
    30_000,
  );

  it(
    "(7) fabricated-500 + no-attribution = settle-refused-no-terminal-link — decision row เดียวครบคู่",
    async () => {
      const opKey = `barrier:h8s-fabricated:${randomUUID().slice(0, 8)}`;
      const guard = await attemptBegin(opKey, "h8s-fabricated-negative");
      try {
        // อ้าง evidenced แต่ไม่มี response จริงติดมือ (fabricated)
        const s1 = await settleHttpWithEvidence(opKey, { claimed: "evidenced", label: "h8s-fabricated-500" });
        expect(s1.settled).toBe(false);
        expect(s1.refusal).toBe("settle-refused-no-terminal-link");
        // อ้าง evidenced-no-response แต่ไม่มี attribution เลย
        const s2 = await settleHttpWithEvidence(opKey, {
          claimed: "evidenced-no-response",
          label: "h8s-no-attribution",
        });
        expect(s2.settled).toBe(false);
        expect(s2.refusal).toBe("settle-refused-no-terminal-link");

        // สอง refusal = สอง decision row — แต่ละแถว scan+การตัดสินคู่กัน (r26-m1/r27)
        const decisions = await ledgerRead({ opKey, kinds: ["settle-decision"] });
        expect(decisions).toHaveLength(2);
        expect(decisions[0]?.payload["decision"]).toBe("settle-refused-no-terminal-link");
        expect(decisions[0]?.payload["scanClean"]).toBe(false);
        expect(decisions[0]?.payload["note"]).toBe("no-response-evidence");
        expect(decisions[1]?.payload["decision"]).toBe("settle-refused-no-terminal-link");
        expect(decisions[1]?.payload["note"]).toBe("no-attribution");
        expect((await invocationState(opKey))?.status, "refusal ไม่ใช่ terminal — คง running").toBe("running");
      } finally {
        // negative fixture เคลียร์ของตัวเองด้วย intent (limitation 5 ข้อยกเว้น)
        await invocationClose(guard.invocationId, opKey, "poisoned", {
          reason: "h8s-negative-fixture-cleanup",
        });
        await manualClearPoison(opKey, "h8s(7) เคลียร์ใน teardown ด้วย intent");
      }
      expect((await invocationState(opKey))?.status).toBe("cleared-manual");
    },
    30_000,
  );

  it("(8) RUN_ID env ถูกเปลี่ยนกลางวิ่ง = override → ledgerWrite ปฏิเสธ", async () => {
    const before = currentRunId();
    const prevEnv = process.env["RUN_ID"];
    process.env["RUN_ID"] = "h8s-evil-override";
    try {
      let threw: unknown = null;
      try {
        await ledgerWrite("note", { event: "h8s-override-attempt" });
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeDefined();
      expect(String(threw)).toContain("run-id-override-refused");
      expect(currentRunId(), "run_id ตรึงตลอด process — ค่าที่ env เปลี่ยนไม่มีผล").toBe(before);
    } finally {
      if (prevEnv === undefined) {
        delete process.env["RUN_ID"];
      } else {
        process.env["RUN_ID"] = prevEnv;
      }
    }
    await ledgerWrite("note", { event: "h8s-override-restored" });
  }, 15_000);

  it(
    "(9-ก) ไม่มี waiter จริง (coordinator ไม่ถือ lock) = handshake deadline FAIL",
    async () => {
      const coordinator = await startPsqlSession("h8s-waiter-stale-coord");
      try {
        let threw: unknown = null;
        try {
          await awaitStuckWaiter(
            {
              relation: "public.credit_rules",
              mode: "ShareRowExclusiveLock",
              blockerPids: [coordinator.identity.pid],
              deadlineMs: 1_500,
              pollMs: 250,
            },
            "h8s-stale-waiter-negative",
          );
        } catch (err) {
          threw = err;
        }
        expect(threw).toBeDefined();
        expect(String(threw)).toContain("ไม่เห็น waiter");
      } finally {
        await coordinator.end();
      }
    },
    30_000,
  );

  it(
    "(9-ข) waiter สองตัวบน lock เดียวกัน = ambiguous FAIL ทันที ไม่ terminate ใคร",
    async () => {
      const coordinator = await startPsqlSession("h8s-waiter-ambig-coord");
      const w1 = await startPsqlSession("h8s-waiter-ambig-one");
      const w2 = await startPsqlSession("h8s-waiter-ambig-two");
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.credit_rules in share row exclusive mode;");
        // จัดคิว waiter สองตัวจริง (exec ค้างรอ lock — ห้าม await ตรงนี้) — LOCK TABLE
        // ต้องอยู่ใน transaction block ("LOCK TABLE can only be used in transaction
        // blocks" ถ้า autocommit) จึงส่ง begin; นำหน้าใน exec เดียวกัน: psql เปิด TX
        // แล้ว lock ค้างรออยู่ใน TX นั้น — pg_locks เห็น granted=false จริง
        const lockSql = "begin; lock table public.credit_rules in share row exclusive mode;";
        const lockP1 = w1.exec(lockSql);
        const lockP2 = w2.exec(lockSql);

        // รอจนเห็น waiter ≥2 ใน pg_locks เองก่อน — awaitStuckWaiter คืนที่ 1 ตัวถ้า
        // เรียกเร็วกว่าคิว (poll ของเรากัน race ของ timing ไม่ใช่ race ของ proof)
        const queueDeadline = Date.now() + 10_000;
        for (;;) {
          const n = await psqlScalar(
            `select count(*) from pg_locks l
             where l.locktype = 'relation'
               and l.relation = 'public.credit_rules'::regclass
               and l.mode = 'ShareRowExclusiveLock'
               and not l.granted
               and ${coordinator.identity.pid} = any(pg_blocking_pids(l.pid));`,
          );
          if (Number(n ?? "0") >= 2) break;
          if (Date.now() > queueDeadline) {
            throw new Error("h8s(9-ข): waiter สองตัวไม่ขึ้นคิวภายใน 10s — setup ล้ม");
          }
          await sleep(200);
        }

        let threw: unknown = null;
        try {
          await awaitStuckWaiter(
            {
              relation: "public.credit_rules",
              mode: "ShareRowExclusiveLock",
              blockerPids: [coordinator.identity.pid],
              deadlineMs: 5_000,
            },
            "h8s-ambiguous-two-waiters",
          );
        } catch (err) {
          threw = err;
        }
        expect(threw).toBeDefined();
        expect(String(threw)).toContain("มากกว่าหนึ่ง");
        expect(String(threw)).toContain("2");

        // "ไม่ terminate ใคร" — backend ของ waiter ทั้งสองยังมีชีวิตจริงหลัง FAIL
        expect(await findBackendByNonce(w1.identity.nonce, w1.identity.pid).then((f) => f.found)).toBe(true);
        expect(await findBackendByNonce(w2.identity.nonce, w2.identity.pid).then((f) => f.found)).toBe(true);

        // ปล่อย lock แบบไม่สมมติลำดับคิว: rollback coordinator แล้วสั่ง rollback ทั้ง
        // สอง waiter ทันที — ตัวที่ยังค้างรอ lock มี rollback ต่อคิวตามหลัง lock ของ
        // ตัวเองอยู่แล้ว (psql อ่านคำสั่งถัดไปเมื่อคำสั่งเดิมจบ) · ตัวที่ถืออยู่ rollback
        // ปล่อยทันที → อีกตัวได้คิว → ได้ lock → rollback ต่อ · ห้ามเขียนแบบ "รอ lock ของ
        // w1 ก่อนแล้วค่อย rollback w1" — ใครได้คิวก่อนไม่การันตีตามลำดับ spawn (spawn
        // ช้ากว่าก็แซงคิวได้) และจะรอยันตายกับตัวที่ยังถืออยู่
        await coordinator.exec("rollback;");
        const rb1 = w1.exec("rollback;");
        const rb2 = w2.exec("rollback;");
        await Promise.allSettled([lockP1, lockP2, rb1, rb2]);
      } finally {
        await coordinator.end();
        await w1.end();
        await w2.end();
      }
    },
    90_000,
  );

  it(
    "(10) audit self-test — run สะอาดผ่าน · run มี running ค้าง = exit 1 ระบุเป้า",
    async () => {
      const sentinelOk = `h8s-audit-ok-${randomUUID().slice(0, 8)}`;
      const sentinelBad = `h8s-audit-bad-${randomUUID().slice(0, 8)}`;
      const invOk = randomUUID();
      const invBad = randomUUID();
      // sentinel rows สร้าง/ลบเอง (direct psql — ข้อมูลทดสอบของ audit script ไม่ใช่
      // lifecycle event ของ transport) · run สะอาด: invocation settled + decision ครบ
      await psql(
        `insert into test_infra.lifecycle_ledger (id, run_id, kind, op_key, invocation_id, payload) values
           (gen_random_uuid(), '${sentinelOk}', 'invocation', 'kong:GET:/selftest-ok', '${invOk}',
            '{"status":"settled","label":"h8s-audit-ok"}'::jsonb),
           (gen_random_uuid(), '${sentinelOk}', 'settle-decision', 'kong:GET:/selftest-ok', '${invOk}',
            '{"decisionId":"${randomUUID()}","invocationId":"${invOk}","scanClean":true,"decision":"completed-evidenced"}'::jsonb),
           (gen_random_uuid(), '${sentinelBad}', 'invocation', 'kong:GET:/selftest-bad', '${invBad}',
            '{"status":"running","label":"h8s-audit-bad"}'::jsonb);`,
      );
      try {
        const runAudit = (runId: string): Promise<{ code: number; stdout: string }> =>
          new Promise((resolve) => {
            const child = spawn(
              "node",
              ["scripts/audit-lifecycle-ledger.mjs", "--run-id", runId],
              { cwd: REPO_ROOT },
            );
            let stdout = "";
            child.stdout.on("data", (c: Buffer) => {
              stdout += String(c);
            });
            child.on("error", (err) => resolve({ code: -1, stdout: String(err) }));
            child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
          });

        const okRun = await runAudit(sentinelOk);
        expect(okRun.code, `run สะอาดต้อง exit 0 (ได้ ${okRun.code}: ${okRun.stdout.slice(0, 300)})`).toBe(0);
        const okReport = JSON.parse(okRun.stdout.trim().split("\n").pop() ?? "{}") as {
          ok?: boolean;
          failures?: unknown[];
        };
        expect(okReport.ok).toBe(true);

        const badRun = await runAudit(sentinelBad);
        expect(badRun.code, "run มี invocation ค้าง 'running' ต้อง exit 1").toBe(1);
        const badReport = JSON.parse(badRun.stdout.trim().split("\n").pop() ?? "{}") as {
          ok?: boolean;
          failures?: unknown[];
        };
        expect(badReport.ok).toBe(false);
        expect(
          JSON.stringify(badReport.failures ?? []),
          "ต้องระบุเป้า: op_key/invocation ที่ค้าง running",
        ).toContain("kong:GET:/selftest-bad");
      } finally {
        // ลบ sentinel rows ที่สร้างเอง — ledger ของ run จริงไม่ถูกแตะ (append-only คงเต็ม)
        await psql(
          `delete from test_infra.lifecycle_ledger where run_id in ('${sentinelOk}', '${sentinelBad}');`,
        );
      }
    },
    30_000,
  );
});

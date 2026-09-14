/**
 * 8l — fault หลัง mutation ถึง server + explicit recovery (r22 §2-D89-4 CC·8l):
 * handshake ยืนยัน backend ของ RPC ติด lock แล้ว "จึง" หยุด ltc-dev-rest
 * (mutation ถึง server แล้ว — ไม่ใช่ล้มก่อนถึง · r20-m4) → connection drop →
 * route catch ตอบ 5xx จริง (แยกจาก client timeout) ขณะ downstream ยังไม่ settle
 * → invocation คง 'running' "แม้ได้ response" → ติดตาม waiter pid จน terminal
 * (deadline 15s — เกิน = pg_terminate_backend + event 'explicit-backend-termination'
 * เราทำ rollback เอง ไม่อนุมาน) → snapshot แถวไม่โผล่ (= rollback จาก connection
 * cancel) → settle 'completed-evidenced' (response จริง + scan สะอาด) → restart
 * ltc-dev-rest + health-wait ใน finally เสมอ
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { awaitStuckWaiter } from "./barrier-harness.js";
import {
  currentRunId,
  deriveOpKey,
  httpWrite,
  invocationState,
  ledgerWrite,
  ledgerRead,
  settleHttpWithEvidence,
  startPsqlSession,
  terminateBackend,
  pidsBusy,
  type PsqlSession,
} from "../integration/test-io.js";
import { REPO_ROOT, ANON_KEY, REST_URL } from "../integration/helpers.js";
import {
  bffPatchHeaders,
  ensureQbFixture,
  newOptionBody,
  optionRowCount,
  qbPatchUrl,
  questionVersion,
  type QbFixture,
} from "./qb-patch-fixture.js";

function compose(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", ...args], { cwd: REPO_ROOT });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
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

describe("8l หยุด PostgREST หลัง handshake — 5xx จริง + explicit recovery + settle evidenced", () => {
  let fixture: QbFixture;

  beforeAll(async () => {
    fixture = await ensureQbFixture("h8l");
  }, 120_000);

  it(
    "rest ตายหลัง mutation ถึง server → 5xx ขณะ row คง running → terminal → settle completed-evidenced",
    async () => {
      const runTail = `${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 6)}`;
      const url = qbPatchUrl(fixture.bankId, fixture.questionId);
      const opKey = deriveOpKey("app-direct", "PATCH", url);
      const invocationId = randomUUID();

      const coordinator: PsqlSession = await startPsqlSession("h8l-coordinator");
      let released = false;
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.question_options in share row exclusive mode;");

        const patch = httpWrite(
          "PATCH",
          url,
          newOptionBody("h8l", runTail),
          {
            invocationId,
            settleMode: "scenario",
            transportTarget: "app-direct",
            label: "h8l-qb-patch",
            extraHeaders: bffPatchHeaders(fixture.token, fixture.user.id),
          },
        );

        const waiter = await awaitStuckWaiter(
          { relation: "public.question_options", mode: "RowExclusiveLock", blockerPids: [coordinator.identity.pid] },
          "h8l-handshake",
        );

        // จุดตายของ fault: "หลัง" handshake — mutation รอ lock อยู่บน server แล้ว
        await ledgerWrite("note", { event: "h8l-rest-stop", waiterPid: waiter.pid });
        const stop = await compose(["stop", "rest"]);
        expect(stop.code, `docker compose stop rest ล้ม: ${stop.stderr.slice(0, 200)}`).toBe(0);

        const result = await patch;
        expect(result.status, "ต้องได้ 5xx จริงจาก route catch — ไม่ใช่ client timeout").toBeGreaterThanOrEqual(500);
        expect(result.settledAs).toBe("held-running");

        // ได้ response แล้วแต่ invocation คง 'running' — 5xx ไม่ใช่หลักฐาน terminal
        expect((await invocationState(opKey))?.status).toBe("running");

        // ติดตาม waiter pid จน terminal (deadline 15 วิ — rest ตายแล้ว backend ต้อง
        // หายไปเองเมื่อ connection ถูกตัด) — เกิน = terminate มีร่องรอย
        let busy = await pidsBusy([waiter.pid]);
        const termDeadline = Date.now() + 15_000;
        while (busy.length > 0 && Date.now() < termDeadline) {
          await sleep(300);
          busy = await pidsBusy([waiter.pid]);
        }
        if (busy.length > 0) {
          const terminated = await terminateBackend(waiter.pid);
          await ledgerWrite("note", {
            event: "explicit-backend-termination",
            file: "8l-rest-stop-5xx-recovery",
            pid: waiter.pid,
            terminated,
          });
        }
        expect(await pidsBusy([waiter.pid]), "waiter backend ต้อง terminal สุดท้าย").toHaveLength(0);

        // ปล่อย lock แล้ว snapshot: แถวไม่โผล่ = rollback จาก connection cancel (rest ตายก่อน commit)
        await coordinator.exec("commit;");
        released = true;
        await sleep(1_000);
        expect(await optionRowCount(fixture.questionId), "RPC rollback — ตัวเลือกใหม่ต้องไม่โผล่").toBe(fixture.baseOptionCount);
        expect(await questionVersion(fixture.questionId), "version คงเดิม").toBe(1);

        // settle ด้วย response จริง + scan สะอาด (waiter ตายแล้ว) → completed-evidenced
        const settle = await settleHttpWithEvidence(opKey, {
          blockerPids: [waiter.pid],
          claimed: "evidenced",
          responseStatus: result.status,
          label: "h8l-evidenced-5xx",
        });
        expect(settle.settled).toBe(true);
        expect(settle.decision).toBe("completed-evidenced");
        expect(settle.terminalLink?.pids).toEqual([waiter.pid]);
        expect((await invocationState(opKey))?.status).toBe("settled");

        const decisions = await ledgerRead({ invocationId, kinds: ["settle-decision"] });
        expect(decisions).toHaveLength(1);
        expect(decisions[0]?.payload["decision"]).toBe("completed-evidenced");
        expect(decisions[0]?.payload["responseStatus"]).toBe(result.status);
      } finally {
        if (!released) {
          await coordinator.exec("rollback;").catch(() => undefined);
        }
        await coordinator.end();
        // restart + health-wait เสมอ — ไฟล์ถัดไป (8m/8n) ต้องมี rest กลับมาเต็ม
        const start = await compose(["start", "rest"]);
        if (start.code !== 0) {
          await ledgerWrite("note", { event: "h8l-rest-restart-failed", stderr: start.stderr.slice(0, 300) });
        }
        expect(await waitRestHealthy(30_000), "ltc-dev-rest ต้องกลับมาสุขภาพดีก่อนจบเทส").toBe(true);
      }
      await ledgerWrite("note", { event: "h8l-scenario-complete", opKey, runTail });
    },
    120_000,
  );
});

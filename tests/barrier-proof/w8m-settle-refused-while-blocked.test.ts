/**
 * 8m — negative proof ของ settle engine (r22 §2-D89-4 CC·8m): "ยังไม่เห็นแถว ≠ จบ"
 * พิสูจน์ตรงๆสองทิศ —
 * (1) settleHttpWithEvidence "ระหว่าง RPC ยังติด lock" ต้องปฏิเสธ
 *     'settle-refused-blocked-backend' (scan ก่อน claim เห็น backend ยังมีชีวิต —
 *     แม้แถวยังไม่โผล่ก็ห้ามเชื่อคำบอกเล่าว่าจบแล้ว)
 * (2) ปล่อย lock → INSERT commit หลัง abort (แถวโผล่) → waiter terminal จริง
 *     (backend PostgREST เป็น pooled connection: commit แล้วกลับไปนั่ง 'idle'
 *     ไม่หายไปจาก pg_stat_activity — จำแนก terminal ด้วย state ≠ 'idle' ไม่ใช่
 *     การมีชีวิต · พิสูจน์รอบแรกของ 8m: pid ยังอยู่หลัง commit) → settle ครั้งที่
 *     สองสำเร็จ 'completed-evidenced-no-response' พร้อม terminalLink ผูกตัวตน
 *     (handshake pid) — ledger เห็น decision สองแถว: แรก scanClean:false ปฏิเสธ ·
 *     หลัง scanClean:true ผ่าน
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { awaitStuckWaiter } from "./barrier-harness.js";
import {
  currentRunId,
  deriveOpKey,
  httpWrite,
  invocationState,
  ledgerRead,
  settleHttpWithEvidence,
  startPsqlSession,
  pidsBusy,
  type PsqlSession,
} from "../integration/test-io.js";
import {
  bffPatchHeaders,
  ensureQbFixture,
  newOptionBody,
  optionRowCount,
  qbPatchUrl,
  questionVersion,
  type QbFixture,
} from "./qb-patch-fixture.js";

describe("8m settle กลาง lock-wait ต้องปฏิเสธ — หลัง terminal จึงผ่าน (negative proof)", () => {
  let fixture: QbFixture;

  beforeAll(async () => {
    fixture = await ensureQbFixture("h8m");
  }, 120_000);

  it(
    "settle#1 ระหว่างติด lock = blocked-backend → ปล่อย lock → commit-after-abort → waiter terminal → settle#2 ผ่าน",
    async () => {
      const runTail = `${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 6)}`;
      const url = qbPatchUrl(fixture.bankId, fixture.questionId);
      const opKey = deriveOpKey("app-direct", "PATCH", url);
      const invocationId = randomUUID();

      const coordinator: PsqlSession = await startPsqlSession("h8m-coordinator");
      let released = false;
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.question_options in share row exclusive mode;");

        const ac = new AbortController();
        const patch = httpWrite(
          "PATCH",
          url,
          newOptionBody("h8m", runTail),
          {
            invocationId,
            settleMode: "scenario",
            signal: ac.signal,
            transportTarget: "app-direct",
            label: "h8m-qb-patch",
            extraHeaders: bffPatchHeaders(fixture.token, fixture.user.id),
          },
        ).then(
          () => "responded" as const,
          (err: unknown) => `thrown:${String(err).slice(0, 80)}` as const,
        );

        const waiter = await awaitStuckWaiter(
          { relation: "public.question_options", mode: "RowExclusiveLock", blockerPids: [coordinator.identity.pid] },
          "h8m-handshake",
        );

        // settle#1 — RPC ยังติด lock อยู่ (แถวยังไม่โผล่ทั้งที่ invocation กำลังจะถูก abort)
        // scan-before-claim ต้องเห็น waiter ยังมีชีวิต → ปฏิเสธ
        const s1 = await settleHttpWithEvidence(opKey, {
          blockerPids: [waiter.pid],
          claimed: "evidenced-no-response",
          label: "h8m-settle-ระหว่างติด-lock",
        });
        expect(s1.settled).toBe(false);
        expect(s1.refusal).toBe("settle-refused-blocked-backend");
        expect((await invocationState(opKey))?.status).toBe("running");

        ac.abort();
        const outcome = await patch;
        expect(outcome.startsWith("thrown")).toBe(true);

        // ปล่อย lock → INSERT commit หลัง abort
        await coordinator.exec("commit;");
        released = true;
        let rows = await optionRowCount(fixture.questionId);
        const deadline = Date.now() + 10_000;
        while (rows !== fixture.baseOptionCount + 1 && Date.now() < deadline) {
          await sleep(200);
          rows = await optionRowCount(fixture.questionId);
        }
        expect(rows, "commit-after-abort — แถวโผล่").toBe(fixture.baseOptionCount + 1);
        expect(await questionVersion(fixture.questionId)).toBe(2);

        // waiter terminal จริง — PostgREST pooled: commit แล้วกลับ 'idle' (ไม่หายไป)
        // → poll pidsBusy (state ≠ 'idle') จนว่าง = งานของ invocation นี้จบแล้ว
        let busy = await pidsBusy([waiter.pid]);
        const termDeadline = Date.now() + 10_000;
        while (busy.length > 0 && Date.now() < termDeadline) {
          await sleep(200);
          busy = await pidsBusy([waiter.pid]);
        }
        expect(busy, "waiter ต้อง terminal — หายไปหรือ idle ใน pool (ไม่มีงานค้าง)").toHaveLength(0);

        const s2 = await settleHttpWithEvidence(opKey, {
          blockerPids: [waiter.pid],
          claimed: "evidenced-no-response",
          label: "h8m-settle-หลัง-terminal",
        });
        expect(s2.settled).toBe(true);
        expect(s2.decision).toBe("completed-evidenced-no-response");
        expect(s2.terminalLink?.pids).toEqual([waiter.pid]);
        expect((await invocationState(opKey))?.status).toBe("settled");

        // ledger: decision สองแถวของ invocation นี้ — แรกปฏิเสธ scanClean:false · หลังผ่าน scanClean:true
        const decisions = await ledgerRead({ invocationId, kinds: ["settle-decision"] });
        expect(decisions).toHaveLength(2);
        expect(decisions[0]?.payload["decision"]).toBe("settle-refused-blocked-backend");
        expect(decisions[0]?.payload["scanClean"]).toBe(false);
        expect(decisions[1]?.payload["decision"]).toBe("completed-evidenced-no-response");
        expect(decisions[1]?.payload["scanClean"]).toBe(true);
      } finally {
        if (!released) {
          await coordinator.exec("rollback;").catch(() => undefined);
        }
        await coordinator.end();
      }
    },
    90_000,
  );
});

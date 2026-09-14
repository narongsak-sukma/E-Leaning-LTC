/**
 * 8k — commit-after-abort (r22 §2-D89-4 CC·8k): RPC ที่ติด lock อยู่จะ commit
 * "หลัง" client abort แล้ว — แถวโผล่จริงแต่ invocation ต้องคง 'running' (ไม่มี
 * response ไม่มีใคร settle) จน budget หมด = poison — พิสูจน์ว่า "เห็นแถว ≠ จบ"
 * และ invocation ไม่แอบตัดสินใจแทนหลักฐาน
 *
 * ลำดับ: coordinator `lock table question_options in share row exclusive mode`
 * → PATCH (option ใหม่ไม่มี id → INSERT 0019:973 ติด RowExclusiveLock รอ SRE)
 * → handshake กลาง (pg_locks: waiter RowExclusiveLock granted=false + blocker =
 * coordinator pid) → abort 1 วิ → row 'running' → ปล่อย lock (finally เสมอ) →
 * INSERT commit หลัง abort (assert แถวโผล่ + version bump) → row ยัง 'running'
 * → budget → poison (ผู้ถือ budget = scenario · limitation 7) → manualClearPoison
 * ปิดโลก · ledger prefix h8k
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { awaitStuckWaiter } from "./barrier-harness.js";
import {
  currentRunId,
  deriveOpKey,
  httpWrite,
  invocationClose,
  invocationState,
  ledgerWrite,
  manualClearPoison,
  startPsqlSession,
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

describe("8k qb PATCH — RPC commit หลัง abort + row คง running จน budget poison", () => {
  let fixture: QbFixture;
  let opKey = "";

  beforeAll(async () => {
    fixture = await ensureQbFixture("h8k");
  }, 120_000);

  it(
    "abort กลาง lock-wait → lock ปล่อย → INSERT commit หลัง abort · invocation ไม่ตัดสินใจแทนหลักฐาน",
    async () => {
      const runTail = `${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 6)}`;
      const url = qbPatchUrl(fixture.bankId, fixture.questionId);
      opKey = deriveOpKey("app-direct", "PATCH", url);
      const invocationId = randomUUID();

      const coordinator: PsqlSession = await startPsqlSession("h8k-coordinator");
      let released = false;
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.question_options in share row exclusive mode;");

        const ac = new AbortController();
        const patch = httpWrite(
          "PATCH",
          url,
          newOptionBody("h8k", runTail),
          {
            invocationId,
            settleMode: "scenario",
            signal: ac.signal,
            transportTarget: "app-direct",
            label: "h8k-qb-patch",
            extraHeaders: bffPatchHeaders(fixture.token, fixture.user.id),
          },
        ).then(
          () => "responded" as const,
          (err: unknown) => `thrown:${String(err).slice(0, 80)}` as const,
        );

        // handshake กลาง — waiter คือ backend ของ RPC (INSERT ติดคิวหลัง SRE ของเรา)
        // 8k ไม่ track pid ต่อ: หลัง abort ไม่มี settle ใด จบด้วย budget poison
        await awaitStuckWaiter(
          { relation: "public.question_options", mode: "RowExclusiveLock", blockerPids: [coordinator.identity.pid] },
          "h8k-handshake",
        );
        await sleep(1_000); // abort 1 วิหลังเห็น waiter
        ac.abort();
        const outcome = await patch;
        expect(outcome.startsWith("thrown"), `abort ต้องโยน ไม่ใช่ได้ response (${outcome})`).toBe(true);

        // abort แล้ว invocation คง 'running' (scenario เป็นผู้ settle เท่านั้น)
        expect((await invocationState(opKey))?.status).toBe("running");

        // ปล่อย lock → RPC ที่ยังจำลองอยู่ commit ต่อแม้ client จะไปแล้ว
        await coordinator.exec("commit;");
        released = true;
        let rows = await optionRowCount(fixture.questionId);
        const deadline = Date.now() + 10_000;
        while (rows !== fixture.baseOptionCount + 1 && Date.now() < deadline) {
          await sleep(200);
          rows = await optionRowCount(fixture.questionId);
        }
        expect(rows, "INSERT ต้อง commit หลัง abort (แถวโผล่จริง)").toBe(fixture.baseOptionCount + 1);
        expect(await questionVersion(fixture.questionId), "version bump ใน TX เดียวกัน").toBe(2);

        // แถวโผล่แล้วแต่ invocation ยัง 'running' — "เห็นแถว ≠ จบ" ฝั่งกลับ
        expect((await invocationState(opKey))?.status).toBe("running");

        // budget หมด = poison โดยผู้ถือ budget (scenario) — ไม่มีใคร settle แทน
        await invocationClose(invocationId, opKey, "poisoned", {
          reason: "settle-budget-exceeded",
          event: "h8k-budget-poison",
          note: "commit-after-abort พิสูจน์แล้ว — ไม่มี response/terminalLink จึงไม่ settle",
        });
        const finalState = await invocationState(opKey);
        expect(finalState?.status).toBe("poisoned");
        expect(finalState?.payload["event"]).toBe("h8k-budget-poison");
      } finally {
        if (!released) {
          await coordinator.exec("rollback;").catch(() => undefined);
        }
        await coordinator.end();
      }

      // ปิดโลก: หลัง poison ต้องเคลียร์มือก่อน attempt ใหม่ (limitation 5)
      await manualClearPoison(opKey, "h8k ปิดหลังพิสูจน์ commit-after-abort");
      expect((await invocationState(opKey))?.status).toBe("cleared-manual");
      await ledgerWrite("note", { event: "h8k-scenario-complete", opKey, runTail });
    },
    90_000,
  );
});

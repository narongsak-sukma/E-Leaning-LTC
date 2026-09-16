/**
 * 8o(ข) — settle ปฏิเสธ "แม้มี terminalLink" เมื่อ op retry-capable (r24:218 ข ·
 * คง r23 ตามสาย r26/r30 §2-D89-4): rest live · coordinator SRE บน
 * public.audit_logs → PATCH admin set-active (singleDispatch=false) → attempt
 * แรก block (handshake เห็น waiter = มีตัวตนผูก invocation) → abort client →
 * settle ด้วย blockerPids ครบ → ปฏิเสธ 'settle-refused-retry-capable' อยู่ดี —
 * users.ts:595-615 อาจ dispatch ซ้ำหลัง transient ดังนั้น scan/attribution
 * เพียงลำพังไม่พอ (จำแนกด้วย manifest ไม่ใช่คำบอกเล่า) → ปล่อย lock ใน
 * finally → commit-after-abort (user ถูกปิดใช้งานจริง) → row 'running' →
 * budget → poison → manualClearPoison ปิดโลก
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import {
  attemptBegin,
  currentRunId,
  deriveOpKey,
  invocationClose,
  invocationState,
  ledgerRead,
  ledgerWrite,
  manualClearPoison,
  settleHttpWithEvidence,
  startPsqlSession,
  type PsqlSession,
} from "../integration/test-io.js";
import { bffPatchHeaders } from "./qb-patch-fixture.js";
import {
  crashRecover,
  ensureUserActiveFixture,
  freshRunTail,
  parkedPatchOrRetry,
  userDisableAuditCount,
  userIsActive,
  userPatchUrl,
  warmRestPool,
  type UserActiveFixture,
} from "./user-active-fixture.js";

describe("8o(ข) settle ปฏิเสธแม้มี terminalLink — op retry-capable (singleDispatch=false)", () => {
  let fixture: UserActiveFixture;

  beforeAll(async () => {
    fixture = await ensureUserActiveFixture("h8okh");
  }, 120_000);

  it(
    "SRE audit_logs → attempt แรก block → abort → settle ปฏิเสธ retry-capable → commit-after-abort → poison",
    async () => {
      const runTail = freshRunTail(`${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 4)}`);
      const url = userPatchUrl(fixture.targetId);
      const opKey = deriveOpKey("app-direct", "PATCH", url);
      // อุ่น rest pool ก่อนเปิด invocation (terminate จาก scenario ก่อนหน้ารีไซเคิล
      // pool — warm ล้มต้องล้มก่อนมี invocation ค้าง)
      await warmRestPool(fixture.token, "h8o-kh-warm");
      const guard = await attemptBegin(opKey, "h8o-kh-attempt-1");

      try {

      const coordinator: PsqlSession = await startPsqlSession("h8o-kh-coordinator");
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.audit_logs in share row exclusive mode;");

        // dispatch จนเกิด park จริง (fast-fail สิ่งแวดล้อมหลัง pool recycle →
        // เปิด dispatch ใหม่ใต้ invocation เดิม — ทุกครั้งลง ledger)
        const parked = await parkedPatchOrRetry({
          url,
          reason: `barrier 8o(ข) ${runTail} — ปิดใช้งานชั่วคราวเพื่อพิสูจน์ retry-capable แม้มี terminalLink`,
          invocationId: guard.invocationId,
          labelBase: "h8o-kh-patch",
          handshakeLabel: "h8o-kh-handshake",
          coordinatorPid: coordinator.identity.pid,
          extraHeaders: bffPatchHeaders(fixture.token, fixture.actor.id),
        });
        const ac = parked.ac;
        const patch = parked.outcome;
        const waiter = parked.waiter;

        ac.abort();
        const outcome = await patch;
        expect(outcome.startsWith("thrown"), `abort ต้องโยน (${outcome})`).toBe(true);

        // settle ด้วย attribution ครบ (blockerPids = handshake pid) — ปฏิเสธอยู่ดี:
        // op retry-capable + ไร้ response = transport อาจ dispatch ซ้ำ
        const settle = await settleHttpWithEvidence(opKey, {
          blockerPids: [waiter.pid],
          claimed: "evidenced-no-response",
          label: "h8o-kh-settle-แม้มี-terminalLink",
        });
        expect(settle.settled).toBe(false);
        expect(settle.refusal).toBe("settle-refused-retry-capable");
        const decisions = await ledgerRead({ invocationId: guard.invocationId, kinds: ["settle-decision"] });
        const row = decisions[decisions.length - 1];
        expect(row?.payload["decision"]).toBe("settle-refused-retry-capable");
        expect(Array.isArray(row?.payload["busyPids"]) && (row?.payload["busyPids"] as number[]).includes(waiter.pid),
          "scan บันทึกความจริง: waiter ยัง busy ระหว่างถือ lock").toBe(true);
        expect((await invocationState(opKey))?.status).toBe("running");
      } finally {
        // ปล่อย lock เสมอ (rollback ของ TX ที่ถือ SRE = ปล่อย) — RPC ที่ค้างอยู่
        // ทำต่อจน commit-after-abort แม้ client ตายไปแล้ว
        await coordinator.exec("rollback;").catch(() => undefined);
        await coordinator.end();
      }

      // commit-after-abort — user ถูกปิดใช้งานจริงแม้ client ตาย
      let active = await userIsActive(fixture.targetId);
      const deadline = Date.now() + 10_000;
      while (active !== false && Date.now() < deadline) {
        await sleep(250);
        active = await userIsActive(fixture.targetId);
      }
      expect(active, "commit-after-abort — target ถูกปิดใช้งาน").toBe(false);
      expect(await userDisableAuditCount(fixture.targetId)).toBeGreaterThan(0);

      // row 'running' จน budget → poison (ไม่มี response ที่ transport จับได้)
      expect((await invocationState(opKey))?.status).toBe("running");
      await invocationClose(guard.invocationId, opKey, "poisoned", {
        reason: "settle-budget-exceeded",
        event: "h8o-kh-budget-poison",
        note: "retry-capable + ไร้ response — settle ไม่ได้แม้มี terminalLink",
      });
      expect((await invocationState(opKey))?.status).toBe("poisoned");

      // ปิดโลก: poison ต้องเคลียร์มือก่อน attempt ใหม่ (limitation 5)
      await manualClearPoison(opKey, "h8o(ข) ปิดหลังพิสูจน์ retry-capable refusal แม้มี terminalLink");
      expect((await invocationState(opKey))?.status).toBe("cleared-manual");
      await ledgerWrite("note", { event: "h8o-kh-scenario-complete", opKey, runTail });
      } catch (err) {
        // opKey แชร์ทั้งครอบครัว (route `:uuid`) — crash กลางทางต้องปิดโลกก่อน rethrow
        await crashRecover(opKey, err);
        throw err;
      }
    },
    120_000,
  );
});

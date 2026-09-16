/**
 * 8o(ก) — child ของ attempt loop ≤3 (r30 §2-D89-4 CC·8o ก · คง r28-r29 + guard
 * จริงผ่าน attemptBegin · ขอบเขต r29-m1): รันเฉพาะเมื่อ wrapper spawn ผ่าน
 * childRun (BARRIER_CHILD=1) — ใน main suite ไฟล์นี้ self-skip
 *
 * opKey `app:PATCH:/api/v1/admin/users/:uuid` (manifest · singleDispatch=false —
 * users.ts:595-615 retry ≤3 หลัง transient · 250/600ms) · coordinator SRE บน
 * public.audit_logs → RPC admin_set_user_active จอดที่ audit INSERT (0038:
 * UPDATE profiles ผ่านก่อน → INSERT audit_logs ติด RowExclusiveLock รอ SRE)
 *
 * attempt N ≤3 ทุกครั้งเริ่มผ่าน attemptBegin (จุดบังคับเดียว):
 *   dispatch → handshake #1 → terminate-1 → observation poll (deadline 5 วิ):
 *   (a) clean → settle-A ปฏิเสธ 'settle-refused-retry-capable' (scanClean=true
 *       — blockerPids=waiter-1 ที่ถูก terminate แล้ว) → handshake #2 (= retry
 *       หลัง sleep 250ms) → abort จุดเดียวปลาย scenario → settle-B ปฏิเสธ
 *       (busyPids=waiter-2 + retry-capable) → ปล่อย lock → commit-after-abort
 *       (user ถูกปิดใช้งาน) → row 'running' → budget → poison + โยนจงใจ (RC≠0)
 *   (b) waiter-2 ก่อน (ambiguous) → ledger 'blocked-backend' → ปล่อย lock →
 *       รอ response ถึง transport (drain deadline 20 วิ) → settle invocation N
 *       จริง ('completed-evidenced') → attemptBegin → attempt ถัดไป
 *   (c) obs deadline ไม่เจอทั้งคู่ = โยน 'observation-window-missed' (FAIL)
 *   ครบ 3 attempt ไม่เคยได้ (a) = โยน 'observation-window-missed' (FAIL)
 *
 * จบ terminal ของ child = poison + โยนข้อความ h8o-attempt-loop-budget-poison —
 * wrapper (w8o-guard) ตรวจ RC≠0 + audit ledger coverage และเคลียร์มือเอง
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { awaitStuckWaiter } from "../barrier-harness.js";
import {
  attemptBegin,
  currentRunId,
  deriveOpKey,
  invocationClose,
  invocationState,
  ledgerRead,
  ledgerWrite,
  settleHttpWithEvidence,
  startPsqlSession,
  terminateBackend,
  pidsBusy,
  type PsqlSession,
} from "../../integration/test-io.js";
import { bffPatchHeaders } from "../qb-patch-fixture.js";
import {
  crashRecover,
  ensureUserActiveFixture,
  findOtherBlockedWaiter,
  freshRunTail,
  parkedPatchOrRetry,
  userDisableAuditCount,
  userIsActive,
  userPatchUrl,
  warmRestPool,
  type UserActiveFixture,
} from "../user-active-fixture.js";

const OBS_DEADLINE_MS = 5_000;
const DRAIN_DEADLINE_MS = 20_000;

type Observation =
  | { kind: "clean" }
  | { kind: "waiter2"; pid: number; mode: string }
  | { kind: "missed" };

async function observeAfterTerminate(
  coordinatorPid: number,
  waiter1Pid: number,
): Promise<Observation> {
  const deadline = Date.now() + OBS_DEADLINE_MS;
  for (;;) {
    // waiter-2 ตรวจก่อน — โผล่แล้ว = ambiguous ทาง (b) ชนะแม้ waiter-1 จะหายแล้ว
    const w2 = await findOtherBlockedWaiter("public.audit_logs", [coordinatorPid], waiter1Pid);
    if (w2 !== null) return { kind: "waiter2", pid: w2.pid, mode: w2.mode };
    const busy = await pidsBusy([waiter1Pid]);
    if (busy.length === 0) return { kind: "clean" };
    if (Date.now() > deadline) return { kind: "missed" };
    await sleep(100);
  }
}

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8o(ก) child — attempt loop ≤3 ผ่าน guard (retry-capable)", () => {
  let fixture: UserActiveFixture;
  let url = "";
  let opKey = "";

  beforeAll(async () => {
    fixture = await ensureUserActiveFixture("h8o");
    url = userPatchUrl(fixture.targetId);
    opKey = deriveOpKey("app-direct", "PATCH", url);
    // wrapper อ่าน target/opKey จาก ledger (IPC เดียวกับที่ 8g/8h ใช้)
    await ledgerWrite("note", {
      event: "h8o-child-fixture",
      targetUserId: fixture.targetId,
      actorId: fixture.actor.id,
      opKey,
    });
  }, 120_000);

  it(
    "attempt loop ≤3 — settle-A/B ปฏิเสธ retry-capable · commit-after-abort · budget poison + RC≠0",
    async () => {
      const runTail = freshRunTail(`${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 4)}`);
      let pathA = false;
      let finalInvocationId = "";
      // designed-poison ต้องคง 'poisoned' ไว้ให้ wrapper audit — crash อื่นเคลียร์เอง
      let designed = false;

      try {

      for (let attempt = 1; attempt <= 3 && !pathA; attempt += 1) {
        // อุ่น rest pool ก่อนเปิด invocation ของรอบ (terminate รอบก่อน/ไฟล์ก่อน
        // รีไซเคิล pool — warm ล้มต้องล้มก่อนมี invocation ค้าง) · รอบ 2+ รอพ้น
        // window recycle (~2-3 วิ) ของ terminate รอบก่อนก่อนเริ่ม warm
        if (attempt > 1) {
          await sleep(3_000);
        }
        await warmRestPool(fixture.token, `h8o-warm-a${attempt}`);
        const guard = await attemptBegin(opKey, `h8o-attempt-${attempt}`);
        const coordinator: PsqlSession = await startPsqlSession(`h8o-coordinator-a${attempt}`);
        let released = false;
        try {
          await coordinator.exec("begin;");
          await coordinator.exec("lock table public.audit_logs in share row exclusive mode;");

          // dispatch จนเกิด park จริง (fast-fail สิ่งแวดล้อมหลัง pool recycle →
          // เปิด dispatch ใหม่ใต้ invocation รอบนี้ — ทุกครั้งลง ledger)
          const parked = await parkedPatchOrRetry({
            url,
            reason: `barrier 8o(ก) attempt ${attempt} ${runTail} — ปิดใช้งานชั่วคราวเพื่อพิสูจน์ retry-capable settle`,
            invocationId: guard.invocationId,
            labelBase: `h8o-patch-a${attempt}`,
            handshakeLabel: `h8o-hs1-a${attempt}`,
            coordinatorPid: coordinator.identity.pid,
            extraHeaders: bffPatchHeaders(fixture.token, fixture.actor.id),
          });
          const ac = parked.ac;
          const patchRaw = parked.patchRaw;
          const patch = parked.outcome;
          const waiter1 = parked.waiter;

          const terminated = await terminateBackend(waiter1.pid);
          await ledgerWrite("note", {
            event: "h8o-terminate-1",
            attempt,
            pid: waiter1.pid,
            terminated,
          });
          expect(terminated, "terminate waiter-1 ต้องสำเร็จ").toBe(true);

          const obs = await observeAfterTerminate(coordinator.identity.pid, waiter1.pid);
          if (obs.kind === "missed") {
            throw new Error(`h8o observation-window-missed (attempt ${attempt}): ไม่เห็น clean หรือ waiter-2 ภายใน ${OBS_DEADLINE_MS}ms`);
          }
          if (obs.kind === "waiter2") {
            // (b) ambiguous — ไม่ abort: ปล่อย lock → drain → settle จริง → รอบใหม่
            await ledgerWrite("note", { event: "blocked-backend", attempt, waiter2Pid: obs.pid });
            await coordinator.exec("commit;");
            released = true;
            const response = await Promise.race([
              patchRaw.then((r) => r.status),
              sleep(DRAIN_DEADLINE_MS).then(() => {
                throw new Error(`h8o drain-timeout (attempt ${attempt}): response ไม่มาภายใน ${DRAIN_DEADLINE_MS}ms`);
              }),
            ]);
            expect(response, "drain ต้องได้ 2xx จาก route (RPC commit แล้ว)").toBeGreaterThanOrEqual(200);
            expect(response).toBeLessThan(300);
            const settleN = await settleHttpWithEvidence(opKey, {
              blockerPids: [waiter1.pid, obs.pid],
              claimed: "evidenced",
              responseStatus: response,
              label: `h8o-settleN-a${attempt}`,
            });
            expect(settleN.settled, `drain settle ของ attempt ${attempt} ต้องผ่าน`).toBe(true);
            expect(await userIsActive(fixture.targetId), "baseline ใหม่ — RPC commit แล้ว").toBe(false);
            continue; // attemptBegin รอบถัดไป (predecessor settled)
          }

          // (a) clean window → settle-A ทันที (blockerPids = waiter-1 ที่ตายแล้ว)
          const settleA = await settleHttpWithEvidence(opKey, {
            blockerPids: [waiter1.pid],
            claimed: "evidenced-no-response",
            label: `h8o-settleA-a${attempt}`,
          });
          expect(settleA.settled).toBe(false);
          expect(settleA.refusal).toBe("settle-refused-retry-capable");
          const decisionsA = await ledgerRead({ invocationId: guard.invocationId, kinds: ["settle-decision"] });
          const rowA = decisionsA[decisionsA.length - 1];
          expect(rowA?.payload["scanClean"], "settle-A ต้องเห็น scan สะอาด (waiter-1 ถูก terminate แล้ว)").toBe(true);

          // handshake #2 — retry ของ users.ts หลัง sleep 250ms (= dispatch-after-sleep)
          const waiter2 = await awaitStuckWaiter(
            { relation: "public.audit_logs", mode: "RowExclusiveLock", blockerPids: [coordinator.identity.pid] },
            `h8o-hs2-a${attempt}`,
          );

          // abort จุดเดียวปลาย scenario — client ตาย แต่ invocation ยังไม่มีใคร settle ได้
          ac.abort();
          const outcome = await patch;
          expect(outcome.startsWith("thrown"), `abort ต้องโยน ไม่ใช่ได้ response (${outcome})`).toBe(true);

          // settle-B — waiter-2 ยัง live + retry-capable → ปฏิเสธ (row เดียว)
          const settleB = await settleHttpWithEvidence(opKey, {
            blockerPids: [waiter2.pid],
            claimed: "evidenced-no-response",
            label: "h8o-settleB",
          });
          expect(settleB.settled).toBe(false);
          expect(settleB.refusal).toBe("settle-refused-retry-capable");
          const decisionsB = await ledgerRead({ invocationId: guard.invocationId, kinds: ["settle-decision"] });
          const rowB = decisionsB[decisionsB.length - 1];
          expect(rowB?.payload["decision"]).toBe("settle-refused-retry-capable");
          const busyB = rowB?.payload["busyPids"];
          expect(Array.isArray(busyB) && busyB.length > 0, "settle-B ต้องเห็น waiter-2 ยัง busy").toBe(true);

          await ledgerWrite("note", { event: "h8o-path-a-complete", attempt });
          pathA = true;
          finalInvocationId = guard.invocationId;
          // ปล่อย lock (ใน attempt-scope นี้เอง) → commit-after-abort ของ waiter-2
          await coordinator.exec("commit;");
          released = true;
        } finally {
          if (!released) {
            await coordinator.exec("rollback;").catch(() => undefined);
          }
          await coordinator.end();
        }
      }

      if (!pathA) {
        throw new Error("h8o observation-window-missed: ครบ 3 attempt ไม่เคยได้ทาง (a)");
      }

      // commit-after-abort — RPC ของ waiter-2 commit แม้ client ตายไปแล้ว
      let active = await userIsActive(fixture.targetId);
      const deadline = Date.now() + 10_000;
      while (active !== false && Date.now() < deadline) {
        await sleep(250);
        active = await userIsActive(fixture.targetId);
      }
      expect(active, "commit-after-abort — target ถูกปิดใช้งาน").toBe(false);
      expect(await userDisableAuditCount(fixture.targetId), "audit USER_DISABLE ต้องมีหลัง RPC commit").toBeGreaterThan(0);

      // row 'running' → budget หมด = poison (ผู้ถือ budget = scenario)
      expect((await invocationState(opKey))?.status).toBe("running");
      await invocationClose(finalInvocationId, opKey, "poisoned", {
        reason: "settle-budget-exceeded",
        event: "h8o-attempt-loop-budget-poison",
        note: "8o(ก) จบตามแผน — ไม่มี response/terminalLink ที่ settle ได้ (retry-capable ทั้งคู่)",
      });
      expect((await invocationState(opKey))?.status).toBe("poisoned");

      // designed failure: poison = battery ตาย — child ต้องออก RC≠0 ให้ wrapper audit
      designed = true;
      throw new Error(
        "h8o-attempt-loop-budget-poison: scenario จบแบบ poisoned โดยออกแบบ (r30·8oก) — wrapper ตรวจ ledger coverage และเคลียร์มือ",
      );
      } catch (err) {
        // crash กลางทาง (ไม่ใช่ designed-poison) = เคลียร์โลกให้ run ถัดไปเริ่มได้
        if (!designed) {
          await crashRecover(opKey, err);
        }
        throw err;
      }
    },
    150_000,
  );
});

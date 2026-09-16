/**
 * 8o fixture (ง) — live-predecessor (r29 §0 + cleanup ลำดับ r29-m2 + ขอบเขต
 * r29-m1 · r30 §2-D89-4): guard ต้องปฏิเสธ attempt ใหม่ "ก่อน dispatch ใดๆ"
 * เมื่อ invocation N ยัง live และ waiter ยังจอดอยู่ — และการเคลียร์ต้องทำตาม
 * ลำดับจริง (terminate → ปล่อย SRE → drain response → settle → guard ผ่าน)
 *
 * test 1 (main): hold SRE บน audit_logs + park invocation N (dispatch →
 *   handshake #1 เจอ waiter-1 → ไม่ terminate ไม่ abort ปล่อยค้าง) →
 *   attemptBegin N+1 → **สาม assert**: guard ปฏิเสธ
 *   'lifecycle-guard-refused-live-predecessor' ก่อน request ใหม่ (ไม่มี
 *   dispatch N+1 — invocation เดียวของ opKey ใน run) · waiter เก่ายัง live
 *   (pid เดิม busy ใน pg_stat_activity) · ledger N ยัง 'running' ครบ →
 *   เคลียร์จริง (r29-m2): terminate waiter-1 → **ถือ SRE ต่อ** เจอ waiter-2
 *   (users.ts retry 250ms กลับมาติด SRE เดิม — มิเรอร์ทาง (b)) → ปล่อย SRE →
 *   รอ response ของ invocation N ถึง transport (drain ≤20 วิ) → settle N
 *   'completed-evidenced' → attemptBegin ผ่าน (ทดสอบต่อได้ — probe invocation
 *   ปิดทันทีโดยไม่ dispatch)
 *
 * test 2 (variant drain-timeout): park N แบบ drain ไม่ถึง — คงถือ lock จน
 *   พ้น drain deadline 20 วิ (response ห้ามมา) → poison N → attemptBegin N+1
 *   ยังปฏิเสธอยู่ (poisoned = เคลียร์มือก่อน — limitation 5) → เคลียร์ใน
 *   teardown ด้วย intent: ปล่อย lock → drain หลัง poison (mutation commit) →
 *   manualClearPoison ปิดโลก
 *
 * audit self-test: นับ guard-event 'lifecycle-guard-refused-live-predecessor'
 * ของ run ได้ ≥2 (สอง test) — "ไม่ใช่แค่ log"
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { awaitStuckWaiter } from "./barrier-harness.js";
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
  terminateBackend,
  pidsBusy,
  GuardRefusedError,
  type PsqlSession,
} from "../integration/test-io.js";
import { bffPatchHeaders } from "./qb-patch-fixture.js";
import {
  crashRecover,
  ensureUserActiveFixture,
  findOtherBlockedWaiter,
  freshRunTail,
  parkedPatchOrRetry,
  userPatchUrl,
  warmRestPool,
  type UserActiveFixture,
} from "./user-active-fixture.js";

const DRAIN_DEADLINE_MS = 20_000;

describe("8o fixture (ง) live-predecessor — guard ปฏิเสธก่อน dispatch + cleanup ลำดับ r29-m2", () => {
  let fixture: UserActiveFixture;
  let url = "";
  let opKey = "";

  beforeAll(async () => {
    fixture = await ensureUserActiveFixture("h8ong");
    url = userPatchUrl(fixture.targetId);
    opKey = deriveOpKey("app-direct", "PATCH", url);
  }, 120_000);

  it(
    "(ง-1) park N → attemptBegin N+1 ปฏิเสธก่อน dispatch · waiter ยัง live · ledger running → เคลียร์ตามลำดับ → guard ผ่าน",
    async () => {
      const runTail = freshRunTail(`${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 4)}`);
      // อุ่น rest pool ก่อนเปิด invocation (warm ล้มต้องล้มก่อนมี invocation ค้าง)
      await warmRestPool(fixture.token, "h8o-ng-warm");
      // battery ใช้ RUN_ID เดียวทั้งไดเรกทอรี — แถว invocation ของ child/ข เกิดก่อน
      // ไฟล์นี้ (opKey เดียวกันเพราะ route-normalized): จับ id ที่มีก่อนรอบนี้ไว้
      // แล้ว assert เฉพาะ id ใหม่ที่เกิดในรอบ (guard ปฏิเสธ N+1 ก่อนสร้างแถวใหม่)
      const preRows = await ledgerRead({ runId: currentRunId(), opKey, kinds: ["invocation"] });
      const preIds = new Set(preRows.map((r) => r.invocation_id));
      const guardN = await attemptBegin(opKey, "h8o-ng-attempt-N");

      try {

      const coordinator: PsqlSession = await startPsqlSession("h8o-ng-coordinator-1");
      let released = false;
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.audit_logs in share row exclusive mode;");

        // dispatch จนเกิด park จริง (fast-fail สิ่งแวดล้อมหลัง pool recycle →
        // เปิด dispatch ใหม่ใต้ invocation เดิม — ทุกครั้งลง ledger)
        const parked = await parkedPatchOrRetry({
          url,
          reason: `barrier 8o(ง-1) ${runTail} — park live-predecessor เพื่อพิสูจน์ guard`,
          invocationId: guardN.invocationId,
          labelBase: "h8o-ng-patch-N",
          handshakeLabel: "h8o-ng-handshake-1",
          coordinatorPid: coordinator.identity.pid,
          extraHeaders: bffPatchHeaders(fixture.token, fixture.actor.id),
        });
        const patchRaw = parked.patchRaw;
        const waiter1 = parked.waiter;

        // ── attemptBegin N+1: guard ต้องปฏิเสธก่อน request ใหม่ ──
        let refused: unknown = null;
        try {
          await attemptBegin(opKey, "h8o-ng-attempt-N-plus-1");
        } catch (err) {
          refused = err;
        }
        expect(refused).toBeInstanceOf(GuardRefusedError);
        expect(String(refused)).toContain("lifecycle-guard-refused-live-predecessor");
        // assert 1 (ก่อน dispatch): id ใหม่เดียวของรอบนี้ = ของ invocation N เท่านั้น
        const invocations = await ledgerRead({ runId: currentRunId(), opKey, kinds: ["invocation"] });
        const newIds = new Set(invocations.map((r) => r.invocation_id).filter((id) => !preIds.has(id)));
        expect(newIds.size, "ไม่มี dispatch/invocation N+1 — guard ปฏิเสธก่อน").toBe(1);
        expect([...newIds][0]).toBe(guardN.invocationId);
        // assert 2: waiter เก่ายัง live (pid เดิม busy — ไม่ถูก terminate)
        expect(await pidsBusy([waiter1.pid]), "waiter-1 ยัง live/busy หลัง guard refusal").toContain(waiter1.pid);
        // assert 3: ledger N ยัง 'running' ครบ
        const stateN = await invocationState(opKey);
        expect(stateN?.invocationId).toBe(guardN.invocationId);
        expect(stateN?.status).toBe("running");
        // guard-event ลง ledger จริง (audit self-test นับได้)
        const guardEvents = await ledgerRead({ runId: currentRunId(), opKey, kinds: ["guard-event"] });
        expect(
          guardEvents.filter((g) => g.payload["event"] === "lifecycle-guard-refused-live-predecessor").length,
        ).toBeGreaterThanOrEqual(1);

        // ── เคลียร์จริงตามลำดับ r29-m2 ──
        // (1) terminate waiter-1 (pid จาก handshake #1)
        const terminated = await terminateBackend(waiter1.pid);
        await ledgerWrite("note", { event: "h8o-ng-terminate-1", pid: waiter1.pid, terminated });
        expect(terminated).toBe(true);
        // (2) ถือ SRE ต่อ — users.ts retry (sleep 250ms) กลับมาติด SRE เดิม
        const waiter2 = await awaitStuckWaiter(
          { relation: "public.audit_logs", mode: "RowExclusiveLock", blockerPids: [coordinator.identity.pid] },
          "h8o-ng-handshake-2",
        );
        // (3) ปล่อย SRE ตอนนี้เอง — response จะมาเพราะ retry ไม่ติดอีก
        await coordinator.exec("commit;");
        released = true;
        // (4) drain response ของ invocation N (deadline 20 วิ)
        const response = await Promise.race([
          patchRaw.then((r) => r.status),
          sleep(DRAIN_DEADLINE_MS).then(() => {
            throw new Error(`h8o(ง-1) drain-timeout: response ไม่มาภายใน ${DRAIN_DEADLINE_MS}ms`);
          }),
        ]);
        expect(response).toBeGreaterThanOrEqual(200);
        expect(response).toBeLessThan(300);
        // (5) settle N ตาม completion class (response จริง)
        const settleN = await settleHttpWithEvidence(opKey, {
          blockerPids: [waiter1.pid, waiter2.pid],
          claimed: "evidenced",
          responseStatus: response,
          label: "h8o-ng-settle-N",
        });
        expect(settleN.settled).toBe(true);
        expect((await invocationState(opKey))?.status).toBe("settled");
      } finally {
        if (!released) {
          await coordinator.exec("rollback;").catch(() => undefined);
        }
        await coordinator.end();
      }

      // ── (6) attemptBegin ผ่านหลัง N settled — ทดสอบต่อได้ (ไม่ dispatch) ──
      const next = await attemptBegin(opKey, "h8o-ng-next-after-settle");
      expect(next.ok).toBe(true);
      await invocationClose(next.invocationId, opKey, "settled", {
        class: "guard-pass-probe",
        note: "h8o(ง-1) probe — พิสูจน์ guard ผ่านหลัง settle แล้วปิดทันที ไม่มี dispatch",
      });
      await ledgerWrite("note", { event: "h8o-ng-1-complete", opKey, runTail });
      } catch (err) {
        // opKey แชร์ทั้งครอบครัว (route `:uuid`) — crash กลางทางต้องปิดโลกก่อน rethrow
        await crashRecover(opKey, err);
        throw err;
      }
    },
    90_000,
  );

  it(
    "(ง-2 variant drain-timeout) park N คงถือ lock พ้น drain deadline → poison → N+1 ยังปฏิเสธ → เคลียร์ใน teardown ด้วย intent",
    async () => {
      const runTail = freshRunTail(`${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 4)}`);
      // อุ่น rest pool ก่อนเปิด invocation (warm ล้มต้องล้มก่อนมี invocation ค้าง)
      await warmRestPool(fixture.token, "h8o-ng2-warm");
      const guardN = await attemptBegin(opKey, "h8o-ng2-attempt-N");

      try {

      const coordinator: PsqlSession = await startPsqlSession("h8o-ng-coordinator-2");
      let released = false;
      // กระจกไม่-reject ของ patchRaw ให้ finally ใช้ (patchRaw ประกาศใน try-scope)
      let patchHeld: Promise<void> | null = null;
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.audit_logs in share row exclusive mode;");

        // dispatch จนเกิด park จริง (fast-fail สิ่งแวดล้อม → dispatch ใหม่ใต้ invocation เดิม)
        const parked = await parkedPatchOrRetry({
          url,
          reason: `barrier 8o(ง-2) ${runTail} — drain-timeout variant ตามแผน r29-m2`,
          invocationId: guardN.invocationId,
          labelBase: "h8o-ng2-patch-N",
          handshakeLabel: "h8o-ng2-handshake-1",
          coordinatorPid: coordinator.identity.pid,
          extraHeaders: bffPatchHeaders(fixture.token, fixture.actor.id),
        });
        const patchRaw = parked.patchRaw;
        patchHeld = patchRaw.then(
          () => undefined,
          () => undefined,
        );
        const tries = parked.tries;
        await ledgerWrite("note", { event: "h8o-ng2-parked", tries });

        // N+1 ปฏิเสธขณะ N ยัง live
        let refused: unknown = null;
        try {
          await attemptBegin(opKey, "h8o-ng2-attempt-N-plus-1");
        } catch (err) {
          refused = err;
        }
        expect(refused).toBeInstanceOf(GuardRefusedError);
        expect(String(refused)).toContain("lifecycle-guard-refused-live-predecessor");

        // คงถือ lock จนพ้น drain deadline — response ห้ามมา (patchRaw ต้องค้าง)
        let drained = false;
        await Promise.race([
          patchRaw.then(() => {
            drained = true;
          }),
          sleep(DRAIN_DEADLINE_MS).then(() => undefined),
        ]);
        expect(drained, `drain ต้องไม่ถึงภายใน ${DRAIN_DEADLINE_MS}ms ขณะถือ lock`).toBe(false);
        // waiter ยังจอดจริงตลอด window (park ไม่ใช่แค่ client ค้าง) — หลักฐานจริง
        // จาก rest log (w8ong-adhoc): statement_timeout 57014 ตัด RPC ที่จอด ~8 วิ
        // → users.ts retry 250ms หมุน waiter เป็น pid ใหม่รอบแล้วรอบเล่า ดังนั้น
        // invariant คือ "มี waiter จอดบน SRE" ไม่ใช่ "pid เดิมยัง busy"
        let parkedNow: { pid: number; mode: string } | null = null;
        const parkedDeadline = Date.now() + 3_000;
        while (parkedNow === null && Date.now() < parkedDeadline) {
          parkedNow = await findOtherBlockedWaiter("public.audit_logs", [coordinator.identity.pid], -1);
          if (parkedNow === null) await sleep(150);
        }
        expect(parkedNow, "ยังมี waiter จอดบน SRE ตลอด drain window (statement_timeout หมุน waiter — pid เปลี่ยนได้)").not.toBeNull();
        expect((await invocationState(opKey))?.status).toBe("running");

        // drain หมดเวลา → poison N
        await invocationClose(guardN.invocationId, opKey, "poisoned", {
          reason: "settle-budget-exceeded",
          event: "h8o-ng-drain-timeout-poison",
          note: "drain deadline ผ่านโดยไม่มี response — ถือ lock ตลอดตามเจตนา",
        });
        expect((await invocationState(opKey))?.status).toBe("poisoned");

        // N+1 ยังปฏิเสธอยู่แม้ predecessor จะ poisoned (เคลียร์มือก่อน — limitation 5)
        let refused2: unknown = null;
        try {
          await attemptBegin(opKey, "h8o-ng2-attempt-N-plus-1-after-poison");
        } catch (err) {
          refused2 = err;
        }
        expect(refused2).toBeInstanceOf(GuardRefusedError);
        expect(String(refused2)).toContain("lifecycle-guard-refused-live-predecessor");
        expect(String(refused2)).toContain("poisoned");
      } finally {
        // เคลียร์ใน teardown ด้วย intent (ข้อยกเว้นเฉพาะ negative fixture):
        // ปล่อย lock → RPC commit (mutation หลัง poison — target เป็น fixture user) →
        // drain หลังปล่อยเพื่อไม่ทิ้ง response ค้าง
        if (!released) {
          await coordinator.exec("rollback;").catch(() => undefined);
          released = true;
        }
        await coordinator.end();
        if (patchHeld !== null) {
          await Promise.race([patchHeld, sleep(15_000).then(() => undefined)]);
        }
      }

      await manualClearPoison(opKey, "h8o(ง-2) เคลียร์ poisoned ใน teardown ด้วย intent ตามแผน r29-m2");
      expect((await invocationState(opKey))?.status).toBe("cleared-manual");

      // audit self-test ของ run: นับ refusal event ได้ ≥2 (สอง test)
      const guardEvents = await ledgerRead({ runId: currentRunId(), opKey, kinds: ["guard-event"] });
      expect(
        guardEvents.filter((g) => g.payload["event"] === "lifecycle-guard-refused-live-predecessor").length,
        "audit self-test — นับ lifecycle-guard-refused-live-predecessor ได้จริง",
      ).toBeGreaterThanOrEqual(2);
      await ledgerWrite("note", { event: "h8o-ng-2-complete", opKey, runTail });
      } catch (err) {
        await crashRecover(opKey, err);
        throw err;
      }
    },
    120_000,
  );
});

/**
 * 8n — park ก่อน mutation dispatch (r22 §2-D89-4 CC·8n ใหม่ ตามคำสั่ง r21-M1):
 * coordinator ถือ AccessExclusive บน public.profiles → PATCH qb → route จอดที่
 * session read (pre-mutation · SELECT ขอ AccessShareLock ติดคิว) — handshake เห็น
 * waiter AccessShareLock · settle#1 = ปฏิเสธ 'settle-refused-blocked-backend'
 * (งาน pre-mutation ก็เป็นงานที่ยังไม่ terminal เหมือนกัน) · abort client ·
 * settle#2 ไร้ terminalLink = ปฏิเสธ 'settle-refused-no-terminal-link'
 *
 * กลไกจริงหลังปล่อย lock (พิสูจน์สด 2026-09-14T21:35Z · D-f-13 — rest log):
 * route ตื่นจาก session read (GET /profiles + my_roles ครบ) แต่ handler ตายที่
 * `await request.json()` เพราะ socket ของ client ถูกทำลายไปแล้ว → RPC
 * admin_update_question ไม่เคยถูก dispatch → แถวไม่โผล่ version ไม่ bump —
 * เป็นภาพกระจกของ 8k: abort "ก่อน" dispatch = mutation ไม่เกิด · abort "หลัง"
 * dispatch (8k/8m) = commit ตกลงไปแล้ว — สองทิศพิสูจน์ว่า invocation ไม่เดา
 * ผลจาก client โดยเด็ดขาด: ไม่มี response/terminalLink ก็คง 'running' จน budget
 * หมด = poison (ผู้ถือ budget = scenario · limitation 7) → attempt ใหม่ถูก guard
 * ปฏิเสธจนกว่าจะ manualClearPoison · ปล่อย lock ใน finally เสมอ
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { awaitStuckWaiter } from "./barrier-harness.js";
import {
  attemptBegin,
  currentRunId,
  deriveOpKey,
  httpWrite,
  invocationClose,
  invocationState,
  ledgerWrite,
  manualClearPoison,
  settleHttpWithEvidence,
  startPsqlSession,
  GuardRefusedError,
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

describe("8n park ก่อน mutation — settle สองครั้งปฏิเสธ + abort ก่อน dispatch = ไม่มี mutation + budget poison", () => {
  let fixture: QbFixture;

  beforeAll(async () => {
    fixture = await ensureQbFixture("h8n");
  }, 120_000);

  it(
    "AccessExclusive profiles → route จอด pre-mutation → settle#1 blocked · settle#2 no-terminal-link · ปล่อย → ไม่มี dispatch → poison",
    async () => {
      const runTail = `${currentRunId().slice(0, 6)}-${randomUUID().slice(0, 6)}`;
      const url = qbPatchUrl(fixture.bankId, fixture.questionId);
      const opKey = deriveOpKey("app-direct", "PATCH", url);
      const invocationId = randomUUID();

      const coordinator: PsqlSession = await startPsqlSession("h8n-coordinator");
      let released = false;
      try {
        await coordinator.exec("begin;");
        await coordinator.exec("lock table public.profiles in access exclusive mode;");

        const ac = new AbortController();
        const patch = httpWrite(
          "PATCH",
          url,
          newOptionBody("h8n", runTail),
          {
            invocationId,
            settleMode: "scenario",
            signal: ac.signal,
            transportTarget: "app-direct",
            label: "h8n-qb-patch",
            extraHeaders: bffPatchHeaders(fixture.token, fixture.user.id),
          },
        ).then(
          () => "responded" as const,
          (err: unknown) => `thrown:${String(err).slice(0, 80)}` as const,
        );

        // handshake — route จอดที่ session read: waiter AccessShareLock บน profiles
        const waiter = await awaitStuckWaiter(
          { relation: "public.profiles", mode: "AccessShareLock", blockerPids: [coordinator.identity.pid] },
          "h8n-pre-mutation-park",
        );

        // settle#1 — งาน pre-mutation ยังไม่ terminal (waiter มีชีวิต) → ปฏิเสธ
        const s1 = await settleHttpWithEvidence(opKey, {
          blockerPids: [waiter.pid],
          claimed: "evidenced-no-response",
          label: "h8n-settle-1-ระหว่าง-park",
        });
        expect(s1.settled).toBe(false);
        expect(s1.refusal).toBe("settle-refused-blocked-backend");

        ac.abort();
        const outcome = await patch;
        expect(outcome.startsWith("thrown")).toBe(true);

        // settle#2 — abort แล้ว "ไร้ terminalLink" (ไม่มี attribution) → ปฏิเสธอีกทาง
        const s2 = await settleHttpWithEvidence(opKey, {
          claimed: "evidenced-no-response",
          label: "h8n-settle-2-no-attribution",
        });
        expect(s2.settled).toBe(false);
        expect(s2.refusal).toBe("settle-refused-no-terminal-link");
        expect((await invocationState(opKey))?.status).toBe("running");

        // ปล่อย lock → route ตื่นจาก session read แต่ตายที่ request.json() (socket
        // ของ client ไปแล้ว) → mutation ไม่ถูก dispatch เลย: แถวคงเดิม version คงเดิม
        // (ภาพกระจก 8k — abort ก่อน dispatch กับหลัง dispatch คนละผลลัพธ์ แต่ invocation
        // ปฏิบัติเหมือนกัน: ไร้หลักฐาน terminal = ห้าม settle)
        await coordinator.exec("commit;");
        released = true;
        await sleep(1_000); // ให้เวลา route ไล่ chain ต่อ (จะไม่ dispatch ก็ตาม)
        expect(await optionRowCount(fixture.questionId), "mutation ไม่ถูก dispatch หลัง abort ก่อน dispatch").toBe(fixture.baseOptionCount);
        expect(await questionVersion(fixture.questionId), "version คงเดิม").toBe(1);

        // invocation คง 'running' จน budget หมด → poison (ผู้ถือ budget = scenario)
        expect((await invocationState(opKey))?.status).toBe("running");
        await invocationClose(invocationId, opKey, "poisoned", {
          reason: "settle-budget-exceeded",
          event: "h8n-budget-poison",
        });
        expect((await invocationState(opKey))?.status).toBe("poisoned");

        // หลัง poison: attempt ใหม่ของ opKey เดิมต้องถูก guard ปฏิเสธจนกว่าจะเคลียร์มือ
        let refused: unknown = null;
        try {
          await attemptBegin(opKey, "h8n-post-poison-attempt");
        } catch (err) {
          refused = err;
        }
        expect(refused).toBeInstanceOf(GuardRefusedError);
        expect(String(refused)).toContain("lifecycle-guard-refused-live-predecessor");
      } finally {
        if (!released) {
          await coordinator.exec("rollback;").catch(() => undefined);
        }
        await coordinator.end();
      }

      await manualClearPoison(opKey, "h8n ปิดหลังพิสูจน์ park-pre-mutation + budget poison");
      expect((await invocationState(opKey))?.status).toBe("cleared-manual");
      await ledgerWrite("note", { event: "h8n-scenario-complete", opKey, runTail });
    },
    120_000,
  );
});

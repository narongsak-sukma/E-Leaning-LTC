/**
 * 8o(ก) wrapper — audit coverage ของ attempt loop child (r30 §2-D89-4 CC·8o ก):
 * spawn child (mm-attempt-loop) ผ่าน childRun → child ต้องออก RC≠0 ด้วยข้อความ
 * designed-poison → audit ledger ของ run นี้:
 *   (1) settle-decision 'settle-refused-retry-capable' scanClean=true = เอ๊ A เดียว
 *   (2) settle-decision 'settle-refused-retry-capable' + busyPids = เอ๊ B เดียว
 *       — "ผ่านต่อเมื่อ audit เจอ decision row เดียวครบคู่" · drain settle
 *       ('completed-evidenced' ทาง b) บันทึกได้แต่ไม่ทดแทน
 *   (3) invocation ปลายทาง 'poisoned' (event h8o-attempt-loop-budget-poison)
 *   (4) ทุก attempt เริ่มผ่าน guard: attempt-allowed ≥1 · ไม่มี guard-refused
 *       ภายใน run ก่อน poison (serial invariant ของ scenario attempt)
 *   (5) commit-after-abort จริงที่ DB: target is_active=false + audit USER_DISABLE ≥1
 * แล้วเคลียร์มือ (manualClearPoison) ปิดโลกให้ไฟล์ถัดไป (ข/ง) ทำงานต่อได้
 */
import { describe, expect, it } from "vitest";

import { childRun } from "./barrier-harness.js";
import {
  currentRunId,
  invocationState,
  ledgerRead,
  ledgerWrite,
  manualClearPoison,
  type LedgerRow,
} from "../integration/test-io.js";
import { userDisableAuditCount, userIsActive } from "./user-active-fixture.js";

const CHILD_FILE = "tests/barrier-proof/child/mm-attempt-loop.test.ts";

describe("8o(ก) wrapper — attempt loop ≤3: audit coverage + เคลียร์มือ", () => {
  it(
    "child RC≠0 ด้วย designed-poison · decision rows ครบคู่ (A clean + B busy) · poisoned → manualClear",
    async () => {
      const runId = currentRunId();
      const result = await childRun([CHILD_FILE], { timeoutMs: 200_000 });
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.code, `child ต้องล้ม (designed poison) — got RC=${result.code}\n${combined.slice(-1_500)}`).not.toBe(0);
      expect(combined).toContain("h8o-attempt-loop-budget-poison");

      // IPC: target/opKey จาก child
      const notes = await ledgerRead({ runId, kinds: ["note"] });
      const fixtureNote = [...notes].reverse().find((n) => n.payload["event"] === "h8o-child-fixture");
      expect(fixtureNote, "ต้องเจอ h8o-child-fixture note").toBeTruthy();
      const targetUserId = fixtureNote?.payload["targetUserId"];
      const opKey = fixtureNote?.payload["opKey"];
      expect(typeof targetUserId).toBe("string");
      expect(typeof opKey).toBe("string");
      const opKeyStr = opKey as string;
      const targetIdStr = targetUserId as string;

      // (1)+(2) settle-decision coverage — ครบคู่ เอ๊ละ
      const decisions = (await ledgerRead({ runId, opKey: opKeyStr, kinds: ["settle-decision"] })) as LedgerRow[];
      const cleanA = decisions.filter(
        (d) => d.payload["decision"] === "settle-refused-retry-capable" && d.payload["scanClean"] === true,
      );
      const busyB = decisions.filter(
        (d) =>
          d.payload["decision"] === "settle-refused-retry-capable" &&
          Array.isArray(d.payload["busyPids"]) &&
          (d.payload["busyPids"] as number[]).length > 0,
      );
      expect(cleanA, `settle-A (scanClean=true) ต้องมีเอ๊เดียว — ได้ ${cleanA.length}`).toHaveLength(1);
      expect(busyB, `settle-B (busyPids) ต้องมีเอ๊เดียว — ได้ ${busyB.length}`).toHaveLength(1);
      // drain settle (ทาง b) ได้แต่ไม่ทดแทนคู่ A/B
      const drains = decisions.filter((d) => d.payload["decision"] === "completed-evidenced");
      expect(drains.length, "drain settle ทาง (b) ได้ไม่เกินจำนวน attempt").toBeLessThanOrEqual(2);

      // (3) invocation ปลายทาง poisoned
      const finalState = await invocationState(opKeyStr);
      expect(finalState?.status).toBe("poisoned");
      expect(finalState?.payload["event"]).toBe("h8o-attempt-loop-budget-poison");

      // (4) ทุก attempt ผ่าน guard — allowed ≥1 · ไม่มี refusal ก่อน poison
      const guardEvents = await ledgerRead({ runId, opKey: opKeyStr, kinds: ["guard-event"] });
      const allowed = guardEvents.filter((g) => g.payload["event"] === "attempt-allowed");
      const refused = guardEvents.filter((g) => g.payload["event"] === "lifecycle-guard-refused-live-predecessor");
      expect(allowed.length, "child ต้องเริ่ม attempt ผ่าน attemptBegin อย่างน้อยหนึ่งครั้ง").toBeGreaterThanOrEqual(1);
      expect(refused, "ภายใน child ต้องไม่มี guard refusal (serial invariant ไม่ถูกละเมิด)").toHaveLength(0);

      // (5) commit-after-abort จริงที่ DB
      expect(await userIsActive(targetIdStr), "target ต้องถูกปิดใช้งาน (RPC commit หลัง abort)").toBe(false);
      expect(await userDisableAuditCount(targetIdStr), "audit USER_DISABLE ≥1 หลัง commit").toBeGreaterThan(0);

      // เคลียร์มือปิดโลก — ไฟล์ถัดไปของครอบครัว 8o เริ่มได้ (limitation 5)
      await manualClearPoison(opKeyStr, "h8o(ก) wrapper เคลียร์หลัง audit coverage ครบ");
      expect((await invocationState(opKeyStr))?.status).toBe("cleared-manual");
      await ledgerWrite("note", { event: "h8o-guard-audit-complete", opKey: opKeyStr });
    },
    240_000,
  );
});

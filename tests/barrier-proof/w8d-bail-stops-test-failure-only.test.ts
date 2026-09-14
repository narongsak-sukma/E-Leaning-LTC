/**
 * 8d — wrapper: --bail=1 หยุด "test-failure" เท่านั้น — คนละกลไกกับ poison ของ 8b
 * (hook-failure ลามไป bb ได้แม้ไม่มี bail เพราะ stop-condition ของ vitest นับ
 * เฉพาะ test failure ที่รันจบ — 8b พิสูจน์ฝั่ง hook แล้ว)
 *
 * สอง child run จากไฟล์คู่เดียวกัน (ee ล้มที่ตัวเทส → ff ตามหลัง):
 *   run A (ไม่มี bail): ff รันต่อ — มี file-attempt-allowed ของ ff + marker ff-done
 *   run B (--bail=1):  รอบหยุดที่ ee — ไม่มี event ใหม่ของ ff เลย (แยกด้วย snapshot
 *                      id ก่อนรอบ เพราะ ledger ใช้ run_id เดียวกันทั้งสองรอบ)
 *
 * และใน run A: teardown ของ ee "ต้องรันแม้ตัวเทสล้ม" (cleanup-ran=1) — ความล้มของ
 * body ไม่ใช่เหตุหยุด teardown
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  childRun,
  countMarkers,
  ensureBarrierInfra,
  fileState,
  resetFileWorld,
} from "./barrier-harness.js";
import { currentRunId, ledgerRead } from "../integration/test-io.js";

const EE = "8d-ee-fail-body";
const FF = "8d-ff-after-fail";
const PAIR = ["tests/barrier-proof/child/ee-fail-body.test.ts", "tests/barrier-proof/child/ff-after-fail.test.ts"];

async function ffAttemptIds(): Promise<Set<string>> {
  const events = await ledgerRead({ runId: currentRunId(), kinds: ["guard-event"] });
  return new Set(
    events
      .filter((e) => e.payload["event"] === "file-attempt-allowed" && e.payload["file"] === FF)
      .map((e) => e.id),
  );
}

describe("8d --bail=1 หยุด test-failure เท่านั้น (ไม่ใช่ hook-failure)", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [EE, FF] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [EE, FF] });
  }, 60_000);

  it(
    "8d-1 run A (ไม่มี bail): ee ล้มที่ body แต่ ff รันต่อ + teardown ของ ee ยังรัน",
    async () => {
      const result = await childRun(PAIR, { timeoutMs: 120_000 });
      expect(
        result.code,
        `stdout ท้าย:\n${result.stdout.slice(-1_500)}\nstderr:\n${result.stderr.slice(-800)}`,
      ).not.toBe(0);
      // ff ถูกเก็บและรันจบครบวง: attempt ผ่าน guard + teardown-settled + cleanup
      // ของตัวเองรน. (marker ff-done ถูก cleanup TX ของ ff เองลบ — หลักฐานคงทน
      // คือ phase + cleanup-ran)
      expect([...(await ffAttemptIds())].length).toBeGreaterThanOrEqual(1);
      expect((await fileState(FF))?.phase).toBe("teardown-settled");
      expect(await countMarkers(FF, "cleanup-ran")).toBe(1);
      // teardown ของ ee รันแม้ body ล้ม (cleanup-ran เกิดจาก cleanup TX)
      expect(await countMarkers(EE, "cleanup-ran")).toBe(1);
      const eeState = await fileState(EE);
      expect(eeState?.phase).toBe("teardown-settled");
    },
    150_000,
  );

  it(
    "8d-2 run B (--bail=1): รอบหยุดที่ ee — ff ไม่มี event ใหม่/marker เลย",
    async () => {
      const before = await ffAttemptIds();
      await resetFileWorld({ files: [EE, FF] });
      const result = await childRun(PAIR, { timeoutMs: 120_000, bail: 1 });
      expect(result.code).not.toBe(0);
      // ไม่มี file-attempt-allowed "ใหม่" ของ ff (bail ตัดก่อนถึง ff)
      const after = await ffAttemptIds();
      const fresh = [...after].filter((id) => !before.has(id));
      expect(fresh, `เกิด event ใหม่ของ ff หลัง bail: ${fresh.join(",")}`).toHaveLength(0);
      expect(await countMarkers(FF, "ff-done")).toBe(0);
      expect(await countMarkers(FF, "cleanup-ran")).toBe(0);
    },
    150_000,
  );
});

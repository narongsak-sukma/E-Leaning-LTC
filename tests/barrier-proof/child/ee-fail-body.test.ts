/**
 * 8d (ลำคู่ ee) — child file ที่ "ตัวเทส" ล้ม (ไม่ใช่ hook) — วัตถุดิบของการพิสูจน์
 * ขอบเขต --bail=1: หยุด test-failure ไม่ใช่ hook-failure (แผน r15 §8d)
 *
 * ทั้งสอง child run (มี bail / ไม่มี bail) ใช้ไฟล์คู่นี้เหมือนกัน:
 *   - run ไม่มี bail → ff รันต่อ (มี file-attempt-allowed ของ ff)
 *   - run --bail=1 → รอบหยุดที่ ee → ff ไม่ถูกเก็บเลย (ไม่มี event ใหม่ของ ff)
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import { guardedAfterAll, guardedBeforeAll, insertMarkers } from "../barrier-harness.js";

export const EE_FILE = "8d-ee-fail-body";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8d-ee test-body ล้มโดยตั้งใจ (child)", () => {
  let lifecycleId = "";

  beforeAll(async () => {
    lifecycleId = await guardedBeforeAll(EE_FILE, "8d-ee setup ปกติ", async () => {
      await insertMarkers(EE_FILE, "ee-setup", 1, "setup ผ่าน — ตัวเทสเองล้ม");
    });
  }, 20_000);

  afterAll(async () => {
    await guardedAfterAll(EE_FILE, "8d-ee teardown เต็มสาย (teardown ต้องรันแม้ body ล้ม)", {
      lifecycleId,
    });
  }, 20_000);

  it("8d-ee body ล้มโดยตั้งใจ — hook ทั้งคู่ผ่าน", () => {
    throw new Error("8d-ee-intentional-test-failure");
  });
});

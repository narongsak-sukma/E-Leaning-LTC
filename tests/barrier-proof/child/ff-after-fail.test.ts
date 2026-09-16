/**
 * 8d (ลำคู่ ff) — child file ที่ต้องรัน "ต่อ" หลัง ee ล้ม เมื่อไม่มี bail
 * (และต้องไม่ถูกเก็บเลยเมื่อ --bail=1) — หลักฐานอยู่ที่ ledger guard-event
 * file-attempt-allowed ของ ff: มีใน run ธรรมดา / ไม่มี (รายการใหม่) ใน run bail
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import { guardedAfterAll, guardedBeforeAll, insertMarkers } from "../barrier-harness.js";

export const FF_FILE = "8d-ff-after-fail";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8d-ff ไฟล์ถัดไปหลังความล้ม (child)", () => {
  let lifecycleId = "";

  beforeAll(async () => {
    lifecycleId = await guardedBeforeAll(FF_FILE, "8d-ff setup ปกติ", async () => {
      await insertMarkers(FF_FILE, "ff-start", 1);
    });
  }, 20_000);

  afterAll(async () => {
    await guardedAfterAll(FF_FILE, "8d-ff teardown เต็มสาย", { lifecycleId });
  }, 20_000);

  it("8d-ff body ผ่าน + ปักหลักฐานว่ารันจริง", async () => {
    await insertMarkers(FF_FILE, "ff-done", 1, "ff รันจบหลัง ee ล้ม (ไม่มี bail)");
  });
});

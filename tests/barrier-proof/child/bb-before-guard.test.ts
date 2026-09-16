/**
 * 8b (ลำคู่ bb) — child file ที่ต้องถูกปฏิเสธ "ก่อน" แตะ setup ใดๆ
 * รันเฉพาะใน child run (BARRIER_CHILD=1) · ตาม sequencer ต้องมาหลัง aa เสมอ
 *
 * สัญญาที่พิสูจน์:
 *   beforeAll: fileBegin เห็น aa เป็น poisoned (live predecessor) → โยน
 *              file-guard-refused-live-predecessor "ก่อน" INSERT แถวของตัวเอง —
 *              ความล้มของ aa หยุดอยู่ที่ไฟล์ aa ไม่ลามไป setup ของ bb
 *   afterAll:  lifecycleId ว่าง → guardedAfterAll fast-refuse
 *              teardown-refused-no-setup — cleanup ห้ามรันเมื่อ setup ไม่เคยเริ่ม
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import { guardedAfterAll, guardedBeforeAll } from "../barrier-harness.js";

export const BB_FILE = "8b-bb-before-guard";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8b-bb guard ปฏิเสธก่อน setup (child)", () => {
  let lifecycleId = "";

  beforeAll(async () => {
    lifecycleId = await guardedBeforeAll(BB_FILE, "8b-bb ต้องถูกปฏิเสธก่อน setup", async () => {
      // ไม่ควรมาถึงบรรทัดนี้ — fileBegin ต้องโยนก่อน fn เริ่ม
    });
  }, 20_000);

  afterAll(async () => {
    await guardedAfterAll(BB_FILE, "8b-bb afterAll หลัง guard ปฏิเสธ", { lifecycleId });
  }, 20_000);

  it("8b-bb body: ไม่รัน (beforeAll ล้ม)", () => {
    // ถ้ารันถึงตรงนี้ = guard ไม่ทำงาน — ให้ล้มดัง
    throw new Error("8b-bb: test body ต้องไม่รันเมื่อ beforeAll ถูก guard ปฏิเสธ");
  });
});

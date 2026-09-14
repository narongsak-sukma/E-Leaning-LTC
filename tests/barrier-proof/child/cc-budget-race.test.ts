/**
 * 8c (ลำคู่ cc) — child file: afterAll budget 8s แข่งกับ hookTimeout 5s
 * รันเฉพาะใน child run (BARRIER_CHILD=1)
 *
 * ลำดับเวลาที่จงใจ (ตามแผน r15 §8c):
 *   t≈0.7s  afterAll fn จับ direct lease แล้วหลับ 9s
 *   t≈5.7s  hookTimeout 5s ตัด hook — runner "ทิ้ง" promise (F56: ยังวิ่งต่อ)
 *   t≈8.7s  budget 8s ชนะ race → harness poison ไฟล์ + โยน (สู่ promise ที่ถูกทิ้ง)
 *           + ผูก handler ให้ฝั่งแพ้
 *   t≈9.7s  fn ตื่น ปล่อย lease เอง → orphan-fn-settled-later (result fn-done)
 *           — เกิดหลัง runner ไปแล้ว ยืนยันด้วย ledger + ตาราง worker_lease
 *   (dd-time-anchor คู่มาด้วยเพื่อให้ process ยังมีชีวิตถึง t≈12s)
 *
 * ห้ามใส่ timeout ให้ afterAll ตัวนี้ — สถานการณ์ต้องการ runner ตัดที่ 5s จริง
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countMarkers, guardedAfterAll, guardedBeforeAll, insertMarkers } from "../barrier-harness.js";
import { acquireLease, releaseLease } from "../../integration/window-coordinator.js";

export const CC_FILE = "8c-cc-budget-race";
export const CC_OWNER = "w8c-cc";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8c-cc budget แข่ง hookTimeout (child)", () => {
  let lifecycleId = "";

  beforeAll(async () => {
    lifecycleId = await guardedBeforeAll(CC_FILE, "8c-cc setup เร็ว (ไม่เกี่ยวกับการแข่ง)", async () => {
      await insertMarkers(CC_FILE, "cc-setup", 2, "ก่อน budget แข่ง hookTimeout");
    });
  }, 20_000);

  // ห้ามใส่อาร์กิวเมนต์ timeout — hookTimeout 5s ของ config ต้องเป็นฝ่ายตัด
  afterAll(async () => {
    await guardedAfterAll(CC_FILE, "8c-cc afterAll: fn ถือ lease 9s แข่ง budget 8s", {
      lifecycleId,
      fnBudgetMs: 8_000,
      fn: async () => {
        const lease = await acquireLease({ kind: "direct", owner: CC_OWNER });
        await new Promise((resolve) => setTimeout(resolve, 9_000));
        await releaseLease(lease.leaseId); // ปล่อยเองหลังแพ้ race ไปแล้ว = orphan ที่มีร่องรอย
      },
    });
  });

  it("8c-cc body ผ่านก่อน afterAll ถูกทิ้งโดย runner", async () => {
    expect(await countMarkers(CC_FILE, "cc-setup")).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 8e2 — child file: setup fn ไม่จบเลย (hang ตลอดกาล) → awaitFileSettled ครบ
 * budget → poison — cleanup ห้ามรัน (แผน r15 §8e2)
 *
 * ต่างจาก 8e: setup ไม่มีวันเซ็ตเทิล — หลักฐานคือ phase ค้าง setup-running จน
 * afterAll หมด budget แล้ว poison ด้วยเหตุผล setup-settle-budget-exceeded
 *
 * ลำดับเวลา (สเกลเครื่องสำรองตาม DCR-BARRIER-REBASELINE — จุดตัด 5s → per-hook 12.5s):
 *   t≈4.5s  fileBegin กลับมือ (phase setup-running) → ค้างใน await ตลอดกาล
 *   t≈12.5s runner ตัด beforeAll
 *   t≈12.7s afterAll → guardedAfterAll → awaitFileSettled (budget 8s คงเดิม)
 *   t≈23s   budget หมด → filePoison(setup-settle-budget-exceeded) + โยน
 *           FileSettleError → hook ล้ม (ภายใน timeout 15s ที่ให้ไว้)
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import { fileBegin, guardedAfterAll } from "../barrier-harness.js";

export const HH_FILE = "8e2-hh-hang-setup";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8e2-hh setup ไม่จบเลย (child)", () => {
  let lifecycleId = "";

  // per-hook timeout 12.5s (DCR-BARRIER-REBASELINE) — ต้องโดนตัดหลัง lifecycleId
  // กลับมือแน่ (config 5s เดิมตัดก่อน fileBegin จบบนเครื่องสำรอง · แล้ว promise ที่ถูกทิ้ง
  // ค้างตลอดกาลต่อไป — ไม่ถือ event loop)
  beforeAll(async () => {
    lifecycleId = await fileBegin(HH_FILE, "8e2-hh setup ที่ไม่มีวันจบ");
    await new Promise<never>(() => {}); // hang ตลอดกาลโดยตั้งใจ
  }, 12_500);

  it("8e2-hh body ต้องไม่รัน", () => {
    throw new Error("8e2-hh: body ห้ามรันเมื่อ setup ค้าง");
  });

  afterAll(async () => {
    await guardedAfterAll(HH_FILE, "8e2-hh teardown หมด budget แล้ว poison", {
      lifecycleId,
      setupBudgetMs: 8_000,
    });
  }, 15_000);
});

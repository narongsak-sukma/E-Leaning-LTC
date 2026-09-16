/**
 * 8c (ลำคู่ dd) — time anchor: ยืดอายุ child process ให้เหตุการณ์ orphan ของ cc
 * (budget ชนะที่ ~8.7s · fn ปล่อย lease + orphan note ที่ ~9.7s) ได้เกิดจริงก่อน
 * process ตาย — ไม่มี dd แล้ว vitest จะจบรอบหลัง hook โดนตัดที่ ~5.7s แล้ว
 * worker ตายก่อนเหตุการณ์ที่ต้องพิสูจน์เกิดเลย
 *
 * anchor ไม่มี file lifecycle ของตัวเอง — หน้าที่เดียวคือเวลา + marker ปลายทาง
 * (wrapper อ่าน anchor-done จาก DB ไม่แกะ stdout)
 */
import { describe, it } from "vitest";

import { insertMarkers } from "../barrier-harness.js";

export const DD_FILE = "8c-dd-anchor";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8c-dd time anchor (child)", () => {
  it(
    "dd ยืดอายุ process ผ่านจุด orphan ของ cc แล้วปัก anchor", async () => {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      await insertMarkers(DD_FILE, "anchor-done", 1, "dd จบหลังเหตุการณ์ orphan ของ cc แล้ว");
    },
    20_000,
  );
});

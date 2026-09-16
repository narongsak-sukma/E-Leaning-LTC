/**
 * 8h h1 (ลำคู่ ll) — trailer ที่ "นอนรอ" ให้กระบวนการ child run ยังมีชีวิตจน
 * body ที่ถูกทิ้งของ kk ตื่น (~8s) — singleFork แชร์ process เดียว ถ้า run จบ
 * ก่อน promise ที่ถูกทิ้งจะตายตาม (F56) — ll คือเหตุผลที่ kk ยังวิ่งต่อได้
 */
import { describe, it } from "vitest";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8h-ll hold กระบวนการไว้ให้ kk ตื่น (child)", () => {
  it("8h-ll นอน 9s — ไม่มี assertion (ตัวถือ-กระบวนการ)", async () => {
    await new Promise((resolve) => setTimeout(resolve, 9_000));
  }, 15_000);
});

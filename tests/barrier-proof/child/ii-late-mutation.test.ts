/**
 * 8g (ลำคู่ ii) — child file ที่ "ตัวเทส" ถูก runner ตัดที่ 5s (testTimeout จงใจ)
 * กลาง pg_sleep แต่ promise ยังวิ่งต่อ (F56 + singleFork): หลัง teardown ของ
 * ii จบไปแล้ว (~5.5s) body ที่ถูกทิ้งกลับมาแทรก marker + เขียน ledger ที่ ~12s
 * — นี่คือ mutation ที่หลุดหลังหน้าต่าง teardown ปิด · jj (ไฟล์ถัดไป) เป็น
 * trailer ที่นอนรอแล้วตรวจจับด้วย absence check
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import { guardedAfterAll, guardedBeforeAll, insertMarkers } from "../barrier-harness.js";
import { ledgerWrite } from "../../integration/test-io.js";
import { psql } from "../../integration/helpers.js";

export const II_FILE = "8g-ii-late-mutation";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8g-ii body ถูกตัด → mutation มาทีหลัง (child)", () => {
  let lifecycleId = "";

  beforeAll(async () => {
    lifecycleId = await guardedBeforeAll(II_FILE, "8g-ii setup ปกติ", async () => {
      await insertMarkers(II_FILE, "ii-setup", 1);
    });
  }, 20_000);

  afterAll(async () => {
    // teardown เต็มสาย รันทันทีหลัง body ถูกตัด (~5.1s) — cleanup-start เกิดก่อน
    // mutation ของ body ที่ถูกทิ้งพอดี (นี่คือสิ่งที่ jj ต้องจับ)
    await guardedAfterAll(II_FILE, "8g-ii teardown เต็มสาย (ก่อน mutation มาถึง)", { lifecycleId });
  }, 20_000);

  it(
    "8g-ii body ค้างใน pg_sleep 12s — runner ตัดที่ 5s แล้ว promise วิ่งต่อ",
    async () => {
      await psql("select pg_sleep(12);", { quiet: true });
      // —— runner ทิ้งเราไปแล้ว (~5s) — ส่วนนี้คือ mutation หลัง teardown ——
      await insertMarkers(II_FILE, "ii-mutation", 1, "body ที่ถูกทิ้งแทรกหลัง cleanup");
      await ledgerWrite("note", { event: "mutation-complete", file: II_FILE });
    },
    5_000, // จงใจ — testTimeout 5s ให้ runner ตัดกลาง pg_sleep
  );
});

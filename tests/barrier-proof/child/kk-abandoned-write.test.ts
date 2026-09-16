/**
 * 8h h1 (ลำคู่ kk) — child file ที่ "ตัวเทส" ถูก runner ตัดที่ 5s กลาง pg_sleep
 * แล้ว body ที่ถูกทิ้งตื่นมา "หลัง release จบ" (~8s) แล้วพยายามเขียนผ่าน
 * guardedMarkerInsert — primitive ต้องโยนก่อนแตะ marker (phase ปิดแล้ว) + ledger
 * event 'mutation-rejected' — write หลุดหลังหน้าต่างไม่มีทางลงเงียบๆ
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import { guardedAfterAll, guardedBeforeAll, guardedMarkerInsert, insertMarkers } from "../barrier-harness.js";
import { ledgerWrite } from "../../integration/test-io.js";
import { psql } from "../../integration/helpers.js";

export const KK_FILE = "8h-kk-abandoned-write";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8h-kk body ที่ถูกทิ้งตื่นหลัง release (child)", () => {
  let lifecycleId = "";

  beforeAll(async () => {
    lifecycleId = await guardedBeforeAll(KK_FILE, "8h-kk setup ปกติ", async () => {
      await insertMarkers(KK_FILE, "kk-setup", 1);
    });
  }, 20_000);

  afterAll(async () => {
    // teardown เต็มสายรันทันทีหลัง body ถูกตัด (~5.1s) — release จบก่อน body ตื่น
    await guardedAfterAll(KK_FILE, "8h-kk teardown ก่อน body ตื่น", { lifecycleId });
  }, 20_000);

  it(
    "8h-kk body ค้าง pg_sleep 8s — ตัดที่ 5s · ตื่นที่ ~8s แล้วเขียนต้องถูกปฏิเสธ",
    async () => {
      await psql("select pg_sleep(8);", { quiet: true });
      // —— runner ทิ้งเราไปแล้ว และ release ของไฟล์นี้จบไปแล้วด้วย ——
      let refused: unknown = null;
      try {
        await guardedMarkerInsert(KK_FILE, "kk-late", "body ที่ถูกทิ้งตื่นมาเขียน");
      } catch (err) {
        refused = err;
      }
      // หลักฐานคงทนใน ledger (assert อยู่ที่ wrapper)
      await ledgerWrite("note", {
        event: "late-write-refused-captured",
        file: KK_FILE,
        refused: refused !== null,
        error: String(refused).slice(0, 200),
      });
    },
    5_000, // จงใจ — testTimeout 5s ให้ runner ตัดกลาง pg_sleep
  );
});

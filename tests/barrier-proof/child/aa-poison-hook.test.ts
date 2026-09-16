/**
 * 8b (ลำคู่ aa) — child file ของสถานการณ์ "poison หยุดการลามของ hook-failure"
 * รันเฉพาะเมื่อ spawn โดย wrapper ผ่าน childRun (BARRIER_CHILD=1) — ใน main suite
 * ไฟล์นี้ self-skip
 *
 * ลำดับการล้มของ aa (จงใจ · ตามแผน r15 §8b):
 *   beforeAll: openIsolatedWindow จริง (pause cron + stop mailer + gate closed) +
 *              markers 3 แถว
 *   afterAll:  fn ของ guardedAfterAll = จับ direct lease ของตัวเองแล้ว drain —
 *              lease ตัวเองทำให้ countsClean เป็น false เสมอ → drained:false ที่
 *              ~1.6s (ต่ำกว่า hookTimeout 5s = พิสูจน์ว่าเราล้มที่ barrier ของ
 *              เราเอง ไม่ใช่โดน runner ตัด) → fn โยน → harness poison ไฟล์ + โยนต่อ
 *              → releaseWindow "ไม่เคย" รัน (หน้าต่างค้างปิด) + cleanup TX ไม่รัน
 *              (markers ยังอยู่ ไม่มี cleanup-ran)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { guardedAfterAll, guardedBeforeAll, countMarkers, insertMarkers } from "../barrier-harness.js";
import { WindowError, acquireLease, drainWorkers, openIsolatedWindow } from "../../integration/window-coordinator.js";

export const AA_FILE = "8b-aa-poison-hook";
export const AA_HOLDER = "w8b-aa";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8b-aa poison ผ่าน hook-failure (child)", () => {
  let lifecycleId = "";

  beforeAll(async () => {
    lifecycleId = await guardedBeforeAll(AA_FILE, "8b-aa เปิดหน้าต่างจริง + markers", async () => {
      await openIsolatedWindow({
        holderId: AA_HOLDER,
        label: "8b-aa",
        drain: true,
        drainBoundMs: 8_000,
      });
      await insertMarkers(AA_FILE, "aa-setup", 3, "ก่อน drain ล้ม");
    });
  }, 60_000);

  afterAll(async () => {
    await guardedAfterAll(AA_FILE, "8b-aa afterAll: drain ล้มเพราะ lease ของตัวเอง → poison", {
      lifecycleId,
      fnBudgetMs: 8_000,
      fn: async () => {
        const lease = await acquireLease({ kind: "direct", owner: AA_HOLDER });
        const drained = await drainWorkers({ pollMs: 400, boundMs: 1_200 });
        if (!drained.drained) {
          throw new WindowError(
            `8b-drain-refused-own-lease — lastCounts=${JSON.stringify(drained.lastCounts)} lease=${lease.leaseId}`,
          );
        }
        // drain สะอาดโดยไม่มีเหตุ = สถานการณ์พัง (ไม่ควรเกิด — lease ตัวเองยังถืออยู่)
        throw new WindowError("8b-unexpected-drain-clean — scenario เสีย (own lease ต้องขวาง drain เสมอ)");
      },
    });
  }, 20_000);

  it("8b-aa body: markers อยู่ครบก่อน afterAll ล้ม", async () => {
    expect(await countMarkers(AA_FILE, "aa-setup")).toBeGreaterThanOrEqual(3);
  });
});

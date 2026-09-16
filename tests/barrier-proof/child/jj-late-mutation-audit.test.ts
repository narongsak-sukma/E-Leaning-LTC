/**
 * 8g (ลำคู่ jj) — trailer ที่นอนรอหลัง ii: ปล่อยเวลาให้ mutation ของ body ที่
 * ถูกทิ้ง (ii) มาถึงจริง (~12s) แล้วตรวจ: absence check ต้องจับแถวที่แทรก
 * หลัง cleanup-start ของ ii — จับได้ = "ล้มดัง" (suite ห้ามผ่านเงียบเมื่อโลก
 * ไม่สะอาด แม้ source ของ mutation คือ test runner เอง)
 */
import { describe, it } from "vitest";

import { markersCreatedSince } from "../barrier-harness.js";
import { currentRunId, ledgerRead } from "../../integration/test-io.js";

const II_FILE = "8g-ii-late-mutation";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8g-jj audit ท้ายรอบ (child)", () => {
  it(
    "8g-jj รอ mutation ตกถึงพื้นแล้ว absence-check ต้องจับ — จับได้คือล้มดัง",
    async () => {
      // ii เริ่ม ~5.5s (หลัง afterAll ของตัวเอง) · mutation มาถึง ~12.5s —
      // นอน 13s ให้พ้นเวลานั้นก่อนตรวจ
      await new Promise((resolve) => setTimeout(resolve, 13_000));

      const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
      const cleanup = notes.find(
        (n) => n.payload["event"] === "cleanup-start" && n.payload["file"] === II_FILE,
      );
      if (cleanup === undefined) {
        throw new Error("8g-jj: ไม่เห็น cleanup-start ของ ii — teardown ไม่เกิด?");
      }
      const mutation = notes.find(
        (n) => n.payload["event"] === "mutation-complete" && n.payload["file"] === II_FILE,
      );
      if (mutation === undefined) {
        throw new Error("8g-jj: ไม่เห็น mutation-complete — body ที่ถูกทิ้งตายก่อนแทรก (ตรวจ F56/singleFork)");
      }
      if (mutation.ts < cleanup.ts) {
        throw new Error(
          `8g-jj: ordering เพี้ยน — mutation (${mutation.ts}) ก่อน cleanup-start (${cleanup.ts})`,
        );
      }
      const leaked = await markersCreatedSince(II_FILE, cleanup.ts);
      if (leaked !== 1) {
        throw new Error(`8g-jj: absence check คาดจับ 1 แถว ได้ ${leaked} — เก็บกวาดหรือจับพลาด?`);
      }
      // จับได้ครบ = ล้มดังตามดีไซน์ (pass เงียบคือ bug ของ suite เอง)
      throw new Error(
        "8g-jj-violation-detected: mutation ของ body ที่ถูกทิ้งแทรกหลัง cleanup-start และถูก absence check จับ (คาดไว้ — นี่คือสัญญาณเตือนของ suite)",
      );
    },
    30_000,
  );
});

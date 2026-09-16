/**
 * 8g — wrapper: mutation จาก "ตัวเทสที่ถูกทิ้ง" (ไม่ใช่ hook) — runner ตัด test
 * ที่ testTimeout 5s กลาง pg_sleep แต่ promise วิ่งต่อ (F56) · teardown ของ ii
 * จบที่ ~5.5s (cleanup-start) · body ที่ถูกทิ้งแทรก marker + ledger ที่ ~12.5s
 * · jj (trailer) ตรวจด้วย absence check แล้ว "ล้มดัง" — suite ห้ามผ่านเงียบเมื่อ
 * มี mutation หลุดหลังหน้าต่าง teardown
 *
 * ต่างจาก 8e (hook ที่ถูกทิ้งแต่ "เซ็ตเทิลเอง" อย่างสวยงาม): 8g คือ side effect
 * ที่ไม่มีใครขอ — สิ่งเดียวที่ขวางมันไม่ได้คือเตือนให้ถัดไปเห็น
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  childRun,
  countMarkers,
  ensureBarrierInfra,
  fileState,
  markersCreatedSince,
  resetFileWorld,
} from "./barrier-harness.js";
import { currentRunId, ledgerRead } from "../integration/test-io.js";

const II = "8g-ii-late-mutation";
const PAIR = [
  "tests/barrier-proof/child/ii-late-mutation.test.ts",
  "tests/barrier-proof/child/jj-late-mutation-audit.test.ts",
];

describe("8g mutation จาก body ที่ถูกทิ้ง — absence check ต้องจับและล้มดัง", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [II] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [II] });
  }, 60_000);

  it(
    "8g-1 child (ii+jj) ล้ม RC≠0 และ failure ของ jj คือ 'violation-detected' จาก absence check",
    async () => {
      const result = await childRun(PAIR, { timeoutMs: 150_000 });
      expect(
        result.code,
        `stdout ท้าย:\n${result.stdout.slice(-1_500)}\nstderr:\n${result.stderr.slice(-800)}`,
      ).not.toBe(0);
      // ล้มสองชั้น: ii ถูกตัดที่ testTimeout · jj ล้มด้วยสัญญาณ violation-detected
      expect(result.stdout).toContain("8g-jj-violation-detected");
      expect(result.stdout).toContain("Timeout");
    },
    170_000,
  );

  it("8g-2 ordering จาก ledger: mutation-complete เกิดหลัง cleanup-start ของ ii", async () => {
    const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
    const cleanup = notes.find(
      (n) => n.payload["event"] === "cleanup-start" && n.payload["file"] === II,
    );
    const mutation = notes.find(
      (n) => n.payload["event"] === "mutation-complete" && n.payload["file"] === II,
    );
    expect(cleanup).toBeDefined();
    expect(mutation).toBeDefined();
    expect(mutation !== undefined && cleanup !== undefined && mutation.ts >= cleanup.ts).toBe(true);
  }, 30_000);

  it("8g-3 absence check จับแถวหลุด + teardown ของ ii จบสะอาดก่อนหน้านั้น", async () => {
    const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
    const cleanup = notes.find(
      (n) => n.payload["event"] === "cleanup-start" && n.payload["file"] === II,
    );
    expect(cleanup).toBeDefined();
    // แถวที่ body ที่ถูกทิ้งแทรก ยังอยู่ (สร้างหลัง cleanup-start) — โดนจับ
    expect(await markersCreatedSince(II, cleanup?.ts ?? "")).toBe(1);
    expect(await countMarkers(II, "ii-mutation")).toBe(1);
    // ตัว teardown เองจบเต็มสายก่อน mutation มาถึง — ความสกปรกไม่ใช่ของ teardown
    expect((await fileState(II))?.phase).toBe("teardown-settled");
    expect(await countMarkers(II, "cleanup-ran")).toBe(1);
  }, 30_000);
});

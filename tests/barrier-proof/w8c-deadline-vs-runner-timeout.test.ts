/**
 * 8c — wrapper: afterAll budget (ของเรา) ชนะ hookTimeout (ของ runner) — และ promise
 * ที่แพ้ race ยังวิ่งจนจบพร้อมร่องรอย (orphan-fn-settled-later + lease คืนจริง)
 *
 * child cc ถือ lease 9s ใน afterAll · budget 8s · hookTimeout 5s (ตัดก่อนทั้งคู่)
 * · dd เป็น time anchor ให้ process มีชีวิตพอให้เหตุการณ์ t≈8.7s/9.7s เกิดจริง
 *
 * ข้อพิสูจน์ (ทั้งหมดจาก DB หลัง child ตาย):
 *   1) child RC≠0 (hookTimeout ตัดจริง)
 *   2) cc poisoned ด้วย "afterAll-fn-budget-exceeded" — budget ของ harness เป็น
 *      ฝ่ายจัดการ ไม่ใช่ปล่อยให้ runner ตัดเฉยๆ (กลไกหยุดการลามของเรา)
 *   3) orphan-fn-settled-later (result fn-done) เกิดหลัง runner ทิ้งไปแล้ว —
 *      และ lease ถูกปล่อยจริง (worker_lease ว่างสำหรับเจ้าของนี้)
 *   4) cleanup ไม่รัน (ไม่มี cleanup-ran · markers เดิมยังอยู่) และ runner ไป
 *      ต่อได้ (dd anchor จบหลังเหตุการณ์ orphan)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { childRun, countMarkers, ensureBarrierInfra, fileState, resetFileWorld } from "./barrier-harness.js";
import { psqlScalar } from "../integration/helpers.js";
import { currentRunId, ledgerRead } from "../integration/test-io.js";

const CC = "8c-cc-budget-race";
const DD = "8c-dd-anchor";
const OWNER = "w8c-cc";

describe("8c budget 8s แข่ง hookTimeout 5s — orphan เซ็ตเทิลชัดเจนใน ledger", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [CC, DD], leaseOwners: [OWNER] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [CC, DD], leaseOwners: [OWNER] });
  }, 60_000);

  it(
    "8c-1 child (cc→dd) ล้ม RC≠0 — hookTimeout ตัดจริง",
    async () => {
      const result = await childRun(
        ["tests/barrier-proof/child/cc-budget-race.test.ts", "tests/barrier-proof/child/dd-time-anchor.test.ts"],
        { timeoutMs: 120_000 },
      );
      expect(
        result.code,
        `stdout ท้าย:\n${result.stdout.slice(-1_500)}\nstderr:\n${result.stderr.slice(-800)}`,
      ).not.toBe(0);
      expect(result.stdout).toContain("cc-budget-race");
    },
    150_000,
  );

  it("8c-2 cc poisoned โดย budget ของ harness (ไม่ใช่แค่โดน runner ตัด)", async () => {
    const st = await fileState(CC);
    expect(st).not.toBeNull();
    expect(st?.phase).toBe("poisoned");
    expect(st?.note ?? "").toContain("afterAll-fn-budget-exceeded");
  });

  it("8c-3 orphan fn เซ็ตเทิลทีหลังพร้อมร่องรอย + ปล่อย lease จริง", async () => {
    const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
    const orphan = notes.find(
      (n) => n.payload["event"] === "orphan-fn-settled-later" && n.payload["file"] === CC,
    );
    expect(orphan, "ต้องมี orphan-fn-settled-later ของ cc").toBeDefined();
    expect(orphan?.payload["result"]).toBe("fn-done");
    // lease คืนจริง — ไม่ทิ้งของค้างให้ battery ถัดไปติด
    const leases = await psqlScalar(
      `select count(*) from test_infra.worker_lease where owner = '${OWNER}';`,
    );
    expect(Number(leases)).toBe(0);
  });

  it("8c-4 cleanup ไม่รัน + runner ไปต่อจนจบ (dd anchor ปักหลังเหตุการณ์ orphan)", async () => {
    expect(await countMarkers(CC, "cleanup-ran")).toBe(0);
    expect(await countMarkers(CC, "cc-setup")).toBeGreaterThanOrEqual(2);
    expect(await countMarkers(DD, "anchor-done")).toBe(1);
  });
});

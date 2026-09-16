/**
 * 8e2 — wrapper: setup fn ไม่มีวันจบ → awaitFileSettled หมด budget → poison
 * (setup-settle-budget-exceeded) — cleanup ห้ามรันและไม่มี cleanup-start เกิด
 *
 * ต่างจาก 8e ตรงที่ไม่มีอะไรมาเซ็ตเทิลให้รอ — budget ของ harness ต้องเป็นเส้นตาย
 * ที่จัดการไฟล์ค้างเอง (ไม่รอ runner ไม่รอนาฬิกาอื่น)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { childRun, countMarkers, ensureBarrierInfra, fileState, resetFileWorld } from "./barrier-harness.js";
import { currentRunId, ledgerRead } from "../integration/test-io.js";

const HH = "8e2-hh-hang-setup";

describe("8e2 setup ค้างตลอดกาล → budget poison (cleanup ไม่รัน)", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [HH] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [HH] });
  }, 60_000);

  it(
    "8e2-1 child (hh) ล้ม RC≠0",
    async () => {
      const result = await childRun(["tests/barrier-proof/child/hh-hang-setup.test.ts"], {
        timeoutMs: 90_000,
      });
      expect(
        result.code,
        `stdout ท้าย:\n${result.stdout.slice(-1_500)}\nstderr:\n${result.stderr.slice(-800)}`,
      ).not.toBe(0);
    },
    120_000,
  );

  it("8e2-2 hh poisoned ด้วย setup-settle-budget-exceeded (ไม่ใช่ค้างเงียบ)", async () => {
    const st = await fileState(HH);
    expect(st).not.toBeNull();
    expect(st?.phase).toBe("poisoned");
    expect(st?.note ?? "").toContain("setup-settle-budget-exceeded");
  });

  it("8e2-3 cleanup ไม่รัน: ไม่มี cleanup-ran และไม่มี note cleanup-start", async () => {
    expect(await countMarkers(HH, "cleanup-ran")).toBe(0);
    const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
    const cleanup = notes.find(
      (n) => n.payload["event"] === "cleanup-start" && n.payload["file"] === HH,
    );
    expect(cleanup).toBeUndefined();
  });
});

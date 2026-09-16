/**
 * 8e — wrapper: setup ที่ถูก runner ทิ้ง (hookTimeout 5s) ยังวิ่งจนจบจริง (F56)
 * และ cleanup ของ afterAll "รอ" ให้ setup เซ็ตเทิลก่อนเริ่ม — พิสูจน์ด้วยลำดับ
 * เวลาใน ledger: ts(setup-complete) < ts(cleanup-start) เสมอ
 *
 * child gg: pg_sleep(12) กลาง setup → runner ตัดที่ 5s → แทรก marker ช้า +
 * setup-complete + setup-settled ที่ ~12.4s (โดย promise ที่ถูกทิ้ง) → afterAll
 * ที่รออยู่ปลดล็อก → cleanup TX ลบ marker ช้าด้วย (สร้างก่อน cleanup-start =
 * โดนลบถูกต้อง ไม่ใช่รอดออกมา)
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

const GG = "8e-gg-abandoned-setup";

describe("8e setup ที่ถูกทิ้งยังเซ็ตเทิลก่อน cleanup-start เสมอ", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [GG] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [GG] });
  }, 60_000);

  it(
    "8e-1 child (gg) ล้ม RC≠0 — beforeAll โดนตัดที่ 5s จริง",
    async () => {
      const result = await childRun(["tests/barrier-proof/child/gg-abandoned-setup.test.ts"], {
        timeoutMs: 120_000,
      });
      expect(
        result.code,
        `stdout ท้าย:\n${result.stdout.slice(-1_500)}\nstderr:\n${result.stderr.slice(-800)}`,
      ).not.toBe(0);
    },
    150_000,
  );

  it("8e-2 setup-complete เกิดก่อน cleanup-start (promise ที่ถูกทิ้งวิ่งจนจบ)", async () => {
    const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
    const complete = notes.find(
      (n) => n.payload["event"] === "setup-complete" && n.payload["file"] === GG,
    );
    const cleanup = notes.find(
      (n) => n.payload["event"] === "cleanup-start" && n.payload["file"] === GG,
    );
    expect(complete, "ต้องมี setup-complete ของ gg").toBeDefined();
    expect(cleanup, "ต้องมี cleanup-start ของ gg").toBeDefined();
    // ts เดียวกันจากนาฬิกา DB — เทียบข้อความตรงๆ (รูปแบบ/เขตเวลาเดียวกัน)
    expect(complete!.ts < cleanup!.ts, `setup-complete(${complete!.ts}) ต้องก่อน cleanup-start(${cleanup!.ts})`).toBe(true);
  });

  it("8e-3 teardown ครบหลังรอ: phase teardown-settled + marker ช้าถูกลบโดย cleanup", async () => {
    const st = await fileState(GG);
    expect(st?.phase).toBe("teardown-settled");
    // gg-late-marker สร้าง "ก่อน" cleanup — ต้องถูกลบ (ไม่รอด)
    expect(await countMarkers(GG, "gg-late-marker")).toBe(0);
    expect(await countMarkers(GG, "cleanup-ran")).toBe(1);
    // ไม่มีแถวใหม่หลุดข้าม cleanup (absence check ของแผน)
    const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
    const cleanup = notes.find(
      (n) => n.payload["event"] === "cleanup-start" && n.payload["file"] === GG,
    );
    expect(await markersCreatedSince(GG, cleanup!.ts)).toBe(0);
  });
});

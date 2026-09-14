/**
 * 8b — wrapper: poison หยุดการลามของ hook-failure (runner-abandonment suite ข้อแรก)
 *
 * spawn child vitest จริง (ไฟล์คู่ aa→bb ตาม sequencer) แล้วพิสูจน์จาก DB ทั้งหมด:
 *   1) child RC≠0 (aa afterAll ล้มที่ barrier ของตัวเอง ~1.6s — ต่ำกว่า hookTimeout 5s)
 *   2) aa poisoned (afterAll-fn-failed · หมายเหตุผูก 8b-drain-refused-own-lease)
 *      และ cleanup ไม่รัน (markers ยังอยู่ · cleanup-ran = 0)
 *   3) bb ถูกปฏิเสธก่อน setup (guard-event live-predecessor · แถว bb ไม่เกิด ·
 *      teardown-refused-no-setup · cleanup-ran = 0)
 *   4) หน้าต่าง aa ค้างปิดจริง — overlap probe ด้วย holder อื่นโดน borrow-refused
 *   5) wrapper force-release ผ่าน handle ที่ reconstruct จาก ledger (cross-process)
 *      — overlapRuns=0 (ไม่มี cron รน. ในช่วงปิด) + gate เปิดคืน
 *   6) เปิดหน้าต่างใหม่ได้หลังคืนโลก (วงจรครบ)
 *   7) manualClearFile ยก poison → attempt ใหม่ของ bb ผ่าน guard + teardown เต็ม
 *      สาย (cleanup-ran=1)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countMarkers,
  ensureBarrierInfra,
  childRun,
  fileBegin,
  fileSetupSettled,
  fileState,
  guardedAfterAll,
  manualClearFile,
  reconstructWindowHandle,
  resetFileWorld,
} from "./barrier-harness.js";
import { currentRunId, ledgerRead } from "../integration/test-io.js";
import {
  gateState,
  openIsolatedWindow,
  releaseWindow,
} from "../integration/window-coordinator.js";

const AA = "8b-aa-poison-hook";
const BB = "8b-bb-before-guard";
const HOLDER = "w8b-aa";

describe("8b poison หยุดการลามของ hook-failure (aa→bb + force-release)", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    // ล้างโลกจากรอบก่อน (ซ้ำ idempotent): คืนหน้าต่างค้าง → ลบ state/markers ของคู่ไฟล์นี้
    await resetFileWorld({ files: [AA, BB], holders: [HOLDER], leaseOwners: [HOLDER] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({
      files: [AA, BB],
      holders: [HOLDER, "w8b-probe2"],
      leaseOwners: [HOLDER],
    });
  }, 60_000);

  let childCode = 0;

  it(
    "8b-1 child run จริง (aa→bb) ต้องล้ม (RC≠0) — ความล้มไม่ถูกกลืน",
    async () => {
      const result = await childRun(
        ["tests/barrier-proof/child/aa-poison-hook.test.ts", "tests/barrier-proof/child/bb-before-guard.test.ts"],
        { timeoutMs: 150_000 },
      );
      childCode = result.code;
      expect(result.code, `stdout ท้าย:\n${result.stdout.slice(-1_500)}\nstderr:\n${result.stderr.slice(-800)}`).not.toBe(0);
      // ทั้งคู่ต้องถูกเก็บเข้ารอบ (ไม่ใช่ไฟล์หายจาก filter)
      expect(result.stdout).toContain("aa-poison-hook");
      expect(result.stdout).toContain("bb-before-guard");
    },
    170_000,
  );

  it("8b-2 aa poisoned ที่ barrier ของตัวเอง และ cleanup ไม่รัน", async () => {
    const st = await fileState(AA);
    expect(st, "แถว aa ต้องยังอยู่ (setup เคยผ่าน)").not.toBeNull();
    expect(st?.phase).toBe("poisoned");
    expect(st?.note ?? "").toContain("afterAll-fn-failed");
    expect(st?.note ?? "").toContain("8b-drain-refused-own-lease");
    // cleanup TX ไม่รัน: markers เดิมยังอยู่ + ไม่มี cleanup-ran
    expect(await countMarkers(AA, "aa-setup")).toBeGreaterThanOrEqual(3);
    expect(await countMarkers(AA, "cleanup-ran")).toBe(0);
  });

  it("8b-3 bb ถูกปฏิเสธก่อน setup และ cleanup ของ bb ไม่รัน", async () => {
    const events = await ledgerRead({ runId: currentRunId(), kinds: ["guard-event", "note"] });
    const refused = events.find(
      (e) => e.payload["event"] === "file-guard-refused-live-predecessor" && e.payload["file"] === BB,
    );
    expect(refused, "guard-event ต้องถูกเขียนก่อนโยน").toBeDefined();
    const preds = refused?.payload["predecessors"] as Array<{ file: string; phase: string }> | undefined;
    expect(preds?.some((p) => p.file === AA && p.phase === "poisoned")).toBe(true);
    // แถว bb ไม่เกิด (guard ปฏิเสธก่อน registration)
    expect(await fileState(BB)).toBeNull();
    // afterAll ของ bb fast-refuse + ไม่มี cleanup-ran
    const noSetup = events.find(
      (e) => e.payload["event"] === "teardown-refused-no-setup" && e.payload["file"] === BB,
    );
    expect(noSetup, "bb afterAll ต้อง fast-refuse").toBeDefined();
    expect(await countMarkers(BB, "cleanup-ran")).toBe(0);
  });

  it("8b-4 หน้าต่าง aa ค้างปิดจริง — gate closed + holder คงอยู่ + borrow ซ้อนถูกปฏิเสธ", async () => {
    const gate = await gateState();
    expect(gate.isOpen).toBe(false);
    expect(gate.holders).toContain(HOLDER);
    // overlap probe ปลอดภัย: borrow ล้ม "ก่อน" side effect ใดๆ
    await expect(
      openIsolatedWindow({ holderId: "w8b-probe", label: "8b-overlap-probe", drain: false }),
    ).rejects.toThrow(/window-borrow-overlap/);
    // gate ยังปิดเหมือนเดิม (probe ไม่ทิ้ง side effect)
    const after = await gateState();
    expect(after.isOpen).toBe(false);
    expect(after.holders).toContain(HOLDER);
  });

  it(
    "8b-5 force-release ข้าม process ผ่าน handle ที่ reconstruct จาก ledger — ไม่มี cron รั่วในช่วงปิด",
    async () => {
      const handle = await reconstructWindowHandle(HOLDER);
      expect(handle, "ledger ต้องมี window closed event ของ holder นี้").not.toBeNull();
      const res = await releaseWindow(handle!);
      // หลักฐาน barrier จริง: ไม่มี cron run ใดเริ่มระหว่างหน้าต่างปิด
      expect(res.overlapRuns).toBe(0);
      expect(res.mailerRestored).toBe(true);
      const gate = await gateState();
      expect(gate.isOpen).toBe(true);
      expect(gate.holders).not.toContain(HOLDER);
    },
    60_000,
  );

  it(
    "8b-6 หลังคืนโลก เปิดหน้าต่างใหม่ได้และปล่อยได้ตามปกติ (วงจรครบ)",
    async () => {
      const handle = await openIsolatedWindow({ holderId: "w8b-probe2", label: "8b-reopen-probe", drain: false });
      const res = await releaseWindow(handle);
      expect(res.overlapRuns).toBe(0);
      const gate = await gateState();
      expect(gate.isOpen).toBe(true);
      expect(gate.holders).toHaveLength(0);
    },
    60_000,
  );

  it("8b-7 manualClearFile ยก poison → attempt ใหม่ของ bb ผ่าน guard + teardown เต็มสาย", async () => {
    await manualClearFile(AA, "8b wrapper: พิสูจน์ครบแล้ว เคลียร์ poison ด้วยมือ");
    // cleared-manual ไม่อยู่ในเซต live อีก → bb ตั้งต้นใหม่ได้
    const id = await fileBegin(BB, "8b wrapper probe: attempt ใหม่หลังเคลียร์");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await fileSetupSettled(BB, id);
    const { cleanupStart } = await guardedAfterAll(BB, "8b wrapper probe teardown", { lifecycleId: id });
    expect(cleanupStart).not.toBeNull();
    expect(await countMarkers(BB, "cleanup-ran")).toBe(1);
    // childCode ยังต้อง != 0 (ความล้มเดิมไม่หายไปเพราะเราเคลียร์โลกทีหลัง)
    expect(childCode).not.toBe(0);
  });
});

/**
 * 8e3 — cleanup TX คือ sync point ของโลกจริง (SRE lock ปิดช่อง insert ขนาน)
 *
 * (ก) การต่อคิวของ PostgreSQL คือพฤติกรรมที่ต้องพิสูจน์ ไม่ใช่สมมติ:
 *     S1 เปิด TX ค้าง (insert แถวหนึ่งใน TX — ถือ ROW EXCLUSIVE บน
 *     barrier_markers) → cleanup TX ของ guardedAfterAll มาขอ SRE → ติดคิวหลัง S1
 *     → S2 (session ใหม่) ยิง insert 'during-cleanup' → ติดคิวตามหลัง request
 *     ของ cleanup (lock-queue fairness) → S1 commit → SRE ของ cleanup ได้ก่อน →
 *     cleanup-start + DELETE + cleanup-ran ใน TX เดียว → คิวของ S2 ปล่อยตาม →
 *     แถว during-cleanup ลงด้วย created_at >= cleanup-start
 *     → absence check (markersCreatedSince) ต้องจับได้ = 1 — "จับได้" คือผ่าน:
 *     scenario พิสูจน์ว่าแถวที่แทรกหลังจุดตัดสินจริงๆ ถูกตรวจพบ ไม่ใช่หายเงียบ
 *
 * (ข) violationProbe — ทางออกที่ harness อนุญาตให้ "ยิงแถวหลุด guard ทุกชั้น"
 *     (ข้าม phase/generation/attemptBegin ทั้งหมด): แถวยังต้องโดน absence check
 *     จับ — เส้นตายสุดท้ายของ defense-in-depth · probe จำกัดเฉพาะ caller ใต้
 *     tests/barrier-proof/ และต้อง retract() เพื่อลบ + เขียน ledger outcome
 */
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  awaitStuckWaiter,
  countMarkers,
  ensureBarrierInfra,
  fileBegin,
  fileSetupSettled,
  guardedAfterAll,
  insertMarkers,
  markersCreatedSince,
  resetFileWorld,
  violationProbe,
} from "./barrier-harness.js";
import { currentRunId, ledgerRead, ledgerWrite, startPsqlSession } from "../integration/test-io.js";
import { psql } from "../integration/helpers.js";

const F = "8e3-sync-point";
const F2 = "8e3-probe";

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

describe("8e3 cleanup TX = sync point (SRE + absence check)", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [F, F2] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [F, F2] });
  }, 60_000);

  it(
    "8e3-ก insert ระหว่าง cleanup ติดคิวหลัง SRE → ลงด้วย created_at ≥ cleanup-start → absence check จับได้",
    async () => {
      const run = currentRunId();
      const lifecycleId = await fileBegin(F, "8e3-ก setup");
      await insertMarkers(F, "pre", 2, "ก่อน cleanup");
      await fileSetupSettled(F, lifecycleId);

      const s1 = await startPsqlSession("8e3-S1-blocking-tx");
      let release: Promise<{ cleanupStart: string | null }> | undefined;
      try {
        // S1 เปิด TX + insert ใน TX — ROW EXCLUSIVE ค้างจนกว่าจะ commit
        await s1.exec("begin;");
        await s1.exec(
          `insert into test_infra.barrier_markers (run_id, file, kind, note)
           values (${lit(run)}, ${lit(F)}, 's1-blocking', 'tx เปิดค้างของ S1');`,
        );

        // release เริ่มวิ่ง: phase TX ผ่าน (แถว window_file_state ไม่มีใครล็อก) →
        // cleanup TX ติด SRE หลัง ROW EXCLUSIVE ของ S1
        release = guardedAfterAll(F, "8e3-ก release — cleanup ต้องติดคิวหลัง S1", {
          lifecycleId,
        });
        const stuck = await awaitStuckWaiter(
          {
            relation: "test_infra.barrier_markers",
            mode: "ShareRowExclusiveLock",
            blockerPids: [s1.identity.pid],
          },
          "8e3-ก cleanup TX (SRE) ติดหลัง S1",
        );

        // S2 ยิง insert ตอน cleanup กำลังติดคิว — ROW EXCLUSIVE ไม่ขัดกับ ROW
        // EXCLUSIVE ของ S1: สิ่งที่ขวาง S2 จริงคือ "request SRE ที่รออยู่ของ
        // cleanup" (lock-queue fairness — คิวไม่แซง) → blocker คือ pid ของ cleanup
        const s2Insert = psql(
          `insert into test_infra.barrier_markers (run_id, file, kind, note)
           values (${lit(run)}, ${lit(F)}, 'during-cleanup', 'แทรกระหว่าง cleanup กำลังถือ SRE');`,
          { quiet: true },
        );
        await awaitStuckWaiter(
          {
            relation: "test_infra.barrier_markers",
            mode: "RowExclusiveLock",
            blockerPids: [stuck.pid],
          },
          "8e3-ก insert ของ S2 ติดคิวตาม request SRE ของ cleanup",
        );

        // ปล่อย S1 → คิวไหลตามลำดับ: cleanup ก่อน → S2 ทีหลัง
        await s1.exec("commit;");
        const { cleanupStart } = await release;
        expect(cleanupStart).not.toBeNull();
        const cs = cleanupStart ?? ""; // ผ่าน expect ข้างบนแล้ว — ค่าจริงไม่ null
        await s2Insert;

        // ── หลักฐาน: แถวของ S2 ลงจริง และถูก absence check จับ ──
        const leaked = await markersCreatedSince(F, cs);
        expect(leaked).toBe(1);
        await ledgerWrite("note", {
          event: "absence-check-detected",
          file: F,
          count: leaked,
          cleanupStart,
          scenario: "8e3-ก insert-during-cleanup",
        });
        // โลกหลังจบ: cleanup-ran 1 + แถวที่รอด (ของ S2) + ของเดิมถูกลบหมด
        expect(await countMarkers(F)).toBe(2);
        expect(await countMarkers(F, "cleanup-ran")).toBe(1);
        expect(await countMarkers(F, "pre")).toBe(0);
        expect(await countMarkers(F, "s1-blocking")).toBe(0);
        const survivor = await psql(
          `select kind from test_infra.barrier_markers
           where run_id = ${lit(run)} and file = ${lit(F)} and kind <> 'cleanup-ran';`,
        );
        expect(survivor.trim()).toBe("during-cleanup");
        // stuck cleanup มี wait event จริง (lock) — ไม่ใช่ค้างเงียบปริศนา
        expect(stuck.waitEvent).toBe("relation");
      } finally {
        await s1.end().catch(() => undefined);
        // release ที่ยังค้าง (กรณี assert พังก่อน commit) — ปล่อยให้มันไหลจบก่อน
        // เข้าสู่ test ถัดไป ไม่งั้น fileBegin ของ 8e3-ข โดน live teardown-running
        if (release !== undefined) {
          await Promise.race([release.catch(() => undefined), sleep(5_000)]);
        }
        // เศษของ S2 (กรณี assert พังก่อน commit) — ลบให้โลกสะอาดสำหรับรอบถัดไป
        await psql(
          `delete from test_infra.barrier_markers where run_id = ${lit(run)} and file = ${lit(F)} and kind = 'during-cleanup';`,
          { quiet: true },
        ).catch(() => undefined);
      }
    },
    60_000,
  );

  it("8e3-ข violationProbe หลุด guard ทุกชั้น → absence check ยังจับได้ + retract เขียน outcome", async () => {
    const lifecycleId = await fileBegin(F2, "8e3-ข setup");
    await insertMarkers(F2, "pre2", 1);
    await fileSetupSettled(F2, lifecycleId);
    const { cleanupStart } = await guardedAfterAll(F2, "8e3-ข release ปกติ", { lifecycleId });
    expect(cleanupStart).not.toBeNull();
    // โลกสะอาดก่อน probe
    expect(await markersCreatedSince(F2, cleanupStart ?? "")).toBe(0);

    // caller นอก tests/barrier-proof/ = ปฏิเสธ (ทางออกถูกจำกัด)
    await expect(
      violationProbe(F2, "nope", "src/app/page.tsx"),
    ).rejects.toThrow(/ปฏิเสธ/);

    // probe ยิงแถวหลุด guard ทุกชั้น — absence check ยังต้องจับ
    const probe = await violationProbe(F2, "probe-violation", "tests/barrier-proof/w8e3-cleanup-sync-point.test.ts");
    expect(await markersCreatedSince(F2, cleanupStart ?? "")).toBe(1);
    expect(await countMarkers(F2, "probe-violation")).toBe(1);

    // retract: ลบ + audit trail
    await probe.retract();
    expect(await markersCreatedSince(F2, cleanupStart ?? "")).toBe(0);
    const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
    const executed = notes.find(
      (n) => n.payload["event"] === "violation-probe-executed" && n.payload["file"] === F2,
    );
    expect(executed).toBeDefined();
    expect(executed?.payload["outcome"]).toBe("executed");
  }, 30_000);
});

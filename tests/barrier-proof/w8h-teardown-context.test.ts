/**
 * 8h — cleanup context = token ของไฟล์จริง (ALS) ไม่ใช่การเดาจาก phase (r17-M2
 * + r20-M2) — mutation หลุดหลังหน้าต่างต้องถูกปฏิเสธที่ primitive · mutation
 * ใน context ที่ถูกต้องรันผ่านเป็นงานของ teardown · งานลูก (descendants) ต้อง
 * จบก่อน teardown-settled · ลูกที่ตื่นหลัง token ตาย = no-fallback ปฏิเสธ
 *
 * h1  body ที่ถูก runner ทิ้ง (testTimeout 5s) ตื่น "หลัง release จบ" →
 *     guardedMarkerInsert โยนก่อนแตะ marker + ledger 'mutation-rejected' +
 *     absence 0 (ต่างจาก 8g ที่ insertMarkers ดิบหลุดจนต้องจับด้วย absence —
 *     h1 คือชั้นที่กันไว้ก่อนถึงระดับนั้น)
 * h3  mutation ใน context teardown ที่ถูกต้อง (fn ของ guardedAfterAll รันใต้
 *     ALS ผูกไฟล์) รันผ่าน + ledger ordering: เขียนจบก่อน cleanup-start เสมอ
 * h3b negative: phase teardown-running แต่ "ไร้ context" = ปฏิเสธ (บิด phase
 *     ด้วยมือเพื่อสร้างสถานะ — ในโลกจริง guardedAfterAll เท่านั้นที่ตั้ง phase นี้)
 * h4  window ปิด + teardown token (transportAdmit) → sqlWrite ปฏิเสธ
 *     'teardown-after-close' ที่ระดับ transport — token ไม่ใช่ใบเบิกเขียน
 *     ข้ามหน้าต่างที่ปิดแล้ว
 * h5  descendants: fn ปล่อยงานลูกผ่าน spawnCleanupChild → teardown-settled
 *     เกิดหลังลูกจบจริง (ledger ordering) · variant ลูกค้างเกิน budget →
 *     poison ไม่ปิดไฟล์อัตโนมัติ · ลูกตื่นหลัง poison เขียน = no-fallback ปฏิเสธ
 */
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CleanupChildHandle,
  childRun,
  countMarkers,
  ensureBarrierInfra,
  fileBegin,
  fileSetupSettled,
  fileState,
  guardedAfterAll,
  guardedMarkerInsert,
  manualClearFile,
  markersCreatedSince,
  resetFileWorld,
  spawnCleanupChild,
} from "./barrier-harness.js";
import {
  currentRunId,
  ledgerRead,
  sqlWrite,
  windowSet,
  withTeardownToken,
} from "../integration/test-io.js";
import { psql } from "../integration/helpers.js";

const KK = "8h-kk-abandoned-write";
const PAIR = [
  "tests/barrier-proof/child/kk-abandoned-write.test.ts",
  "tests/barrier-proof/child/ll-hold-open.test.ts",
];
const H3 = "8h-h3-ctx";
const H3B = "8h-h3b-no-ctx";
const H5 = "8h-h5-descendants";
const H5B = "8h-h5b-overstay";
const CALLER = "tests/barrier-proof/w8h-teardown-context.test.ts";

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function findNote(event: string, file: string) {
  const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
  return notes.find((n) => n.payload["event"] === event && n.payload["file"] === file);
}

describe("8h cleanup context (token ผูกไฟล์) + descendants", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [KK, H3, H3B, H5, H5B] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [KK, H3, H3B, H5, H5B] });
  }, 60_000);

  it(
    "h1 body ที่ถูกทิ้งตื่นหลัง release — guardedMarkerInsert โยนก่อนแตะ + absence 0",
    async () => {
      const result = await childRun(PAIR, { timeoutMs: 120_000 });
      expect(
        result.code,
        `stdout ท้าย:\n${result.stdout.slice(-1_500)}\nstderr:\n${result.stderr.slice(-800)}`,
      ).not.toBe(0);

      const rejected = await findNote("mutation-rejected", KK);
      expect(rejected, "ต้องมี event mutation-rejected ของ kk").toBeDefined();
      expect(rejected?.payload["reason"]).toBe("phase-teardown-settled");
      const captured = await findNote("late-write-refused-captured", KK);
      expect(captured).toBeDefined();
      expect(captured?.payload["refused"]).toBe(true);

      // ordering: ตื่นมา "หลัง" release จบ (cleanup-start ก่อนการปฏิเสธ)
      const cleanup = await findNote("cleanup-start", KK);
      expect(cleanup).toBeDefined();
      if (captured !== undefined && cleanup !== undefined) {
        expect(captured.ts >= cleanup.ts).toBe(true);
      }
      // ไม่มี marker หลุดเลย — ปฏิเสธที่ primitive ก่อนถึงระดับ absence check
      expect(await countMarkers(KK, "kk-late")).toBe(0);
      expect(await markersCreatedSince(KK, cleanup?.ts ?? "")).toBe(0);
    },
    140_000,
  );

  it("h3 mutation ใน context teardown ที่ถูกต้องรันผ่าน — และจบก่อน cleanup-start เสมอ", async () => {
    const lifecycleId = await fileBegin(H3, "8h-h3 setup");
    await fileSetupSettled(H3, lifecycleId);
    const { cleanupStart } = await guardedAfterAll(H3, "8h-h3 release — fn เขียนใน context ของตัวเอง", {
      lifecycleId,
      fnBudgetMs: 20_000,
      fn: async () => {
        // อนุญาต: อยู่ใต้ teardown context ของ H3 จริง (ALS จาก guardedAfterAll)
        await guardedMarkerInsert(H3, "h3-cleanup-marker", "งานของ teardown นี้");
        await (await import("../integration/test-io.js")).ledgerWrite("note", {
          event: "h3-cleanup-mutation-done",
          file: H3,
        });
      },
    });
    expect(cleanupStart).not.toBeNull();
    // marker โดน cleanup TX ลบตามดีไซน์ (งานของ teardown จบก่อน cleanup) —
    // หลักฐานคงทนคือ note + ordering: mutation-done "ก่อน" cleanup-start
    const done = await findNote("h3-cleanup-mutation-done", H3);
    expect(done).toBeDefined();
    expect(done !== undefined && done.ts < (cleanupStart ?? "")).toBe(true);
    expect((await fileState(H3))?.phase).toBe("teardown-settled");
    expect(await markersCreatedSince(H3, cleanupStart ?? "")).toBe(0);
  }, 30_000);

  it("h3b phase teardown-running แต่ไร้ context = ปฏิเสธ (context ตัดสิน ไม่ใช่ phase เพียงลำพัง)", async () => {
    const lifecycleId = await fileBegin(H3B, "8h-h3b setup");
    await fileSetupSettled(H3B, lifecycleId);
    // สร้างสถานะ "teardown-running ไร้ context" ด้วยมือ (ในโลกจริง phase นี้
    // ตั้งโดย phase TX ของ guardedAfterAll เท่านั้น — ตรงนี้คือ negative construction)
    await psql(
      `update test_infra.window_file_state set phase = 'teardown-running', updated_at = now()
       where run_id = ${lit(currentRunId())} and file = ${lit(H3B)};`,
      { quiet: true },
    );
    let refused: unknown = null;
    try {
      await guardedMarkerInsert(H3B, "h3b-no-ctx", "เขียนนอก context ตอน phase teardown-running");
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeDefined();
    expect(String(refused)).toContain("mutation-rejected(phase-teardown-running)");
    const rejected = await findNote("mutation-rejected", H3B);
    expect(rejected?.payload["reason"]).toBe("phase-teardown-running");
    expect(rejected?.payload["inTeardownCtx"]).toBe(false);
    expect(await countMarkers(H3B, "h3b-no-ctx")).toBe(0);
    // ปิดสถานะที่สร้างมือเอง — ไม่งั้น live-predecessor guard ขวางไฟล์ถัดไป
    // (serial invariant ข้ามไฟล์ทำงานถูกต้องอยู่ — หน้าที่เราคือเก็บของเราเอง)
    await manualClearFile(H3B, "8h-h3b ปิดสถานะที่สร้างมือหลังพิสูจน์");
  }, 20_000);

  it("h4 window ปิด + teardown token → sqlWrite ปฏิเสธ teardown-after-close (token ไม่ใช่ใบเบิกเขียนข้ามหน้าต่าง)", async () => {
    await windowSet("closed", "8h-h4 ปิดเพื่อพิสูจน์");
    let err4: unknown = null;
    try {
      try {
        await withTeardownToken(() =>
          sqlWrite("select 1;", { opKey: "barrier:8h-h4-probe", label: "8h-h4" }),
        );
      } catch (err) {
        err4 = err;
      }
    } finally {
      // เปิดคืนเสมอ (singleFork แชร์ process — window ค้างปิด = ไฟล์ถัดไปตายทั้งกระบวน)
      await windowSet("open", "8h-h4 เปิดคืนเสมอ (finally)");
    }
    expect(err4).toBeDefined();
    expect(String(err4)).toContain("sqlWrite refused: teardown-after-close");
  }, 20_000);

  it("h5 descendants — teardown-settled เกิดหลังลูกจบจริง (ledger ordering)", async () => {
    const lifecycleId = await fileBegin(H5, "8h-h5 setup");
    await fileSetupSettled(H5, lifecycleId);
    const { cleanupStart } = await guardedAfterAll(H5, "8h-h5 release พร้อมงานลูก", {
      lifecycleId,
      fnBudgetMs: 20_000,
      descendantBudgetMs: 15_000,
      fn: async () => {
        await spawnCleanupChild(
          H5,
          "h5-luk",
          async () => {
            await sleep(2_500);
            await (await import("../integration/test-io.js")).ledgerWrite("note", {
              event: "h5-child-done",
              file: H5,
            });
          },
          CALLER,
        );
      },
    });
    expect(cleanupStart).not.toBeNull();
    const childDone = await findNote("h5-child-done", H5);
    expect(childDone, "งานลูกต้องจบจริง").toBeDefined();
    const settled = await fileState(H5);
    expect(settled?.phase).toBe("teardown-settled");
    // ledger ordering: ลูกจบ (note ts) "ก่อน" teardown-settled (updated_at)
    expect(childDone !== undefined && settled !== null && childDone.ts <= settled.updatedAt).toBe(true);
    // งานลูกยังเห็นใน descendant table: completed (audit trail)
    const rows = await psql(
      `select status from test_infra.cleanup_descendants
       where run_id = ${lit(currentRunId())} and file = ${lit(H5)} order by created_at;`,
    );
    expect(rows.trim()).toBe("completed");
  }, 30_000);

  it("h5b ลูกค้างเกิน budget → poison ไม่ปิดไฟล์อัตโนมัติ · ลูกตื่นหลัง poison = no-fallback ปฏิเสธ · re-attempt ต้อง manualClear", async () => {
    const lifecycleId = await fileBegin(H5B, "8h-h5b setup");
    await fileSetupSettled(H5B, lifecycleId);
    let child: CleanupChildHandle | undefined;
    let err: unknown = null;
    try {
      await guardedAfterAll(H5B, "8h-h5b release — ลูกค้างเกิน budget", {
        lifecycleId,
        fnBudgetMs: 20_000,
        descendantBudgetMs: 2_000,
        fn: async () => {
          child = await spawnCleanupChild(
            H5B,
            "h5b-luk-overstay",
            async () => {
              await sleep(8_000);
              // ตื่นหลัง poison — no-fallback: ห้ามตกกลับไปใช้สิทธิ์ caller ปกติ
              let lateRefused: unknown = null;
              try {
                await guardedMarkerInsert(H5B, "h5b-late", "ลูกตื่นหลัง token ตาย");
              } catch (e) {
                lateRefused = e;
              }
              await (await import("../integration/test-io.js")).ledgerWrite("note", {
                event: "h5b-late-write-outcome",
                file: H5B,
                refused: lateRefused !== null,
                error: String(lateRefused).slice(0, 200),
              });
            },
            CALLER,
          );
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toContain("descendants");

    const st = await fileState(H5B);
    expect(st?.phase).toBe("poisoned");
    expect(st?.note ?? "").toContain("descendants-overstayed-budget");
    // cleanup TX รันไปก่อนหน้า budget ของ descendants (sync point ยังเกิด)
    expect(await countMarkers(H5B, "cleanup-ran")).toBe(1);

    // รอลูกตื่นและปฏิเสธ (~8s)
    if (child !== undefined) {
      expect(await child.done).toBe("completed");
    }
    const outcome = await findNote("h5b-late-write-outcome", H5B);
    expect(outcome, "ลูกต้องตื่นและรายงานผล").toBeDefined();
    expect(outcome?.payload["refused"]).toBe(true);
    const rejected = await findNote("mutation-rejected", H5B);
    expect(rejected?.payload["reason"]).toBe("phase-poisoned");
    expect(await countMarkers(H5B, "h5b-late")).toBe(0);

    // ไฟล์พิษ: ห้ามเปิดใหม่จนกว่าจะเคลียร์มือ
    let reopen: unknown = null;
    try {
      await fileBegin(H5B, "8h-h5b re-attempt หลัง poison");
    } catch (e) {
      reopen = e;
    }
    expect(reopen).toBeDefined();
    await manualClearFile(H5B, "8h-h5b ปิดสถานะหลังพิสูจน์ no-fallback");
  }, 40_000);
});

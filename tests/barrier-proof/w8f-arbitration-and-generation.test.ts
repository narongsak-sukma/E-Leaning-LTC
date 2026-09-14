/**
 * 8f — arbitration + generation: ใครได้ตัดสิน ตัดสินเมื่อไหร่ และ release เก่า
 * ห้ามแตะของใหม่ — ทั้งหมดพิสูจน์ที่ "โลกจริง" (row lock / lock queue / ledger)
 * ระดับ wrapper ไม่ต้อง spawn child
 *
 * f1  phase TX แข่งบน row lock เดียวกับ registration — outsider ถือ FOR UPDATE
 *     อยู่ = release บล็อกที่ phase TX (ค้างแบบมี wait event จริง) · ปล่อยแล้ว
 *     ตัดสินคนเดียว · release ซ้ำ (same lifecycle) = stale-lifecycle-release
 *     (ห้ามรัน cleanup สองครั้ง)
 * f2  ordering: phase 'teardown-running' ต้อง commit ก่อน cleanup TX ขอ SRE —
 *     ขณะ cleanup ติดคิว คนนอกต้องเห็น phase แล้ว แต่ยังไม่มี cleanup-start
 *     (พิสูจน์ลำดับ 2 TX ไม่กลับหัว — ไม่มี path ที่ cleanup วิ่งก่อน arbitration)
 * f3  double release ตรงๆ (multi-describe ใน child ก็คือรูปนี้)
 * f4a fn ค้างเกิน budget → poison → fileBegin re-attempt ถูกปฏิเสธ (ห้ามเปิด
 *     หน้าต่างใหม่เงียบๆ หลัง poison — ต้อง manualClearFile)
 * f4b generation: windowSet ทุกครั้ง bump gen — caller ที่จด gen เก่าไว้ถูก
 *     ปฏิเสธด้วย 'stale-generation' "แม้ phase เปิดอยู่" (กันการกลับมาเขียน
 *     ข้ามหน้าต่าง) · token + closed = teardown-after-close · ไร้ token + closed
 *     = window-closed
 * f4c lifecycle ต่อหน้าต่าง: release ของ lifecycle เก่าต้องไม่แตะหน้าต่างใหม่
 */
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FileGuardError,
  awaitStuckWaiter,
  countMarkers,
  ensureBarrierInfra,
  fileBegin,
  fileSetupSettled,
  fileState,
  guardedAfterAll,
  insertMarkers,
  manualClearFile,
  markersCreatedSince,
  resetFileWorld,
} from "./barrier-harness.js";
import {
  currentRunId,
  ledgerRead,
  startPsqlSession,
  transportAdmit,
  windowGet,
  windowSet,
  withTeardownToken,
} from "../integration/test-io.js";
import { psql } from "../integration/helpers.js";

const F1 = "8f1-arbitration";
const F2 = "8f2-ordering";
const F3 = "8f3-double-release";
const F4 = "8f4a-hang-budget";
const F5 = "8f4c-lifecycle";

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** รอ waiter ที่ค้างบน row lock (transactionid) ที่ holder ถืออยู่ — f1 ใช้
 *  (คนละรูปกับ awaitStuckWaiter ซึ่งดู relation lock) */
async function awaitRowLockWaiter(holderPid: number, deadlineMs = 10_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const raw = await psql(`
      select l.pid::text from pg_locks l
      where l.locktype = 'transactionid' and not l.granted
        and pg_blocking_pids(l.pid) && '{${holderPid}}'::int[];`);
    const pid = Number(raw.trim());
    if (Number.isFinite(pid) && pid > 0) return pid;
    if (Date.now() > deadline) {
      throw new Error(`awaitRowLockWaiter: ไม่เห็น waiter ของ holder ${holderPid} ภายใน ${deadlineMs}ms`);
    }
    await sleep(150);
  }
}

async function expectStaleRelease(file: string, label: string, lifecycleId: string): Promise<void> {
  let err: unknown;
  try {
    await guardedAfterAll(file, label, { lifecycleId });
  } catch (e) {
    err = e;
  }
  expect(err, `release ของ ${label} ต้องถูกปฏิเสธ`).toBeInstanceOf(FileGuardError);
  expect((err as FileGuardError).reason).toBe("stale-lifecycle-release");
  const notes = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
  expect(
    notes.some((n) => n.payload["event"] === "stale-lifecycle-release" && n.payload["file"] === file),
  ).toBe(true);
}

describe("8f arbitration + generation (row lock / lock queue / ledger)", () => {
  beforeAll(async () => {
    await ensureBarrierInfra();
    await resetFileWorld({ files: [F1, F2, F3, F4, F5] });
  }, 60_000);

  afterAll(async () => {
    await resetFileWorld({ files: [F1, F2, F3, F4, F5] });
  }, 60_000);

  it(
    "f1 phase TX ติด row lock ของ outsider → ปล่อยแล้วตัดสินครั้งเดียว · release ซ้ำ = stale",
    async () => {
      const run = currentRunId();
      const id = await fileBegin(F1, "8f1 setup");
      await insertMarkers(F1, "f1-pre", 1);
      await fileSetupSettled(F1, id);

      const s = await startPsqlSession("8f1-row-holder");
      try {
        await s.exec("begin;");
        await s.exec(
          `select 1 from test_infra.window_file_state where run_id = ${lit(run)} and file = ${lit(F1)} for update;`,
        );

        const release = guardedAfterAll(F1, "8f1 release — phase TX ต้องติด row lock ของ S", {
          lifecycleId: id,
        });
        const waiterPid = await awaitRowLockWaiter(s.identity.pid);
        expect(waiterPid).toBeGreaterThan(0);
        // ยังบล็อกอยู่จริง: phase ยังไม่ขยับ
        expect((await fileState(F1))?.phase).toBe("setup-settled");

        await s.exec("commit;");
        const { cleanupStart } = await release;
        expect(cleanupStart).not.toBeNull();
        expect((await fileState(F1))?.phase).toBe("teardown-settled");
        expect(await countMarkers(F1, "cleanup-ran")).toBe(1);
        expect(await markersCreatedSince(F1, cleanupStart ?? "")).toBe(0);

        // release ซ้ำ same lifecycle: phase ไม่ใช่ setup-settled แล้ว → stale
        await expectStaleRelease(F1, "8f1 release ซ้ำ (หลังเสร็จ)", id);
        expect((await fileState(F1))?.phase).toBe("teardown-settled");
        expect(await countMarkers(F1, "cleanup-ran")).toBe(1); // ไม่รันซ้ำ
      } finally {
        await s.end().catch(() => undefined);
      }
    },
    60_000,
  );

  it(
    "f2 phase 'teardown-running' commit ก่อน cleanup SRE — ขณะ cleanup ติดคิว เห็น phase แต่ไม่มี cleanup-start",
    async () => {
      const run = currentRunId();
      const id = await fileBegin(F2, "8f2 setup");
      await insertMarkers(F2, "f2-pre", 1);
      await fileSetupSettled(F2, id);

      const s = await startPsqlSession("8f2-marker-tx-holder");
      try {
        await s.exec("begin;");
        await s.exec(
          `insert into test_infra.barrier_markers (run_id, file, kind, note)
           values (${lit(run)}, ${lit(F2)}, 'f2-blocking', 'tx เปิดค้างของ f2');`,
        );

        const release = guardedAfterAll(F2, "8f2 release — cleanup ต้องติด SRE หลัง S", {
          lifecycleId: id,
        });
        await awaitStuckWaiter(
          {
            relation: "test_infra.barrier_markers",
            mode: "ShareRowExclusiveLock",
            blockerPids: [s.identity.pid],
          },
          "8f2 cleanup TX ติด SRE",
        );

        // ── ordering proof ณ จุดที่ cleanup กำลังติดคิว ──
        expect((await fileState(F2))?.phase).toBe("teardown-running"); // phase ไปแล้ว
        const notesMid = await ledgerRead({ runId: currentRunId(), kinds: ["note"] });
        expect(
          notesMid.find((n) => n.payload["event"] === "cleanup-start" && n.payload["file"] === F2),
          "cleanup-start ห้ามมีก่อน SRE ได้ lock",
        ).toBeUndefined();

        await s.exec("commit;");
        const { cleanupStart } = await release;
        expect(cleanupStart).not.toBeNull();
        expect((await fileState(F2))?.phase).toBe("teardown-settled");
        expect(await countMarkers(F2, "cleanup-ran")).toBe(1);
        expect(await countMarkers(F2, "f2-blocking")).toBe(0);
        expect(await markersCreatedSince(F2, cleanupStart ?? "")).toBe(0);
      } finally {
        await s.end().catch(() => undefined);
      }
    },
    60_000,
  );

  it("f3 double release ตรงๆ — ครั้งเดียวที่ cleanup เกิด", async () => {
    const id = await fileBegin(F3, "8f3 setup");
    await insertMarkers(F3, "f3-pre", 1);
    await fileSetupSettled(F3, id);
    const first = await guardedAfterAll(F3, "8f3 release แรก", { lifecycleId: id });
    expect(first.cleanupStart).not.toBeNull();
    expect(await countMarkers(F3, "cleanup-ran")).toBe(1);
    await expectStaleRelease(F3, "8f3 release ซ้ำ", id);
    expect(await countMarkers(F3, "cleanup-ran")).toBe(1);
    expect((await fileState(F3))?.phase).toBe("teardown-settled");
  }, 30_000);

  it("f4a fn ค้างเกิน budget → poison → fileBegin re-attempt ถูกปฏิเสธจนกว่าจะ manualClearFile", async () => {
    const id = await fileBegin(F4, "8f4a setup ปกติ");
    await insertMarkers(F4, "f4a-pre", 1);
    await fileSetupSettled(F4, id);

    let err: unknown;
    try {
      await guardedAfterAll(F4, "8f4a fn ไม่มีวันจบ", {
        lifecycleId: id,
        fn: () => new Promise<void>(() => {}),
        fnBudgetMs: 1_500,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toContain("budget");

    const st = await fileState(F4);
    expect(st?.phase).toBe("poisoned");
    expect(st?.note ?? "").toContain("afterAll-fn-budget-exceeded");
    expect(await countMarkers(F4, "cleanup-ran")).toBe(0); // cleanup ห้ามรัน

    // re-attempt หลัง poison: ห้ามเปิดหน้าต่างใหม่เงียบๆ (self-live guard)
    let reopen: unknown;
    try {
      await fileBegin(F4, "8f4a re-attempt หลัง poison");
    } catch (e) {
      reopen = e;
    }
    expect(reopen).toBeInstanceOf(FileGuardError);
    expect((reopen as FileGuardError).reason).toBe("file-guard-refused-live-predecessor");
    const guardEvents = await ledgerRead({ runId: currentRunId(), kinds: ["guard-event"] });
    expect(
      guardEvents.some(
        (g) => g.payload["event"] === "file-guard-refused-live-predecessor" && g.payload["file"] === F4,
      ),
    ).toBe(true);

    // manualClearFile = ทางออกเดียว — หลังเคลียร์ สถานะไม่ live อีก
    await manualClearFile(F4, "8f4a เคลียร์ปิดสถานะหลังพิสูจน์ no-reopen");
    expect((await fileState(F4))?.phase).toBe("cleared-manual");
  }, 30_000);

  it("f4b stale-generation ปฏิเสธแม้ phase เปิด · token+closed = teardown-after-close · ไร้ token+closed = window-closed", async () => {
    await windowSet("open", "8f4b baseline เปิด");
    const staleGen = windowGet().generation;

    await windowSet("closed", "8f4b ปิดชั่วคราว");
    expect(transportAdmit()).toMatchObject({ ok: false, reason: "window-closed" });
    await expect(withTeardownToken(async () => transportAdmit())).resolves.toMatchObject({
      ok: false,
      reason: "teardown-after-close",
    });

    await windowSet("open", "8f4b เปิดใหม่ — generation ใหม่");
    const currentGen = windowGet().generation;
    expect(currentGen).not.toBe(staleGen);
    // แกนของ f4b: phase เปิดอยู่ แต่ caller จด gen เก่า → ปฏิเสธ (ห้ามเขียนข้ามหน้าต่าง)
    expect(transportAdmit(staleGen)).toMatchObject({ ok: false, reason: "stale-generation" });
    expect(transportAdmit(currentGen)).toEqual({ ok: true });
    expect(transportAdmit()).toEqual({ ok: true });
  }, 15_000);

  it("f4c release ของ lifecycle เก่าไม่แตะหน้าต่างใหม่ (stale-lifecycle-release)", async () => {
    const id1 = await fileBegin(F5, "8f4c หน้าต่างแรก");
    await insertMarkers(F5, "f4c-pre", 1);
    await fileSetupSettled(F5, id1);

    // หน้าต่างใหม่แทนที่ (เดิม settled แล้ว = เปิดได้)
    const id2 = await fileBegin(F5, "8f4c หน้าต่างใหม่");
    expect(id2).not.toBe(id1);
    await fileSetupSettled(F5, id2);

    await expectStaleRelease(F5, "8f4c release ของ lifecycle เก่า", id1);
    // ของใหม่ไม่ถูกแตะ: lifecycle + phase คงเดิม และ cleanup ไม่เกิด
    const st = await fileState(F5);
    expect(st?.lifecycleId).toBe(id2);
    expect(st?.phase).toBe("setup-settled");
    expect(await countMarkers(F5, "cleanup-ran")).toBe(0);

    // lifecycle ปัจจุบันปล่อยได้ปกติ
    const r = await guardedAfterAll(F5, "8f4c release ของ lifecycle ปัจจุบัน", { lifecycleId: id2 });
    expect(r.cleanupStart).not.toBeNull();
  }, 30_000);
});

/**
 * tests/barrier-proof/barrier-harness.ts — Wave H D89-3 [#94] (gate แผน r15-r30)
 *
 * harness ของ barrier-proof suite — สามองค์ประกอบ:
 *
 * 1) file lifecycle (window_file_state · ต่อ (run_id, file)): guardedBeforeAll /
 *    guardedAfterAll ให้ "runner abandonment" มีร่องรอยที่ตรวจได้จาก DB — vitest
 *    ทิ้ง hook จริงที่ hookTimeout 5s แต่ promise เดิมยังวิ่งต่อ (F56) · release
 *    (afterAll) ต้องรอ setup "เซ็ตเทิลจริง" ก่อน cleanup-start (8e/f1) · phase TX
 *    แข่งบน row lock เดียวกับ registration (f1) · lifecycle_id ต่อ window (f4c —
 *    stale-lifecycle-release ห้าม decrement/แตะของใหม่)
 *
 * 2) barrier_markers + cleanup TX เดียว: SRE lock ปิดช่อง insert ขนาน → ledger note
 *    'cleanup-start' + DELETE แรก + marker 'cleanup-ran' ใน TX เดียว (sync point
 *    ของ 8e3) — แถวที่แทรกระหว่าง cleanup จะติด lock แล้วโดนจับด้วย created_at >=
 *    cleanup-start (absence check)
 *
 * 3) child run spawner + force-release: wrapper (main suite) ตรวจหลักฐานจาก child
 *    vitest ที่ spawn จริง (RC≠0 / marker / ledger) แล้ว force-release หน้าต่างที่
 *    child ทิ้งค้าง ผ่าน handle ที่ reconstruct จาก ledger 'window' event
 *
 * dev-only ทั้งหมด · schema test_infra (runtime DDL idempotent — ไม่มีใน production)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO_ROOT, psql, psqlScalar } from "../integration/helpers.js";
import {
  currentRunId,
  ensureTestInfra,
  ledgerRead,
  ledgerWrite,
  type LedgerRow,
} from "../integration/test-io.js";
import {
  gateState,
  releaseWindow,
  type WindowHandle,
} from "../integration/window-coordinator.js";

// ─── runtime DDL (idempotent) ─────────────────────────────────────────────────

const BARRIER_DDL = `
create table if not exists test_infra.window_file_state (
  file text not null,
  run_id text not null,
  lifecycle_id uuid not null,
  phase text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, file)
);
create table if not exists test_infra.barrier_markers (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  file text not null,
  kind text not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists barrier_markers_file_idx on test_infra.barrier_markers (run_id, file, kind);
create table if not exists test_infra.cleanup_descendants (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  file text not null,
  label text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cleanup_descendants_idx on test_infra.cleanup_descendants (run_id, file, status);
`;

// ─── teardown context (ALS ผูกไฟล์ — 8h h3/h5) ────────────────────────────────

interface TeardownCtx {
  readonly file: string;
  readonly teardownId: string;
}

const teardownCtxAls = new AsyncLocalStorage<TeardownCtx>();

/** context ของ teardown "ของไฟล์นี้จริง" — guardedAfterAll รัน fn ใต้ context นี้
 *  (mutation ใน context นี้ = งานของ teardown · นอก context = ปฏิเสธ) */
export function teardownContextActiveFor(file: string): boolean {
  return teardownCtxAls.getStore()?.file === file;
}

let barrierDdlReady = false;

export async function ensureBarrierInfra(): Promise<void> {
  if (barrierDdlReady) return;
  await ensureTestInfra(); // lifecycle_ledger ของ test-io (file นี้ไม่ DDL ซ้ำ)
  await psql(BARRIER_DDL);
  barrierDdlReady = true;
}

// ─── error types ──────────────────────────────────────────────────────────────

export type FileGuardReason =
  | "file-guard-refused-live-predecessor" // 8b: bb ปฏิเสธก่อน setup เพราะ aa ยัง live/poisoned
  | "teardown-refused-no-setup" // 8b: cleanup ห้ามรันเมื่อ setup ไม่เคยเริ่ม/ไม่ใช่ lifecycle นี้
  | "stale-lifecycle-release"; // f4c: release ของ lifecycle เก่าต้องไม่แตะ lifecycle ใหม่

export class FileGuardError extends Error {
  readonly reason: FileGuardReason;
  constructor(reason: FileGuardReason, detail: string) {
    super(`barrier file guard: ${reason} — ${detail}`);
    this.reason = reason;
  }
}

export class FileSettleError extends Error {
  constructor(detail: string) {
    super(`barrier file settle budget เกิน: ${detail}`);
  }
}

// ─── helpers SQL เล็ก ─────────────────────────────────────────────────────────

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export type FilePhase =
  | "idle"
  | "setup-running"
  | "setup-settled"
  | "setup-failed"
  | "teardown-running"
  | "teardown-settled"
  | "poisoned"
  | "cleared-manual";

export interface FileState {
  readonly file: string;
  readonly lifecycleId: string;
  readonly phase: FilePhase;
  readonly note: string | null;
  readonly updatedAt: string;
}

export async function fileState(file: string): Promise<FileState | null> {
  await ensureBarrierInfra();
  const run = currentRunId();
  const raw = await psql(`
    select lifecycle_id::text || '|' || phase || '|' || coalesce(note, '') || '|' || updated_at::text
    from test_infra.window_file_state where run_id = ${sqlLit(run)} and file = ${sqlLit(file)};`);
  const line = raw.trim();
  if (line === "") return null;
  const [lifecycleId, phase, note, updatedAt] = line.split("|");
  return {
    file,
    lifecycleId: lifecycleId ?? "",
    phase: (phase ?? "idle") as FilePhase,
    note: note === "" ? null : note ?? null,
    updatedAt: updatedAt ?? "",
  };
}

async function fileSetPhase(
  file: string,
  phase: FilePhase,
  note: string,
  opts: { lifecycleId?: string } = {},
): Promise<void> {
  const run = currentRunId();
  const lifeCond = opts.lifecycleId === undefined ? "" : ` and lifecycle_id = ${sqlLit(opts.lifecycleId)}`;
  await psql(`
    update test_infra.window_file_state
       set phase = ${sqlLit(phase)}, note = ${sqlLit(note)}, updated_at = now()
     where run_id = ${sqlLit(run)} and file = ${sqlLit(file)}${lifeCond};`);
}

// ─── markers ──────────────────────────────────────────────────────────────────

export async function insertMarkers(file: string, kind: string, count: number, note = ""): Promise<void> {
  await ensureBarrierInfra();
  if (count <= 0) return;
  const run = currentRunId();
  const values = Array.from({ length: count }, () => `(${sqlLit(run)}, ${sqlLit(file)}, ${sqlLit(kind)}, ${sqlLit(note)})`).join(",");
  await psql(`insert into test_infra.barrier_markers (run_id, file, kind, note) values ${values};`, {
    quiet: true,
  });
}

export async function countMarkers(file: string, kind?: string): Promise<number> {
  await ensureBarrierInfra();
  const run = currentRunId();
  const kindCond = kind === undefined ? "" : ` and kind = ${sqlLit(kind)}`;
  const raw = await psql(`
    select count(*) from test_infra.barrier_markers
    where run_id = ${sqlLit(run)} and file = ${sqlLit(file)}${kindCond};`);
  return Number(raw.trim());
}

/** absence check — แถว (นอกเหนือ cleanup-ran) ที่ถูกสร้างตั้งแต่ cleanup-start ต้องเป็น 0 เสมอ */
export async function markersCreatedSince(file: string, cleanupStart: string): Promise<number> {
  await ensureBarrierInfra();
  const run = currentRunId();
  const raw = await psql(`
    select count(*) from test_infra.barrier_markers
    where run_id = ${sqlLit(run)} and file = ${sqlLit(file)}
      and kind <> 'cleanup-ran'
      and created_at >= ${sqlLit(cleanupStart)}::timestamptz;`);
  return Number(raw.trim());
}

/**
 * primitive เขียนของโลก marker — จุดบังคับ "mutation หลุดหลังหน้าต่าง" (8h h1):
 * อนุญาตเฉพาะ setup (running/settled) และ teardown-running "ใน context ของ
 * ไฟล์นี้จริง" (ALS จาก guardedAfterAll · h3) — นอกจากนั้น (teardown-settled /
 * poisoned / cleared-manual / setup-failed / ไม่มีแถว / teardown-running ไร้
 * context) = โยนก่อนแตะ marker + ledger event 'mutation-rejected' — write ที่
 * หลุดหลัง release ไม่มีทางลงเงียบๆ (ต่างจาก insertMarkers/violationProbe ที่เป็น
 * ระดับ infrastructure/scenario setup)
 */
export async function guardedMarkerInsert(file: string, kind: string, note = ""): Promise<void> {
  await ensureBarrierInfra();
  const st = await fileState(file);
  const inTeardownCtx = teardownContextActiveFor(file);
  const phase = st?.phase ?? "no-file";
  const allowed =
    st !== null &&
    (st.phase === "setup-running" ||
      st.phase === "setup-settled" ||
      (st.phase === "teardown-running" && inTeardownCtx));
  if (!allowed) {
    await ledgerWrite("note", {
      event: "mutation-rejected",
      reason: `phase-${phase}`,
      file,
      kind,
      inTeardownCtx,
    });
    throw new Error(`mutation-rejected(phase-${phase}): ${file} ไม่รับ marker ใหม่ (${kind})`);
  }
  await insertMarkers(file, kind, 1, note);
}

// ─── 1) file lifecycle — begin/settle/teardown ────────────────────────────────

/**
 * จุดบังคับก่อน setup ของไฟล์ (สัญญา 8b): มีหน้าต่าง live ใดๆ ใน run เดียวกัน —
 * รวม "ตัวไฟล์เอง" (setup-running/teardown-running/poisoned) = ปฏิเสธ "ก่อน"
 * แตะ setup ใดๆ + เขียน guard-event · self-poison ก็ห้ามเปิดใหม่เงียบๆ — ต้อง
 * manualClearFile ก่อน (f4a: hang→poison→re-attempt ถูกปฏิเสธ) · ผ่าน =
 * registration (lifecycle ใหม่ — หน้าต่างเดิมที่ setup-settled แทนที่ได้: f4c) ·
 * registration เป็น statement เดียว (INSERT..ON CONFLICT UPDATE) — outsider
 * ล็อกแถวอยู่ = บล็อกที่นี่ (f1)
 */
export async function fileBegin(file: string, label: string): Promise<string> {
  await ensureBarrierInfra();
  const run = currentRunId();
  const live = await psql(`
    select file || '|' || phase from test_infra.window_file_state
    where run_id = ${sqlLit(run)}
      and phase in ('setup-running','teardown-running','poisoned');`);
  const predecessors = live.trim().split("\n").filter((l) => l.length > 0);
  if (predecessors.length > 0) {
    await ledgerWrite(
      "guard-event",
      {
        event: "file-guard-refused-live-predecessor",
        file,
        label,
        predecessors: predecessors.map((p) => {
          const [f, ph] = p.split("|");
          return { file: f ?? "?", phase: ph ?? "?" };
        }),
      },
      { opKey: `file:${file}` },
    );
    throw new FileGuardError("file-guard-refused-live-predecessor", `${file} ถูกขวางโดย ${live.trim()}`);
  }
  const lifecycleId = randomUUID();
  await psql(`
    insert into test_infra.window_file_state (file, run_id, lifecycle_id, phase, note)
    values (${sqlLit(file)}, ${sqlLit(run)}, '${lifecycleId}', 'setup-running', ${sqlLit(label)})
    on conflict (run_id, file) do update
      set lifecycle_id = excluded.lifecycle_id, phase = 'setup-running',
          note = excluded.note, updated_at = now();`);
  await ledgerWrite("guard-event", { event: "file-attempt-allowed", file, label, lifecycleId }, { opKey: `file:${file}` });
  return lifecycleId;
}

/** setup เซ็ตเทิล (เรียกโดย guardedBeforeAll หลัง fn ผ่าน — หรือ promise ที่ถูก runner
 *  ทิ้งแล้ววิ่งต่อจนจบเอง: 8e) · lifecycle ไม่ตรง = no-op (stale ห้ามแตะของใหม่) */
export async function fileSetupSettled(file: string, lifecycleId: string): Promise<void> {
  await fileSetPhase(file, "setup-settled", "fn ผ่านครบ", { lifecycleId });
}

export async function fileSetupFailed(file: string, lifecycleId: string, msg: string): Promise<void> {
  await fileSetPhase(file, "setup-failed", msg.slice(0, 300), { lifecycleId });
}

export async function filePoison(file: string, reason: string): Promise<void> {
  await fileSetPhase(file, "poisoned", reason.slice(0, 300));
}

/** เคลียร์ poison ด้วยมือ (limitation 5 — wrapper/teardown ของ negative fixture เท่านั้น) */
export async function manualClearFile(file: string, intent: string): Promise<void> {
  await fileSetPhase(file, "cleared-manual", intent);
}

/**
 * รอ setup ของไฟล์ "เซ็ตเทิลจริง" — poll ต่อเนื่องภายใน deadline · deadline เกิน =
 * poison + โยน (8e2: fn ไม่จบเลย → cleanup ห้ามรัน · ผู้เรียกต้องเคลียร์เอง)
 */
export async function awaitFileSettled(
  file: string,
  deadlineMs: number,
  pollMs = 150,
): Promise<"setup-settled" | "setup-failed"> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const st = await fileState(file);
    if (st !== null && (st.phase === "setup-settled" || st.phase === "setup-failed")) {
      return st.phase;
    }
    if (Date.now() > deadline) {
      await filePoison(file, `setup-settle-budget-exceeded (${deadlineMs}ms)`);
      throw new FileSettleError(`setup ของ ${file} ไม่เซ็ตเทิลภายใน ${deadlineMs}ms`);
    }
    await sleep(pollMs);
  }
}

/**
 * beforeAll แบบมีร่องรอย: register (guard+phase) → fn → settle
 * fn ค้าง = runner ทิ้งเราที่ hookTimeout แต่ promise วิ่งต่อ — คำสั่งหลัง await fn()
 * ยังรันเมื่อ fn จบ (F56) แล้วเซ็ตเทิลเอง → afterAll ที่รออยู่ปลดล็อก (8e)
 */
export async function guardedBeforeAll(file: string, label: string, fn: () => Promise<void>): Promise<string> {
  const lifecycleId = await fileBegin(file, label);
  try {
    await fn();
    // หลักฐานคงทน (markers โดน cleanup TX ลบ): setup "จบจริง" เมื่อไหร่ — 8e เทียบ ts
    // กับ cleanup-start ของ afterAll ที่รออยู่ (เขียนโดย promise ที่ runner ทิ้งแล้ว)
    await ledgerWrite("note", { event: "setup-complete", file, lifecycleId });
    await fileSetupSettled(file, lifecycleId);
  } catch (err) {
    await fileSetupFailed(file, lifecycleId, `setup fn ล้ม: ${String(err)}`).catch(() => undefined);
    throw err;
  }
  return lifecycleId;
}

// ─── cleanup TX เดียว (sync point ของ 8e3) ────────────────────────────────────

/**
 * TX เดียว: SRE lock barrier_markers → ledger note 'cleanup-start' → DELETE แถวของ
 * ไฟล์ → marker 'cleanup-ran' · คืน ts ของ cleanup-start (อ่านคืนตาม id — ตัวเดียวกับ
 * TX) · insert จาก session อื่น "ระหว่าง" cleanup จะติด SRE lock แล้วโดน absence
 * check จับ (created_at >= cleanup-start)
 */
export async function runFileCleanupTx(file: string): Promise<string> {
  const run = currentRunId();
  const noteId = randomUUID();
  await psql(`
    begin;
    lock table test_infra.barrier_markers in share row exclusive mode;
    insert into test_infra.lifecycle_ledger (id, run_id, kind, op_key, invocation_id, payload)
    values ('${noteId}', ${sqlLit(run)}, 'note', 'file:${file}', null,
            ${sqlLit(JSON.stringify({ event: "cleanup-start", file, run_id: run }))}::jsonb);
    delete from test_infra.barrier_markers where run_id = ${sqlLit(run)} and file = ${sqlLit(file)};
    insert into test_infra.barrier_markers (run_id, file, kind, note)
    values (${sqlLit(run)}, ${sqlLit(file)}, 'cleanup-ran', 'cleanup-start ${noteId}');
    commit;`);
  const ts = await psqlScalar(`select ts::text from test_infra.lifecycle_ledger where id = '${noteId}';`);
  return ts.trim();
}

// ─── descendants ของ cleanup (r20-M2 · 8h h5) ─────────────────────────────────

export interface CleanupChildHandle {
  readonly id: string;
  readonly done: Promise<"completed" | "failed">;
}

async function descendantsRunning(file: string): Promise<number> {
  const run = currentRunId();
  const raw = await psqlScalar(`
    select count(*) from test_infra.cleanup_descendants
    where run_id = ${sqlLit(run)} and file = ${sqlLit(file)} and status = 'running';`);
  return Number(raw.trim());
}

/** รอ descendants 'running' หมด — deadline ล้น = poison + โยน (teardown ไม่ปิด
 *  ไฟล์อัตโนมัติ — งานลูกที่ตื่นทีหลังต้องเจอ phase ปฏิเสธ no-fallback) */
export async function awaitDescendants(file: string, deadlineMs: number, pollMs = 150): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if ((await descendantsRunning(file)) === 0) return;
    if (Date.now() > deadline) {
      await filePoison(file, `descendants-overstayed-budget (${deadlineMs}ms)`);
      throw new FileSettleError(
        `descendants ของ ${file} ไม่จบภายใน ${deadlineMs}ms — poison (ไฟล์ไม่ปิดอัตโนมัติ)`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * ปล่อยงานลูกจาก cleanup fn — ต้องเรียกใน teardown context ของไฟล์เท่านั้น
 * (ALS จาก guardedAfterAll) · แทรก descendant row 'running' ก่อนคืน handle
 * (awaitDescendants เห็นก่อน body จบเสมอ) แล้วรัน body แบบ async — fn คืนก่อนได้
 * แต่ teardown-settled ต้องรอลูกจบจริง · callerModule จำกัด tests/barrier-proof/
 * เท่านั้น (r30 #19) · งานลูกที่ตื่นหลัง token ตาย (phase ปิด/พิษ) ต้องเจอ
 * guardedMarkerInsert ปฏิเสธ — ห้ามตกกลับไปใช้สิทธิ์ caller ปกติ (no-fallback)
 */
export async function spawnCleanupChild(
  file: string,
  label: string,
  body: () => Promise<void>,
  callerModule: string,
): Promise<CleanupChildHandle> {
  if (!/^tests\/barrier-proof\//.test(callerModule)) {
    throw new Error(
      `spawnCleanupChild: ปฏิเสธ — callerModule ต้องอยู่ใต้ tests/barrier-proof/ เท่านั้น (ได้ ${callerModule})`,
    );
  }
  if (teardownContextActiveFor(file) !== true) {
    throw new Error(`spawnCleanupChild: ปฏิเสธ — ต้องเรียกใน teardown context ของ ${file} เท่านั้น`);
  }
  const run = currentRunId();
  const id = randomUUID();
  await psql(
    `insert into test_infra.cleanup_descendants (id, run_id, file, label, status)
     values ('${id}', ${sqlLit(run)}, ${sqlLit(file)}, ${sqlLit(label)}, 'running');`,
    { quiet: true },
  );
  const done = (async (): Promise<"completed" | "failed"> => {
    try {
      await body();
      await psql(
        `update test_infra.cleanup_descendants set status = 'completed', updated_at = now() where id = '${id}';`,
        { quiet: true },
      );
      await ledgerWrite("note", { event: "cleanup-child-completed", file, label, id });
      return "completed";
    } catch (err) {
      await psql(
        `update test_infra.cleanup_descendants set status = 'failed', updated_at = now() where id = '${id}';`,
        { quiet: true },
      );
      await ledgerWrite("note", { event: "cleanup-child-failed", file, label, id, error: String(err).slice(0, 300) });
      return "failed";
    }
  })();
  return { id, done };
}

/**
 * afterAll แบบมีร่องรอย (release):
 * (1) fast-refuse — lifecycle ไม่ตรง/ไม่เคยเริ่ม = ห้าม cleanup (8b: bb หลัง guard
 *     ปฏิเสธ — cleanup-ran ต้องไม่เกิด)
 * (2) barrier fn (ถ้ามี) — ล้ม หรือ budget เกิน = poison + โยน → cleanup ไม่รัน
 *     (8b: drain-timeout ของเราเองก่อน hookTimeout · 8c: budget 8s < hold 15s —
 *     promise ที่แพ้ race วิ่งต่อ ปล่อย lease เป็น orphan พร้อมโน้ต)
 * (3) รอ setup เซ็ตเทิลจริง (8e/f1 — ผ่าน runner abandonment window)
 * (4) phase TX — UPDATE เดียว มี lifecycle_id ใน WHERE: บล็อกบน row lock เดียวกับ
 *     registration (f1) · 0 แถว = stale-lifecycle-release (f4c — ไม่แตะของใหม่)
 * (5) cleanup TX → teardown-settled · คืน cleanupStart ให้ test ทำ absence check
 */
export interface GuardedAfterAllOptions {
  readonly lifecycleId: string;
  /** barrier fn ก่อน cleanup — ล้ม/budget เกิน = poison (cleanup ไม่รัน) · รันใต้
   *  teardown context ของไฟล์ (ALS) — mutation ที่ fn (หรือ descendant) เขียน =
   *  งานของ teardown นี้ (8h h3/h5) */
  readonly fn?: () => Promise<void>;
  readonly fnBudgetMs?: number;
  readonly setupBudgetMs?: number;
  /** budget รอ descendants (spawnCleanupChild) จบก่อน teardown-settled — เกิน = poison */
  readonly descendantBudgetMs?: number;
}

export interface GuardedAfterAllResult {
  readonly cleanupStart: string | null;
}

export async function guardedAfterAll(
  file: string,
  label: string,
  opts: GuardedAfterAllOptions,
): Promise<GuardedAfterAllResult> {
  await ensureBarrierInfra();
  // (1) fast-refuse — สองกรณี · (ก) ไม่มี setup เลย (lifecycle ว่าง/ไม่มีแถว) =
  //     teardown-refused-no-setup (8b: bb หลัง guard ปฏิเสธ) · (ข) มีแถวแต่
  //     lifecycle ไม่ใช่ของเรา = stale-lifecycle-release (f4c — หน้าต่างถูกแทนที่
  //     แล้ว release เก่าห้ามแตะของใหม่)
  const st0 = await fileState(file);
  if (opts.lifecycleId === "" || st0 === null) {
    await ledgerWrite("note", {
      event: "teardown-refused-no-setup",
      file,
      label,
      phase: st0?.phase ?? null,
      currentLifecycle: st0?.lifecycleId ?? null,
    });
    throw new FileGuardError(
      "teardown-refused-no-setup",
      `${file}: setup ไม่เคยเริ่มของ lifecycle นี้ (lifecycleId=${opts.lifecycleId || "-"})`,
    );
  }
  if (st0.lifecycleId !== opts.lifecycleId) {
    await ledgerWrite("note", {
      event: "stale-lifecycle-release",
      file,
      label,
      myLifecycle: opts.lifecycleId,
      currentLifecycle: st0.lifecycleId,
      phase: st0.phase,
    });
    throw new FileGuardError(
      "stale-lifecycle-release",
      `${file}: lifecycle ${opts.lifecycleId} ไม่ใช่ lifecycle ปัจจุบัน (${st0.lifecycleId})`,
    );
  }
  // (2) barrier fn — race กับ budget (แพ้ = poison; fn เดิมวิ่งต่อ) · รันใต้ teardown
  //     context ของไฟล์ (ALS) — guardedMarkerInsert/spawnCleanupChild ในนี้ = งาน teardown
  if (opts.fn !== undefined) {
    const budget = opts.fnBudgetMs ?? 60_000;
    const teardownId = randomUUID();
    let fnError: unknown = null;
    const losingSide = teardownCtxAls.run({ file, teardownId }, opts.fn).then(
      () => "fn-done" as const,
      (err: unknown) => {
        fnError = err;
        return "fn-error" as const;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const budgetPromise = new Promise<"budget-exceeded">((resolve) => {
      timer = setTimeout(() => resolve("budget-exceeded"), budget);
    });
    let first: "fn-done" | "fn-error" | "budget-exceeded";
    try {
      first = await Promise.race([losingSide, budgetPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (first === "budget-exceeded") {
      await filePoison(file, `afterAll-fn-budget-exceeded (${budget}ms)`);
      void losingSide.then(
        (r) => {
          void ledgerWrite("note", { event: "orphan-fn-settled-later", file, result: r });
        },
        () => {
          void ledgerWrite("note", { event: "orphan-fn-settled-later", file, result: "fn-error" });
        },
      );
      throw new FileSettleError(`afterAll fn ของ ${file} เกิน budget ${budget}ms — poison (cleanup ไม่รัน)`);
    }
    if (fnError !== null) {
      await filePoison(file, `afterAll-fn-failed: ${String(fnError)}`);
      throw fnError;
    }
  }
  // (3) รอ setup เซ็ตเทิลจริง — เฉพาะเมื่อ setup ยังวิ่งอยู่ (8e) · phase อื่น
  //     (settled แล้ว / failed / teardown แล้ว / poisoned) ไม่ต้องรอ — ปล่อยให้
  //     phase TX ตัดสินที่ (4) (f1 double-release / f4c stale lifecycle ต้อง
  //     ปฏิเสธทันที ไม่ใช่ค้างรอจน budget)
  if (st0.phase === "setup-running") {
    await awaitFileSettled(file, opts.setupBudgetMs ?? 30_000);
  }
  // (4) phase TX — บล็อกบน row lock · lifecycle เก่า = stale (f4c)
  const run2 = currentRunId();
  const upd = await psql(`
    update test_infra.window_file_state
       set phase = 'teardown-running', note = ${sqlLit(`teardown ${label}`)}, updated_at = now()
     where run_id = ${sqlLit(run2)} and file = ${sqlLit(file)}
       and lifecycle_id = ${sqlLit(opts.lifecycleId)}
       and phase = 'setup-settled'
     returning 1;`, { quiet: true });
  if (upd.trim() !== "1") {
    const st = await fileState(file);
    await ledgerWrite("note", {
      event: "stale-lifecycle-release",
      file,
      myLifecycle: opts.lifecycleId,
      currentLifecycle: st?.lifecycleId ?? null,
      phase: st?.phase ?? null,
    });
    throw new FileGuardError(
      "stale-lifecycle-release",
      `${file}: lifecycle ${opts.lifecycleId} ไม่ใช่ lifecycle ปัจจุบัน (${st?.lifecycleId ?? "null"})`,
    );
  }
  // (5) cleanup TX → รอ descendants จบจริง → teardown-settled (r20-M2: settle
  //     'completed' ได้เฉพาะ fn คืน AND ไม่มี descendant 'running' — งานลูกของ
  //     cleanup ต้องก่อนหน้าเสมอ · deadline ล้น = poison ไม่ปิดไฟล์อัตโนมัติ)
  const cleanupStart = await runFileCleanupTx(file);
  await awaitDescendants(file, opts.descendantBudgetMs ?? 30_000);
  await fileSetPhase(file, "teardown-settled", "cleanup ครบ", { lifecycleId: opts.lifecycleId });
  return { cleanupStart };
}

// ─── 3) child run + force-release ─────────────────────────────────────────────

export interface ChildRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * spawn vitest child run ด้วย config เดียวกัน + BARRIER_CHILD=1 (child files
 * self-skip เมื่อรันใน main suite) · RUN_ID ส่งต่อจาก env — guard ของ child เห็น
 * โลกเดียวกับ wrapper · ส่งต่อ exit code เป๊ะ (ห้ามกลืน — ล้มคือล้ม)
 */
export async function childRun(
  files: readonly string[],
  opts: { bail?: number; timeoutMs?: number; extraEnv?: Record<string, string> } = {},
): Promise<ChildRunResult> {
  const args = ["vitest", "run", "--config", "vitest.barrier-proof.config.ts", ...files];
  if (opts.bail !== undefined) {
    args.push("--bail", String(opts.bail));
  }
  return await new Promise<ChildRunResult>((resolve, reject) => {
    const child = spawn("npx", args, {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: "0", BARRIER_CHILD: "1", ...opts.extraEnv },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`childRun timeout ${opts.timeoutMs ?? 180_000}ms: ${files.join(" ")}`));
    }, opts.timeoutMs ?? 180_000);
    child.stdout.on("data", (c: Buffer) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** reconstruct WindowHandle จาก ledger 'window' close event ล่าสุดของ holder —
 *  releaseWindow ไม่ผูก identity กับ process ผู้เปิด → wrapper ใช้ปล่อยหน้าต่าง
 *  ที่ child ทิ้งค้างได้ (force-release ตามแผน r15) */
export async function reconstructWindowHandle(holderId: string): Promise<WindowHandle | null> {
  const events = await ledgerRead({ runId: currentRunId(), kinds: ["window"] });
  const closed = [...events]
    .reverse()
    .find((e: LedgerRow) => e.payload["phase"] === "closed" && e.payload["holderId"] === holderId);
  if (closed === undefined) return null;
  const snapshotRaw = closed.payload["snapshot"];
  const snapshot = Array.isArray(snapshotRaw)
    ? (snapshotRaw as Array<{ jobid: number; active: boolean }>).map((j) => ({
        jobid: Number(j.jobid),
        active: Boolean(j.active),
      }))
    : [];
  return {
    holderId,
    generation: String(closed.payload["generation"] ?? ""),
    // ts ของ ledger event ก่อน closedAt จริงเล็กน้อย — ปลอดภัยกว่าสำหรับ overlap audit
    closedAt: closed.ts,
    cronSnapshot: snapshot,
    mailerWasRunning: closed.payload["mailerWasRunning"] === true,
  };
}

export interface ResetFileWorldOptions {
  readonly files: readonly string[];
  /** holder ของหน้าต่างที่ scenario อาจทิ้งค้าง (force-release ก่อนเริ่มรอบใหม่) */
  readonly holders?: readonly string[];
  /** เจ้าของ worker_lease ของ scenario (ล้างเฉพาะของตัวเอง — ห้ามแตะของคนอื่น) */
  readonly leaseOwners?: readonly string[];
}

/** รีเซ็ตโลกของ scenario ก่อน/หลัง child run — idempotent · คืนหน้าต่างค้างก่อนลบ
 *  state เสมอ (ห้ามทิ้ง gate ปิดค้างข้าม scenario) */
export async function resetFileWorld(opts: ResetFileWorldOptions): Promise<void> {
  await ensureBarrierInfra();
  const run = currentRunId();
  for (const holderId of opts.holders ?? []) {
    const handle = await reconstructWindowHandle(holderId);
    if (handle === null) continue;
    const gate = await gateState();
    if (!gate.isOpen || gate.holders.includes(holderId)) {
      try {
        await releaseWindow(handle);
      } catch (err) {
        await ledgerWrite("note", { event: "force-release-failed", holderId, error: String(err).slice(0, 300) });
      }
    }
  }
  for (const owner of opts.leaseOwners ?? []) {
    await psql(`delete from test_infra.worker_lease where owner = ${sqlLit(owner)};`);
  }
  const fileList = opts.files.map((f) => sqlLit(f)).join(",");
  await psql(`delete from test_infra.window_file_state where run_id = ${sqlLit(run)} and file in (${fileList});`);
  await psql(`delete from test_infra.barrier_markers where run_id = ${sqlLit(run)} and file in (${fileList});`);
  await psql(`delete from test_infra.cleanup_descendants where run_id = ${sqlLit(run)} and file in (${fileList});`);
}

// ─── lock-handshake waiter-mode (r22-r30 — กลุ่ม D ใช้ต่อ) ────────────────────

export interface WaiterInfo {
  readonly pid: number;
  readonly waitEvent: string | null;
}

/**
 * รอ "waiter ตัวเดียว" ที่ค้างอยู่บน relation lock จริง — predicate: locktype
 * relation + relation OID + mode ตรง + granted=false + pg_blocking_pids(waiter)
 * ∋ coordinator pid · เจอ >1 waiter = FAIL ทันที "ไม่ terminate ใคร" (F57-ข
 * exactly-one-waiter) · deadline เกิน = FAIL · psql ของ helpers spawn ต่อครั้ง
 * ~100-300ms — poll นี้เห็น window ≥ pollMs*2 ขึ้นไปอย่างน่าเชื่อถือ
 */
export async function awaitStuckWaiter(
  opts: {
    readonly relation: string; // เช่น 'public.audit_logs' — แปลง ::regclass ใน SQL
    readonly mode: string; // เช่น 'ShareRowExclusiveLock' / 'RowExclusiveLock'
    readonly blockerPids: readonly number[];
    readonly deadlineMs?: number;
    readonly pollMs?: number;
  },
  label: string,
): Promise<WaiterInfo> {
  if (opts.blockerPids.length === 0) {
    throw new Error(`awaitStuckWaiter(${label}): blockerPids ว่าง — ต้องมี coordinator pid อย่างน้อยหนึ่ง`);
  }
  const blockers = `{${opts.blockerPids.join(",")}}`;
  const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
  const pollMs = opts.pollMs ?? 250;
  for (;;) {
    const raw = await psql(`
      select l.pid::text || '|' || coalesce(act.wait_event, '')
      from pg_locks l
      join pg_stat_activity act on act.pid = l.pid
      where l.locktype = 'relation'
        and l.relation = ${sqlLit(opts.relation)}::regclass
        and l.mode = ${sqlLit(opts.mode)}
        and not l.granted
        and pg_blocking_pids(l.pid) && '${blockers}'::int[];`);
    const rows = raw.trim().split("\n").filter((l) => l.length > 0);
    if (rows.length > 1) {
      throw new Error(
        `awaitStuckWaiter(${label}): waiter มากกว่าหนึ่ง (${rows.length}) = ambiguous — FAIL โดยไม่ terminate ใคร (F57-ข)`,
      );
    }
    if (rows.length === 1) {
      const [pidRaw, waitEvent] = (rows[0] ?? "").split("|");
      const pid = Number(pidRaw);
      if (Number.isFinite(pid) && pid > 0) {
        return { pid, waitEvent: waitEvent || null };
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`awaitStuckWaiter(${label}): ไม่เห็น waiter ภายใน ${opts.deadlineMs ?? 10_000}ms`);
    }
    await sleep(pollMs);
  }
}

// ─── violation probe (8e3-ข) ─────────────────────────────────────────────────

export interface ViolationProbe {
  /** ลบแถวที่แทรกไว้ + เขียน ledger outcome 'executed' — ปิดรอบ probe เสมอ */
  retract(): Promise<void>;
}

/**
 * ทางออกที่ "ตั้งใจ" ให้ทดสอบยิงแถวหลุด guard ทุกชั้น (ข้าม phase/generation —
 * จำลอง mutation ที่เกิดหลัง cleanup-start โดยไม่ผ่าน attemptBegin/transport) —
 * พิสูจน์ว่า absence check (markersCreatedSince) เป็นเส้นตายสุดท้ายของ
 * defense-in-depth: จับแถวที่ guard ทุกชั้นไม่เห็น · จำกัดให้เรียกจากโมดูลใต้
 * tests/barrier-proof/ เท่านั้น (callerModule ต้องขึ้นต้นด้วย prefix นี้) ·
 * probe แทรก 1 แถว (note='violation-probe') ค้างไว้ให้ checker จับ แล้วผู้เรียก
 * ต้อง retract() เพื่อลบ + เขียน audit trail
 */
export async function violationProbe(
  file: string,
  kind: string,
  callerModule: string,
): Promise<ViolationProbe> {
  if (!/^tests\/barrier-proof\//.test(callerModule)) {
    throw new Error(
      `violationProbe: ปฏิเสธ — callerModule ต้องอยู่ใต้ tests/barrier-proof/ เท่านั้น (ได้ ${callerModule})`,
    );
  }
  await ensureBarrierInfra();
  const run = currentRunId();
  await psql(
    `insert into test_infra.barrier_markers (run_id, file, kind, note)
     values (${sqlLit(run)}, ${sqlLit(file)}, ${sqlLit(kind)}, 'violation-probe');`,
    { quiet: true },
  );
  await ledgerWrite("note", { event: "violation-probe-armed", file, kind, callerModule });
  return {
    retract: async () => {
      await psql(
        `delete from test_infra.barrier_markers
         where run_id = ${sqlLit(run)} and file = ${sqlLit(file)}
           and kind = ${sqlLit(kind)} and note = 'violation-probe';`,
        { quiet: true },
      );
      await ledgerWrite("note", {
        event: "violation-probe-executed",
        outcome: "executed",
        file,
        kind,
        inserted: 1,
        deleted: 1,
      });
    },
  };
}

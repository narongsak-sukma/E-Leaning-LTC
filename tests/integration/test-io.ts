/**
 * tests/integration/test-io.ts — transport กลางของ Wave H D89-3 [#94] (gate แผน r30 APPROVED)
 *
 * หน้าที่: ทุกการเขียนของเทส (SQL/HTTP/SDK) ผ่านจุดเดียว — lifecycle ledger ครบทุก attempt
 * + opKey/binding/ua_nonce ต่อ dispatch + before-snapshot/log-cursor + session identity
 * + settle ตาม completion class + access-log fence + `attemptBegin` guard (serial invariant)
 *
 * ขอบเขต guard (r29-m1/r30): จุดบังคับเดียว = attemptBegin เอง — scenario attempt ของ
 * ครอบครัว waiter-attribution เท่านั้น · transport ไม่ปรึกษา guard · retry ภายใน parent
 * invocation (users.ts loop · SDK retry) ไม่ผ่าน guard · dcr12 ขนานไม่กระทบ
 *
 * dev-only ทั้งหมด · ledger อยู่ใน schema `test_infra` (runtime DDL idempotent — ไม่มีใน
 * production migrations) · run_id มาจาก env RUN_ID เท่านั้น (battery-run.mjs ตั้ง)
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO_ROOT, psql, REST_URL, ANON_KEY } from "./helpers";

// ─── 1) runtime DDL (idempotent) ─────────────────────────────────────────────

const DDL = `
create schema if not exists test_infra;
create table if not exists test_infra.lifecycle_ledger (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  run_id text not null,
  kind text not null,
  op_key text,
  invocation_id uuid,
  payload jsonb not null default '{}'::jsonb
);
create index if not exists lifecycle_ledger_op_idx on test_infra.lifecycle_ledger (op_key, ts);
create index if not exists lifecycle_ledger_inv_idx on test_infra.lifecycle_ledger (invocation_id, ts);
create index if not exists lifecycle_ledger_run_idx on test_infra.lifecycle_ledger (run_id, kind);
`;

let ddlReady = false;

/** สร้าง/ตรวจ test_infra ครั้งแรกที่มีการใช้ ledger (idempotent — ปลอดภัยเรียกซ้ำ) */
export async function ensureTestInfra(): Promise<void> {
  if (ddlReady) return;
  await psql(DDL);
  ddlReady = true;
}

// ─── 2) ledger ───────────────────────────────────────────────────────────────

export type LedgerKind =
  | "invocation" // เหตุการณ์สถานะ invocation (status ใน payload)
  | "attempt" // transport dispatch หนึ่งครั้ง (รวม SDK retry — ผูก parent_call_key)
  | "settle-decision" // row เดียว: scan+การตัดสินคู่กัน (r26-m1/r27)
  | "guard-event" // attemptBegin ปฏิเสธ/อนุญาต
  | "session" // PsqlSession identity (nonce+pid+backend_start)
  | "window" // phase เปลี่ยน (coordinator)
  | "note"; // เหตุการณ์อื่น (blocked-backend ฯลฯ)

export interface LedgerRow {
  readonly id: string;
  readonly ts: string;
  readonly run_id: string;
  readonly kind: LedgerKind;
  readonly op_key: string | null;
  readonly invocation_id: string | null;
  readonly payload: Record<string, unknown>;
}

/** run_id ตรึงตั้งแต่โหลดโมดูล — battery-run.mjs ตั้ง env RUN_ID หนึ่งครั้งก่อน
 * spawn vitest ของ stage นั้น · env ที่ถูกเปลี่ยนกลางวิ่งคือ override ที่ต้อง
 * ปฏิเสธ (D89-4 CC "run-id override ปฏิเสธ") — ledger ผูก run เดียวต่อ process */
const FROZEN_RUN_ID = (() => {
  const v = process.env["RUN_ID"];
  return v === undefined || v === "" ? "adhoc" : v;
})();

export function currentRunId(): string {
  return FROZEN_RUN_ID;
}

/** เขียน ledger row หนึ่งแถว (append-only) — ปฏิเสธ run-id override กลางวิ่ง */
export async function ledgerWrite(
  kind: LedgerKind,
  payload: Record<string, unknown>,
  refs: { opKey?: string | undefined; invocationId?: string | undefined } = {},
): Promise<string> {
  await ensureTestInfra();
  const envRunId = process.env["RUN_ID"];
  if (envRunId !== undefined && envRunId !== "" && envRunId !== FROZEN_RUN_ID) {
    throw new Error(
      `run-id-override-refused: RUN_ID env ถูกเปลี่ยนกลางวิ่ง (${FROZEN_RUN_ID} → ${envRunId}) — ledger ผูก run เดียวต่อ process`,
    );
  }
  const id = randomUUID();
  const safePayload = JSON.stringify(payload).replace(/'/g, "''");
  const opKey = refs.opKey === undefined ? null : `'${refs.opKey}'`;
  const invId = refs.invocationId === undefined ? null : `'${refs.invocationId}'`;
  await psql(
    `insert into test_infra.lifecycle_ledger (id, run_id, kind, op_key, invocation_id, payload)
     values ('${id}', '${currentRunId()}', '${kind}', ${opKey}, ${invId},
             '${safePayload}'::jsonb);`,
  );
  return id;
}

/** อ่าน ledger ตามเงื่อนไข (เรียงตามเวลา) */
export async function ledgerRead(
  where: { runId?: string; kinds?: LedgerKind[]; opKey?: string; invocationId?: string } = {},
): Promise<LedgerRow[]> {
  await ensureTestInfra();
  const conds: string[] = [];
  if (where.runId !== undefined) conds.push(`run_id = '${where.runId}'`);
  if (where.kinds !== undefined)
    conds.push(`kind in (${where.kinds.map((k) => `'${k}'`).join(",")})`);
  if (where.opKey !== undefined) conds.push(`op_key = '${where.opKey}'`);
  if (where.invocationId !== undefined) conds.push(`invocation_id = '${where.invocationId}'`);
  const cond = conds.length > 0 ? `where ${conds.join(" and ")}` : "";
  const raw = await psql(
    `select coalesce(json_agg(q), '[]'::json)::text from (
       select id::text, ts::text, run_id, kind, op_key, invocation_id::text, payload
       from test_infra.lifecycle_ledger ${cond} order by ts, id
     ) q;`,
  );
  return JSON.parse(raw.trim()) as LedgerRow[];
}

/** สถานะ invocation ล่าสุดของ opKey (จาก event 'invocation' ล่าสุด — append-only) */
export async function invocationState(
  opKey: string,
): Promise<{ invocationId: string; status: string; payload: Record<string, unknown> } | null> {
  await ensureTestInfra();
  const raw = await psql(
    `select json_build_object('invocation_id', invocation_id, 'payload', payload)::text
     from test_infra.lifecycle_ledger
     where kind = 'invocation' and op_key = '${opKey}'
     order by ts desc, id desc limit 1;`,
  );
  const line = raw.trim();
  if (line === "") return null;
  const row = JSON.parse(line) as { invocation_id: string; payload: Record<string, unknown> };
  const status = row.payload["status"];
  return {
    invocationId: row.invocation_id,
    status: typeof status === "string" ? status : "unknown",
    payload: row.payload,
  };
}

// ─── 3) window phase + generation + teardown token (ALS) ─────────────────────

export type WindowPhase = "open" | "closed";

interface WindowState {
  phase: WindowPhase;
  generation: string;
}

const windowState: WindowState = { phase: "open", generation: "gen-0" };

export function windowGet(): { phase: WindowPhase; generation: string } {
  return { ...windowState };
}

/** เปลี่ยน phase — ปิด/เปิด window ของ battery (coordinator เรียก) — bump generation ทุกครั้ง */
export async function windowSet(
  phase: WindowPhase,
  note: string,
): Promise<{ phase: WindowPhase; generation: string }> {
  windowState.generation = `gen-${randomUUID().slice(0, 8)}`;
  windowState.phase = phase;
  await ledgerWrite("window", { phase, generation: windowState.generation, note });
  return { ...windowState };
}

interface TeardownToken {
  readonly kind: "teardown";
  readonly startedAt: number;
}

const teardownAls = new AsyncLocalStorage<TeardownToken>();

/** รัน fn ใต้ teardown token — transport อนุญาตทุก phase ยกเว้น 'closed' เมื่อมี token จริง */
export function withTeardownToken<T>(fn: () => Promise<T>): Promise<T> {
  return teardownAls.run({ kind: "teardown", startedAt: Date.now() }, fn);
}

export function teardownTokenActive(): boolean {
  return teardownAls.getStore() !== undefined;
}

/**
 * จุดตัดสินกลางของ transport (ลำดับ r18):
 * (1) teardown token จริง → อนุญาตทุก phase ยกเว้น 'closed'
 * (2) ไร้ token + phase ≠ 'open' → ปฏิเสธ
 * (3) phase 'open' + teardown running → ปฏิเสธ (การเขียนหลังเปิด window ต้องไม่ใช่ teardown)
 * (4) generation ที่ caller จดไว้ ≠ ปัจจุบัน → 'stale-generation' abort
 * (5) ผ่าน → transport ลง row + รัน
 */
export function transportAdmit(
  callerGeneration?: string,
): { ok: true } | { ok: false; reason: "window-closed" | "teardown-after-close" | "write-during-teardown" | "stale-generation" } {
  const hasToken = teardownTokenActive();
  const { phase, generation } = windowState;
  if (hasToken) {
    if (phase === "closed") return { ok: false, reason: "teardown-after-close" };
  } else {
    if (phase !== "open") return { ok: false, reason: "window-closed" };
  }
  if (callerGeneration !== undefined && callerGeneration !== generation) {
    return { ok: false, reason: "stale-generation" };
  }
  return { ok: true };
}

// ─── 4) attemptBegin guard (r29-m1 ขอบเขต: scenario attempt เท่านั้น) ────────

export interface GuardRefusal {
  readonly ok: false;
  readonly reason: "lifecycle-guard-refused-live-predecessor";
  readonly predecessor: { invocationId: string; status: string };
  readonly eventId: string;
}

export interface GuardAllow {
  readonly ok: true;
  readonly invocationId: string;
  readonly eventId: string;
}

/** สถานะที่อนุญาตให้เริ่ม attempt ใหม่ — เฉพาะ settled / cleared-manual เท่านั้น
 * poisoned ก็ยังปฏิเสธ (เคลียร์มือก่อน — limitation 5) · running/unresolved = live predecessor */
const ALLOWED_PREDECESSOR_STATUS = new Set(["settled", "cleared-manual"]);

/**
 * จุดบังคับเดียวของ serial invariant — ทางเริ่ม scenario attempt ใหม่ของ opKey
 * (ครอบครัว waiter-attribution: 8o(ก) · fixtures (ก)(ข)(ง)) ต้องผ่านฟังก์ชันนี้เท่านั้น
 *
 * invocation ก่อนหน้าของ opKey เดียวกันต้อง terminal (settled/poisoned/unresolved)
 * เท่านั้น — พบ running = ปฏิเสธก่อน dispatch/handshake ใดๆ · poisoned ก็ยังปฏิเสธ
 * (เคลียร์มือก่อน — limitation 5 · ข้อยกเว้น: negative fixture เคลียร์ของตัวเองใน
 * teardown ด้วย intent) · guard ไม่ terminate ใคร ไม่แตะ waiter ไม่แก้ ledger เดิม
 *
 * ผ่าน = เปิด invocation ใหม่ (ledger 'invocation' status=running)
 * ปฏิเสธ = โยน GuardRefusedError (fixture (ง) catch แล้ว assert) + ledger 'guard-event'
 */
export class GuardRefusedError extends Error {
  readonly refusal: GuardRefusal;
  constructor(refusal: GuardRefusal) {
    super(`attemptBegin refused: ${refusal.reason} (predecessor ${refusal.predecessor.invocationId} status=${refusal.predecessor.status})`);
    this.refusal = refusal;
  }
}

export async function attemptBegin(opKey: string, label: string): Promise<GuardAllow> {
  const prev = await invocationState(opKey);
  if (prev !== null && !ALLOWED_PREDECESSOR_STATUS.has(prev.status)) {
    const eventId = await ledgerWrite(
      "guard-event",
      {
        event: "lifecycle-guard-refused-live-predecessor",
        label,
        predecessorInvocationId: prev.invocationId,
        predecessorStatus: prev.status,
      },
      { opKey },
    );
    throw new GuardRefusedError({
      ok: false,
      reason: "lifecycle-guard-refused-live-predecessor",
      predecessor: { invocationId: prev.invocationId, status: prev.status },
      eventId,
    });
  }
  const invocationId = randomUUID();
  const eventId = await ledgerWrite(
    "invocation",
    { status: "running", label, opKey, startedAt: new Date().toISOString() },
    { opKey, invocationId },
  );
  await ledgerWrite("guard-event", { event: "attempt-allowed", label, predecessor: prev?.invocationId ?? null }, { opKey, invocationId });
  return { ok: true, invocationId, eventId };
}

/**
 * เคลียร์ poisoned ด้วยมือ (limitation 5: poison/ค้างทุกชนิด = battery ตายจนเคลียร์มือ) —
 * ผู้เรียกต้องระบุ intent · ใช้โดย operator/teardown ของ negative fixture เท่านั้น
 * หลังเคลียร์ attemptBegin จึงอนุญาต attempt ใหม่ได้
 */
export async function manualClearPoison(
  opKey: string,
  intent: string,
): Promise<void> {
  const prev = await invocationState(opKey);
  if (prev === null) throw new Error(`manualClearPoison: ไม่มี invocation ของ ${opKey}`);
  await ledgerWrite(
    "invocation",
    { status: "cleared-manual", intent, clearedFrom: prev.status, invocationId: prev.invocationId },
    { opKey, invocationId: prev.invocationId },
  );
}

/** ปิด invocation (append status ใหม่) — settle ปกติ / poison / unresolved */
export async function invocationClose(
  invocationId: string,
  opKey: string,
  status: "settled" | "poisoned" | "unresolved",
  detail: Record<string, unknown>,
): Promise<void> {
  await ledgerWrite("invocation", { status, ...detail }, { opKey, invocationId });
}

// ─── 5) opKey derivation + ua_nonce + before-snapshot + log cursor ───────────

/** kong-path: rpc name จาก path + method · app-direct: method + normalized route (strip uuid) */
export function deriveOpKey(
  transportTarget: "kong-path" | "app-direct",
  method: string,
  url: string,
): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
  if (transportTarget === "kong-path") {
    const m = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/i.exec(path);
    if (m !== null) return `rpc:${m[1] ?? ""}:${method.toUpperCase()}`;
    return `kong:${method.toUpperCase()}:${path}`;
  }
  const normalized = path.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    ":uuid",
  );
  return `app:${method.toUpperCase()}:${normalized}`;
}

/** path-normalized สำหรับเทียบใน access log — strip `/rest/v1` ตาม Kong strip_path (kong.yml:44) */
export function normalizePathForLog(transportTarget: "kong-path" | "app-direct", url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
  if (transportTarget === "kong-path") {
    return path.replace(/^\/rest\/v1/, "") || "/";
  }
  return path;
}

export function mintUaNonce(): string {
  return `ltc-inv-${randomUUID()}`;
}

export interface LogCursor {
  readonly capturedAt: string;
  readonly lineCount: number;
  readonly restStartedAt: string;
}

function dockerCompose(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", ...args], { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** จับ log cursor ก่อน dispatch: line-count ของ `docker compose logs rest` + StartedAt ของ container (read-only) */
export async function captureLogCursor(): Promise<LogCursor> {
  const logs = await dockerCompose(["logs", "rest", "--no-color", "--timestamps"]);
  if (logs.code !== 0) throw new Error(`captureLogCursor: docker compose logs rest failed: ${logs.stderr.slice(0, 200)}`);
  const lines = logs.stdout.split("\n").filter((l) => l.trim().length > 0);
  const started = await new Promise<string>((resolve) => {
    const child = spawn(
      "docker",
      ["inspect", "--format", "{{.State.StartedAt}}", "ltc-dev-rest"],
      { cwd: REPO_ROOT },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += String(c);
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve("unknown"));
  });
  return {
    capturedAt: new Date().toISOString(),
    lineCount: lines.length,
    restStartedAt: started,
  };
}

/** อ่าน window ของ access log จาก cursor — คืนทุก line (สด) ของ rest ตั้งแต่ cursor */
export async function readAccessLogWindow(cursor: LogCursor): Promise<string[]> {
  const logs = await dockerCompose(["logs", "rest", "--no-color", "--timestamps"]);
  if (logs.code !== 0) throw new Error(`readAccessLogWindow: docker compose logs rest failed: ${logs.stderr.slice(0, 200)}`);
  const lines = logs.stdout.split("\n").filter((l) => l.trim().length > 0);
  // docker compose logs ไม่การันตี stable global line-count ระหว่าง rotation — เรา dev-only
  // ไม่หมุน (json-file default) ดังนั้นนับแถวตั้งแต่ cursor ไปคือ window
  if (lines.length < cursor.lineCount) {
    throw new Error(`readAccessLogWindow: cursor เสีย (lines ${lines.length} < cursor ${cursor.lineCount}) — ปฏิเสธ`);
  }
  return lines.slice(cursor.lineCount);
}

export interface AccessLogFenceResult {
  readonly matches: number;
  readonly lines: string[];
  readonly restRestartedInWindow: boolean;
}

/**
 * access-log fence (r26-M1): หา line {ua_nonce + method + path-normalized + " <status> "}
 * หนึ่งต่อหนึ่งใน window · กำกวม (nonce >1 line · rest restart ใน window) = ปฏิเสธ
 * หมายเหตุ step-2 flake: line แรกหลัง restart อายาว/ช้า — caller poll ภายใน deadline
 */
export async function accessLogFence(
  cursor: LogCursor,
  probe: { uaNonce: string; method: string; pathNorm: string; status: number },
): Promise<AccessLogFenceResult> {
  const windowLines = await readAccessLogWindow(cursor);
  const methodUpper = probe.method.toUpperCase();
  const needle = `"${methodUpper} ${probe.pathNorm} HTTP/`;
  const statusNeedle = `" ${probe.status} `;
  const lines = windowLines.filter(
    (l) => l.includes(probe.uaNonce) && l.includes(needle) && l.includes(statusNeedle),
  );
  return {
    matches: lines.length,
    lines,
    restRestartedInWindow: cursor.restStartedAt !== "unknown" && await restStartedAfter(cursor.capturedAt),
  };
}

async function restStartedAfter(iso: string): Promise<boolean> {
  const child = spawn("docker", ["inspect", "--format", "{{.State.StartedAt}}", "ltc-dev-rest"], { cwd: REPO_ROOT });
  return await new Promise<boolean>((resolve) => {
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += String(c);
    });
    child.on("close", () => {
      const started = out.trim();
      resolve(started !== "" && started !== "unknown" && new Date(started).getTime() > new Date(iso).getTime());
    });
    child.on("error", () => resolve(false));
  });
}

/**
 * ตัดสิน kong-path 500 (r26-r30): มีสิทธิ์ evidence-settle เฉพาะ op ที่อยู่ใน
 * EVIDENCE_SETTLE_MANIFEST เท่านั้น — เขียนมือลอยไม่มีสิทธิ์ (limitation 22) ·
 * เรียงตามความกำกวม: rest restart ใน window = หลักฐานขาดความต่อเนื่อง → ปฏิเสธ
 * ก่อน · nonce เดียว >1 line = กำกวม · ไม่มี line = ไม่มี terminal ต้นทาง ·
 * ครบทุกเงื่อนไข + อยู่ manifest → 'completed-evidenced(rejected|state-changed)'
 */
export function kong500Decision(
  fence: { readonly matches: number; readonly restRestartedInWindow: boolean },
  opKey: string,
): { readonly settledAs: string; readonly terminal: boolean } {
  if (fence.restRestartedInWindow) {
    return { settledAs: "settle-refused-rest-restart-in-window", terminal: false };
  }
  if (fence.matches > 1) {
    return { settledAs: "settle-refused-ambiguous", terminal: false };
  }
  if (fence.matches === 0) {
    return { settledAs: "settle-refused-no-upstream-terminal", terminal: false };
  }
  if (manifestByOpKey(opKey) === undefined) {
    return { settledAs: "settle-refused-op-not-eligible", terminal: false };
  }
  return { settledAs: "completed-evidenced(rejected|state-changed)", terminal: true };
}

/** before-snapshot ของ touchSet — scoped ตาม entity keys · แถวว่าง = [] · stable key (r26) */
export async function beforeSnapshot(
  touchSet: ReadonlyArray<{ table: string; where: string; orderBy: string }>,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of touchSet) {
    const raw = await psql(
      `select coalesce(json_agg(q), '[]'::json)::text from (
         select * from ${t.table} where ${t.where} order by ${t.orderBy}
       ) q;`,
    );
    const rows = JSON.parse(raw.trim()) as unknown[];
    out[t.table] = rows.map((r) => stableKeySort(r as Record<string, unknown>));
  }
  return out;
}

function stableKeySort(row: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(row).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = row[k];
  return sorted;
}

// ─── 6) PsqlSession (session identity: nonce + pid + backend_start) ──────────

export interface PsqlSessionIdentity {
  readonly nonce: string;
  readonly pid: number;
  readonly backendStart: string;
}

export interface PsqlSession {
  readonly identity: PsqlSessionIdentity;
  /** รัน SQL ใน session (stdin) เก็บผลลัพธ์ตอน prompt กลับ */
  exec(sql: string, opts?: { timeoutMs?: number }): Promise<string>;
  /** จบ session (exit code จริงคืนมา) — ค้างเกิน killAfterMs (default 15s) = SIGKILL
   *  fallback (8i: session ที่ backend ยุ่งอยู่กับ query ยาวต้องจบได้แบบมีขอบเขต) */
  end(opts?: { killAfterMs?: number }): Promise<number>;
}

/**
 * session ยาว (interactive psql -At) พร้อม identity: set application_name=<nonce>
 * แล้วอ่าน pg_backend_pid()/backend_start จาก pg_stat_activity — ผูก ledger 'session'
 * recovery หา backend ด้วย nonce+pid · backend_start ต่าง = pid-reuse (r24-r28)
 */
export async function startPsqlSession(label: string): Promise<PsqlSession> {
  await ensureTestInfra();
  const nonce = `ltc_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const child: ChildProcessWithoutNullStreams = spawn(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "db",
      "sh",
      "-c",
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=0 -At',
    ],
    { cwd: REPO_ROOT },
  ) as ChildProcessWithoutNullStreams;
  let buf = "";
  const pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; mark: string }> = [];
  child.stdout.on("data", (c: Buffer) => {
    buf += String(c);
    for (;;) {
      const next = pending[0];
      if (next === undefined) return;
      const idx = buf.indexOf(next.mark);
      if (idx === -1) return;
      const out = buf.slice(0, idx);
      buf = buf.slice(idx + next.mark.length);
      pending.shift();
      clearTimeout(next.timer);
      next.resolve(out);
    }
  });
  child.stderr.on("data", (c: Buffer) => {
    process.stderr.write(`[psql-session ${nonce}] ${String(c)}`);
  });
  const markSeq = { n: 0 };
  const exec = (sql: string, opts?: { timeoutMs?: number }): Promise<string> => {
    const mark = `__LTC_MARK_${markSeq.n++}__`;
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.shift();
        reject(new Error(`psql session exec timeout after ${timeoutMs}ms: ${sql.slice(0, 120)}`));
      }, timeoutMs);
      pending.push({ resolve, reject, timer, mark });
      child.stdin.write(`${sql}\nselect '${mark}';\n`);
    });
  };
  // identity
  await exec(`set application_name = '${nonce}';`);
  const idRaw = await exec(
    `select pg_backend_pid() || '|' || (select backend_start::text from pg_stat_activity where pid = pg_backend_pid());`,
  );
  const [pidRaw, backendStart] = idRaw.trim().split("|");
  const pid = Number(pidRaw);
  if (!Number.isFinite(pid)) throw new Error(`startPsqlSession: pid อ่านไม่ได้: ${idRaw}`);
  const identity: PsqlSessionIdentity = { nonce, pid, backendStart: backendStart ?? "?" };
  await ledgerWrite("session", { label, ...identity });
  return {
    identity,
    exec,
    end: async (opts?: { killAfterMs?: number }) => {
      const killAfterMs = opts?.killAfterMs ?? 15_000;
      return await new Promise<number>((resolve) => {
        const killer = setTimeout(() => {
          child.kill("SIGKILL");
        }, killAfterMs);
        child.on("close", (c) => {
          clearTimeout(killer);
          resolve(c ?? -1);
        });
        child.stdin.end();
      });
    },
  };
}

/** ค้นหา backend ด้วย nonce+pid — คืน {found, backendStart} (ไม่ตรง = pid-reuse) */
export async function findBackendByNonce(
  nonce: string,
  pid: number,
): Promise<{ found: boolean; state: string | null; backendStart: string | null }> {
  const raw = await psql(
    `select state::text, backend_start::text from pg_stat_activity
     where pid = ${pid} and application_name = '${nonce}';`,
  );
  const line = raw.trim();
  if (line === "") return { found: false, state: null, backendStart: null };
  const [state, backendStart] = line.split("|");
  return { found: true, state: state ?? null, backendStart: backendStart ?? null };
}

/** pg_terminate_backend — คืนสำเร็จ/ไม่ (terminate-error = transient ไม่มีป้าย ERR- — F53)
 * เทียบ 'true' เพราะ ::text ของ boolean = 'true'/'false' (ไม่ใช่ t/f ของ psql display) */
export async function terminateBackend(pid: number): Promise<boolean> {
  const raw = await psql(`select pg_terminate_backend(${pid})::text;`);
  return raw.trim() === "true";
}

// ─── 7) sqlWrite (normal/abnormal — r23) ─────────────────────────────────────

export interface SqlWriteResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly invocationId: string;
  readonly opKey: string;
  readonly settled: "completed" | "poisoned";
  readonly settleReason?: string;
}

/**
 * SQL write ผ่านจุดกลาง — normal = downstream-acknowledged (exit 0 + ON_ERROR_STOP)
 * → settled 'completed' · abnormal (exit ≠ 0 / spawn ตาย) = ห้าม settle ตาม Promise คืน —
 * เปิด invocation 'running' + track backend ด้วย nonce+pid จน terminal ภายใน deadline
 * เกิน = pg_terminate_backend + poison (r23-r28) · หาไม่เจอ = unresolved → poison
 */
export async function sqlWrite(
  sql: string,
  opts: {
    opKey: string;
    label: string;
    invocationId?: string;
    trackDeadlineMs?: number;
    onErrorStop?: boolean;
  },
): Promise<SqlWriteResult> {
  const admit = transportAdmit();
  if (!admit.ok) throw new Error(`sqlWrite refused: ${admit.reason}`);
  const nonce = `ltc_sql_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const invocationId = opts.invocationId ?? randomUUID();
  await ledgerWrite(
    "invocation",
    { status: "running", label: opts.label, opKey: opts.opKey, transport: "sqlWrite", sessionNonce: nonce },
    { opKey: opts.opKey, invocationId },
  );
  await ledgerWrite(
    "attempt",
    { transport: "sqlWrite", sessionNonce: nonce, onErrorStop: opts.onErrorStop !== false },
    { opKey: opts.opKey, invocationId },
  );
  const wrapped = `set application_name = '${nonce}';\n${sql}\n`;
  const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        `PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres ${
          opts.onErrorStop !== false ? "-v ON_ERROR_STOP=1" : ""
        } -At`,
      ],
      { cwd: REPO_ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.write(wrapped);
    child.stdin.end();
  });
  if (run.code === 0) {
    await invocationClose(invocationId, opts.opKey, "settled", {
      class: "completed",
      transport: "sqlWrite",
      exitCode: 0,
    });
    return { exitCode: 0, stdout: run.stdout, stderr: run.stderr, invocationId, opKey: opts.opKey, settled: "completed" };
  }
  // abnormal — track backend ด้วย nonce จนหาย/terminal ภายใน deadline (r23)
  const deadline = opts.trackDeadlineMs ?? 15_000;
  const started = Date.now();
  for (;;) {
    const raw = await psql(
      `select coalesce(string_agg(pid::text, ','), '') from pg_stat_activity where application_name = '${nonce}';`,
    );
    const pids = raw.trim().split(",").map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0);
    if (pids.length === 0) break;
    if (Date.now() - started > deadline) {
      for (const pid of pids) await terminateBackend(pid);
      await invocationClose(invocationId, opts.opKey, "poisoned", {
        reason: "sql-abnormal-backend-overstayed-deadline",
        exitCode: run.code,
        stderr: run.stderr.slice(0, 400),
      });
      return { exitCode: run.code, stdout: run.stdout, stderr: run.stderr, invocationId, opKey: opts.opKey, settled: "poisoned", settleReason: "sql-abnormal-backend-overstayed-deadline" };
    }
    await sleep(300);
  }
  await invocationClose(invocationId, opts.opKey, "settled", {
    class: "completed",
    transport: "sqlWrite",
    exitCode: run.code,
    note: "abnormal-exit-but-backend-terminal (rollback/finished)",
  });
  return { exitCode: run.code, stdout: run.stdout, stderr: run.stderr, invocationId, opKey: opts.opKey, settled: "completed", settleReason: "abnormal-exit-but-backend-terminal" };
}

// ─── 8) httpWrite (opKey/binding/ua_nonce + settle ตาม provenance) ──────────

export type TransportTarget = "kong-path" | "app-direct";

export interface HttpWriteResult {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  readonly invocationId: string;
  readonly opKey: string;
  readonly uaNonce: string;
  readonly settledAs: string;
}

export interface HttpWriteOptions {
  readonly opKeyHint?: string;
  readonly apiKey?: string;
  readonly token?: string | null;
  readonly invocationId?: string;
  readonly transportTarget?: TransportTarget;
  readonly label?: string;
  /** touchSet สำหรับ before-snapshot (manifest op เท่านั้น) */
  readonly touchSet?: ReadonlyArray<{ table: string; where: string; orderBy: string }>;
  readonly callerGeneration?: string;
  /** signal ของ caller — abort กลาง dispatch ได้ (scenario commit-after-abort 8k/8m/8n) */
  readonly signal?: AbortSignal;
  /** header เพิ่มของ caller (cookie/origin/x-forwarded-for ของ BFF — D89-3: httpWrite ครอบ bffPatch) */
  readonly extraHeaders?: Record<string, string>;
  /** 'scenario' = ผู้เรียกเป็นผู้ settle เองผ่าน settleHttpWithEvidence — transport
   *  ห้ามปิด invocation เองไม่ว่าจะได้ response หรือ error (row คง 'running') */
  readonly settleMode?: "auto" | "scenario";
}

/** http write ผ่านจุดกลาง — ทุก dispatch: binding immutable + ua_nonce + cursor + snapshot */
export async function httpWrite(
  method: string,
  url: string,
  body: unknown,
  opts: HttpWriteOptions = {},
): Promise<HttpWriteResult> {
  const admit = transportAdmit(opts.callerGeneration);
  if (!admit.ok) throw new Error(`httpWrite refused: ${admit.reason}`);
  const transportTarget: TransportTarget = opts.transportTarget ?? "kong-path";
  const derived = deriveOpKey(transportTarget, method, url);
  const opKey = derived;
  if (opts.opKeyHint !== undefined && opts.opKeyHint !== derived) {
    await ledgerWrite("note", { event: "op-key-mismatch", hint: opts.opKeyHint, derived });
  }
  const uaNonce = mintUaNonce();
  const invocationId = opts.invocationId ?? randomUUID();
  const cursor = transportTarget === "kong-path" ? await captureLogCursor() : null;
  const snapshot =
    opts.touchSet !== undefined && opts.touchSet.length > 0 ? await beforeSnapshot(opts.touchSet) : null;
  await ledgerWrite(
    "invocation",
    {
      status: "running",
      label: opts.label ?? "httpWrite",
      opKey,
      transport: "httpWrite",
      transportTarget,
      binding: { opKey, method: method.toUpperCase(), urlNormalized: normalizePathForLog(transportTarget, url), uaNonce },
    },
    { opKey, invocationId },
  );
  await ledgerWrite(
    "attempt",
    { transport: "httpWrite", uaNonce, parentCallKey: null, logCursor: cursor, beforeSnapshot: snapshot },
    { opKey, invocationId },
  );
  const headers: Record<string, string> = {
    apikey: opts.apiKey ?? ANON_KEY,
    accept: "application/json",
    "user-agent": uaNonce,
  };
  if (opts.token !== undefined && opts.token !== null) {
    headers["authorization"] = `Bearer ${opts.token}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
    headers[k] = v;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (opts.signal !== undefined) init.signal = opts.signal;
  let status = -1;
  let text = "";
  let json: unknown = null;
  try {
    const response = await fetch(url.startsWith("http") ? url : `${REST_URL}${url}`, init);
    status = response.status;
    text = await response.text();
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
  } catch (err) {
    // abort/network — scenario mode: ผู้เรียกถือหลักฐาน (handshake pid) และเป็นคน
    // settle เอง → คง 'running' + โยนต่อ · auto mode: ชั้นกลางไม่มีหลักฐาน terminal
    // → poison (ต้อง singleDispatch+terminalLink ตาม manifest)
    if (opts.settleMode === "scenario") {
      await ledgerWrite(
        "note",
        { event: "http-error-held-running", uaNonce, opKey, error: String(err).slice(0, 200) },
        { opKey, invocationId },
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
    await invocationClose(invocationId, opKey, "poisoned", {
      reason: "settle-refused-no-terminal-link",
      error: String(err).slice(0, 300),
    });
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (opts.settleMode === "scenario") {
    // ได้ response แล้วแต่ scenario ยังไม่ settle — เช่น 5xx ขณะ downstream ยังไม่
    // terminal (8l: ต้องแน่ใจ backend จบก่อน) — คง 'running' ให้ผู้เรียกตัดสิน
    await ledgerWrite(
      "note",
      { event: "http-response-held-running", uaNonce, opKey, status },
      { opKey, invocationId },
    );
    return { status, json, text, invocationId, opKey, uaNonce, settledAs: "held-running" };
  }
  // completion ตาม provenance (r26-r28):
  // kong-path /rest/v1: 2xx/4xx = confirmed · 500 = ต้อง access-log fence (ของ rest)
  // kong-path อื่น (/auth/v1 ฯลฯ): 5xx ทุกตัว = gateway class — fence ของ rest ใช้เทียบ
  //   ไม่ได้ (upstream คนละตัว · วัดจริง: auth กำลัง stop ระบาย request บางส่วน ตอบ 500
  //   ทั้งที่ส่วนมากได้ 503 — ทั้งคู่ไม่มี terminal ต้นทาง = retryable unresolved)
  // app-direct: 2xx/4xx = confirmed · 5xx = evidenced เมื่อมี manifest (ที่ชั้นนี้ยังไม่มี manifest
  //   ก็ confirmed-by-handler-response ตาม route contract — manifest settle engine ทำชั้นบน)
  const urlPath = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
  const restUpstream = transportTarget === "kong-path" && urlPath.startsWith("/rest/v1");
  const class5xxGateway =
    status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
  let settledAs: string;
  if (status >= 200 && status < 500) {
    settledAs = `confirmed-${status}`;
    await invocationClose(invocationId, opKey, "settled", { class: settledAs, transportTarget });
  } else if (status === 500 && restUpstream && cursor !== null) {
    const fence = await accessLogFence(cursor, {
      uaNonce,
      method,
      pathNorm: normalizePathForLog(transportTarget, url),
      status: 500,
    });
    const decision = kong500Decision(fence, opKey);
    settledAs = decision.settledAs;
    if (decision.terminal) {
      await invocationClose(invocationId, opKey, "settled", { class: settledAs, transportTarget, fenceLine: fence.lines[0]?.slice(0, 400) });
    } else {
      await invocationClose(invocationId, opKey, "poisoned", { reason: settledAs, transportTarget, matches: fence.matches });
    }
  } else if (class5xxGateway || (status === 500 && transportTarget === "kong-path")) {
    // gateway class: 502/503/504/52x ทุก transport + kong-path 500 ที่ไม่มี fence
    // ประกอบ (auth-upstream ตาย/draining) = retryable ไม่มี terminal ต้นทาง —
    // ห้าม settle (unresolved จนกว่าจะมีหลักฐาน terminal) · app-direct 500 อยู่ else
    // ท้าย (handler จบจริง = evidenced)
    settledAs = "unresolved-gateway";
    await invocationClose(invocationId, opKey, "unresolved", { class: settledAs, transportTarget });
  } else {
    // app-direct 5xx หรืออื่น — handler จบจริง (response มาถึง) — evidenced ที่ชั้น manifest
    settledAs = `evidenced-${status}`;
    await invocationClose(invocationId, opKey, "settled", { class: settledAs, transportTarget });
  }
  return { status, json, text, invocationId, opKey, uaNonce, settledAs };
}

/** settle decision row เดียว (r26-m1/r27): scan+การตัดสินคู่กันใน row เดียว — ห้ามแยกสอง event */
export async function writeSettleDecision(
  invocationId: string,
  opKey: string,
  decision: string,
  scanClean: boolean,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return ledgerWrite(
    "settle-decision",
    { decisionId: randomUUID(), invocationId, scanClean, decision, ...extra },
    { opKey, invocationId },
  );
}

// ─── 8b) settle engine ชั้นบน — evidence-based settle (barrier suite 8k-8o) ────

export type SettleRefusal =
  | "settle-refused-retry-capable" // op retry-capable (manifest singleDispatch=false) + claim ไร้ response — scan สะอาดก็ห้าม settle (8o)
  | "settle-refused-blocked-backend" // backend ที่ handshake จับได้ยังมีชีวิต — settle เดี๋ยวนี้ไม่ได้
  | "settle-refused-no-terminal-link"; // อ้างจบแต่ไม่มีหลักฐาน terminal (response/scan) — ห้าม settle

export interface SettleHttpEvidenceOptions {
  /** pid ของ backend ที่ handshake จับได้ (ตรงกับ invocation) — scan ตัดสินก่อน claim เสมอ */
  readonly blockerPids?: readonly number[];
  /** 'evidenced' = response มาถึงแล้ว (เช่น 5xx) · 'evidenced-no-response' = ไม่มี response (abort/kill) */
  readonly claimed: "evidenced" | "evidenced-no-response";
  /** status ที่จับได้จาก response จริง (claimed 'evidenced' ต้องมี — ไม่ใช่คำบอกเล่า) */
  readonly responseStatus?: number;
  readonly label?: string;
}

export interface SettleHttpEvidenceResult {
  readonly settled: boolean;
  readonly decision: string;
  readonly refusal?: SettleRefusal;
  readonly terminalLink?: { pids: number[]; checkedAt: string };
}

/** pid ที่ "ยังไม่ terminal": ยังมีชีวิตและ state ≠ 'idle' — กำลัง active-query
 *  (รวมรอ lock) หรือ TX ค้าง (idle in transaction = ถือ lock อยู่) · backend
 *  pooled ของ PostgREST ที่ commit แล้วจะนั่ง 'idle' = terminal จริง (lock ปล่อย
 *  แล้ว ไม่มีงานต่อจาก invocation เดิม) — จำแนกด้วยสถานะ ไม่ใช่การมีชีวิตเปล่าๆ
 *  (พิสูจน์ด้วย 8m รอบแรก: pid ยังอยู่หลัง commit แต่ idle) */
export async function pidsBusy(pids: readonly number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  const raw = await psql(
    `select pid::text from pg_stat_activity
     where pid = any('{${pids.join(",")}}'::int[]) and state <> 'idle';`,
  );
  return raw
    .trim()
    .split("\n")
    .map((l) => Number(l))
    .filter((p) => Number.isFinite(p) && p > 0);
}

/**
 * settle ด้วยหลักฐานจริง ไม่ใช่คำบอกเล่า (r22 8m/8n · r25 fabricated-500):
 * (1) scan ก่อน claim เสมอ — blockerPids ยังมีชีวิต = ปฏิเสธ blocked-backend
 *     (claim 5xx ที่แจ้งมาหลัง backend ยังยุ่ง = fabricated — scan ชนะ)
 * (2) claimed 'evidenced-no-response' (abort/kill ก่อนได้ response): ต้องมี
 *     attribution (blockerPids ที่ scan ตายหมดแล้ว) — ไม่มี = no-terminal-link
 * (3) claimed 'evidenced': ต้องมี responseStatus จริงติดมือ — ไม่มี = no-terminal-link
 * (4) ผ่าน = settle-decision row เดียว (scan+decision คู่กัน) + invocationClose settled
 */
export async function settleHttpWithEvidence(
  opKey: string,
  opts: SettleHttpEvidenceOptions,
): Promise<SettleHttpEvidenceResult> {
  const inv = await invocationState(opKey);
  if (inv === null) {
    throw new Error(`settleHttpWithEvidence: ไม่เจอ invocation ของ opKey ${opKey}`);
  }
  if (inv.status !== "running") {
    throw new Error(
      `settleHttpWithEvidence: invocation ${inv.invocationId} (${opKey}) สถานะ ${inv.status} แล้ว — settle ซ้ำ?`,
    );
  }
  const invocationId = inv.invocationId;
  const label = opts.label ?? "settleHttpWithEvidence";
  // (0) op retry-capable (manifest singleDispatch=false) + claim ไร้ response —
  //     settle ตาม scan ล้วยมีโอกาสหลอก: transport อาจ dispatch ซ้ำหลัง scan สะอาด
  //     (users.ts loop 250/600ms) — ห้าม settle ไม่ว่า scan/attribution จะสวยแค่ไหน
  //     · scan ยังรันเพื่อบันทึกความจริง (scanClean = ผล scan ณ ตอนนั้น) · claim
  //     'evidenced' (response จริงมาถึง transport) ไม่อยู่ข้อนี้ — response = terminal (r24-r30 8o)
  const manifestEntry = manifestByOpKey(opKey);
  if (manifestEntry !== undefined && !manifestEntry.singleDispatch && opts.claimed === "evidenced-no-response") {
    const busyNow = await pidsBusy(opts.blockerPids ?? []);
    await writeSettleDecision(invocationId, opKey, "settle-refused-retry-capable", busyNow.length === 0, {
      busyPids: busyNow,
      retryCapable: true,
      label,
      claimed: opts.claimed,
    });
    return {
      settled: false,
      decision: "settle-refused-retry-capable",
      refusal: "settle-refused-retry-capable",
    };
  }
  // (1) scan ก่อน claim เสมอ
  const busy = await pidsBusy(opts.blockerPids ?? []);
  if (busy.length > 0) {
    await writeSettleDecision(invocationId, opKey, "settle-refused-blocked-backend", false, {
      busyPids: busy,
      label,
      claimed: opts.claimed,
    });
    return {
      settled: false,
      decision: "settle-refused-blocked-backend",
      refusal: "settle-refused-blocked-backend",
    };
  }
  // (2)+(3) ตรวจหลักฐานตาม claim
  if (opts.claimed === "evidenced-no-response") {
    const pids = opts.blockerPids ?? [];
    if (pids.length === 0) {
      await writeSettleDecision(invocationId, opKey, "settle-refused-no-terminal-link", false, {
        label,
        note: "no-attribution",
      });
      return {
        settled: false,
        decision: "settle-refused-no-terminal-link",
        refusal: "settle-refused-no-terminal-link",
      };
    }
    const terminalLink = { pids: [...pids], checkedAt: new Date().toISOString() };
    await writeSettleDecision(invocationId, opKey, "completed-evidenced-no-response", true, {
      terminalLink,
      label,
    });
    await invocationClose(invocationId, opKey, "settled", {
      class: "completed-evidenced-no-response",
      transport: "settleHttpWithEvidence",
      terminalLink,
    });
    return { settled: true, decision: "completed-evidenced-no-response", terminalLink };
  }
  if (typeof opts.responseStatus !== "number" || !Number.isFinite(opts.responseStatus)) {
    await writeSettleDecision(invocationId, opKey, "settle-refused-no-terminal-link", false, {
      label,
      note: "no-response-evidence",
    });
    return {
      settled: false,
      decision: "settle-refused-no-terminal-link",
      refusal: "settle-refused-no-terminal-link",
    };
  }
  const terminalLink =
    (opts.blockerPids ?? []).length > 0
      ? { pids: [...(opts.blockerPids ?? [])], checkedAt: new Date().toISOString() }
      : undefined;
  await writeSettleDecision(invocationId, opKey, "completed-evidenced", true, {
    responseStatus: opts.responseStatus,
    terminalLink: terminalLink ?? null,
    label,
  });
  await invocationClose(invocationId, opKey, "settled", {
    class: "completed-evidenced",
    transport: "settleHttpWithEvidence",
    responseStatus: opts.responseStatus,
    terminalLink: terminalLink ?? null,
  });
  return {
    settled: true,
    decision: "completed-evidenced",
    ...(terminalLink !== undefined ? { terminalLink } : {}),
  };
}

// ─── 9) EVIDENCE_SETTLE_MANIFEST (machine-verified · opKey = transport-derived) ──

export interface TouchSetSpecEntry {
  readonly table: string;
  /** ชื่อ param ของ entity key ใน where template เช่น 'id = :uuid' — caller แทนค่าจริงตอน dispatch */
  readonly whereTemplate: string;
  readonly orderBy: string;
}

export interface ManifestEntry {
  /** opKey ตาม deriveOpKey — runtime settle เช็ค opKey กับ manifest ด้วยค่านี้เท่านั้น */
  readonly opKey: string;
  readonly label: string;
  readonly transportTarget: TransportTarget;
  readonly singleDispatch: boolean;
  readonly finalMutation: string;
  readonly touchSet: readonly TouchSetSpecEntry[];
  /** ไฟล์ SDK/handler ที่ AST ต้องเห็นการเรียกจริง (two-layer verify: AST + catalog + sdkTargets) */
  readonly sdkTargets: readonly string[];
}

/**
 * manifest 5 entry ตามแผน r26-r30 — entry เพิ่มใหม่ได้ต่อเมื่อผ่าน AST+catalog+sdkTargets
 * must-equal (scripts/verify-settle-manifest.mjs) — เขียนมือลอยไม่มีสิทธิ์ settle (limitation 22)
 */
export const EVIDENCE_SETTLE_MANIFEST: readonly ManifestEntry[] = [
  {
    // route จริง: question-banks/[id]/questions/[qid]/route.ts · PATCH :129 → rpc admin_update_question :150
    opKey: "app:PATCH:/api/v1/admin/question-banks/:uuid/questions/:uuid",
    label: "qb-patch-admin-update-question",
    transportTarget: "app-direct",
    singleDispatch: true,
    finalMutation: "rpc admin_update_question → public.questions + audit append",
    touchSet: [
      { table: "public.questions", whereTemplate: "id = :uuid", orderBy: "id" },
    ],
    sdkTargets: ["src/app/api/v1/admin/question-banks/[id]/questions/[qid]/route.ts"],
  },
  {
    // status route จริง export PATCH (ไม่ใช่ POST) :80 → rpc admin_set_question_status :102
    opKey: "app:PATCH:/api/v1/admin/question-banks/:uuid/questions/:uuid/status",
    label: "admin-set-question-status",
    transportTarget: "app-direct",
    singleDispatch: true,
    finalMutation: "rpc admin_set_question_status → questions.status + audit",
    touchSet: [
      { table: "public.questions", whereTemplate: "id = :uuid", orderBy: "id" },
    ],
    sdkTargets: ["src/app/api/v1/admin/question-banks/[id]/questions/[qid]/status/route.ts"],
  },
  {
    opKey: "app:PATCH:/api/v1/admin/users/:uuid",
    label: "admin-set-user-active",
    transportTarget: "app-direct",
    singleDispatch: false, // users.ts:595-615 retry loop ≤3 — dispatch หลายครั้งใน invocation เดียว
    finalMutation: "rpc admin_set_user_active → profiles.is_active + audit",
    touchSet: [
      { table: "public.profiles", whereTemplate: "id = :uuid", orderBy: "id" },
    ],
    sdkTargets: [
      "src/app/api/v1/admin/users/[id]/route.ts",
      "src/lib/admin/users.ts",
    ],
  },
  {
    opKey: "rpc:admin_revoke_role:POST",
    label: "admin-revoke-role",
    transportTarget: "kong-path",
    singleDispatch: true,
    finalMutation: "UPDATE role_assignments (revoked_at) — 0 แถว→P0002 no-op (0035:502-560)",
    touchSet: [
      { table: "public.role_assignments", whereTemplate: "user_id = :uuid", orderBy: "granted_at" },
    ],
    sdkTargets: ["tests/integration/dcr12-p5r1-hardening.test.ts"],
  },
  {
    opKey: "rpc:complete_data_export_job:POST",
    label: "complete-data-export-job",
    transportTarget: "kong-path",
    singleDispatch: true,
    finalMutation: "data_export_jobs + audit_logs + event_outbox (0039 — guard P0002 ก่อนทุก write)",
    touchSet: [
      { table: "public.data_export_jobs", whereTemplate: "id = :uuid", orderBy: "id" },
    ],
    sdkTargets: ["src/lib/pdpa/export.ts"], // export.ts:258 client.rpc("complete_data_export_job")
  },
];

export function manifestByOpKey(opKey: string): ManifestEntry | undefined {
  return EVIDENCE_SETTLE_MANIFEST.find((e) => e.opKey === opKey);
}

/** สร้าง touchSet จริงจาก spec + params (entity keys ของ invocation)
 * ค่า string แทนแบบ quoted literal (escape ' เป็น '') — ไม่งั้น where เป็น SQL ที่ใช้ไม่ได้ */
export function buildTouchSet(
  entry: ManifestEntry,
  params: Record<string, string>,
): Array<{ table: string; where: string; orderBy: string }> {
  return entry.touchSet.map((t) => ({
    table: t.table,
    where: t.whereTemplate.replace(/:([a-z_]+)/g, (_m, k: string) => {
      const v = params[k];
      if (v === undefined) return `:missing-${k}`;
      return `'${v.replace(/'/g, "''")}'`;
    }),
    orderBy: t.orderBy,
  }));
}

// ─── 10) trackedClient (SDK fetch-injection — r22-r28) ───────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** RPC ที่พิสูจน์แล้วว่าอ่านอย่างเดียว (read-only) — นอกนี้ทุก rpc = write (default-deny, limitation 19) */
export const SDK_READ_ONLY_RPC = new Set<string>([]); // เติมเมื่อมีหลักฐาน probe จริงต่อ entry

export interface TrackedClient {
  readonly client: SupabaseClient;
  readonly parentCallKey: string;
}

export interface TrackedClientOptions {
  readonly label: string;
  readonly supabaseUrl?: string;
  readonly apiKey?: string;
  /** invocation ของ scenario (ถ้ามี — attempt rows ผูกเข้า) · ไม่มี = attempt-level tracking เท่านั้น */
  readonly invocationId?: string;
  readonly opKey?: string;
  readonly callerGeneration?: string;
}

/**
 * SDK factory + fetch injection — ทุก request ของ SDK (รวม retry ภายใน parent invocation
 * เดียวกัน — แต่ละครั้ง = dispatch ใหม่ = ua_nonce ใหม่ + attempt row ผูก parent_call_key)
 * ผ่านจุดกลาง: admit → nonce → classify → attempt row → dispatch → บันทึก status
 * (r29-m1: transport ไม่ปรึกษา attemptBegin — retry ภายใน invocation เดิมไม่ผ่าน guard)
 */
export function createTrackedClient(opts: TrackedClientOptions): TrackedClient {
  const parentCallKey = `sdk-${randomUUID()}`;
  const url = opts.supabaseUrl ?? REST_URL;
  const apiKey = opts.apiKey ?? ANON_KEY;
  const trackedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const admit = transportAdmit(opts.callerGeneration);
    if (!admit.ok) throw new Error(`trackedClient refused: ${admit.reason}`);
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = rawUrl.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
    const opKey = opts.opKey ?? deriveOpKey("kong-path", method, rawUrl);
    const uaNonce = mintUaNonce();
    const isRpc = /^\/rest\/v1\/rpc\//.test(path);
    const readOnly = !isRpc ? method === "GET" || method === "HEAD" : SDK_READ_ONLY_RPC.has((path.split("/").pop() ?? ""));
    const classification = readOnly ? "read" : "write"; // unknown = write เสมอ (default-deny)
    const attemptEventId = await ledgerWrite(
      "attempt",
      {
        transport: "sdk",
        uaNonce,
        parentCallKey,
        method,
        urlNorm: normalizePathForLog("kong-path", rawUrl),
        classification,
        status: null,
      },
      { opKey, invocationId: opts.invocationId },
    );
    const headers = new Headers(init?.headers);
    headers.set("user-agent", uaNonce);
    const nextInit: RequestInit = { ...init, headers };
    if (init?.method !== undefined) nextInit.method = init.method;
    const response = await fetch(rawUrl, nextInit);
    await ledgerWrite(
      "attempt",
      {
        transport: "sdk",
        parentCallKey,
        outcome: true,
        attemptEventId,
        status: response.status,
        classification,
      },
      { opKey, invocationId: opts.invocationId },
    );
    return response;
  };
  const client = createClient(url, apiKey, {
    global: { fetch: trackedFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, parentCallKey };
}

/**
 * tests/integration/window-coordinator.ts — Wave H D89-2 [#94] (gate แผน r30 APPROVED)
 *
 * coordinator ครบวงของ battery window: runtime pre-check → snapshot → ปิด intake
 * (gate closed + cron pause + mailer stop) → drain ระดับ invocation (worker_lease +
 * in-flight=0) → ปิด/เปิด window พร้อม refcount → restore ตาม snapshot → overlap audit
 *
 * ของจริงที่ตรวจแล้ว (D-f-13): pg_cron 1.6 · cron.job = {jobid, schedule, command,
 * nodename, nodeport, database, username, active, jobname} — ไม่มี log_run/alter_job
 * log_run · cron.job_run_details มีจริงและบันทึกทุก run โดย default (45 rows/10 นาที)
 * → overlap audit ใช้ job_run_details (เสมือน log_run=on ตามแผน) · mailer =
 * ltc-dev-mailer (docker compose service "mailer")
 *
 * dev-only ทั้งหมด · gate/lease อยู่ใน schema test_infra (runtime DDL idempotent —
 * ไม่มีใน production migrations) · refcount/holders เห็นข้าม process (battery-run.mjs
 * อ่านได้ — limitation 15: ALS token ใช้ได้เฉพาะ process vitest เดียว)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO_ROOT, psql } from "./helpers";
import { ensureTestInfra, ledgerWrite, windowSet } from "./test-io";

// ─── runtime DDL (idempotent) ─────────────────────────────────────────────────

const WINDOW_DDL = `
create table if not exists test_infra.worker_gate (
  id int primary key default 1 check (id = 1),
  is_open boolean not null default true,
  generation text not null default 'gen-0',
  holders text[] not null default '{}',
  updated_at timestamptz not null default now()
);
insert into test_infra.worker_gate (id) values (1) on conflict (id) do nothing;
create table if not exists test_infra.worker_lease (
  lease_id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('route','direct')),
  owner text not null,
  heartbeat_at timestamptz not null default now(),
  invocation_id uuid,
  created_at timestamptz not null default now()
);
`;

let windowDdlReady = false;

export async function ensureWindowInfra(): Promise<void> {
  if (windowDdlReady) return;
  await ensureTestInfra();
  await psql(WINDOW_DDL);
  windowDdlReady = true;
}

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

// ─── gate state ───────────────────────────────────────────────────────────────

export interface GateState {
  readonly isOpen: boolean;
  readonly generation: string;
  readonly holders: string[];
}

export async function gateState(): Promise<GateState> {
  await ensureWindowInfra();
  // bool ฉายเป็น '1'/'0' เอง (ห้าม ::text — ได้ 'true'/'false' ไม่ใช่ t/f ของ psql)
  const raw = await psql(
    `select case when is_open then '1' else '0' end || '|' || generation || '|' || array_to_string(holders, ',')
     from test_infra.worker_gate where id = 1;`,
  );
  const [isOpen, generation, holders] = raw.trim().split("|");
  return {
    isOpen: isOpen === "1",
    generation: generation ?? "",
    holders: (holders ?? "").split(",").filter((h) => h.length > 0),
  };
}

// ─── borrow/release (refcount ใต้ row lock จุดเดียว) ──────────────────────────

async function borrowHolder(holderId: string): Promise<string[] | null> {
  await ensureWindowInfra();
  // atomic: เพิ่ม holder ได้ต่อเมื่อไม่มี holder คนอื่นอยู่ (battery serial — limitation 11
  // แต่ guard ไว้ที่ UPDATE เอง ไม่พึ่ง read-then-throw) · re-borrow คนเดิมไม่ append ซ้ำ
  // -q เพื่อตัด "UPDATE n" tag (0 rows = stdout ว่างจริง) · คืน null = overlap
  const raw = await psql(
    `update test_infra.worker_gate
     set holders = case when '${holderId}' = any(holders) then holders
                        else array_append(holders, '${holderId}') end,
         updated_at = now()
     where id = 1 and (cardinality(holders) = 0 or '${holderId}' = any(holders))
     returning array_to_string(holders, ',');`,
    { quiet: true },
  );
  const line = raw.trim();
  if (line === "") return null;
  return line.split(",").filter((h) => h.length > 0);
}

async function releaseHolder(holderId: string): Promise<string[]> {
  const raw = await psql(
    `update test_infra.worker_gate
     set holders = array_remove(holders, '${holderId}'), updated_at = now()
     where id = 1
     returning array_to_string(holders, ',');`,
    { quiet: true },
  );
  return raw.trim().split(",").filter((h) => h.length > 0);
}

// ─── snapshot + cron pause/resume + docker service ────────────────────────────

export interface CronJobSnapshot {
  readonly jobid: number;
  readonly active: boolean;
}

async function snapshotCron(): Promise<CronJobSnapshot[]> {
  const raw = await psql(
    `select coalesce(json_agg(q), '[]'::json)::text from (
       select jobid, case when active then 1 else 0 end as active from cron.job order by jobid
     ) q;`,
  );
  return (JSON.parse(raw.trim()) as Array<{ jobid: number; active: number }>).map((j) => ({
    jobid: Number(j.jobid),
    active: Number(j.active) === 1,
  }));
}

async function pauseCronJobs(jobids: number[]): Promise<void> {
  for (const id of jobids) {
    await psql(`select cron.alter_job(${id}, active := false);`);
  }
}

async function resumeCronJobs(jobids: number[]): Promise<void> {
  for (const id of jobids) {
    await psql(`select cron.alter_job(${id}, active := true);`);
  }
}

function dockerCompose(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", ...args], { cwd: REPO_ROOT });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function containerRunning(container: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["inspect", "--format", "{{.State.Running}}", container], { cwd: REPO_ROOT });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += String(c);
    });
    child.on("close", () => resolve(out.trim() === "true"));
    child.on("error", () => resolve(false));
  });
}

async function containerStartedAt(container: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["inspect", "--format", "{{.State.StartedAt}}", container], { cwd: REPO_ROOT });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += String(c);
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

const MAILER_CONTAINER = "ltc-dev-mailer";

// ─── worker lease (kind route/direct — purge ต่างกัน) ─────────────────────────

export interface WorkerLease {
  readonly leaseId: string;
  readonly kind: "route" | "direct";
  readonly owner: string;
}

export async function acquireLease(opts: {
  kind: "route" | "direct";
  owner: string;
  invocationId?: string;
}): Promise<WorkerLease> {
  await ensureWindowInfra();
  const inv = opts.invocationId === undefined ? null : `'${opts.invocationId}'`;
  const raw = await psql(
    `insert into test_infra.worker_lease (kind, owner, invocation_id)
     values ('${opts.kind}', '${opts.owner}', ${inv}) returning lease_id::text;`,
    { quiet: true }, // ตัด "INSERT 0 1" tag ออก — เหลือ uuid เดียว
  );
  return { leaseId: raw.trim(), kind: opts.kind, owner: opts.owner };
}

export async function heartbeatLease(leaseId: string): Promise<void> {
  await psql(`update test_infra.worker_lease set heartbeat_at = now() where lease_id = '${leaseId}';`);
}

export async function releaseLease(leaseId: string): Promise<void> {
  await psql(`delete from test_infra.worker_lease where lease_id = '${leaseId}';`);
}

async function activeDirectLeaseCount(): Promise<number> {
  const raw = await psql(`select count(*) from test_infra.worker_lease where kind = 'direct';`);
  return Number(raw.trim());
}

/**
 * auto-purge เฉพาะ kind='route' เมื่อเจ้าของ (container) restart หลัง heartbeat
 * ล่าสุด (StartedAt > heartbeat_at = lease เก่าจาก container รุ่นก่อน) ·
 * kind='direct' ห้าม purge เด็ดขาด (invocation ของเทสยังมีชีวิต) — ทุกการ purge
 * เขียน ledger note 'worker-lease-auto-purged-stale-route'
 */
export async function purgeStaleRouteLeases(): Promise<number> {
  await ensureWindowInfra();
  const rows = await psql(
    `select lease_id::text, owner, heartbeat_at::text from test_infra.worker_lease where kind = 'route';`,
  );
  let purged = 0;
  for (const line of rows.trim().split("\n").filter((l) => l.length > 0)) {
    const [leaseId, owner, heartbeat] = line.split("|");
    if (leaseId === undefined || owner === undefined || heartbeat === undefined) {
      continue; // แถวเพี้ยน — ไม่ purge ด้วยการเดา
    }
    const startedAt = await containerStartedAt(owner);
    if (startedAt === "") continue; // ไม่รู้จัก container — ไม่ purge ด้วยการเดา
    if (new Date(startedAt).getTime() > new Date(heartbeat ?? "").getTime()) {
      await psql(`delete from test_infra.worker_lease where lease_id = '${leaseId}';`);
      await ledgerWrite("note", {
        event: "worker-lease-auto-purged-stale-route",
        leaseId,
        owner,
        heartbeatAt: heartbeat,
        ownerStartedAt: startedAt,
      });
      purged++;
    }
  }
  return purged;
}

// ─── drain (in-flight invocation = 0 ภายใน effort bound) ─────────────────────

export interface InFlightCounts {
  readonly emailSending: number;
  readonly eventProcessing: number;
  readonly reportProcessing: number;
  readonly exportProcessing: number;
  readonly cronRunning: number;
  readonly directLeases: number;
}

export async function inFlightCounts(): Promise<InFlightCounts> {
  await ensureWindowInfra();
  const raw = await psql(
    `select
       (select count(*) from public.email_outbox where status = 'sending')
       || '|' || (select count(*) from public.event_outbox where status = 'processing')
       || '|' || (select count(*) from public.report_exports where status = 'processing')
       || '|' || (select count(*) from public.data_export_jobs where status = 'processing')
       || '|' || (select count(*) from cron.job_run_details where status = 'running');`,
  );
  const [a, b, c, d, e] = raw.trim().split("|").map((v) => Number(v));
  return {
    emailSending: a ?? 0,
    eventProcessing: b ?? 0,
    reportProcessing: c ?? 0,
    exportProcessing: d ?? 0,
    cronRunning: e ?? 0,
    directLeases: await activeDirectLeaseCount(),
  };
}

function countsClean(c: InFlightCounts): boolean {
  return (
    c.emailSending === 0 && c.eventProcessing === 0 && c.reportProcessing === 0 &&
    c.exportProcessing === 0 && c.cronRunning === 0 && c.directLeases === 0
  );
}

export interface DrainResult {
  readonly drained: boolean;
  readonly iterations: number;
  readonly lastCounts: InFlightCounts;
  readonly purgedStaleRoutes: number;
}

/** drainWorkers แยกเป็น API (battery เรียกระหว่าง stage ได้) — poll ทุก pollMs ภายใน boundMs */
export async function drainWorkers(opts: { pollMs?: number; boundMs?: number } = {}): Promise<DrainResult> {
  const pollMs = opts.pollMs ?? 5_000;
  const boundMs = opts.boundMs ?? 60_000;
  const startedAt = Date.now();
  let lastCounts = await inFlightCounts();
  let iterations = 0;
  let purgedStaleRoutes = 0;
  while (!countsClean(lastCounts)) {
    if (Date.now() - startedAt > boundMs) {
      return { drained: false, iterations, lastCounts, purgedStaleRoutes };
    }
    await sleep(pollMs);
    purgedStaleRoutes += await purgeStaleRouteLeases();
    lastCounts = await inFlightCounts();
    iterations++;
  }
  return { drained: true, iterations, lastCounts, purgedStaleRoutes };
}

// ─── coordinator ครบวง ────────────────────────────────────────────────────────

export interface WindowHandle {
  readonly holderId: string;
  readonly generation: string;
  readonly closedAt: string;
  readonly cronSnapshot: readonly CronJobSnapshot[];
  readonly mailerWasRunning: boolean;
}

export interface ReleaseResult {
  readonly overlapRuns: number;
  readonly restoredJobs: number;
  readonly mailerRestored: boolean;
}

/**
 * runtime pre-check → snapshot → ปิด intake → drain → คืน handle
 * drain หมดเวลา = restore best-effort + ledger poison-note + โยน WindowError
 * (ผู้เรียกห้ามถือว่าได้ window) · overlap audit ทำตอน release
 */
export async function openIsolatedWindow(opts: {
  holderId: string;
  label: string;
  drain?: boolean;
  drainBoundMs?: number;
}): Promise<WindowHandle> {
  await ensureWindowInfra();
  // (1) runtime pre-check — ของจริงต้องมีครบก่อนแตะอะไร
  const extRaw = await psql(
    `select count(*) from pg_extension where extname = 'pg_cron';`,
  );
  if (extRaw.trim() !== "1") throw new WindowError("pre-check ล้ม: ไม่มี pg_cron");
  const jrdRaw = await psql(
    `select count(*) from information_schema.tables where table_schema = 'cron' and table_name = 'job_run_details';`,
  );
  if (jrdRaw.trim() !== "1") {
    throw new WindowError("pre-check ล้ม: ไม่มี cron.job_run_details (overlap audit ใช้ตารางนี้)");
  }
  const jobCount = Number((await psql(`select count(*) from cron.job;`)).trim());
  if (jobCount === 0) throw new WindowError("pre-check ล้ม: cron.job ว่าง");
  const mailerWasRunning = await containerRunning(MAILER_CONTAINER);
  // (2) borrow ก่อน (refcount) — ซ้อนกัน = ล้มดัง (atomic ใน UPDATE)
  const holders = await borrowHolder(opts.holderId);
  if (holders === null) {
    const current = await gateState();
    await ledgerWrite("note", {
      event: "window-borrow-refused-overlap",
      holderId: opts.holderId,
      holders: current.holders,
    });
    throw new WindowError(`window-borrow-overlap: holders=${current.holders.join(",")}`);
  }
  // (3) snapshot
  const cronSnapshot = await snapshotCron();
  // (4) ปิด intake: gate closed + cron pause + mailer stop
  const activeIds = cronSnapshot.filter((j) => j.active).map((j) => j.jobid);
  await pauseCronJobs(activeIds);
  if (mailerWasRunning) {
    const stop = await dockerCompose(["stop", "mailer"]);
    if (stop.code !== 0) {
      await resumeCronJobs(activeIds).catch(() => undefined);
      await releaseHolder(opts.holderId);
      throw new WindowError(`stop mailer ล้ม: ${stop.stderr.slice(0, 200)}`);
    }
  }
  const generation = `wgen-${randomUUID().slice(0, 8)}`;
  await psql(
    `update test_infra.worker_gate set is_open = false, generation = '${generation}', updated_at = now() where id = 1;`,
  );
  await windowSet("closed", opts.label); // mirror ใน process — transportAdmit ปฏิเสธทุกเทสใน process นี้
  await ledgerWrite("window", {
    phase: "closed",
    generation,
    label: opts.label,
    holderId: opts.holderId,
    pausedJobs: activeIds,
    mailerWasRunning,
    snapshot: cronSnapshot,
  });
  const closedAt = new Date().toISOString();
  // (5) drain
  if (opts.drain !== false) {
    const drain = await drainWorkers({ boundMs: opts.drainBoundMs ?? 60_000 });
    if (!drain.drained) {
      await ledgerWrite("note", {
        event: "window-drain-timeout-poison",
        label: opts.label,
        lastCounts: drain.lastCounts,
      });
      // restore best-effort แล้วโยน — ผู้เรียกไม่ได้ window
      await resumeCronJobs(activeIds).catch(() => undefined);
      if (mailerWasRunning) await dockerCompose(["start", "mailer"]);
      await psql(`update test_infra.worker_gate set is_open = true, updated_at = now() where id = 1;`);
      await windowSet("open", `${opts.label}-drain-fail-restore`);
      await releaseHolder(opts.holderId);
      throw new WindowError(`window-drain-timeout: ${JSON.stringify(drain.lastCounts)}`);
    }
    await ledgerWrite("note", { event: "window-drained", label: opts.label, iterations: drain.iterations });
  }
  return { holderId: opts.holderId, generation, closedAt, cronSnapshot, mailerWasRunning };
}

/** ปิด window: overlap audit (job_run_details ที่ start ในช่วง closed) → restore ตาม snapshot → คืน refcount */
export async function releaseWindow(handle: WindowHandle): Promise<ReleaseResult> {
  await ensureWindowInfra();
  // overlap audit ก่อนเปิด (หลักฐาน: cron ต้องไม่รันเลยในช่วง closed)
  const overlapRaw = await psql(
    `select count(*) from cron.job_run_details
     where start_time >= '${handle.closedAt}' and status in ('running','succeeded','failed');`,
  );
  const overlapRuns = Number(overlapRaw.trim());
  await ledgerWrite("note", {
    event: "window-overlap-audit",
    holderId: handle.holderId,
    generation: handle.generation,
    overlapRuns,
  });
  // restore ตาม snapshot ต่อ job — เฉพาะ job ที่ snapshot บอก active เท่านั้น
  const restoreIds = handle.cronSnapshot.filter((j) => j.active).map((j) => j.jobid);
  await resumeCronJobs(restoreIds);
  let mailerRestored = false;
  if (handle.mailerWasRunning) {
    const start = await dockerCompose(["start", "mailer"]);
    mailerRestored = start.code === 0;
  } else {
    mailerRestored = true; // เดิมก็ไม่รัน — "คืนตาม snapshot" สำเร็จโดยนิยาม
  }
  await psql(
    `update test_infra.worker_gate
     set is_open = true, generation = 'wgen-${randomUUID().slice(0, 8)}', updated_at = now()
     where id = 1;`,
  );
  const holders = await releaseHolder(handle.holderId);
  await windowSet("open", `${handle.holderId}-release`);
  await ledgerWrite("window", {
    phase: "open",
    holderId: handle.holderId,
    restoredJobs: restoreIds.length,
    mailerRestored,
    remainingHolders: holders,
    overlapRuns,
  });
  return { overlapRuns, restoredJobs: restoreIds.length, mailerRestored };
}

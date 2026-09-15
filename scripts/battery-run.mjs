#!/usr/bin/env node
/**
 * scripts/battery-run.mjs — คุมลำดับ battery เต็มของ Wave H (plan §3 ขั้น 5 [#94] · gate r30 APPROVED)
 *
 * หน้าที่: รัน 13 stage ตามลำดับตายตัว — RC = OR ของทุก stage · fail-fast (stage ล้ม = หยุด
 * ทันที ไม่รัน stage ถัดไป เว้นแต่ --keep-going) · integration กับ e2e ไม่มีทางชนกันเพราะ
 * sequential by construction (รันทีละตัว ไม่มีโค้ดขนานใดๆ) และระหว่าง integration กับ e2e
 * ต้องมี health ผ่านก่อนเสมอ — บังคับแม้กระทั่ง --stages subset: เลือก integration → e2e
 * โดยข้าม health = ปฏิเสธตั้งแต่ต้น (exit 2)
 *
 * ลำดับ (RUN_ID ที่ส่งให้ลูก):
 *   heap-start → owner-proof → barrier-proof(pre-it) → unit → tsc → lint → build →
 *   integration(it) → audit-it(pre-it,it) → health → e2e(e2e) → audit-e2e(e2e) → heap-end
 *
 * ใช้:
 *   node scripts/battery-run.mjs                     # battery เต็ม (fail-fast)
 *   node scripts/battery-run.mjs --keep-going        # stage ล้มก็รันต่อ (เก็บผลทุก stage)
 *   node scripts/battery-run.mjs --stages unit,tsc   # subset ตามลำดับปกติ (ใช้ตอนพัฒนา)
 *
 * ออก (stdout): [stage-id] START <iso-ts> / [stage-id] EXIT <code> <duration-ms> ทุก stage
 *   และสรุปท้าย: BATTERY <PASS|FAIL> stages=<ผ่าน>/<ทั้งหมด> rc=<0|1>
 * Exit: 0 = ทุก stage ที่เลือกไว้รันและผ่านครบ · 1 = มี stage ล้ม/ถูกข้ามเพราะ fail-fast ·
 *   2 = ใช้งานผิด/ลำดับไม่ปลอดภัย (usage ผิด / health-gate ไม่ครบ)
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BARRIER_DIR = path.join(REPO_ROOT, "tests", "barrier-proof");
const HEALTH_URL = "http://127.0.0.1:3000/api/health";
const HEALTH_TIMEOUT_MS = 120_000;
/** poll /api/health ทุก 1 วินาทีจนได้ 200 หรือหมดเวลา */
const HEALTH_POLL_MS = 1_000;

// ─── 1) ตาราง stage — ลำดับตายตัว (แก้ลำดับที่นี่ที่เดียว) ──────────────────

const STAGES = [
  { id: "heap-start", runId: undefined, file: "scripts/heap-sampler.sh", args: ["--label", "battery-start"] },
  { id: "owner-proof", runId: undefined, file: "node", args: ["scripts/window-owner-proof.mjs"] },
  {
    // โฟลเดอร์จะมีในภายหลัง — ยังไม่มีไฟล์ใดใน tests/barrier-proof/ = FAIL ชัดเจน (ห้ามผ่านปลอม)
    id: "barrier-proof",
    runId: "pre-it",
    file: "npx",
    // config เฉพาะของ barrier suite: AaToBbSequencer (ลำดับไฟล์ 8b→8p) + singleFork +
    // hookTimeout 5 วิโดยตั้งใจ — รันด้วย integration config จะทำลาย proof ที่
    // ต้องอาศัยลำดับ/timeout ตายตัว (pass 6 แก้จาก config ผิดตัวเดิม)
    args: ["vitest", "run", "--config", "vitest.barrier-proof.config.ts", "tests/barrier-proof/"],
  },
  { id: "unit", runId: undefined, file: "npm", args: ["test"] },
  { id: "tsc", runId: undefined, file: "npx", args: ["tsc", "--noEmit"] },
  { id: "lint", runId: undefined, file: "npm", args: ["run", "lint"] },
  { id: "build", runId: undefined, file: "npm", args: ["run", "build"] },
  { id: "integration", runId: "it", file: "npm", args: ["run", "test:integration"] },
  {
    id: "audit-it",
    runId: undefined,
    file: "node",
    args: ["scripts/audit-lifecycle-ledger.mjs", "--run-id", "pre-it,it", "--expect-clean"],
  },
  { id: "health", runId: undefined, builtin: "health" },
  { id: "e2e", runId: "e2e", file: "npx", args: ["playwright", "test"] },
  {
    id: "audit-e2e",
    runId: undefined,
    file: "node",
    args: ["scripts/audit-lifecycle-ledger.mjs", "--run-id", "e2e", "--expect-clean"],
  },
  { id: "heap-end", runId: undefined, file: "scripts/heap-sampler.sh", args: ["--label", "battery-end"] },
];

// ─── 2) CLI — --keep-going / --stages id1,id2 ────────────────────────────────

/** แยก flag — ผิดรูปแบบ = exit 2 (ใช้งานผิด ไม่ใช่ battery FAIL) */
function parseArgs(argv) {
  let keepGoing = false;
  const selectedIds = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep-going") {
      keepGoing = true;
      continue;
    }
    let value;
    if (arg === "--stages") {
      value = argv[++i];
      if (value === undefined || value === "") usageExit("--stages ต้องมีค่าตามหลัง (เช่น unit,tsc)");
    } else if (arg.startsWith("--stages=")) {
      value = arg.slice("--stages=".length);
    } else {
      usageExit(`ตัวเลือกไม่รู้จัก: ${arg}`);
    }
    for (const part of value.split(",")) {
      const id = part.trim();
      if (id !== "") selectedIds.push(id);
    }
  }
  return { keepGoing, selectedIds };
}

function usageExit(message) {
  const ids = STAGES.map((s) => s.id).join(",");
  process.stderr.write(
    `battery-run: ${message}\n` +
      `ใช้: node scripts/battery-run.mjs [--keep-going] [--stages id1,id2]\n` +
      `stage ที่มี (ลำดับตายตัว): ${ids}\n`,
  );
  process.exit(2);
}

/** เลือก subset ตามลำดับปกติของ STAGES — id ไม่รู้จัก = exit 2 · ซ้ำ = ตัดซ้ำ */
function selectStages(selectedIds) {
  if (selectedIds.length === 0) return STAGES;
  const known = new Set(STAGES.map((s) => s.id));
  for (const id of selectedIds) {
    if (!known.has(id)) usageExit(`stage ไม่รู้จัก: ${id}`);
  }
  return STAGES.filter((s) => selectedIds.includes(s.id));
}

/**
 * กันชน ledger ซ้ำ run-id ตายตัว (pre-it/it/e2e): ก่อนรัน stage ใด ต้องไม่มีแถวเก่าของ
 * run-id เหล่านั้นค้างใน test_infra.lifecycle_ledger — suite นับ/ตัดสินตาม opKey ข้าม run
 * (w8f-f2 ห้ามเจอ cleanup-start ก่อน SRE · w8o settle-A ต้องมีเอ๊เดียว · attemptBegin/
 * fileBegin ปฏิเสธเมื่อ predecessor ยังไม่ terminal) แถวค้างของ battery ก่อน (ตายกลางทาง
 * ก่อน audit/truncate) จะทำ assertion นับข้ามรอบและ poison เก่าปฏิเสธ attempt ใหม่ —
 * เกิดจริง: battery r1 ตายที่ e2e → r2 ล้มที่ barrier f2/8o(ก)(ข)(ง) ด้วยแถว pre-it 408 แถวของ r1
 *
 * เคลียร์ให้สะอาดก่อนเริ่มด้วยทางที่ชอบ:
 *   · run ที่ audit ผ่านแล้ว → node scripts/audit-lifecycle-ledger.mjs --run-id <ids> --truncate
 *   · แถว poison/ค้างของ run ที่ล้ม → เคลียร์มือตาม limitation 5 (จด intent ใน PROJECT-STATE)
 * ตารางยังไม่เกิด (DB ใหม่) = ถือว่าสะอาด — รันต่อได้ · docker/db ล้มจริง = exit 2 หยุดก่อน
 */
async function assertLedgerFresh(selected) {
  const runIds = [...new Set(selected.map((s) => s.runId).filter((r) => r !== undefined))];
  if (runIds.length === 0) return;
  const sql =
    `select run_id || '=' || count(*) from test_infra.lifecycle_ledger ` +
    `where run_id = any('{${runIds.join(",")}}'::text[]) group by run_id;`;
  const res = await new Promise((resolve) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -At -v ON_ERROR_STOP=1',
      ],
      { cwd: REPO_ROOT },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    child.on("error", (e) => resolve({ ok: false, out, err: String(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, out, err }));
    child.stdin.write(sql);
    child.stdin.end();
  });
  if (!res.ok) {
    // ตาราง/schema ยังไม่เกิด = DB ใหม่ สะอาด (psql ON_ERROR_STOP=1 ให้ exit≠0 พร้อมข้อความ does not exist)
    if (res.err.includes("does not exist")) return;
    process.stderr.write(
      `[battery] ledger pre-check รันไม่ได้ (docker/db ล้ม?): ${res.err.slice(0, 200)}\n`,
    );
    process.exit(2);
  }
  const leftover = res.out.trim().split("\n").filter((l) => l.trim() !== "");
  if (leftover.length > 0) {
    process.stderr.write(
      `[battery] ledger มีแถวเก่าของ run-id ที่ battery จะใช้ — ห้ามเริ่ม (assertion นับข้ามรอบ + poison เก่าปฏิเสธ attempt ใหม่): ${leftover.join(" · ")}\n` +
        `เคลียร์ก่อน: run ที่ audit ผ่าน = node scripts/audit-lifecycle-ledger.mjs --run-id <ids> --truncate · แถว poison ของ run ที่ล้ม = เคลียร์มือตาม limitation 5 (จด intent ใน PROJECT-STATE)\n`,
    );
    process.exit(2);
  }
}

/**
 * กันชน (ห้าม integration กับ e2e ชนกัน): ถ้า subset เลือกทั้ง integration และ e2e
 * ต้องมี health คั่นกลางเสมอ — ข้าม health = ปฏิเสธตั้งแต่ต้น (exit 2)
 * (ลำดับเต็มผ่านเองเพราะ health อยู่ระหว่าง integration กับ e2e ใน STAGES อยู่แล้ว)
 */
function assertHealthGate(selected) {
  const pos = (id) => selected.findIndex((s) => s.id === id);
  const integration = pos("integration");
  const e2e = pos("e2e");
  if (integration === -1 || e2e === -1 || e2e < integration) return;
  const between = selected.slice(integration + 1, e2e);
  if (!between.some((s) => s.id === "health")) {
    usageExit(
      "subset นี้รัน integration แล้ว e2e โดยข้าม health — ระหว่าง IT กับ e2e ต้อง health-check ผ่านก่อน (เพิ่ม health ใน --stages)",
    );
  }
}

// ─── 3) ตัวรัน stage ─────────────────────────────────────────────────────────

/**
 * spawn ลูก stdio inherit (เห็น output จริง ไม่ซ่อน) + env RUN_ID ต่อ stage · cwd = repo root
 * คืน exit code: โค้ดจริงของลูก · spawn ล้ม (ENOENT ฯลฯ) = 127 · โดน signal = 128+n
 */
function spawnChild(file, args, runId) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (runId !== undefined) env["RUN_ID"] = runId;
    const child = spawn(file, args, { cwd: REPO_ROOT, stdio: "inherit", env });
    let settled = false;
    const finish = (code, note) => {
      if (settled) return;
      settled = true;
      if (note !== undefined) process.stderr.write(note);
      resolve(code);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigint);
    };
    // battery โดน Ctrl-C: ปิด stage ปัจจุบันแบบรู้ตัว (code 130) แทนค้างเงียบ
    const onSigint = () => finish(130);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);
    child.on("error", (err) => finish(127, `[battery] spawn ${file} ล้มเหลว: ${err.message}\n`));
    child.on("close", (code, signal) => {
      if (code !== null) {
        finish(code);
        return;
      }
      // ลูกจบด้วย signal — แปลงเป็น exit code แบบ shell (128+n)
      const sigMap = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 };
      const n = typeof signal === "string" ? (sigMap[signal] ?? 1) : 1;
      finish(128 + n, `[battery] ${file} จบด้วย signal ${signal}\n`);
    });
  });
}

/**
 * barrier-proof ยังไม่มีไฟล์ = FAIL ด้วยข้อความชัดเจน (ไม่ spawn vitest — ผ่านปลอมเป็นที่ต้องห้าม)
 * exit 2 ที่ stage นี้ = โครงยังไม่พร้อม ไม่ใช่เทสล้ม — battery ยังถือว่า FAIL (rc=1) เหมือนกัน
 */
function runBarrierProofPrecheck() {
  let entries;
  try {
    entries = readdirSync(BARRIER_DIR);
  } catch {
    process.stderr.write(
      `[battery] barrier-proof: ยังไม่มีโฟลเดอร์ tests/barrier-proof/ — stage นี้ FAIL (ห้ามผ่านปลอม)\n`,
    );
    return 2;
  }
  if (entries.length === 0) {
    process.stderr.write(
      `[battery] barrier-proof: ยังไม่มีไฟล์ใดใน tests/barrier-proof/ — stage นี้ FAIL (ห้ามผ่านปลอม)\n`,
    );
    return 2;
  }
  return undefined; // พร้อม — รันคำสั่งจริงต่อ
}

/** health gate: poll /api/health จนได้ 200 ภายใน 120s — ไม่ผ่าน = stage ล้ม (exit 1) */
async function waitForHealth() {
  process.stderr.write(`[health] poll GET ${HEALTH_URL} → 200 (timeout ${HEALTH_TIMEOUT_MS / 1000}s)\n`);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const res = await fetch(HEALTH_URL);
      if (res.status === 200) {
        process.stderr.write(`[health] ได้ 200 หลัง poll ${attempts} ครั้ง\n`);
        return 0;
      }
    } catch {
      // ยังเชื่อมต่อไม่ได้ (server ยังไม่ขึ้น) — ถือเป็น "ยังไม่พร้อม" แล้ว poll ต่อจนหมดเวลา
    }
    if (Date.now() >= deadline) {
      process.stderr.write(`[health] ไม่ได้ 200 ภายใน ${HEALTH_TIMEOUT_MS / 1000}s (${attempts} ครั้ง) — FAIL\n`);
      return 1;
    }
    await sleep(HEALTH_POLL_MS);
  }
}

/** รัน stage หนึ่ง stage — พิมพ์ timeline START/EXIT และคืน {id, code, ms} */
async function runStage(stage) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`[${stage.id}] START ${startedAt}`);
  let code;
  if (stage.builtin === "health") {
    code = await waitForHealth();
  } else if (stage.id === "barrier-proof") {
    const precheck = runBarrierProofPrecheck();
    if (precheck !== undefined) {
      code = precheck;
    } else {
      code = await spawnChild(stage.file, stage.args, stage.runId);
    }
  } else {
    code = await spawnChild(stage.file, stage.args, stage.runId);
  }
  const ms = Date.now() - t0;
  console.log(`[${stage.id}] EXIT ${code} ${ms}`);
  return { id: stage.id, code, ms };
}

// ─── 4) main — ลำดับตายตัว · fail-fast · RC = OR ────────────────────────────

const { keepGoing, selectedIds } = parseArgs(process.argv.slice(2));
const selected = selectStages(selectedIds);
assertHealthGate(selected);
await assertLedgerFresh(selected);

const results = [];
for (const stage of selected) {
  const result = await runStage(stage);
  results.push(result);
  // fail-fast: stage ล้ม = หยุดทันที (เก็บ timeline ที่รันไปแล้ว — ไม่รัน stage ถัดไป)
  if (result.code !== 0 && !keepGoing) break;
}

const passed = results.filter((r) => r.code === 0).length;
const allRan = results.length === selected.length;
const rc = allRan && passed === selected.length ? 0 : 1;
console.log(`BATTERY ${rc === 0 ? "PASS" : "FAIL"} stages=${passed}/${selected.length} rc=${rc}`);
process.exit(rc);

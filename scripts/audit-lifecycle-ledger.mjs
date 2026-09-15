#!/usr/bin/env node
/**
 * scripts/audit-lifecycle-ledger.mjs — ผู้คุม truncate เดี่ยว + audit ledger ของ battery
 * (Wave H plan D89-3 [#94] · gate r30 APPROVED)
 *
 * หน้าที่: audit แถวของ test_infra.lifecycle_ledger (dev DB · schema test_infra เป็น dev-only
 * ตาม tests/integration/test-io.ts) ตาม run-id ที่ระบุ — เช็ค 4 ข้อ:
 *   1) invocation: group ตาม invocation_id — สถานะ = payload->>'status' ของ event ล่าสุดตาม
 *      (ts,id) — ต้องไม่ค้าง 'running' (leftover = FAIL พร้อมระบุ op_key/invocation_id)
 *   2) settle-decision: payload ต้องมี decisionId (uuid string), invocationId (uuid string),
 *      scanClean (boolean), decision (string ไม่ว่าง) — ขาด/malformed = FAIL
 *   3) guard-event: นับ event 'lifecycle-guard-refused-live-predecessor' → รายงาน guardRefusals
 *   4) --expect-clean: สถานะล่าสุด poisoned/unresolved = FAIL (ใช้กับ stage ปกติ — ถ้าไม่ใส่
 *      ยอมรับ terminal ทุกชนิด แต่ยังห้าม 'running' ค้าง)
 *
 * --truncate = ผู้คุม truncate เดี่ยว: ลบแถวของ run-id เหล่านั้น "หลัง audit ผ่านเท่านั้น" —
 * audit ล้ม = ห้ามลบ (ไม่มีทางลบหลักฐานทับความล้มเหลว) · ลบเฉพาะ run-id ที่ audit ไม่มีทางแตะ
 * run-id อื่น
 *
 * ช่องทาง DB: docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql …'
 * ตาม pattern tests/integration/helpers.ts ฟังก์ชัน psql — รหัสผ่านอยู่ใน env ของ container
 * สคริปต์นี้ไม่แตะ/ไม่พิมพ์ค่าออกทาง stdout เด็ดขาด
 *
 * ใช้: node scripts/audit-lifecycle-ledger.mjs --run-id pre-it,it [--expect-clean] [--truncate]
 * ออก: รายงาน JSON บรรทัดเดียวทาง stdout
 *   {"ok":bool,"runIds":[...],"invocations":N,"guardRefusals":N,"failures":[...strings...]}
 * Exit: 0 = ผ่านทั้งหมด · 1 = audit ล้มอย่างน้อยหนึ่งข้อ · 2 = ใช้งานผิด/สภาพแวดล้อมไม่พร้อม
 */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TABLE = "test_infra.lifecycle_ledger";
/** guard-event ที่ attemptBegin ปฏิเสธ live predecessor (test-io.ts GuardRefusal) */
const GUARD_REFUSED_EVENT = "lifecycle-guard-refused-live-predecessor";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `\
ใช้: node scripts/audit-lifecycle-ledger.mjs --run-id <id1,id2,...> [--expect-clean] [--truncate]

  --run-id        บังคับ — run_id ที่จะ audit (comma-separated → SQL in-list)
  --expect-clean  สถานะ invocation ล่าสุดห้ามเป็น poisoned/unresolved และต้องมี invocation
                  ≥1 (audit บนชุดว่างเปล่า = ผ่านปลอม — ใช้กับ stage ปกติของ battery)
  --truncate      ลบแถวของ run-id เหล่านั้น — ทำหลัง audit ผ่านเท่านั้น · บังคับเงื่อนไข
                  clean เสมอแม้ไม่ใส่ --expect-clean: ห้ามใช้ script ลบหลักฐาน
                  poisoned/unresolved — แถวพวกนั้นต้องเคลียร์มือตาม limitation 5
`;

// ─── 1) CLI ──────────────────────────────────────────────────────────────────

/** แยก --run-id (comma-separated) + flag บูลีน — ผิดรูปแบบ = exit 2 (ใช้งานผิด ไม่ใช่ audit ล้ม) */
function parseArgs(argv) {
  const runIds = [];
  let expectClean = false;
  let truncate = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--expect-clean") {
      expectClean = true;
      continue;
    }
    if (arg === "--truncate") {
      truncate = true;
      continue;
    }
    let value;
    if (arg === "--run-id") {
      value = argv[++i];
      if (value === undefined || value === "") usageExit("--run-id ต้องมีค่าตามหลัง (เช่น pre-it,it)");
    } else if (arg.startsWith("--run-id=")) {
      value = arg.slice("--run-id=".length);
    } else {
      usageExit(`ตัวเลือกไม่รู้จัก: ${arg}`);
    }
    for (const part of value.split(",")) {
      const id = part.trim();
      if (id !== "") runIds.push(id);
    }
    if (runIds.length === 0) usageExit("--run-id ว่าง — ต้องระบุ run-id อย่างน้อยหนึ่งค่า");
  }
  if (runIds.length === 0) usageExit("ขาด --run-id — ต้องระบุ run-id อย่างน้อยหนึ่งค่า");
  return { runIds, expectClean, truncate };
}

function usageExit(message) {
  process.stderr.write(`audit-lifecycle-ledger: ${message}\n${USAGE}`);
  process.exit(2);
}

// ─── 2) DB — psql ใน container db (เหมือน tests/integration/helpers.ts) ─────

/** รัน SQL ผ่าน psql ใน container `db` (stdin) คืน stdout — รหัสผ่านมาจาก env ของ container */
function psql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At',
      ],
      { cwd: REPO_ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`psql exit ${code ?? "?"}: ${stderr || stdout}`));
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** escape string เป็น SQL literal (run_id มาจาก CLI — ต้อง quote ป้องกัน injection) */
function sqlLiteral(text) {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * ดึงข้อมูล audit ครบใน psql เรียกเดียว (json_build_object 3 ส่วน):
 * - invLast: event ล่าสุดต่อ invocation (distinct on … order by invocation_id, ts desc, id desc
 *   = "ล่าสุดตาม (ts,id)" ตามความหมายของ Postgres โดยตรง ไม่ต้องเทียบ timestamp ใน JS)
 * - settle: ทุกแถว settle-decision (สำหรับตรวจ payload)
 * - guardRefusals: จำนวน guard-event ที่ attemptBegin ปฏิเสธ live predecessor
 */
async function fetchAuditData(inList) {
  const raw = await psql(
    `select json_build_object(
       'invLast', (select coalesce(json_agg(q), '[]'::json) from (
         select distinct on (invocation_id)
           invocation_id::text as invocation_id,
           op_key,
           payload->>'status' as status
         from ${TABLE}
         where kind = 'invocation' and run_id in (${inList})
         order by invocation_id, ts desc, id desc
       ) q),
       'settle', (select coalesce(json_agg(q), '[]'::json) from (
         select id::text as id, op_key, invocation_id::text as invocation_id, payload
         from ${TABLE}
         where kind = 'settle-decision' and run_id in (${inList})
         order by ts, id
       ) q),
       'guardRefusals', (select count(*) from ${TABLE}
         where kind = 'guard-event' and run_id in (${inList})
           and payload->>'event' = '${GUARD_REFUSED_EVENT}')
     )::text;`,
  );
  const parsed = JSON.parse(raw.trim());
  return {
    invLast: Array.isArray(parsed["invLast"]) ? parsed["invLast"] : [],
    settle: Array.isArray(parsed["settle"]) ? parsed["settle"] : [],
    guardRefusals: Number(parsed["guardRefusals"] ?? 0),
  };
}

/** ลบแถวของ run-id ใน in-list — เรียกได้เมื่อ audit ผ่านเท่านั้น (คืนจำนวนแถวที่ลบ) */
async function truncateRunIds(inList) {
  const raw = await psql(
    `with deleted as (
       delete from ${TABLE} where run_id in (${inList}) returning 1
     )
     select count(*) from deleted;`,
  );
  const last = raw.trim().split("\n").at(-1) ?? "0";
  return Number(last);
}

// ─── 3) กฎ audit ─────────────────────────────────────────────────────────────

/** ตรวจ payload ของ settle-decision หนึ่งแถว — คืนรายการปัญหา (ว่าง = ผ่าน) */
function settleProblems(row) {
  const payload = typeof row.payload === "object" && row.payload !== null ? row.payload : {};
  const problems = [];
  if (typeof payload["decisionId"] !== "string" || !UUID_RE.test(payload["decisionId"])) {
    problems.push("decisionId ขาด/ไม่ใช่ uuid string");
  }
  if (typeof payload["invocationId"] !== "string" || !UUID_RE.test(payload["invocationId"])) {
    problems.push("invocationId ขาด/ไม่ใช่ uuid string");
  }
  if (typeof payload["scanClean"] !== "boolean") {
    problems.push("scanClean ขาด/ไม่ใช่ boolean");
  }
  if (typeof payload["decision"] !== "string" || payload["decision"] === "") {
    problems.push("decision ขาด/ไม่ใช่ string ไม่ว่าง");
  }
  return problems;
}

/**
 * หัวใจ audit — คืนรายการ failures (ว่าง = ผ่านทั้งหมด)
 * กฎ fail-closed: status ล่าสุดอ่านไม่ได้ (null) = malformed = FAIL ด้วย
 * (row 'invocation' ที่เขียนถูกต้องต้องมี payload.status เสมอ — อ่านไม่ได้คือ ledger พัง)
 *
 * gate waveh-r1 M3: poisoned/unresolved ต้องล้มทั้ง --expect-clean และ --truncate
 * (เดิมผูกกับ expectClean อย่างเดียว — truncate ลบหลักฐาน poison ได้โดยไม่ผ่าน
 * manual-with-intent ขัด limitation 5) · --expect-clean บนชุด invocation ว่าง = ล้ม
 * (audit ว่างเปล่า = ผ่านปลอม — เกิดจริงกับ audit-e2e r3: invocations:0 ยัง ok:true)
 */
function audit({ invLast, settle, guardRefusals }, runIds, expectClean, truncate = false) {
  const failures = [];
  for (const inv of invLast) {
    const invId = inv.invocation_id ?? "(null)";
    const opKey = inv.op_key ?? "-";
    const status = inv.status;
    if (typeof status !== "string" || status === "") {
      failures.push(
        `invocation ${invId} event ล่าสุดไม่มี payload.status (op_key=${opKey}) — malformed (fail-closed)`,
      );
      continue;
    }
    if (status === "running") {
      failures.push(
        `invocation ${invId} สถานะล่าสุด 'running' (op_key=${opKey}) — leftover ห้ามทิ้งค้าง`,
      );
      continue;
    }
    if ((expectClean || truncate) && (status === "poisoned" || status === "unresolved")) {
      failures.push(
        `invocation ${invId} สถานะล่าสุด '${status}' (op_key=${opKey}) — ${truncate ? "ห้าม truncate หลักฐาน poisoned/unresolved — เคลียร์มือตาม limitation 5 (จด intent ใน PROJECT-STATE)" : "--expect-clean ห้าม terminal แบบนี้"}`,
      );
    }
  }
  if (expectClean && invLast.length === 0) {
    failures.push(
      `run-id (${runIds.join(",")}) ไม่มี invocation เลย — audit บนชุดว่างเปล่า = ผ่านปลอม (fail-closed)`,
    );
  }
  for (const row of settle) {
    const problems = settleProblems(row);
    if (problems.length > 0) {
      const invId = row.invocation_id ?? "-";
      failures.push(
        `settle-decision id=${row.id} invocation_id=${invId} (op_key=${row.op_key ?? "-"}): ${problems.join("; ")}`,
      );
    }
  }
  return { failures, invocations: invLast.length, guardRefusals };
}

// ─── 4) main ─────────────────────────────────────────────────────────────────

/** รันจริงในฐานะ script (แยกจาก audit เพื่อ import ในเทสได้โดยไม่แตะ DB) */
async function main() {
  const { runIds, expectClean, truncate } = parseArgs(process.argv.slice(2));
  try {
    const inList = runIds.map(sqlLiteral).join(", ");
    const data = await fetchAuditData(inList);
    const { failures, invocations, guardRefusals } = audit(data, runIds, expectClean, truncate);
    const ok = failures.length === 0;

    // รายงาน JSON บรรทัดเดียวทาง stdout (ตัดสิน exit code จาก ok เท่านั้น)
    console.log(JSON.stringify({ ok, runIds, invocations, guardRefusals, failures }));

    // --truncate: ผู้คุม truncate เดี่ยว — audit ล้ม = ห้ามลบแม้แต่แถวเดียว
    if (truncate) {
      if (!ok) {
        process.stderr.write(
          `audit-lifecycle-ledger: audit ล้ม ${failures.length} ข้อ — ห้าม truncate (ผู้คุม truncate เดี่ยว)\n`,
        );
      } else {
        const deleted = await truncateRunIds(inList);
        process.stderr.write(
          `audit-lifecycle-ledger: truncate run_id in (${runIds.join(",")}) แล้ว ${deleted} แถว\n`,
        );
      }
    }

    process.exit(ok ? 0 : 1);
  } catch (err) {
    // docker/psql ล้ม = สภาพแวดล้อมไม่พร้อม (ไม่ใช่ audit FAIL) — exit 2 แบบ heap-sampler
    process.stderr.write(
      `audit-lifecycle-ledger: สภาพแวดล้อม/DB ล้ม: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}

// เรียกตรงเมื่อรันเป็น script เท่านั้น — import จากเทส (wave-h-battery-audit-guards)
// ได้ audit() แบบ in-memory โดยไม่แตะ CLI/DB
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

export { audit, main };

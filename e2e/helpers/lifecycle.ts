/**
 * e2e/helpers/lifecycle.ts — lifecycle ledger ของ e2e บน test_infra [#94]
 * (gate waveh-r1 M1/M2: audit-e2e `--run-id e2e --expect-clean` ต้องเห็น
 * invocation จริง ≥1 — ก่อนหน้านี้ e2e ไม่เขียน ledger เลย ทำให้ audit ผ่านปลอม
 * ด้วย invocations:0 · ชุดว่างเปล่าถูก kill แล้วใน audit script — e2e ต้องมีแถวจริง)
 *
 * Playwright-safe โดยออกแบบ: node ล้วน (psql ใน container ผ่าน ./db) · ห้าม import
 * tests/integration/test-io (โมดูลนั้น import helpers ที่มี import.meta.url —
 * โหลดใต้ Playwright CJS ไม่ได้ ตามธงของ d9-helpers) — โครงแถว/DDL เหมือน test-io
 * ตารางเดียวกัน (test_infra.lifecycle_ledger) แต่เขียนผ่านทางของ e2e
 *
 * run_id ตรึงจาก env RUN_ID ตอนโหลดโมดูล (battery e2e stage ตั้ง "e2e" · รัน adhoc
 * นอก battery = "adhoc") — สัญญาเดียวกับ FROZEN_RUN_ID ของ test-io · audit ของ
 * battery อ่าน run_id "e2e" เท่านั้น
 */
import { randomUUID } from "node:crypto";
import { psql } from "./db";

const FROZEN_RUN_ID = (() => {
  const v = process.env["RUN_ID"];
  return v === undefined || v === "" ? "adhoc" : v;
})();

/** DDL idempotent — เดียวกับ test-io.ts ของ integration (รันครั้งแรกเท่านั้น) */
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

async function ensureLedger(): Promise<void> {
  if (ddlReady) return;
  await psql(DDL);
  ddlReady = true;
}

function sqlLiteral(v: string): string {
  return v.replace(/'/g, "''");
}

/** เปิด invocation 'running' — คืน invocationId สำหรับ lifecycleSettle */
export async function lifecycleBegin(opKey: string, label: string): Promise<string> {
  await ensureLedger();
  const invocationId = randomUUID();
  const payload = JSON.stringify({
    status: "running",
    label,
    opKey,
    startedAt: new Date().toISOString(),
  });
  await psql(`
    insert into test_infra.lifecycle_ledger (id, run_id, kind, op_key, invocation_id, payload)
    values ('${invocationId}', '${FROZEN_RUN_ID}', 'invocation', '${sqlLiteral(opKey)}',
            '${invocationId}', '${sqlLiteral(payload)}'::jsonb);
  `);
  return invocationId;
}

/** ปิด invocation (append status ใหม่) — settled ปกติ / poisoned เมื่อ cleanup ล้ม
 * (audit --expect-clean ของ battery จะ fail-loud กับ poisoned — ตรงตามเซมันติก) */
export async function lifecycleSettle(
  invocationId: string,
  opKey: string,
  status: "settled" | "poisoned",
  detail: Record<string, unknown> = {},
): Promise<void> {
  const payload = JSON.stringify({ status, ...detail, settledAt: new Date().toISOString() });
  await psql(`
    insert into test_infra.lifecycle_ledger (id, run_id, kind, op_key, invocation_id, payload)
    values ('${randomUUID()}', '${FROZEN_RUN_ID}', 'invocation', '${sqlLiteral(opKey)}',
            '${invocationId}', '${sqlLiteral(payload)}'::jsonb);
  `);
}

/** run_id ตรึงของ process นี้ (ให้ assert/ตรวจจากภายนอกได้) */
export function e2eRunId(): string {
  return FROZEN_RUN_ID;
}

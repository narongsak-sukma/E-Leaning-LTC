/**
 * DCR 22023 (Wave H closing) — error-format ของ append_audit_event ต้องเป็นรูป
 * convention "(CODE|tag)" ปิดท้าย message ตามที่ parseRpcErrorCodeDetailed
 * (src/lib/api/rpc-errors.ts) จับแบบ anchored
 *
 * ข้อบกพร่องเดิม (พบใน pass 4c `f4d9988` · probe สดก่อนแก้ 2026-09-16
 * `.omc/artifacts/dcr22023-probe-old-form.log`): จุดยก error ใช้รูป
 * '(ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw)' ซึ่งไม่ตรง TRAILING_CODE_RE →
 * parser คืน undefined → rpcOnceWithClassification (src/lib/admin/users.ts)
 * จัดเป็น transient → retry 3 ครั้ง → route ตอบ 503 ERR-SYS-002 ทั้งที่เป็น
 * การปฏิเสธถาวรที่ควรตอบ 400 ERR-VAL-001 ทันที (httpStatus ของทะเบียน) ·
 * จุดยก error ถูกสำเนาไป 3 migration หลังที่ redefine append_audit_event
 * (0019/0025/0032 — 0032 คือนิยามสุดท้ายที่รันจริงบน DB) — แก้ครบ 6 จุดที่แหล่ง
 * ตาม DCR "แก้ที่แหล่งยก error ของ 0008"
 *
 * known-legacy ปิดแล้ว (Wave I เฟส 2 · DCR ASM-011 ตาม verdict r22 ข้อ 2): raise ตระกูล
 * '(ASM-011 — ERR-RBAC-001)' 4 จุด (0011 ×2 · 0019 · 0020) ถูกแก้ที่แหล่งเป็น
 * '(ERR-RBAC-001|session_mismatch)' ตามเอกสาร docs/09-dev/DCR-ASM-011-RPC-ERROR-FORMAT.md
 * — exception ของ fence ถูกตัดตามคำสั่งของ fence เอง ("น้อยลง = ถูกแก้แล้วให้ตัดรายการ
 * ยกเว้น") ทิศ ก จึงบังคับ strict ต่อจาก Wave I เฟส 2 นี้
 *
 * two-way proof [[regression-test-two-way-proof]]:
 *   ทิศสกปรก (pure): คืนข้อความ em-dash ที่ 0008 → ทิศ ก ล้มเป๊ะ (fence จับ)
 *   ทิศสกปรก (parser): รูปเก่า → undefined (ชุด unit ที่ src/lib/api/rpc-errors.test.ts)
 *   ทิศสกปรก (live): ก่อน reset-db ฟังก์ชันเดิมบน DB ยังยก em-dash → ทิศ ง ล้ม
 *   (บันทึก guards-r34-live-old.log) — หลัง reset-db (replay migration ที่แก้)
 *   → ผ่านทุกขา
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SERVICE_KEY, restCall } from "./helpers.js";
import { parseRpcErrorCodeDetailed } from "../../src/lib/api/rpc-errors.js";

const DB_URL = process.env["TEST_DATABASE_URL"];

/** repo root = tests/integration → ขึ้นสองชั้น */
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "supabase", "migrations");

/** รูปปิดท้ายที่ parser ยอมรับ — สะท้อน TRAILING_CODE_RE ของ rpc-errors.ts (นิยามเดียวกันเป๊ะ) */
const TRAILING_OK = /\((ERR-[A-Z]+-\d{3})(?:\|([a-z0-9_]+))?\)$/;

interface RaiseSite {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** ทุก raise ที่ฝัง error code ในข้อความ — อ่านจากไฟล์จริงทุกครั้งที่รัน (ไม่แคช) */
function raiseSites(): RaiseSite[] {
  const sites: RaiseSite[] = [];
  for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const lines = readFileSync(join(MIGRATIONS_DIR, name), "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (!/raise\s+(exception|notice|warning)/i.test(ln)) return;
      if (!/ERR-[A-Z]+-\d{3}/.test(ln)) return;
      const m = /raise\s+\w+\s+'([^']*)'/.exec(ln);
      if (m === null) return;
      sites.push({ file: name, line: i + 1, message: m[1] ?? "" });
    });
  }
  return sites;
}

describe("DCR 22023 (pure) · raise ที่ฝัง ERR- ใน migrations ต้องจบด้วยรูป anchored (CODE|tag)", () => {
  it("ทิศ ก: ทุกจุดยก error ผ่านรูปปิดท้าย (strict — legacy ASM-011 ปิดแล้ว Wave I เฟส 2)", () => {
    const sites = raiseSites();
    expect(sites.length, "ต้องเจอจุดยก error ที่ฝัง code จริง (ไม่ใช่ศูนย์ — scan พัง?)").toBeGreaterThan(
      400,
    );
    const malformed = sites.filter((s) => !TRAILING_OK.test(s.message));
    expect(
      malformed.map((s) => `${s.file}:${s.line}`),
      "raise ที่ฝัง ERR- ต้องจบด้วย (CODE) หรือ (CODE|tag) เท่านั้น — ไม่ตรง = parser จัด transient → route ตอบ 503 แทน 4xx (DCR 22023 · ASM-011 ปิดแล้วไม่มี exception เหลือ)",
    ).toEqual([]);
  });

  it("ทิศ ข: ข้อความ pii_rejected ทั้ง 6 จุด (0008 ×3 · 0019 · 0025 · 0032) ผูกกับ parser จริงได้ code เป๊ะ", () => {
    const fixedFiles = new Set([
      "0008_audit.sql",
      "0019_wave_d_batch.sql",
      "0025_admin_export_audit.sql",
      "0032_credit_rule_atomic_rpc.sql",
    ]);
    const pii = raiseSites().filter(
      (s) => fixedFiles.has(s.file) && s.message.includes("(ERR-VAL-001|pii_rejected)"),
    );
    expect(
      pii.length,
      "ต้องเจอครบ 6 จุด (0008: before/after + context ×2 · สำเนา context ใน 0019/0025/0032)",
    ).toBe(6);
    for (const s of pii) {
      expect(
        parseRpcErrorCodeDetailed({ message: s.message }),
        `${s.file}:${s.line} ต้อง parse ได้เป็น ERR-VAL-001|pii_rejected`,
      ).toEqual({ code: "ERR-VAL-001", reason: "pii_rejected" });
    }
  });
});

describe.skipIf(!DB_URL)("DCR 22023 (live) · ปฏิเสธ PII บน RPC จริงต้องกลายเป็น 4xx ไม่ใช่ transient 503", () => {
  it("ทิศ ง: service_role PII_ACCESS + context มี digit-run → 400 · message ท้าย (ERR-VAL-001|pii_rejected) · parser ได้ code เป๊ะ", async () => {
    const res = await restCall(
      "POST",
      "/rest/v1/rpc/append_audit_event",
      { apiKey: SERVICE_KEY, token: SERVICE_KEY },
      {
        p_action: "PII_ACCESS",
        p_entity_type: "audit_log",
        p_entity_id: null,
        p_before: null,
        p_after: null,
        // digit-run 7 ตัวใน free-text = รูปแบบที่ audit_context_pii_ok ปฏิเสธ (heuristic
        // license_no ของ D19-B2) — ปฏิเสธก่อนเขียนแถวใด ๆ (ไม่มีการเขียน raw)
        p_context: { purpose: "ตรวจสอบ ref 1234567 ของรัน dcr22023" },
        p_actor_roles: null,
        p_ip_hash: null,
        p_user_agent: null,
        p_request_id: null,
      },
    );
    expect(res.status, "PostgREST แผน errcode 22023 (data exception) เป็น 400 — ไม่ใช่ 5xx").toBe(400);
    const message =
      typeof (res.json as { message?: unknown } | null)?.message === "string"
        ? ((res.json as { message: string }).message)
        : "";
    expect(message, "ต้องเป็นข้อความปฏิเสธ PII ของ append_audit_event จริง").toContain(
      "append_audit_event: ",
    );
    expect(
      parseRpcErrorCodeDetailed({ message }),
      "message ต้อง parse ได้ = ความผิดสัญญาถาวร → rpcOnceWithClassification โยน 4xx ทันที ไม่ retry เป็น 503",
    ).toEqual({ code: "ERR-VAL-001", reason: "pii_rejected" });
  });
});

/**
 * shared — kernel กลางของโดเมนประกาศนียบัตร (Wave D — D-4)
 *
 * - **service_role รวมศูนย์ที่ src/lib/certificates/** เท่านั้น (D36-O3)** — ทุก query ในโดเมนนี้
 *   ใช้ client จาก createSupabaseServiceRoleClient (lib/supabase/server) แบบ SELECT คอลัมน์แคบ
 *   + เหตุผลกำกับทุกจุด (SDS §5.2); route handler เรียกฟังก์ชันของ lib เท่านั้น ห้าม import
 *   service client ตรง
 * - cert_no `LTC-<ปี ค.ศ.>-<สุ่ม 6 หลัก>` + verify_code 43 อักขระ — **CSPRNG (node:crypto randomInt)
 *   ห้าม Math.random** (SDS §3.4a — sequence/generator ที่เดาได้ใช้ไม่ได้) · 0019-r1 มี
 *   generator ฝั่ง DB อีกชุดใน cert_issue_core (mirror ชุดเดียวกัน — BFF เลิกใช้ตอนออกใบ)
 * - audit: 0019-r1 ย้าย mutation events (CERT_ISSUE/CERT_REVOKE/CERT_REISSUE) ไปบันทึก
 *   **ใน TX เดียวกับ mutation** ภายใน SECURITY DEFINER RPCs (admin_issue/revoke/reissue_
 *   certificate + cert_issue_core — gate r1 B2/B7) — BFF เรียก `append_audit_event`
 *   เหลือ **PII_ACCESS เท่านั้น** (allowlist service_role ของ wrapper = AUTH_* + PII_ACCESS)
 */
import "server-only";
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";
import { AppError, type ErrorCode } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

/** logger ของโดเมน — ฟิลด์ผ่าน allowlist ของ repo (SDS §6.2) จึงเขียน PII ไม่ได้แม้ส่งผิดพลาด */
export const certLogger = createLogger(getConfig().logLevel);

/** แถวดิบจาก Supabase (untyped client — ตรวจชนิดเองก่อนใช้ แบบเดียวกับ route อื่นของ repo) */
export type Row = Record<string, unknown>;

/** รูปแบบ cert_no ตาม SRS Appendix A certificate_code_format — `LTC-<ปี ค.ศ.>-<สุ่ม 6 หลัก>` */
export const CERT_NO_PATTERN = /^LTC-\d{4}-\d{6}$/;

/** ความยาว verify_code (nanoid 43 อักขระ — SDS §3.4b D10) */
export const VERIFY_CODE_LENGTH = 43;

/**
 * alphabet ของ nanoid (urlAlphabet — 64 อักขระ) — ใช้ตัวอักษรที่พิมพ์/อ่านได้ทั้งชุด
 * ไม่มี package nanoid ใน repo จึงสุ่มเองจาก node:crypto (ห้ามเพิ่ม package)
 */
const VERIFY_CODE_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict";

/** bucket ของ Storage ที่เก็บ PDF ประกาศนียบัตร (SDS §3.4) */
export const CERTIFICATE_BUCKET = "certificates";

/** จำนวนครั้งสูงสุดในการสุ่ม cert_no/verify_code เมื่อชน UNIQUE (23505) */
export const MAX_CODE_ATTEMPTS = 5;

/** DB error → AppError แบบไม่ leak รายละเอียด SQL (SDS §6.1) — 503 เหมือน query อื่นของ repo */
export function dbFailed(reason: string): AppError {
  return new AppError("ERR-SYS-002", { details: { reason } });
}

/**
 * ป้าย error ท้าย message ของ RPC 0019-r1 — ข้อความไทย + `(ERR-XXX-NNN|reason)`
 * (ต่อจากแบบแผน `(ERR-XXX-NNN)` ของ 0011 — เหตุผลเจาะจงเพิ่มของ 0019-r1) เช่น
 * `ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|enrollment_not_found)`
 */
const CERT_RPC_ERROR_RE = /\((ERR-[A-Z]+-\d{3})(?:\|([a-z0-9_]+))?\)\s*$/;

/** รหัสที่ทะเทียน error ของ repo รู้จัก — รหัสนอกชุด = drift ของ DB → ไม่ map (503) */
const CERT_RPC_KNOWN_CODES = new Set([
  "ERR-VAL-001",
  "ERR-NF-001",
  "ERR-AUTH-001",
  "ERR-RBAC-001",
  "ERR-SYS-001",
  "ERR-SYS-002",
]);

/** แยกรหัส+เหตุผลจาก message ของ RPC — null = ไม่มีป้าย (เป็น error อื่น ไม่ใช่ธุรกิจ) */
export function parseCertRpcErrorCode(
  message: string,
): { code: string; reason: string | null } | null {
  const matched = CERT_RPC_ERROR_RE.exec(message);
  if (matched === null) {
    return null;
  }
  return {
    code: matched[1] as string,
    reason: typeof matched[2] === "string" ? matched[2] : null,
  };
}

/**
 * error ของ RPC 0019-r1 → AppError: มีป้ายรหัสที่รู้จัก = map ตรง (สถานะตามทะเทียน) +
 * details.reason; ไม่มีป้าย/รหัสไม่รู้จัก = ERR-SYS-002 opaque (ไม่ leak SQL ออกไป)
 */
export function certRpcError(error: unknown, fallbackReason: string): AppError {
  const message =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  const parsed = typeof message === "string" ? parseCertRpcErrorCode(message) : null;
  if (parsed !== null && CERT_RPC_KNOWN_CODES.has(parsed.code)) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    // cast ปลอดภัย: has() ผ่านชุด 6 รหัสข้างบน ซึ่งเป็นสับเซตของ ERROR_REGISTRY ทั้งหมด
    return new AppError(parsed.code as ErrorCode, { details });
  }
  return dbFailed(fallbackReason);
}

/** อ่านค่า string จากแถว — ชนิดไม่ตรง = สัญญา DB เพี้ยน (fail-closed ไม่เดาค่า) */
export function rowString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw dbFailed("cert_row_contract_mismatch");
  }
  return value;
}

/** อ่านค่า string ที่อาจเป็น null/ไม่มีฟิลด์ */
export function rowStringOrNull(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw dbFailed("cert_row_contract_mismatch");
  }
  return value;
}

/** อ่านค่า number ที่อาจเป็น null/ไม่มีฟิลด์ */
export function rowNumberOrNull(row: Row, field: string): number | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number") {
    throw dbFailed("cert_row_contract_mismatch");
  }
  return value;
}

/** สุ่ม cert_no `LTC-<ปี ค.ศ. ตามเวลาไทย>-<สุ่ม 6 หลัก>` — CSPRNG (randomInt) ห้าม Math.random */
export function generateCertNo(issuedAt: Date = new Date()): string {
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
  }).format(issuedAt);
  return `LTC-${year}-${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
}

/** สุ่ม verify_code 43 อักขระ (nanoid alphabet) ด้วย CSPRNG — rejection-free เพราะ 64 | อักขระ */
export function generateVerifyCode(): string {
  const chars: string[] = new Array(VERIFY_CODE_LENGTH);
  for (let i = 0; i < VERIFY_CODE_LENGTH; i += 1) {
    chars[i] = VERIFY_CODE_ALPHABET[randomInt(0, VERIFY_CODE_ALPHABET.length)] as string;
  }
  return chars.join("");
}

/** PostgrestError ที่มาจาก UNIQUE violation (23505) — ใช้เป็นเงื่อนไข retry ของ cert_no/verify_code */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "23505") {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("duplicate key value violates unique constraint");
}

/**
 * ชื่อ-นามสกุลจริงก่อน ถ้าไม่มีใช้ display_name (snapshot ณ วันออก — SDS §3.4a)
 * r4-H6: trim ทีละส่วนก่อน join — mirror SQL canonical ของ 0019 (holder_name_trim
 * ต่อ first/last แล้ว concat_ws — ครบชุด [[:space:]] เท่า .trim() ฝั่ง JS ตาม r7-m3)
 * เดิม join สตริงดิบทำ "Alice " + " Smith" → double space
 */
export function holderNameOf(profile: Row): string {
  const first = rowStringOrNull(profile, "first_name");
  const last = rowStringOrNull(profile, "last_name");
  const full = [first, last]
    .map((part) => (part === null ? "" : part.trim()))
    .filter((part) => part.length > 0)
    .join(" ");
  // r8-n3: fallback display_name ตัด [[:space:]] ทั้งสองข้างเหมือน issuance ฝั่ง SQL
  // (0019: nullif(holder_name_trim(display_name),'')) — ชื่อที่ไม่ว่างต้องได้ค่า
  // เดียวกันทุกทาง · whitespace ล้วนกลายเป็น '' (แถวคิวยังแสดง ไม่ใช่หาย)
  return full.length > 0 ? full : rowString(profile, "display_name").trim();
}

/**
 * r8-N2: jsonb scalar ของ RPC — ยอมรับ object ตรง ๆ หรือ array ความยาว 1 พอดี
 * (PostgREST อาจ wrap scalar เป็น array หลักเดียว) · ความยาวอื่น (0, 2+) คืนของ
 * เดิมให้ schema ขาเข้าตีตก = drift — แถวที่สอง ([validRow, junk]) หายเงียบไม่ได้
 */
export function unwrapScalarRow(data: unknown): unknown {
  if (Array.isArray(data) && data.length === 1) {
    return data[0];
  }
  return data;
}

/**
 * event audit ที่ BFF เขียนเองได้ — 0019-r1 เหลือ **PII_ACCESS เท่านั้น** (คิว eligible
 * อ่านชื่อผู้ผ่านเกณฑ์ D12-23); CERT_ISSUE/CERT_REVOKE/CERT_REISSUE บันทึกใน TX ของ
 * RPC ฝั่ง DB (append_audit_event_internal + p_actor_override) — gate r1 B2/B7
 */
export type CertificateAuditAction = "PII_ACCESS";

export interface AuditEventInput {
  readonly action: CertificateAuditAction;
  readonly entityType: "certificate" | "enrollment" | "assessment_attempt";
  readonly entityId: string | null;
  /** คีย์ต้องอยู่ใน allowlist ราย event ของ 0008_audit.sql (strict — AUDIT §3.2) + ห้ามมี PII */
  readonly context: Record<string, string>;
  readonly actorId?: string;
  readonly requestId?: string | null;
}

export interface AuditEventResult {
  readonly written: boolean;
  readonly reason: string;
}

/**
 * เขียน audit event ผ่าน RPC `append_audit_event` — **เส้นทางเดียวที่ DB เปิดให้ service_role**
 * (0010_security.sql:102 revoke insert บน audit_logs จากทุก role รวม service_role)
 *
 * **สัญญา DB ปัจจุบัน (0019-r1 ปรับ allowlist ของ 0008_audit.sql):**
 * - ใต้ role `service_role` RPC รับ **AUTH_* 12 + PII_ACCESS เท่านั้น** — CERT_ISSUE/
 *   CERT_REVOKE/CERT_REISSUE ถูกถอนออกจาก allowlist เพราะต้องบันทึก atomic กับ
 *   mutation ใน TX เดียว (D12-8) ซึ่งทำไม่ได้ผ่านสอง PostgREST call แยก → ย้ายไป RPCs
 *   ของ 0019-r1 (mutation+audit ในตัว)
 * - actor ยกจาก context.user_id (BFF trusted ใส่มา) แล้ว strip ออกก่อนเก็บจริง (0019)
 * - RPC ปฏิเสธ before/after ที่ไม่ใช่ null → ฟังก์ชันนี้ส่ง null เสมอ
 *
 * เรียก "แบบมีเงื่อนไข" ได้เฉพาะ PII_ACCESS (access event ไม่ใช่ mutation — เสียไปไม่ทำ
 * audit ขัดแย้งกับสถานะจริง): DB ปฏิเสธ → ไม่ล้ม read ธุรกิจ + WARN ไม่มี PII (tripwire
 * ตรวจการถอน allowlist/เปลี่ยนสัญญา DB) — ห้ามเดาว่าเขียนสำเร็จ จึงคืนผลให้ผู้เรียกตรวจ
 */
export async function appendAuditEvent(
  client: SupabaseClient,
  input: AuditEventInput,
): Promise<AuditEventResult> {
  const { error } = await client.rpc("append_audit_event", {
    p_action: input.action,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_before: null,
    p_after: null,
    p_context: input.context,
    p_actor_roles: null, // เมินโดย DB — derive ฝั่ง server (0008:411 D15-N1)
    p_ip_hash: null,
    p_user_agent: null,
    p_request_id: input.requestId ?? null,
  });
  if (error === null) {
    return { written: true, reason: "audit_written" };
  }
  certLogger.warn("certificate_audit_rpc_denied", {
    route: `certificates:${input.action}`,
    ...(input.actorId === undefined ? {} : { user_id: input.actorId }),
  });
  return { written: false, reason: auditDenialReason(error) };
}

/** จำแนกสาเหตุแบบสั้น ไม่มี PII และไม่คัดลอกข้อความ SQL เต็มลง log */
function auditDenialReason(error: unknown): string {  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === "42501") {
      return "db_allowlist_denies_service_role";
    }
    if (code === "P0001") {
      return "db_function_rejected_event";
    }
  }
  return "rpc_error";
}

/**
 * audit สำหรับจุดที่ไม่มี service client อยู่ในมือ (เช่น route ของ GET eligible —
 * ห้าม import service client ตรงตาม D36-O3) — สร้าง client แบบ one-shot ภายใน lib เอง
 */
export async function auditCertificateEvent(input: AuditEventInput): Promise<AuditEventResult> {
  return appendAuditEvent(createSupabaseServiceRoleClient(), input);
}

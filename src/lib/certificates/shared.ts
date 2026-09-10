/**
 * shared — kernel กลางของโดเมนประกาศนียบัตร (Wave D — D-4)
 *
 * - **service_role รวมศูนย์ที่ src/lib/certificates/** เท่านั้น (D36-O3)** — ทุก query ในโดเมนนี้
 *   ใช้ client จาก createSupabaseServiceRoleClient (lib/supabase/server) แบบ SELECT คอลัมน์แคบ
 *   + เหตุผลกำกับทุกจุด (SDS §5.2); route handler เรียกฟังก์ชันของ lib เท่านั้น ห้าม import
 *   service client ตรง
 * - cert_no `LTC-<ปี ค.ศ.>-<สุ่ม 6 หลัก>` + verify_code 43 อักขระ — **CSPRNG (node:crypto randomInt)
 *   ห้าม Math.random** (SDS §3.4a — sequence/generator ที่เดาได้ใช้ไม่ได้)
 * - audit ผ่าน RPC `append_audit_event` เท่านั้น (0010_security.sql:102 revoke insert บน audit_logs
 *   จาก service_role) — สัญญา DB ปัจจุบันปฏิเสธ event ธุรกิจใต้ service_role (ดู appendAuditEvent)
 */
import "server-only";
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
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

/** ชื่อ-นามสกุลจริงก่อน ถ้าไม่มีใช้ display_name (snapshot ณ วันออก — SDS §3.4a) */
export function holderNameOf(profile: Row): string {
  const first = rowStringOrNull(profile, "first_name");
  const last = rowStringOrNull(profile, "last_name");
  const full = [first, last]
    .filter((part) => part !== null && part.trim().length > 0)
    .join(" ")
    .trim();
  return full.length > 0 ? full : rowString(profile, "display_name");
}

/** event audit ของโดเมนนี้ — เฉพาะชื่อที่ doc ระบุ (AUDIT §2 / API-SPECIFICATION endpoint 79-83) */
export type CertificateAuditAction = "CERT_ISSUE" | "CERT_REVOKE" | "CERT_REISSUE" | "PII_ACCESS";

export interface AuditEventInput {
  readonly action: CertificateAuditAction;
  readonly entityType: "certificate" | "enrollment" | "assessment_attempt";
  readonly entityId: string;
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
 * **สัญญา DB จริงที่พบ (supabase/migrations/0008_audit.sql):**
 * - 390-394: `append_audit_event_internal` revoke EXECUTE จาก service_role (grant ให้ app_owner เท่านั้น)
 * - 457-461: ใต้ role `service_role` RPC รับเฉพาะ 12 event `AUTH_*` — `CERT_ISSUE/CERT_REVOKE/
 *   CERT_REISSUE/PII_ACCESS` ถูกปฏิเสธ (42501) เสมอ
 * - 525: RPC ปฏิเสธ before/after ที่ไม่ใช่ null → ฟังก์ชันนี้ส่ง null เสมอ
 * - 619-620: EXECUTE ของ RPC ตัวนอก granted to authenticated, service_role → เรียกได้ แต่ถูก filter
 *
 * จึงเรียก "แบบมีเงื่อนไข": พยายามเขียนจริงทุกครั้ง (ถ้า lead ออก migration ขยาย allowlist ให้
 * service_role หรือย้ายไป business function ตาม AUDIT §4 code path นี้ใช้ได้ทันทีโดยไม่แก้ caller)
 * และเมื่อ DB ปฏิเสธ → **ไม่ล้ม write ธุรกิจ** (ธงช่องว่าง audit ตามใบงาน) + WARN log ที่ไม่มี PII
 * เพื่อให้สังเกตเห็นช่องว่างได้จาก log — ห้ามเดาว่าเขียนสำเร็จ จึงคืนผลลัพธ์ให้ผู้เรียกตรวจได้
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

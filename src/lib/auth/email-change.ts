/**
 * email-change — เปลี่ยนอีเมลของตนเอง (double opt-in) — Wave F · D-f-2
 *
 * ผู้ใช้ที่ล็อกอินอยู่ขอเปลี่ยนอีเมลผ่าน GoTrue native `updateUser({ email })`
 * (MAILER_AUTOCONFIRM=false → GoTrue ส่งลิงก์ยืนยันไปที่อีเมล "ใหม่" ก่อน —
 * และเพราะ GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED ไม่ได้ตั้ง (default true ของ
 * GoTrue v2.164.0) เมื่อคลิกลิงก์แรกแล้ว GoTrue จะส่งลิงก์ยืนยัน "ฉบับที่สอง" ไปที่
 * อีเมลเดิมเพื่อยืนยันเป็นขั้นสุดท้าย — probe จริงบน dev stack 2026-09-13 ·
 * อีเมลเดิมยังใช้เข้าสู่ระบบได้จนกว่าจะคลิกยืนยันครบทั้งสองลิงก์ (double opt-in))
 * · ลิงก์ verify ที่ GoTrue แต่งขึ้นใช้ host ตาม API_EXTERNAL_URL (dev = :8000) ไม่ใช่ SITE_URL
 *
 * ลำดับของ requestEmailChange (ตาม D-f-2 — ห้ามสลับ):
 *   (a) rate limit กลุ่ม AUTH (§5 — ip + อีเมลปัจจุบัน normalized เป็นคีย์รอง)
 *   (b) zod ตรวจฟอร์ม (อีเมลใหม่ lower/trim ≤254 ต่างจากอีเมลปัจจุบัน + รหัสผ่าน ≥1)
 *   (c) re-auth รหัสผ่านปัจจุบันผ่าน GoTrue signInWithPassword ด้วย client ทิ้งได้
 *       (throwaway — persistSession:false, session ที่ได้ **ใช้เป็นหลักฐานเท่านั้น**
 *        ห้ามถือไว้หรือเขียน cookie ใด ๆ) — ผิด = รหัสผ่านไม่ถูกต้อง ไม่เฉลยฟิลด์
 *   (d) guard บังคับ MFA: บทบาทอยู่ในชุดบังคับ (instructor · staff:* ทุกระดับ · super_admin) แต่
 *       session ยัง aal1 → ERR-AUTH-004 (เดียวกับ RBAC §4.2 และ guard ของ RPC 0044)
 *   (e) updateUser({ email }, { emailRedirectTo: callback URL }) บน session ของผู้ใช้
 *   (f) RPC `my_audit_email_change_request(p_new_email_sha256)` — audit durable
 *       USER_EMAIL_CHANGE_REQUEST (เรียก "หลัง updateUser สำเร็จ" เท่านั้น —
 *       USER_EMAIL_CHANGE_CONFIRMED เป็นหน้าที่ของ trigger 0044 เมื่อ GoTrue
 *       ผูกอีเมลใหม่จริง — lib นี้ไม่เขียนเองเด็ดขาด)
 *
 * - ทุก failure คืน "ผลลัพธ์" (ไม่ throw ยกเว้น AppError ERR-RATE-001 ของ enforce ชั้นล่าง
 *   ที่ไม่ถูกใช้ที่นี่) — caller (Server Action / REST wrapper ในอนาคต) แปลงต่อเอง
 * - ข้อความที่แสดงผู้ใช้ = ไทยเท่านั้น · ห้าม log รหัสผ่าน/JWT/อีเมล (SDS §6.2)
 * - กัน enumeration: GoTrue ตอบ email_exists (422 — อีเมลใหม่เป็นของบัญชีอื่น) →
 *   **ตอบเหมือนสำเร็จ** (แนวเดียวกับ registerAction ที่ปิดบัง user_already_exists และ
 *   API-SPEC §3.1) — ไม่มีอีเมลยืนยันถูกส่งและไม่มี audit REQUEST (updateUser ล้ม)
 *   แต่มุมมองผู้ใช้เหมือนผ่านทุกขั้น
 */
import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import type { ErrorCode } from "../errors";
import { requiresMfa, type AalLevel } from "../rbac";
import { checkRateLimit } from "../rate-limit";

// ─── hash ของ audit (0044 — correlation ฝั่งตรวจสอบ ไม่ใส่อีเมลเด็ดขาด) ────────

/**
 * sha256 hex (64 ตัวอักษรพิมพ์เล็ก) ของอีเมล "lowercase + trim" แบบ UTF-8 —
 * normalization เดียวกับ trigger ของ 0044 (`sha256(convert_to(lower(email),'UTF8'))`
 * — อีเมลใน auth.users เป็นตัวพิมพ์เล็กตาม GoTrue อยู่แล้ว) และต้องผ่านรูปแบบ
 * `^[0-9a-f]{64}$` ที่ RPC ตรวจ
 */
export function hashEmailForAudit(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

// ─── ปลายทางหลังยืนยัน (emailRedirectTo) ─────────────────────────────────────

/** path หน้าผลลัพธ์สาธารณะ (route group (auth)) — GoTrue redirect_to หลัง verify */
export const EMAIL_CHANGE_CALLBACK_PATH = "/email-change/callback";

/**
 * URL เต็มของหน้าผลลัพธ์ จาก origin ของแอป (config `publicBaseUrl`) —
 * origin นี้ต้องอยู่ใน GOTRUE_URI_ALLOW_LIST (dev compose = http://localhost:3000/**)
 */
export function buildEmailChangeCallbackUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/u, "")}${EMAIL_CHANGE_CALLBACK_PATH}`;
}

// ─── zod schema ของฟอร์ม ─────────────────────────────────────────────────────

/**
 * schema ของคำขอเปลี่ยนอีเมล — email: trim+lowercase ≤254 อักขระ + รูปแบบอีเมล;
 * password: กรอกมาอย่างน้อย 1 อักขระ (นโยบายความยาวเป็นของ GoTrue — เราไม่ซ้ำซ้อน);
 * อีเมลใหม่ต้อง "ต่างจากอีเมลปัจจุบัน" (เทียบแบบ normalized — case-insensitive)
 */
export function createEmailChangeSchema(currentEmail: string | null | undefined) {
  const normalizedCurrent = (currentEmail ?? "").trim().toLowerCase();
  return z
    .object({
      email: z
        .string()
        .trim()
        .toLowerCase()
        .max(254, "อีเมลต้องมีความยาวไม่เกิน 254 อักขระ")
        .pipe(z.email({ message: "รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง" })),
      password: z.string().min(1, "กรุณากรอกรหัสผ่าน"),
    })
    .refine((value) => value.email !== normalizedCurrent, {
      message: "กรุณากรอกอีเมลใหม่ที่ต่างจากอีเมลปัจจุบัน",
      path: ["email"],
    });
}

// ─── guard บังคับ MFA (pure — ตารางความจริงเดียวกับ RBAC §4.2 / RPC 0044) ─────

/**
 * true = บัญชีถือบทบาทบังคับ MFA แต่ session ยังไม่ถึง aal2 → ปฏิเสธการเปลี่ยนอีเมล
 * (SoD เดียวกับการลบบัญชี — D-f-2); citizen/lawyer ไม่ถูกบังคับ ผ่านตลอด
 */
export function emailChangeMfaRejected(roles: readonly string[], aal: AalLevel): boolean {
  return requiresMfa(roles) && aal !== "aal2";
}

// ─── ผลลัพธ์ + ข้อความไทยของหน้า ─────────────────────────────────────────────

/** สาเหตุที่คำขอไม่ผ่าน — caller แปลงเป็น code ทะเบียนต่อด้วย EMAIL_CHANGE_ERROR_CODES */
export type EmailChangeFailure =
  | "validation" // ERR-VAL-001 — ฟอร์มไม่ผ่าน zod
  | "password_mismatch" // ERR-AUTH-002 — re-auth ไม่ผ่าน (ไม่เฉลยฟิลด์)
  | "mfa_required" // ERR-AUTH-004 — บังคับ MFA แต่ session ยัง aal1
  | "rate_limited" // ERR-RATE-001 — เกิน quota AUTH ของ app หรือ GoTrue
  | "system"; // ERR-SYS-001 — ที่เหลือทั้งหมด (opaque)

export type EmailChangeResult =
  | { readonly ok: true; readonly newEmail: string; readonly newEmailSha256: string }
  | {
      readonly ok: false;
      readonly failure: EmailChangeFailure;
      readonly errorCode: ErrorCode;
    };

/** failure → code จากทะเบียน src/lib/errors.ts (API-SPEC §2) — ห้ามคิด code นอกทะเบียน */
export const EMAIL_CHANGE_ERROR_CODES: Readonly<
  Record<EmailChangeFailure, ErrorCode>
> = {
  validation: "ERR-VAL-001",
  password_mismatch: "ERR-AUTH-002",
  mfa_required: "ERR-AUTH-004",
  rate_limited: "ERR-RATE-001",
  system: "ERR-SYS-001",
};

/**
 * ข้อความไทยของผลลัพธ์ (แหล่งเดียว — หน้า my/security/email ใช้ตรง ๆ)
 * - password_mismatch ใช้สำเนาเจาะจงฟอร์มนี้ "รหัสผ่านไม่ถูกต้อง" ตาม D-f-2
 *   (ฟอร์มมีฟิลด์รหัสผ่านเดียว — ข้อความทะเบียน "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
 *   ของ ERR-AUTH-002 กว้างกว่าความจริงของฟอร์มนี้)
 * - sent = การ์ดความสำเร็จหลัง updateUser + audit ผ่าน (double opt-in — แจ้งชัด
 *   ว่าอีเมลเดิมยังใช้ได้จนกว่าจะยืนยัน)
 */
export const EMAIL_CHANGE_MESSAGES: Readonly<
  Record<EmailChangeFailure | "sent", string>
> = {
  sent: "ระบบส่งอีเมลยืนยันไปที่อีเมลใหม่แล้ว กรุณาคลิกลิงก์ในอีเมลใหม่ก่อน จากนั้นระบบจะส่งลิงก์ยืนยันฉบับที่สองไปที่อีเมลเดิมเพื่อยืนยันเป็นขั้นสุดท้าย — อีเมลเดิมยังใช้เข้าสู่ระบบได้จนกว่าจะยืนยันครบทั้งสองลิงก์",
  validation: "ข้อมูลที่ส่งมาไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
  password_mismatch: "รหัสผ่านไม่ถูกต้อง",
  mfa_required: "กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนเปลี่ยนอีเมล",
  rate_limited: "มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
  system: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่",
};

// ─── ชนิดของ dependency (inject — unit/integration test แทนที่ได้) ───────────

/** ผลของ re-auth รหัสผ่าน — "invalid" ไม่เฉลยเหตุ (invalid_credentials / banned) */
export type VerifyPasswordResult = "ok" | "invalid" | "rate_limited" | "system";

export interface EmailChangeDeps {
  /** re-auth รหัสผ่านปัจจุบันผ่าน GoTrue (client ทิ้งได้ — session ต้องไม่ถูกเก็บ) */
  readonly verifyPassword: (
    email: string,
    password: string,
  ) => Promise<VerifyPasswordResult>;
  /** updateUser บน session ของผู้ใช้ — คืน code/message ดิบของ GoTrue เมื่อล้ม */
  readonly updateUserEmail: (
    email: string,
    emailRedirectTo: string,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string | null; readonly message: string | null }
  >;
  /** RPC my_audit_email_change_request ด้วย user JWT — เรียกหลัง updateUser สำเร็จ */
  readonly auditRequest: (
    newEmailSha256: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string | null }>;
}

export interface EmailChangeInput {
  /** อีเมลใหม่ (ดิบจากฟอร์ม — schema จัด trim/lowercase เอง) */
  readonly newEmail: string;
  /** รหัสผ่านปัจจุบัน (ดิบจากฟอร์ม — ห้าม log) */
  readonly password: string;
  /** อีเมลปัจจุบันของ session (จาก GoTrue getUser ฝั่ง server) */
  readonly currentEmail: string;
  /** บทบาทของผู้ใช้ (RPC my_roles) — ใช้ตัดสิน guard MFA */
  readonly roles: readonly string[];
  /** ระดับ assurance ของ session ปัจจุบัน */
  readonly aal: AalLevel;
  /** IP ของผู้เรียก (clientIpFrom — คีย์นับ rate limit หลัก) */
  readonly rateLimitIp: string;
  /** URL หน้าผลลัพธ์สำหรับ emailRedirectTo (buildEmailChangeCallbackUrl ของ origin แอป) */
  readonly callbackUrl: string;
  /** inject นาฬิกาของ rate limit (unit test) */
  readonly now?: () => number;
}

// ─── การจำแนก error ของ GoTrue updateUser / RPC audit ────────────────────────

/**
 * จำแนก error ของ updateUser — **email_exists = ตอบเหมือนสำเร็จ** (กัน enumeration
 * ตามหัวไฟล์) · over_*_rate_limit = ถูกจำกัด · ที่เหลือ opaque เป็น system
 */
export function classifyUpdateUserError(error: {
  code?: string | null;
}): "email_taken_masked" | "rate_limited" | "system" {
  switch (error.code) {
    case "email_exists":
      return "email_taken_masked";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "rate_limited";
    default:
      return "system";
  }
}

/**
 * จำแนก error ของ RPC audit (0044 แท็กข้อความไว้ "ERR-AUTH-004|mfa_required" /
 * "ERR-VAL-001|hash_format") — mfa_required ถึงมาได้เมื่อบทบาทถูกเปลี่ยนระหว่าง
 * re-auth → updateUser (race — guard ฝั่งแอปผ่านไปก่อน) = fail-closed ที่ DB
 */
export function classifyAuditRpcError(message: string | null): EmailChangeFailure {
  if (message !== null && message.includes("mfa_required")) {
    return "mfa_required";
  }
  return "system";
}

// ─── orchestration (ทางเข้าเดียวของ Server Action + REST wrapper ภายหลัง) ────

/**
 * คำขอเปลี่ยนอีเมล — ลำดับ (a)→(f) ตามหัวไฟล์ · สำเร็จ = GoTrue ส่งลิงก์ยืนยันแล้ว
 * และ audit REQUEST ถูกเขียนแล้ว (ยกเว้นกรณี masked email_exists — ไม่ส่ง ไม่ audit)
 */
export async function requestEmailChange(
  input: EmailChangeInput,
  deps: EmailChangeDeps,
): Promise<EmailChangeResult> {
  // (a) rate limit กลุ่ม AUTH — ip + อีเมลปัจจุบัน normalized (คีย์รองประจำกลุ่ม §5)
  const limit = checkRateLimit(
    "AUTH",
    { ip: input.rateLimitIp, secondary: input.currentEmail.trim().toLowerCase() },
    input.now,
  );
  if (!limit.allowed) {
    return fail("rate_limited");
  }

  // (b) zod — รูปแบบ/ความยาว/ต่างจากอีเมลปัจจุบัน/รหัสผ่านกรอกมา
  const parsed = createEmailChangeSchema(input.currentEmail).safeParse({
    email: input.newEmail,
    password: input.password,
  });
  if (!parsed.success) {
    return fail("validation");
  }
  const newEmail = parsed.data.email;
  const newEmailSha256 = hashEmailForAudit(newEmail);

  // (c) re-auth รหัสผ่านปัจจุบัน — ผิด = ไม่ดำเนินการใด ๆ ต่อ (ไม่เฉลยฟิลด์)
  const verified = await deps.verifyPassword(input.currentEmail, parsed.data.password);
  if (verified === "invalid") {
    return fail("password_mismatch");
  }
  if (verified === "rate_limited") {
    return fail("rate_limited");
  }
  if (verified !== "ok") {
    return fail("system");
  }

  // (d) guard บังคับ MFA — ทำหลัง re-auth ตาม D-f-2 (RPC 0044 ตรวจซ้ำเป็นชั้นที่สอง)
  if (emailChangeMfaRejected(input.roles, input.aal)) {
    return fail("mfa_required");
  }

  // (e) updateUser — GoTrue ส่งลิงก์ยืนยันไปที่อีเมลใหม่ (AUTOCONFIRM=false) ·
  // emailRedirectTo ต้องอยู่ใน GOTRUE_URI_ALLOW_LIST จึงจะถูกใช้จริง
  const updated = await deps.updateUserEmail(newEmail, input.callbackUrl);
  if (!updated.ok) {
    const kind = classifyUpdateUserError(updated);
    if (kind === "email_taken_masked") {
      // กัน enumeration — ตอบเหมือนสำเร็จ (ไม่มีอีเมลส่งจริง ไม่มี audit REQUEST)
      return { ok: true, newEmail, newEmailSha256 };
    }
    return fail(kind === "rate_limited" ? "rate_limited" : "system");
  }

  // (f) audit durable USER_EMAIL_CHANGE_REQUEST (หลัง updateUser สำเร็จเท่านั้น)
  const audited = await deps.auditRequest(newEmailSha256);
  if (!audited.ok) {
    return fail(classifyAuditRpcError(audited.message));
  }

  return { ok: true, newEmail, newEmailSha256 };
}

/** ผลลัพธ์ล้มเหลว — แปลง failure เป็น code ทะเบียนที่นี่ที่เดียว */
function fail(failure: EmailChangeFailure): EmailChangeResult {
  return { ok: false, failure, errorCode: EMAIL_CHANGE_ERROR_CODES[failure] };
}

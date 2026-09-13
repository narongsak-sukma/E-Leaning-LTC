/**
 * password-change — เปลี่ยนรหัสผ่านของตนเอง (AUTH-005 · Wave G P1 · D72)
 *
 * ผู้ใช้ที่ล็อกอินอยู่เปลี่ยนรหัสผ่านได้เมื่อ "พิสูจน์รหัสผ่านปัจจุบัน" ก่อนเสมอ —
 * ลำดับของ changePassword (ตาม D72 — ห้ามสลับ):
 *   (a) ตรวจรูปแบบ (pure — จุดเรียกต้อง enforce rate limit กลุ่ม AUTH ก่อนเรียก lib เสมอ:
 *       route = enforceRateLimit(request, { group: "AUTH", secondaryKey: userId })
 *       action = checkRateLimit แบบไม่ throw แล้วแปลงเป็นการ์ดไทย — การนับเกิดก่อน
 *       พิสูจน์รหัสผ่านเสมอ จึง "นับเข้า rate limit" ทั้งกรณีกรอกผิด)
 *   (b) รหัสใหม่ ≥12 (GOTRUE_PASSWORD_MIN_LENGTH — ข้อความนโยบายเดียวกับหน้า register)
 *       · รหัสใหม่ต่างจากรหัสปัจจุบัน · (ฟอร์ม UI เพิ่มยืนยันรหัสใหม่ตรงกัน)
 *   (c) re-auth รหัสผ่านปัจจุบันผ่าน GoTrue signInWithPassword ด้วย client ทิ้งได้
 *       (standalone — persistSession:false, session ที่ได้ใช้เป็นหลักฐานเท่านั้น ไม่เขียน
 *        cookie ใด ๆ — แบบเดียวกับ loginAction / email-change) ผิด = ไม่แตะ GoTrue ต่อ
 *   (d) PUT /auth/v1/user {password} ด้วย session ของผู้ใช้ (client ผูก cookie — ssr.ts)
 *       — เซสชันปัจจุบัน "คงไว้" ตามสัญญา (ห้าม sign out จากขานี้) · พฤติกรรมเซสชัน
 *       อื่น ๆ เป็นของ GoTrue — พิสูจน์ด้วย integration test จริง (wave-g-auth005)
 *   (e) audit AUTH_PASSWORD_CHANGE ผ่าน service-role RPC append_audit_event (allowlist
 *       0025/0008 — context strict ได้เฉพาะ ['method','session_id'] + user_id ที่ RPC
 *       ยกเป็น actor) · audit ไม่ผ่าน = fail-closed (ไม่ตอบ 200 แม้ GoTrue เปลี่ยนแล้ว
 *       — แนวเดียวกับ admin/users.ts:367) — หมายเหตุตรงไปตรงมา: ณ กรณีนี้รหัสผ่าน
 *       เปลี่ยนจริงแล้วใน GoTrue แต่ผู้ใช้เห็นการ์ดข้อผิดพลาด (trade-off ที่ยอมรับ
 *       เพื่อคง "ไม่มี mutation ลอด audit")
 *
 * - ทุก failure คืน "ผลลัพธ์" (ไม่ throw) — caller (route/action) แปลงต่อเอง
 * - ข้อความที่แสดงผู้ใช้ = ไทยเท่านั้น · ห้าม log รหัสผ่าน/JWT/อีเมล (SDS §6.2)
 */
import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ErrorCode } from "../errors";
import { getConfig } from "../config";
import { createSupabaseServiceRoleClient } from "../supabase/server";

// ─── ข้อความไทย (แหล่งเดียว — หน้า /my/security และ route ใช้ตรง ๆ) ─────────────

/**
 * ข้อความนโยบายรหัสผ่าน — **คัดลอกคำต่อคำจากหน้า register** (REGISTER_NOTICE_MESSAGES
 * weak_password — D72 ให้ใช้ข้อความ policy เดียวกัน)
 */
export const PASSWORD_POLICY_MESSAGE =
  "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่";

/** ความยาวขั้นต่ำ = GOTRUE_PASSWORD_MIN_LENGTH ของ docker-compose (12) */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * ข้อความไทยของผลลัพธ์ — wrong_current ตรงสัญญา D72 ("รหัสผ่านปัจจุบันไม่ถูกต้อง"
 * เจาะจงกว่าข้อความทะเบียนของ ERR-AUTH-002 ที่กว้างกว่าความจริงของฟอร์มนี้)
 */
export const PASSWORD_CHANGE_MESSAGES = {
  changed: "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว",
  validation: "ข้อมูลที่ส่งมาไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
  password_policy: PASSWORD_POLICY_MESSAGE,
  wrong_current: "รหัสผ่านปัจจุบันไม่ถูกต้อง",
  same_password: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน",
  confirm_mismatch: "รหัสผ่านใหม่กับการยืนยันรหัสผ่านใหม่ไม่ตรงกัน",
  rate_limited: "มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
  audit_failed:
    "ระบบบันทึกหลักฐานการเปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง (หากลองแล้วระบบแจ้งว่ารหัสผ่านใหม่ซ้ำกับปัจจุบัน แสดงว่าเปลี่ยนสำเร็จแล้ว — ให้ใช้รหัสผ่านใหม่ต่อไป)",
  system: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่",
} as const;

// ─── validation (pure — unit test ได้เต็ม ๆ) ─────────────────────────────────

/** ชุดสาเหตุที่คำขอไม่ผ่าน — caller แปลงเป็น code ทะเบียนด้วย PASSWORD_CHANGE_ERROR_CODES */
export type PasswordChangeFailure =
  | "validation" // ERR-VAL-001 — รูป/ชนิดของ body ผิด
  | "password_policy" // ERR-VAL-001 — รหัสใหม่ < 12 (ข้อความ policy)
  | "same_password" // ERR-VAL-001 — รหัสใหม่ซ้ำกับปัจจุบัน (400 ไทย)
  | "confirm_mismatch" // ERR-VAL-001 — ยืนยันรหัสใหม่ไม่ตรง (ของฟอร์ม UI)
  | "wrong_current" // ERR-AUTH-002 401 — พิสูจน์รหัสปัจจุบันไม่ผ่าน
  | "rate_limited" // ERR-RATE-001 — เกิน quota AUTH (จุดเรียกตรวจ)
  | "audit_failed" // ERR-SYS-002 — RPC audit ไม่ผ่าน (fail-closed)
  | "system"; // ERR-SYS-001 — ที่เหลือทั้งหมด (opaque)

/**
 * ตรวจคำขอเปลี่ยนรหัสผ่านแบบ pure — คืน null = ผ่านทุกข้อ หรือ failure แรกที่พบ
 * (ลำดับความสำคัญ: รูปแบบ → นโยบายความยาว → ซ้ำกับปัจจุบัน → ยืนยันไม่ตรง)
 */
export function validatePasswordChange(input: {
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly confirmPassword?: string;
}): PasswordChangeFailure | null {
  if (
    typeof input.currentPassword !== "string" ||
    input.currentPassword.length === 0 ||
    typeof input.newPassword !== "string"
  ) {
    return "validation";
  }
  if (input.newPassword.length < PASSWORD_MIN_LENGTH) {
    return "password_policy";
  }
  if (input.newPassword === input.currentPassword) {
    return "same_password";
  }
  if (
    input.confirmPassword !== undefined &&
    input.confirmPassword !== input.newPassword
  ) {
    return "confirm_mismatch";
  }
  return null;
}

// ─── ผลลัพธ์ + code ทะเบียน ──────────────────────────────────────────────────

/** failure → code จากทะเบียน src/lib/errors.ts (API-SPEC §2) — ห้ามคิด code นอกทะเบียน */
export const PASSWORD_CHANGE_ERROR_CODES: Readonly<
  Record<PasswordChangeFailure, ErrorCode>
> = {
  validation: "ERR-VAL-001",
  password_policy: "ERR-VAL-001",
  same_password: "ERR-VAL-001",
  confirm_mismatch: "ERR-VAL-001",
  wrong_current: "ERR-AUTH-002", // 401 ตามทะเบียน
  rate_limited: "ERR-RATE-001",
  audit_failed: "ERR-SYS-002",
  system: "ERR-SYS-001",
};

export type PasswordChangeResult =
  | { readonly ok: true; readonly userId: string; readonly sessionId: string }
  | {
      readonly ok: false;
      readonly failure: PasswordChangeFailure;
      readonly errorCode: ErrorCode;
      /** ข้อความไทยของ failure (แหล่งเดียวกับ PASSWORD_CHANGE_MESSAGES) */
      readonly errorMessage: string;
    };

/** ผลลัพธ์ล้มเหลว — แปลง failure เป็น code ทะเบียน + ข้อความไทยที่นี่ที่เดียว */
function fail(failure: PasswordChangeFailure): PasswordChangeResult {
  return {
    ok: false,
    failure,
    errorCode: PASSWORD_CHANGE_ERROR_CODES[failure],
    errorMessage: PASSWORD_CHANGE_MESSAGES[failure],
  };
}

// ─── dependency (inject — unit/integration test แทนที่ได้) ───────────────────

/** ผลของ re-auth รหัสผ่านปัจจุบัน — "invalid" ไม่เฉลยเหตุ (invalid_credentials / banned) */
export type VerifyCurrentPasswordResult = "ok" | "invalid" | "rate_limited" | "system";

export interface PasswordChangeDeps {
  /** re-auth รหัสผ่านปัจจุบันผ่าน GoTrue (client ทิ้งได้ — session ต้องไม่ถูกเก็บ/เขียน cookie) */
  readonly verifyCurrentPassword: (
    email: string,
    password: string,
  ) => Promise<VerifyCurrentPasswordResult>;
  /** PUT /auth/v1/user {password} บน session ของผู้ใช้ — คืน code/message ดิบของ GoTrue เมื่อล้ม */
  readonly updateUserPassword: (
    password: string,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string | null; readonly message: string | null }
  >;
  /** RPC audit AUTH_PASSWORD_CHANGE (service-role) — เรียกหลัง updateUser สำเร็จเท่านั้น */
  readonly auditPasswordChange: (
    userId: string,
    sessionId: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string | null }>;
}

export interface PasswordChangeInput {
  /** id ของผู้ใช้จาก session (requireUser — trusted ฝั่ง server) */
  readonly userId: string;
  /** อีเมลปัจจุบันของ session (GoTrue getUser ฝั่ง server) — ใช้ใน re-auth */
  readonly email: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  /** claim `session_id` ของ access token ปัจจุบัน (audit — readJwtSessionClaim) */
  readonly sessionId: string;
}

/**
 * จำแนก error ของ GoTrue updateUser (รหัสผ่าน) — weak_password = นโยบาย ·
 * over_*_rate_limit = ถูกจำกัด · ที่เหลือ opaque เป็น system (แนวเดียวกับ email-change)
 */
export function classifyUpdateUserPasswordError(error: {
  code?: string | null;
}): PasswordChangeFailure {
  switch (error.code) {
    case "weak_password":
      return "password_policy";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "rate_limited";
    default:
      return "system";
  }
}

/**
 * เปลี่ยนรหัสผ่าน — ลำดับ (b)→(e) ตามหัวไฟล์ · rate limit เป็นหน้าที่ของจุดเรียก
 * (ต้องเรียกก่อน lib เสมอ — กรอกรหัสผิดต้องนับเข้า quota AUTH ด้วย)
 */
export async function changePassword(
  input: PasswordChangeInput,
  deps: PasswordChangeDeps,
): Promise<PasswordChangeResult> {
  // (b) รูปแบบ + นโยบาย + ต่างจากปัจจุบัน — ตรวจก่อนแตะ GoTrue เสมอ
  const invalid = validatePasswordChange(input);
  if (invalid !== null) {
    return fail(invalid);
  }

  // (c) พิสูจน์รหัสผ่านปัจจุบันก่อนเสมอ — ผิด = ไม่ดำเนินการใด ๆ ต่อ
  const verified = await deps.verifyCurrentPassword(input.email, input.currentPassword);
  if (verified !== "ok") {
    if (verified === "invalid") {
      return fail("wrong_current");
    }
    if (verified === "rate_limited") {
      return fail("rate_limited");
    }
    return fail("system");
  }

  // (d) PUT /auth/v1/user {password} ด้วย session ผู้ใช้ — เซสชันปัจจุบันคงไว้
  const updated = await deps.updateUserPassword(input.newPassword);
  if (!updated.ok) {
    return fail(classifyUpdateUserPasswordError(updated));
  }

  // (e) audit AUTH_PASSWORD_CHANGE — fail-closed (ห้ามตอบ 200 เมื่อ audit ไม่ผ่าน)
  const audited = await deps.auditPasswordChange(input.userId, input.sessionId);
  if (!audited.ok) {
    return fail("audit_failed");
  }

  return { ok: true, userId: input.userId, sessionId: input.sessionId };
}

// ─── dependency จริง (route + server action ใช้ชุดเดียวกัน) ──────────────────

/**
 * ประกอบ deps จริงของ changePassword — "ประกอบ dependency จริง" แบบเดียวกับ
 * /my/security/email/actions.ts จึงไม่มี wiring ซ้ำระหว่าง REST wrapper กับ action:
 * - verifyCurrentPassword: standalone client (persistSession:false — session ที่ได้
 *   ใช้เป็นหลักฐานเท่านั้น ทิ้งทันที ไม่เขียน cookie ใด ๆ)
 * - updateUserPassword: client ผูก cookie ของ session ปัจจุบัน (ssr.ts)
 * - auditPasswordChange: service-role RPC append_audit_event — context strict
 *   ['method','session_id'] + user_id (RPC ยกเป็น actor แล้ว strip ออก — 0008)
 */
export function buildPasswordChangeDeps(
  supabase: SupabaseClient,
  requestId: string | null = null,
): PasswordChangeDeps {
  const config = getConfig();
  return {
    verifyCurrentPassword: async (email, password) => {
      const probe = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await probe.auth.signInWithPassword({ email, password });
      if (error === null) {
        return "ok";
      }
      switch (error.code) {
        case "over_request_rate_limit":
          return "rate_limited";
        case "invalid_credentials":
        case "user_banned":
          return "invalid";
        default:
          return "system";
      }
    },
    updateUserPassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      return error === null
        ? { ok: true }
        : { ok: false, code: error.code ?? null, message: error.message ?? null };
    },
    auditPasswordChange: async (auditUserId, auditSessionId) => {
      const service = createSupabaseServiceRoleClient();
      const { error } = await service.rpc("append_audit_event", {
        p_action: "AUTH_PASSWORD_CHANGE",
        p_entity_type: "user",
        p_entity_id: auditUserId,
        p_before: null,
        p_after: null,
        p_context: {
          user_id: auditUserId,
          method: "password",
          session_id: auditSessionId,
        },
        p_actor_roles: null, // เมินโดย DB — derive ฝั่ง server (0008:411 D15-N1)
        p_ip_hash: null,
        p_user_agent: null,
        p_request_id: requestId,
      });
      return error === null ? { ok: true } : { ok: false, message: error.message ?? null };
    },
  };
}

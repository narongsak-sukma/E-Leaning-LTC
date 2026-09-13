/**
 * password-reset — ลืมรหัสผ่าน/ตั้งรหัสใหม่ (AUTH-004 · Wave G P1 · D72)
 * flow: request → GoTrue recover (ตอบ 200 ข้อความเดียวกันทุกกรณี) → ลิงก์ recovery
 * → /reset-password (fragment session) → confirm (PUT /auth/v1/user + logout
 * scope=global + ล้าง cookie + audit DONE) — รายละเอียดกำกับที่จุดต่าง ๆ ด้านล่าง
 */
import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { getConfig } from "../config";
import type { ErrorCode } from "../errors";

// ─── redirect_to + ข้อความคงที่ ──────────────────────────────────────────────

/** path ของหน้าตั้งรหัสใหม่ — GoTrue recovery redirect_to */
export const RESET_PASSWORD_PATH = "/reset-password";

/** URL เต็มของหน้าตั้งรหัสใหม่จาก origin ของแอป (ต้องอยู่ใน GOTRUE_URI_ALLOW_LIST) */
export function buildResetPasswordUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/u, "")}${RESET_PASSWORD_PATH}`;
}

/**
 * ข้อความตอบกลับของ request — ข้อความเดียวกันทุกกรณี (anti-enumeration —
 * ห้ามเปลี่ยนข้อความตามผล)
 */
export const PASSWORD_RESET_REQUEST_MESSAGE =
  "ถ้าอีเมลนี้มีในระบบ ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว";

/** ข้อความ success ของ confirm — หน้า /reset-password แสดงก่อนพาไป /login */
export const PASSWORD_RESET_DONE_MESSAGE =
  "ตั้งรหัสผ่านใหม่สำเร็จแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่";

/** ข้อความนโยบายรหัสผ่าน (GoTrue weak_password) — copy เดียวกับหน้า register */
export const PASSWORD_RESET_POLICY_MESSAGE =
  "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่";

// ─── zod + parsers (ขาเข้า) ──────────────────────────────────────────────────

/** อีเมล: trim + lowercase + รูปแบบอีเมล (แบบเดียวกับ actions.ts) */
const requestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "อีเมลต้องมีความยาวไม่เกิน 254 อักขระ")
    .pipe(z.email({ message: "รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง" })),
});

/** confirm — รหัสผ่าน ≥12 (GOTRUE_PASSWORD_MIN_LENGTH) */
export const passwordResetConfirmSchema = z.object({
  password: z.string().min(12, "รหัสผ่านต้องมีความยาวอย่างน้อย 12 อักขระ"),
});

/** zod-ตรวจ body ของ request — คืน normalized email หรือ fail */
export function parsePasswordResetRequest(
  body: unknown,
): { ok: true; email: string } | { ok: false } {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, email: parsed.data.email };
}

/** zod-ตรวจ body ของ confirm — คืน password (≥12) หรือ fail */
export function parsePasswordResetConfirm(
  body: unknown,
): { ok: true; password: string } | { ok: false } {
  const parsed = passwordResetConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, password: parsed.data.password };
}

// ─── ip_hash (PB-13 — แบบเดียวกับ route ตรวจประกาศนียบัตร) ───────────────────

/**
 * ip_hash = sha256(ip + salt) — salt = IP_HASH_SALT ไม่ตั้ง → fallback
 * SUPABASE_ANON_KEY (dev-grade — prod โดน superRefine กั้นตอน boot)
 */
export function ipHashOf(ip: string): string {
  const { ipHashSalt, supabaseAnonKey } = getConfig();
  const salt = ipHashSalt ?? supabaseAnonKey;
  return createHash("sha256").update(ip + salt).digest("hex");
}

// ─── (1) request — audit ก่อน แล้ว recover (ผลใด ๆ = ตอบเหมือนสำเร็จ) ─────────

/** ผลลัพธ์ของ request — ล้มเหลวได้ทางเดียวคือ audit fail (ERR-SYS-002) */
export type PasswordResetRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: ErrorCode };

export interface PasswordResetRequestDeps {
  /**
   * เรียก GoTrue POST /auth/v1/recover — ผลใด ๆ (สำเร็จ/429/5xx/network) ห้าม
   * เปลี่ยนผลลัพธ์ของ request (over_email_send_rate_limit นับเฉพาะอีเมลที่มีบัญชี
   * — แยกตอบ = ช่อง enumeration)
   */
  readonly recover: (email: string, redirectTo: string) => Promise<unknown>;
  /** เขียน audit AUTH_PASSWORD_RESET_REQUEST (context {ip_hash}) — fail-closed */
  readonly audit: (
    ipHash: string,
    requestId: string | null,
  ) => Promise<{ ok: true } | { ok: false }>;
}

export interface PasswordResetRequestInput {
  /** อีเมล normalized แล้ว (parsePasswordResetRequest) */
  readonly email: string;
  /** redirect_to ที่ส่งให้ GoTrue (buildResetPasswordUrl(publicBaseUrl)) */
  readonly redirectTo: string;
  /** ip_hash ของผู้เรียก — audit field เดียวตาม allowlist 0008:470 */
  readonly ipHash: string;
  /** request id จาก middleware (audit) */
  readonly requestId: string | null;
}

/**
 * คำขอลืมรหัสผ่าน — audit REQUEST ก่อน recover (gate r1 F3: ห้ามมี mutation
 * โดยไม่มี audit) — audit ล้ม = ไม่เรียก GoTrue ตอบ ERR-SYS-002 · recover ล้ม
 * ทุกแบบ = ok:true (ตอบ 200 ข้อความคงที่ — ผู้เรียกแยกไม่ออก)
 */
export async function requestPasswordReset(
  input: PasswordResetRequestInput,
  deps: PasswordResetRequestDeps,
): Promise<PasswordResetRequestResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const audited = await deps.audit(input.ipHash, input.requestId);
    if (audited.ok) {
      try {
        await deps.recover(input.email, input.redirectTo);
      } catch {
        // ผลใด ๆ ของ recover (รวม throw) = ตอบเหมือนสำเร็จ (masking — anti-enumeration)
      }
      return { ok: true };
    }
  }
  return { ok: false, errorCode: "ERR-SYS-002" };
}

// ─── (3) confirm — ลำดับคงที่: update → logout global → clear → audit ────────

/** สาเหตุที่ confirm ไม่ผ่าน — route แปลงเป็น code ทะเบียนด้วยตารางข้างล่าง */
export type PasswordResetConfirmFailure =
  | "no_session"
  | "expired_link"
  | "weak_password"
  | "system"
  // gate r1 M3: PUT+logout สำเร็จแล้ว เหลือแค่ชั้น audit ล้ม — แยกkind เพื่อให้
  // route รู้ว่า "ต้อง flush การล้าง cookie แล้ว" (ต่างจาก system ก่อน mutation)
  | "audit_failed";

/** failure → code จากทะเบียน src/lib/errors.ts (API-SPEC §2) — ห้ามคิดนอกทะเบียน */
export const PASSWORD_RESET_CONFIRM_ERROR_CODES: Readonly<
  Record<PasswordResetConfirmFailure, ErrorCode>
> = {
  no_session: "ERR-AUTH-001",
  expired_link: "ERR-AUTH-005",
  weak_password: "ERR-VAL-001",
  system: "ERR-SYS-002",
  audit_failed: "ERR-SYS-002",
};

export interface PasswordResetConfirmDeps {
  /** PUT /auth/v1/user {password} ด้วย Bearer token ของ session recovery */
  readonly updatePassword: (
    accessToken: string,
    password: string,
  ) => Promise<"ok" | "expired_link" | "weak_password" | "system">;
  /** POST /auth/v1/logout?scope=global — เพิกถอนทุกเซสชันของ user ทันที */
  readonly logoutGlobal: (accessToken: string) => Promise<"ok" | "system">;
  /** เขียน audit AUTH_PASSWORD_RESET_DONE (context {ip_hash}) — fail-closed */
  readonly audit: (
    ipHash: string,
    requestId: string | null,
  ) => Promise<{ ok: true } | { ok: false }>;
  /** ล้าง cookie session ฝั่งเรา (เรียกเมื่อ "ปลอดภัยแล้ว" เท่านั้น) */
  readonly clearCookies: () => void;
}

export interface PasswordResetConfirmInput {
  /** access token ของ session recovery (จาก cookie — ตรวจกับ GoTrue แล้ว) */
  readonly accessToken: string;
  /** รหัสผ่านใหม่ (≥12 ตาม schema) */
  readonly password: string;
  /** ip_hash ของผู้เรียก — audit field เดียวตาม allowlist 0008:471 */
  readonly ipHash: string;
  /** request id จาก middleware (audit) */
  readonly requestId: string | null;
}

/**
 * จำแนกความล้มเหลวของ PUT /auth/v1/user จาก (status, error_code) — 422+
 * weak_password = นโยบายรหัสผ่าน · 400/401/403 = token ของ recovery session
 * ไม่ถูกต้อง/หมดอายุ (ลิงก์เสีย) · ที่เหลือ = system (429/5xx/parse ไม่ได้)
 */
export function classifyGoTruePutUserFailure(
  status: number,
  goTrueErrorCode: string | null,
): "expired_link" | "weak_password" | "system" {
  if (status === 422 && goTrueErrorCode === "weak_password") {
    return "weak_password";
  }
  if (status === 400 || status === 401 || status === 403) {
    return "expired_link";
  }
  return "system";
}

/** จำแนก error_code จาก body ของ GoTrue (สนใจแค่ weak_password — ที่เหลือ null) */
export function goTrueErrorCodeOf(status: number, bodyText: string | null): string | null {
  if (status !== 422 || bodyText === null || bodyText.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null && "error_code" in parsed) {
      const code = (parsed as { error_code: unknown }).error_code;
      if (typeof code === "string") {
        return code;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * ยืนยันรหัสผ่านใหม่ — ลำดับคงที่ (ห้ามสลับ):
 *   (a) PUT /auth/v1/user — ล้ม = ไม่ดำเนินการใด ๆ ต่อ (cookie คงไว้: no_session
 *       ผ่าน retry ได้ · weak_password ผู้ใช้กรอกใหม่ได้ · ลิงก์เสีย = 403 ลิงก์หมดอายุ)
 *   (b) logout scope=global — ล้ม = 503 คง cookie ไว้ให้กด retry (แบบเดียวกับ
 *       logout route: ห้ามล้าง cookie ก่อน revoke จริง)
 *   (c) ล้าง cookie
 *   (d) audit DONE (retry 1 ครั้ง; ยังล้ม = ERR-SYS-002 — cookie ล้างไปแล้ว
 *       เพราะ revoke สำเร็จแล้ว ความล้มเหลวที่เหลือคือชั้น audit ล้วน)
 */
export async function confirmPasswordReset(
  input: PasswordResetConfirmInput,
  deps: PasswordResetConfirmDeps,
): Promise<{ ok: true } | { ok: false; failure: PasswordResetConfirmFailure }> {
  // (a) PUT /auth/v1/user {password}
  const updated = await deps.updatePassword(input.accessToken, input.password);
  if (updated !== "ok") {
    return { ok: false, failure: updated === "system" ? "system" : updated };
  }
  // (b) เพิกถอนทุกเซสชันทันที
  const loggedOut = await deps.logoutGlobal(input.accessToken);
  if (loggedOut !== "ok") {
    return { ok: false, failure: "system" };
  }
  // (c) ล้าง cookie ฝั่งเรา — recovery session ห้ามคงเหลือ
  deps.clearCookies();
  // (d) audit DONE — retry อีกครั้งเดียว (แบบ auditUsersPiiAccessFailClosed)
  let auditedOk = false;
  for (let attempt = 0; attempt < 2 && !auditedOk; attempt += 1) {
    const audited = await deps.audit(input.ipHash, input.requestId);
    auditedOk = audited.ok;
  }
  if (!auditedOk) {
    // gate r1 M3: ตรงนี้ PUT+logout สำเร็จและ cookie ถูกล้างไปแล้ว — แยกจาก
    // "system" (ที่ยังไม่เกิด mutation) เพื่อให้ route commit การล้าง cookie
    // อย่างเดียวกับทางสำเร็จก่อนตอบ 503
    return { ok: false, failure: "audit_failed" };
  }
  return { ok: true };
}

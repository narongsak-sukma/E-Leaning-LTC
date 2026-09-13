"use server";

/**
 * actions — Server Action ของ /my/security (section รหัสผ่าน · AUTH-005 · Wave G P1 · D72)
 *
 * - ทางเข้า UI ของการเปลี่ยนรหัสผ่าน — ลำดับภายในอยู่ใน src/lib/auth/password-change.ts
 *   (ทางเข้าเดียวกับ REST wrapper /api/v1/me/password) — action ทำแค่ "ประกอบ dependency
 *   จริง" และ rate limit แบบไม่ throw (แตกต่างจาก route ที่ใช้ enforceRateLimit แล้วให้
 *   429): เกิน quota → การ์ดไทย (เดียวกับ email-change ที่ lib คืน failure rate_limited)
 * - ผลลัพธ์กลับมาทาง query string ของ /my/security: ?status=<allowlist ของหน้า> —
 *   หน้า allowlist เองแล้วแสดงการ์ดไทย (แนวเดียวกับ MFA status ของหน้านี้)
 * - ห้าม log รหัสผ่าน/JWT/อีเมล (SDS §6.2)
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  buildPasswordChangeDeps,
  changePassword,
  validatePasswordChange,
  type PasswordChangeFailure,
} from "@/lib/auth/password-change";
import { getUser } from "@/lib/auth/session";
import { readJwtSessionClaim } from "@/lib/schemas/v1/exam";
import { checkRateLimit, clientIpFrom } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** path ของหน้าศูนย์ความปลอดภัย — ปลายทาง redirect หลัง action จบทุกกรณี */
const SECURITY_PATH = "/my/security";

/** status ของหน้า (allowlist เดียวกับ page.tsx) ต่อ failure ของ lib — แหล่งเดียว */
const PASSWORD_STATUS_BY_FAILURE: Record<PasswordChangeFailure, string> = {
  validation: "password-failed",
  password_policy: "password-policy",
  same_password: "password-same",
  confirm_mismatch: "password-confirm",
  wrong_current: "password-wrong-current",
  rate_limited: "password-rate-limited",
  // gate r1 MINOR-1: การ์ดเฉพาะ — รหัสเปลี่ยนแล้วจริง เหลือแค่ชั้น audit ล้ม (ใช้
  // ข้อความเดียวกับ route ที่มาจาก PASSWORD_CHANGE_MESSAGES.audit_failed)
  audit_failed: "password-audit-failed",
  system: "password-failed",
};

/** อ่านฟิลด์ข้อความจาก FormData แบบปลอดภัย (null → ค่าว่าง ให้ validation ตัดสิน) */
function textField(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  // session gate — ไม่มี session ที่พิสูจน์ได้ = กลับ /login (next ให้กลับมาหลังล็อกอิน)
  const user = await getUser();
  const loginTarget = `/login?next=${encodeURIComponent(SECURITY_PATH)}`;
  if (user === null) {
    redirect(loginTarget);
  }

  const supabase = await createSupabaseSsrClient();
  const requestHeaders = await headers();
  const ip = clientIpFrom(
    new Request("http://internal/server-action", { headers: requestHeaders }),
  );

  // (0) rate limit กลุ่ม AUTH (ip + userId — D12-11) — นับก่อนพิสูจน์รหัสผ่านเสมอ (D72)
  const limit = checkRateLimit("AUTH", { ip, secondary: user.userId });
  if (!limit.allowed) {
    redirect(`${SECURITY_PATH}?status=password-rate-limited`);
  }

  const currentPassword = textField(formData, "currentPassword");
  const newPassword = textField(formData, "newPassword");
  const confirmPassword = textField(formData, "confirmPassword");

  // (b) รูปแบบ + นโยบาย + ต่างจากปัจจุบัน + ยืนยันตรง — ตรวจก่อนแตะ GoTrue เสมอ
  const invalid = validatePasswordChange({ currentPassword, newPassword, confirmPassword });
  if (invalid !== null) {
    redirect(`${SECURITY_PATH}?status=${PASSWORD_STATUS_BY_FAILURE[invalid]}`);
  }

  // claim session_id ของ session ปัจจุบัน (audit) — fail-closed เมื่อไม่มี session จริง
  const sessionId = await readJwtSessionClaim(supabase);
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email ?? null;
  if (email === null || email.length === 0) {
    // session พังกลางทาง (ปิดบัญชี/token ถูกเพิกถอนระหว่างขา) — ถือว่าไม่มี session
    redirect(loginTarget);
  }

  const result = await changePassword(
    {
      userId: user.userId,
      email,
      currentPassword,
      newPassword,
      sessionId,
    },
    buildPasswordChangeDeps(supabase),
  );

  redirect(
    result.ok
      ? `${SECURITY_PATH}?status=password-changed`
      : `${SECURITY_PATH}?status=${PASSWORD_STATUS_BY_FAILURE[result.failure]}`,
  );
}

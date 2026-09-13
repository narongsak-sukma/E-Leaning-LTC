"use server";

/**
 * actions — Server Actions ของ login/register (Wave C-0)
 *
 * - ใช้ Supabase Auth ผ่าน cookie-bound client (ssr.ts) — session เข้า cookie httpOnly
 *   (SDS §5.1); browser ไม่ถือ key ใด ๆ (API-SPEC §1.2)
 * - สำเร็จ → redirect ไป `?next=` (ผ่าน resolveSafeNextPath — กัน open redirect);
 *   ไม่สำเร็จ → กลับมาที่หน้าเดิมพร้อม error code จากทะเบียน (API-SPEC §2) เท่านั้น
 * - ห้าม log PII — ไม่ log email/รหัสผ่าน ใด ๆ ทั้งสิ้น (SDS §6.2)
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ErrorCode } from "@/lib/errors";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveSafeNextPath, DEFAULT_POST_LOGIN_PATH } from "@/lib/auth/session";
import {
  MFA_PENDING_COOKIE,
  MFA_PENDING_COOKIE_MAX_AGE,
  createStandaloneAuthClient,
  firstVerifiedTotpFactor,
  stashPendingMfaTokens,
} from "@/lib/auth/mfa";
import { buildSignupConsents, SIGNUP_CONSENT_POLICY_VERSION } from "./signup-consents";

/** ข้อความแจ้ง (ไม่ใช่ error code) สำหรับสถานะที่เอกสารกำหนดให้แจ้งผู้ใช้ */
type LoginNotice = "registered" | "email_not_confirmed";
type RegisterNotice = "weak_password";

interface ActionOutcome {
  readonly error?: ErrorCode;
  readonly notice?: LoginNotice | RegisterNotice;
}

/** อีเมล: trim + lowercase แล้วตรวจรูปแบบ (ข้อความไทยตาม DESIGN-SYSTEM §5.2) */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง" }));

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "กรุณากรอกรหัสผ่าน"),
});

/**
 * นโยบายรหัสผ่าน (ความยาว/ breached list) บังคับโดย Supabase Auth (RBAC §4.2 แถวสุดท้าย)
 * ฝั่งแอปจึงตรวจแค่ "กรอกมาหรือไม่" — ค่าตัวเลขนโยบายไม่ hardcoded ในโค้ด
 */
const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "กรุณากรอกรหัสผ่าน"),
  acknowledgeNotice: z.literal("on", { message: "กรุณายืนยันการรับทราบประกาศความเป็นส่วนตัว" }),
});

/**
 * แปลง error ของ signInWithPassword เป็น code/ข้อความจากทะเบียนเท่านั้น
 *
 * ข้อจำกัด timing (API-SPEC §3.1 แนว anti-enumeration): Supabase Auth ตรวจ
 * บัญชีถูกแบน **ก่อนตรวจรหัสผ่าน** (GoTrue ที่ compose pin ไว้) — เราจึงตอบ
 * user_banned เหมือนรหัสผ่านผิดทุกประการ จะเหลือคือเวลาตอบที่ต่างกันเท่านั้น
 * (ลดไม่ได้จากฝั่งแอป — หมายเหตุไว้ตามเกณฑ์ SDS §5)
 */
function classifyLoginError(error: { code?: string | null | undefined }): ActionOutcome {
  switch (error.code) {
    case "invalid_credentials":
      return { error: "ERR-AUTH-002" };
    // บัญชีถูกแบน: GoTrue ตรวจก่อนรหัสผ่าน → ตอบเหมือนรหัสผ่านผิด (กัน enumeration)
    case "user_banned":
      return { error: "ERR-AUTH-002" };
    // สถานะนี้เปิดเฉพาะเมื่อรหัสผ่านถูกแล้ว (GoTrue ตรวจรหัสผ่านก่อน confirmation)
    // — ผู้ไม่รู้รหัสผ่านกระตุ้นสถานะนี้ไม่ได้ จึงแจ้งตรง ๆ ได้ (AUTH-001)
    case "email_not_confirmed":
      return { notice: "email_not_confirmed" };
    case "over_request_rate_limit":
      return { error: "ERR-RATE-001" };
    default:
      return { error: "ERR-SYS-001" };
  }
}

/**
 * signUp: อีเมลซ้ำ = ตอบเหมือนสำเร็จ (กัน enumeration — แนวเดียวกับ API-SPEC §3.1
 * password-reset "ตอบเหมือนกันทุกกรณี")
 */
function classifyRegisterError(error: { code?: string | null | undefined }): ActionOutcome | null {
  switch (error.code) {
    case "user_already_exists":
      return null;
    case "weak_password":
      return { error: "ERR-VAL-001", notice: "weak_password" };
    case "over_email_send_rate_limit":
      return { error: "ERR-RATE-001" };
    default:
      return { error: "ERR-SYS-001" };
  }
}

/** สร้าง URL ของ /login (แนบ next/error/notice เฉพาะเมื่อต่างจากค่า default) */
function loginUrl(next: string, outcome: ActionOutcome): string {
  const params = new URLSearchParams();
  if (next !== DEFAULT_POST_LOGIN_PATH) {
    params.set("next", next);
  }
  if (outcome.error) {
    params.set("error", outcome.error);
  }
  if (outcome.notice) {
    params.set("notice", outcome.notice);
  }
  const qs = params.toString();
  return qs.length > 0 ? `/login?${qs}` : "/login";
}

/** สร้าง URL ของ /register (แนบ next/error/notice) */
function registerUrl(next: string, outcome: ActionOutcome): string {
  const params = new URLSearchParams();
  if (next !== DEFAULT_POST_LOGIN_PATH) {
    params.set("next", next);
  }
  if (outcome.error) {
    params.set("error", outcome.error);
  }
  if (outcome.notice) {
    params.set("notice", outcome.notice);
  }
  const qs = params.toString();
  return qs.length > 0 ? `/register?${qs}` : "/register";
}

/**
 * เข้าสู่ระบบ (signInWithPassword) — สำเร็จ redirect ไป next (ปลอดภัยแล้วจาก
 * resolveSafeNextPath) · ไม่สำเร็จ redirect กลับ /login พร้อม error code จากทะเบียน
 *
 * Wave G P1 — ปิดช่อง rate limit: server action นี้เดิมไม่มีการจำกัดเลย (AUTH group
 * ของ rate-limit.ts ผูก path /api/v1/auth/* อยู่ route เดียว) — เพิ่มการนับเข้ากลุ่ม
 * AUTH เดิม (10 ครั้ง/นาที ต่อ IP + คีย์รองอีเมล normalized · D12-11 นับแยกทั้งคู่
 * "ใครถึงขีดก่อนถูกจำกัดก่อน") ก่อนยิง GoTrue เสมอ · IP อ่านจาก headers() ของ
 * server action (Next 15) แบบเดียวกับ clientIpFrom ของ rate-limit.ts (x-forwarded-for
 * ตัวแรกก่อน แล้ว x-real-ip) · เกิน = ตอบ ERR-RATE-001 ตามรูปแบบ error ของ action
 * (redirect กลับ /login?error=… — หน้า login render ข้อความไทยจากทะเบียน error)
 *
 * Wave F · D-f-1 login สองขั้น: ถ้าบัญชีมี factor TOTP ที่ verified (บทบาทบังคับ MFA
 * และผู้ใช้ที่เปิดเอง) จะ **ไม่มี session cookie ถูกเขียน** ณ ขั้น password — token
 * ถูกเก็บใน cookie ชั่วคราว `ltc_mfa_pending` (httpOnly · sameSite=lax · path=/login ·
 * อายุ 5 นาที · secure เมื่อ production) แล้วพาไป /login/verify เพื่อยืนยันรหัส 6 หลัก
 * (หรือโค้ดสำรอง) ก่อนจึงออก session จริง aal2
 */
function ipFromHeaders(headerList: Headers): string {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  const realIp = headerList.get("x-real-ip");
  if (realIp !== null && realIp.trim().length > 0) {
    return realIp.trim();
  }
  return "unknown";
}

export async function loginAction(formData: FormData): Promise<void> {
  const next = resolveSafeNextPath(formData.get("next"));
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    redirect(loginUrl(next, { error: "ERR-VAL-001" }));
  }
  // Wave G P1 — ปิดช่อง: loginAction เดิมไม่มี rate limit เลย — นับเข้ากลุ่ม AUTH
  // (10 ครั้ง/นาที ต่อ IP + คีย์รองอีเมล normalized — D12-11 นับแยกทั้งคู่) ก่อนยิง
  // GoTrue เสมอ · เกิน = redirect กลับ /login พร้อม ERR-RATE-001 (หน้าเว็บ render
  // ข้อความไทยจากทะเบียน error — รูปแบบ return เดิมของ action ทั้งหมด)
  const limit = checkRateLimit(
    "AUTH",
    { ip: ipFromHeaders(await headers()), secondary: parsed.data.email },
  );
  if (!limit.allowed) {
    redirect(loginUrl(next, { error: "ERR-RATE-001" }));
  }
  // Wave F · D-f-1: ขั้น password ผ่าน client เดี่ยว (ไม่ผูก cookie) — บัญชีที่มี
  // factor TOTP verified ยัง "ไม่เข้าระบบจริง" ณ จุดนี้ (ไม่มี session cookie เขียน)
  const auth = createStandaloneAuthClient();
  const { data, error } = await auth.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error !== null) {
    redirect(loginUrl(next, classifyLoginError(error)));
  }
  const session = data.session;
  if (session === null) {
    redirect(loginUrl(next, { error: "ERR-SYS-001" }));
  }
  // ตรวจ factor — fail-closed: ค้นล้มเหลว = กลับ /login (ERR-SYS-001) ไม่ปล่อยผ่าน
  const { data: factorsData, error: factorsError } = await auth.auth.mfa.listFactors();
  if (factorsError !== null) {
    redirect(loginUrl(next, { error: "ERR-SYS-001" }));
  }
  const pendingFactor = factorsData === null ? null : firstVerifiedTotpFactor(factorsData.all);
  if (pendingFactor !== null) {
    // gate r1 F2/F5: token จริงหยุดอยู่ฝั่ง server — เข้ารหัส AES-256-GCM เก็บใน
    // mfa_pending_stash ผ่าน RPC (single-use · อายุ 300 วิบังคับที่ DB) · cookie
    // เก็บ uuid อย่างเดียว — Set-Cookie รั่วก็ไม่ได้ session ใด ๆ
    // gate r2 G1: AAD ผูก ciphertext กับ (userId, deadlineSec) — สำเนาที่ถูก
    // re-host ไปแถวของคนอื่นถอดไม่ได้ (RPC 0046 ตรวจกรอบ p_expires_at เอง)
    const stashId = await stashPendingMfaTokens(
      auth,
      {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      },
      session.user.id,
    );
    if (stashId === null) {
      redirect(loginUrl(next, { error: "ERR-SYS-001" }));
    }
    const store = await cookies();
    store.set(MFA_PENDING_COOKIE, stashId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/login",
      maxAge: MFA_PENDING_COOKIE_MAX_AGE,
      secure: process.env.NODE_ENV === "production",
    });
    redirect(
      next === DEFAULT_POST_LOGIN_PATH
        ? "/login/verify"
        : `/login/verify?next=${encodeURIComponent(next)}`,
    );
  }
  // ไม่มี factor TOTP ที่ verified — เส้นทางเดิม: เขียน session ลง cookie ผ่าน
  // SSR client (setSession ตรวจ token กับ Auth server ก่อนบันทึกลง cookie)
  const supabase = await createSupabaseSsrClient();
  const { error: setSessionError } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (setSessionError !== null) {
    redirect(loginUrl(next, { error: "ERR-SYS-001" }));
  }
  redirect(next);
}

/**
 * สมัครสมาชิก (signUp) สำหรับประชาชนทั่วไป (citizen) — RBAC-DESIGN §1.1
 *
 * AUTH-001: บัญชีต้องยืนยันอีเมลก่อนเปิดใช้งาน (config: enable_confirmations=true) —
 * สำเร็จเสมอทางเดียว: กลับ /login พร้อม notice registered ("ตรวจสอบอีเมล")
 * **ทั้งอีเมลใหม่และอีเมลซ้ำตอบเหมือนกันเป๊ะ** (กัน enumeration — API-SPEC §3.1 แนวเดียวกับ
 * password-reset) แม้ Supabase คืน session ก็ไม่เข้าระบบทันที
 */
export async function registerAction(formData: FormData): Promise<void> {
  const next = resolveSafeNextPath(formData.get("next"));
  const parsed = registerSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    acknowledgeNotice: formData.get("acknowledgeNotice"),
  });
  if (!parsed.success) {
    redirect(registerUrl(next, { error: "ERR-VAL-001" }));
  }
  const supabase = await createSupabaseSsrClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: {
        // PDPA opt-in เสริม (D-f-3) — เฉพาะช่องที่ติ๊ก; ไม่ติ๊ก = [] = ไม่เกิดแถว consents
        // (trigger 0043 แปลงเป็นแถว consents เมื่อยืนยันอีเมลสำเร็จ)
        consents_granted: buildSignupConsents(formData, SIGNUP_CONSENT_POLICY_VERSION),
      },
    },
  });
  if (error) {
    const outcome = classifyRegisterError(error);
    if (outcome !== null) {
      redirect(registerUrl(next, outcome));
    }
    // อีเมลซ้ำ = ตอบเหมือนสำเร็จ (กัน enumeration) → ขั้น "ตรวจอีเมล" เดียวกันด้านล่าง
  }
  redirect(loginUrl(DEFAULT_POST_LOGIN_PATH, { notice: "registered" }));
}

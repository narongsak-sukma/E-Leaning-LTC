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
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ErrorCode } from "@/lib/errors";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resolveSafeNextPath, DEFAULT_POST_LOGIN_PATH } from "@/lib/auth/session";

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

/** แปลง error ของ signInWithPassword เป็น code/ข้อความจากทะเบียนเท่านั้น */
function classifyLoginError(error: { code?: string | null | undefined }): ActionOutcome {
  switch (error.code) {
    case "invalid_credentials":
      return { error: "ERR-AUTH-002" };
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
 */
export async function loginAction(formData: FormData): Promise<void> {
  const next = resolveSafeNextPath(formData.get("next"));
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    redirect(loginUrl(next, { error: "ERR-VAL-001" }));
  }
  const supabase = await createSupabaseSsrClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    redirect(loginUrl(next, classifyLoginError(error)));
  }
  redirect(next);
}

/**
 * สมัครสมาชิก (signUp) สำหรับประชาชนทั่วไป (citizen) — RBAC-DESIGN §1.1
 * สำเร็จ → ถ้า Supabase คืน session (auto-confirm) เข้าระบบทันที; ถ้าไม่ (ต้องยืนยันอีเมล)
 * → กลับ /login พร้อม notice registered
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
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    const outcome = classifyRegisterError(error);
    if (outcome !== null) {
      redirect(registerUrl(next, outcome));
    }
    // อีเมลซ้ำ = ตอบเหมือนสำเร็จ (กัน enumeration) → ไปยังขั้น "ตรวจอีเมล" ตามด้านล่าง
  }
  if (data?.session) {
    // auto-confirm: ได้ session เลย
    redirect(next);
  }
  redirect(loginUrl(DEFAULT_POST_LOGIN_PATH, { notice: "registered" }));
}

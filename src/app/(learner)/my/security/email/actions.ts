"use server";

/**
 * actions — Server Action ของ /my/security/email (Wave F · D-f-2)
 *
 * - ทางเข้าเดียวของคำขอเปลี่ยนอีเมล — ลำดับภายใน (rate → zod → re-auth รหัสผ่าน →
 *   guard MFA → updateUser → audit RPC) อยู่ใน src/lib/auth/email-change.ts
 *   (ทางเข้าเดียวกับ REST wrapper ที่จะตามมา) — action ทำแค่ "ประกอบ dependency จริง":
 *   - session/บทบาท: getUser + my_roles (session.ts canonical)
 *   - อีเมลปัจจุบัน: auth.getUser ด้วย cookie-bound client (ssr.ts)
 *   - ip ของผู้เรียก: clientIpFrom บน headers ของ request (x-forwarded-for ก่อน)
 *   - re-auth: GoTrue signInWithPassword ผ่าน client ทิ้งได้ (persistSession:false,
 *     autoRefreshToken:false) — session ที่ได้ใช้เป็นหลักฐานเท่านั้น ทิ้งทันที
 *     (ไม่เขียน cookie — ไม่มีทางแชร์ session ใหม่จากขานี้)
 *   - updateUser + audit RPC: client เดียวกัน (cookie-bound user JWT) ตามสัญญา 0044
 * - ผลลัพธ์ไปทาง query string ของหน้าเดิม (notice=sent | error=<code ทะเบียน>) —
 *   หน้า allowlist เอง (แนวเดียวกับ /login) · ห้าม log รหัสผ่าน/JWT/อีเมล (SDS §6.2)
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

import { buildEmailChangeCallbackUrl, requestEmailChange } from "@/lib/auth/email-change";
import { getMyRoles, getUser } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { clientIpFrom } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** path ของหน้าฟอร์ม — ปลายทาง redirect หลัง action จบทุกกรณี */
const FORM_PATH = "/my/security/email";

/** อ่านฟิลด์ข้อความจาก FormData แบบปลอดภัย (null → ค่าว่าง ให้ zod ตัดสิน) */
function textField(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

export async function requestEmailChangeAction(formData: FormData): Promise<void> {
  // session gate — ไม่มี session ที่พิสูจน์ได้ = กลับ /login (ไม่แนบ error — /login
  // ไม่มี ERR-AUTH-001 ใน allowlist แต่ next ให้กลับมาหลังล็อกอิน)
  const user = await getUser();
  const loginTarget = `/login?next=${encodeURIComponent(FORM_PATH)}`;
  if (user === null) {
    redirect(loginTarget);
  }

  const supabase = await createSupabaseSsrClient();
  const { data } = await supabase.auth.getUser();
  const currentEmail = data.user?.email ?? null;
  if (currentEmail === null || currentEmail.length === 0) {
    // session พังกลางทาง (ปิดบัญชี/token ถูกเพิกถอนระหว่างขา) — ถือว่าไม่มี session
    redirect(loginTarget);
  }

  const roles = await getMyRoles();
  const requestHeaders = await headers();
  const ip = clientIpFrom(
    new Request("http://internal/server-action", { headers: requestHeaders }),
  );

  const config = getConfig();
  const result = await requestEmailChange(
    {
      newEmail: textField(formData, "email"),
      password: textField(formData, "password"),
      currentEmail,
      roles,
      aal: user.aal,
      rateLimitIp: ip,
      callbackUrl: buildEmailChangeCallbackUrl(config.publicBaseUrl),
    },
    {
      verifyPassword: async (email, password) => {
        // client ทิ้งได้ — persistSession:false + ไม่เขียน cookie ใด ๆ ·
        // session ที่ได้เมื่อสำเร็จใช้เป็น "หลักฐานว่ารหัสผ่านถูก" เท่านั้น (D-f-2)
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
      updateUserEmail: async (email, emailRedirectTo) => {
        const { error } = await supabase.auth.updateUser({ email }, { emailRedirectTo });
        return error === null
          ? { ok: true }
          : { ok: false, code: error.code ?? null, message: error.message ?? null };
      },
      auditRequest: async (newEmailSha256) => {
        const { error } = await supabase.rpc("my_audit_email_change_request", {
          p_new_email_sha256: newEmailSha256,
        });
        return error === null ? { ok: true } : { ok: false, message: error.message ?? null };
      },
    },
  );

  if (result.ok) {
    redirect(`${FORM_PATH}?notice=sent`);
  }
  redirect(`${FORM_PATH}?error=${encodeURIComponent(result.errorCode)}`);
}

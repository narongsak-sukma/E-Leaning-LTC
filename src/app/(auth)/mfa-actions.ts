"use server";

/**
 * mfa-actions — Server Action ของขั้นที่ 2 ของ login สองขั้น (Wave F · D-f-1)
 *
 * รับ code จากฟอร์ม /login/verify — รองรับ 2 เส้นทาง:
 * - TOTP 6 หลัก: challenge+verify บน pending session → GoTrue คืน session ใหม่ (aal2)
 *   พร้อม "หมุน refresh token" — ต้อง setSession ลง SSR client เพื่อบันทึก cookie จริง
 * - โค้ดสำรอง xxxx-xxxx: RPC `mfa_backup_codes_consume` (DB ตรวจ single-use + audit)
 *   แล้ว "ปั้น" session aal2 ด้วย recovery factor ชั่วคราว (mintAal2ForBackupLogin —
 *   ข้อจำกัดของ GoTrue v2.164.0 ดูหัวไฟล์ src/lib/auth/mfa.ts) จึงออก session จริง
 *
 * ไม่มี pending cookie หรือ token ตาย → state=expired · รหัสผิด → state=invalid ·
 * ความผิดพลาดอื่น → state=error (ข้อความไทย fixed copy — ไม่ leak ข้อความ upstream)
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppError } from "@/lib/errors";
import { DEFAULT_POST_LOGIN_PATH, resolveSafeNextPath } from "@/lib/auth/session";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  MFA_PENDING_COOKIE,
  type PendingMfaTokens,
  challengeAndVerifyTotp,
  createPendingMfaClient,
  decodePendingMfaValue,
  firstVerifiedTotpFactor,
  mintAal2ForBackupLogin,
  normalizeBackupCodeInput,
} from "@/lib/auth/mfa";

/** URL ของหน้ายืนยัน (แนบ next/state เฉพาะเมื่อต่างจากค่า default) */
function verifyUrl(next: string, state: "invalid" | "expired" | "error"): string {
  const params = new URLSearchParams();
  if (next !== DEFAULT_POST_LOGIN_PATH) {
    params.set("next", next);
  }
  params.set("state", state);
  return `/login/verify?${params.toString()}`;
}

/** กลับ /login พร้อม error ระบบ (ใช้เมื่อ MFA ผ่านแล้วแต่ตั้ง session จริงไม่สำเร็จ) */
function loginErrorUrl(next: string): string {
  const params = new URLSearchParams();
  if (next !== DEFAULT_POST_LOGIN_PATH) {
    params.set("next", next);
  }
  params.set("error", "ERR-SYS-001");
  return `/login?${params.toString()}`;
}

/**
 * ขั้นที่ 2 ของ login สองขั้น — ยืนยันรหัส TOTP 6 หลักหรือโค้ดสำรอง แล้วออก session จริง
 */
export async function verifyMfaStepTwoAction(formData: FormData): Promise<void> {
  const next = resolveSafeNextPath(formData.get("next"));
  const store = await cookies();
  const raw = store.get(MFA_PENDING_COOKIE)?.value ?? "";
  const rawCode = formData.get("code");
  const code = typeof rawCode === "string" ? rawCode.trim() : "";

  let state: "invalid" | "expired" | "error" = "error";
  let minted: PendingMfaTokens | null = null;

  const tokens = decodePendingMfaValue(raw);
  if (tokens === null) {
    state = "expired";
  } else {
    try {
      const pending = await createPendingMfaClient(tokens);
      if (/^\d{6}$/.test(code)) {
        // เส้นทาง TOTP — factor canonical คือ "ตัวแรกที่ verified" (เดียวกับตอน login)
        const { data: factorsData, error: factorsError } = await pending.auth.mfa.listFactors();
        const factor =
          factorsError === null && factorsData !== null
            ? firstVerifiedTotpFactor(factorsData.all)
            : null;
        if (factor === null) {
          state = "expired"; // factor ถูกถอนระหว่างรอ — pending ใช้ต่อไม่ได้
        } else {
          const verified = await challengeAndVerifyTotp(pending, factor.id, () => code);
          if (verified === null) {
            state = "invalid";
          } else {
            minted = verified;
          }
        }
      } else {
        // เส้นทางโค้ดสำรอง — DB ตรวจ single-use ก่อน (hash ฝั่ง RPC เจอค่าเดียวกับ
        // backupCodeHash: sha256 ของ trim+lowercase) แล้วจึงปั้น session aal2
        const backup = normalizeBackupCodeInput(code);
        const consume =
          backup === null ? null : await pending.rpc("mfa_backup_codes_consume", { p_code: backup });
        const valid =
          consume?.error === null && (consume.data as { valid?: boolean } | null)?.valid === true;
        if (!valid) {
          state = "invalid";
        } else {
          // โค้ดถูกเผาแล้วจากจุดนี้ (single-use ใน DB) — ถ้าขั้นถัดไปล้ม ผู้ใช้ลอง
          // TOTP ปกติหรือ regenerate ชุดใหม่ (คอมเมนต์หัวไฟล์ mfa.ts)
          minted = await mintAal2ForBackupLogin(pending);
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "ERR-AUTH-005") {
        state = "expired";
      } else {
        state = "error"; // ไม่ leak รายละเอียด upstream ออกหน้าจอ
      }
    }
  }

  if (minted === null) {
    redirect(verifyUrl(next, state));
  }
  // ออก session จริง — setSession ตรวจ token กับ GoTrue ก่อนบันทึกลง cookie ผ่าน ssr.ts
  const ssr = await createSupabaseSsrClient();
  const { error: setSessionError } = await ssr.auth.setSession({
    access_token: minted.accessToken,
    refresh_token: minted.refreshToken,
  });
  if (setSessionError !== null) {
    redirect(loginErrorUrl(next));
  }
  // ล้าง cookie ชั่วคราว (ต้อง set ที่ path เดียวกับตอนตั้ง — path=/login)
  store.set(MFA_PENDING_COOKIE, "", { path: "/login", maxAge: 0 });
  redirect(next);
}

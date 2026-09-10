/**
 * auth-errors — ความหมายของ error ที่ @supabase/auth-js โยนกลับมาจาก GoTrue
 *
 * ใช้ร่วมกันระหว่าง logout route (gate r9–r10) และ middleware (gate r11 M1) —
 * คำตอบเดียวกันสำหรับคำถามเดียวกัน: **error นี้พิสูจน์ว่า refresh token/session
 * สิ้นสภาพจริงหรือไม่** เพราะทั้งคู่ต้องตัดสินว่าจะลบ credential ออกจากเครื่อง
 * ผู้ใช้ (ลบ cookie) หรือคงไว้ให้ลองใหม่
 *
 * หลักการ (สะสมจาก gate r9–r11): ตัดสินจาก**รหัส error** ไม่ใช่ status —
 * 401 จากชั้น key-auth ของ gateway (Kong ตอบ `{"message":"Invalid authentication
 * credentials"}` ไม่มี code — probe กับ cluster จริง) ไม่ได้แตะ session ฝั่ง
 * server เลย แต่เข้ามาในรูป AuthApiError 401 เหมือนกัน ถ้ายึด status จะล้าง
 * cookie + ตอบเหมือนสำเร็จ ทิ้ง session ที่ยังมีชีวิต
 */

import type { CookieOptions } from "@supabase/ssr";

/** รูปร่างของ AuthApiError ที่เราอ่าน (คลาสจริงไม่ export type ให้ import โดยตรง) */
export interface AuthApiErrorLike extends Error {
  readonly status?: number;
  readonly code?: string;
}

/**
 * error ของ SDK ที่ "ยืนยันว่า refresh token/session สิ้นสภาพจริง" เท่านั้น:
 * - AuthSessionMissingError — ไม่มี session ในเครื่อง หรือ GoTrue ตอบ
 *   `session_not_found` (SDK แปลงเป็นชื่อนี้ให้ใน handleError ของ fetch.js)
 * - AuthApiError ที่ code เป็นค่าใดค่าหนึ่งต่อไปนี้ (ครบทุก code ตายจริงของ
 *   GoTrue v2.164.0 — รุ่นเดียวกับ docker-compose; source: internal/api/
 *   token_refresh.go + errorcodes.go):
 *   - `refresh_token_not_found` (token ถูก revoke/หมดอายุ/ใช้ซ้ำจนถูกลบ — live
 *     probe: 400 `{"code":400,"error_code":"refresh_token_not_found"}`)
 *   - `refresh_token_already_used` (ใช้ refresh token เก่าซ้ำหลังหมุนไปแล้ว —
 *     live probe กับ cluster จริง: reuse ตัว grandparent → 400
 *     `{"code":400,"error_code":"refresh_token_already_used","msg":"Invalid
 *     Refresh Token: Already Used"}`)
 *   - `session_expired` (หมดอายุตามเวลา / inactivity / ถูกเพิกถอนโดย login ใหม่)
 *   - `invalid_grant` (รูป OAuth เดิม)
 *
 * ที่เหลือทุกอย่าง — รวม 400/401/403 ที่ไม่มี code ที่รู้จัก เช่น `user_banned`
 * (บัญชีถูกระงับ ≠ session สิ้นสภาพ — logout ยังลอง revoke ใหม่ได้ภายหลัง) และ
 * transient (429/5xx/network) — ถือว่า**ไม่รู้ความหมาย**: รักษา credential ล่าสุด
 * ไว้ ไม่เผยแพร่การลบที่ SDK queue ไว้
 */
export function isDefinitiveAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AuthSessionMissingError") {
    return true;
  }
  if (error.name !== "AuthApiError") {
    return false;
  }
  const code = (error as AuthApiErrorLike).code;
  return (
    code === "refresh_token_not_found" ||
    code === "refresh_token_already_used" ||
    code === "session_expired" ||
    code === "invalid_grant"
  );
}

/**
 * นโยบายเผยแพร่ cookie ที่ SDK buffer ไว้ (gate r12 — ใช้ร่วม middleware + SSR client
 * ของ handler ผ่าน commitAuthWrites) — ตอบคำถามเดียว: **รายการไหนเผยแพร่ถึง
 * browser/render ได้**
 *
 * การลบ cookie auth มีสองความหมายที่ต้องแยกกัน:
 * 1. **การล้าง session** (refresh โดนปฏิเสธ → SDK _removeSession) — เผยแพร่เฉพาะเมื่อ
 *    `deathConfirmed` (error ยืนยันตายจริงตาม isDefinitiveAuthError) ไม่งั้น
 *    401 ไร้ code ของชั้น gateway/429/user_banned จะล้าง credential ที่ยังมีชีวิต
 * 2. **เก็บกวาด chunk เก่าระหว่าง rotation** (dist/main/cookies.js setItem: base เดี่ยว
 *    ↔ หลาย chunk .N — ชื่อเก่าที่ไม่อยู่ในชุดใหม่ถูกลบด้วย maxAge:0 **ใน setAll
 *    เดียวกับการเขียนชุดใหม่**) — ต้องเผยแพร่เสมอที่มี rotation ไม่งั้น base เก่า
 *    ค้างทั้ง browser และ render แล้ว combineChunks (อ่าน base ก่อน) ยังใช้ token เก่า
 *
 * กติกา: การเขียน (ค่าไม่ว่าง) เผยแพร่เสมอ · การลบในตระกูล auth cookie เผยแพร่เมื่อ
 * deathConfirmed **หรือ** มี rotation (มีการเขียน auth cookie สักชื่อในชุดเดียวกัน)
 * · การลบนอกตระกูล auth ไม่ใช่ของเราจะหยุด — เผยแพร่ตามปกติ
 */

/** ชื่อ base cookie ตามสูตรของ @supabase/ssr: sb-<hostname ส่วนแรก>-auth-token */
export function authCookieBaseName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

/** รายการ cookie ที่ถูก buffer ไว้ (รูปเดียวกับที่ middleware/ssr เก็บ) */
export interface BufferedAuthCookie {
  readonly name: string;
  readonly value: string;
  readonly options?: CookieOptions;
}

/** @supabase/ssr ลบ cookie ด้วยค่าว่าง + maxAge: 0 (dist/main/cookies.js) */
export function isBufferedDeletion(entry: BufferedAuthCookie): boolean {
  return entry.value === "" || entry.options?.maxAge === 0;
}

/**
 * กรองรายการที่ buffer ไว้เหลือเฉพาะที่เผยแพร่ได้ตามนโยบายข้างบน —
 * middleware และ commitAuthWrites ของ SSR client ใช้ฟังก์ชันเดียวกัน
 */
export function selectPublishableAuthCookies<T extends BufferedAuthCookie>(
  buffered: readonly T[],
  deathConfirmed: boolean,
  isAuthCookieName: (name: string) => boolean,
): T[] {
  const rotationPresent = buffered.some(
    (entry) => isAuthCookieName(entry.name) && !isBufferedDeletion(entry),
  );
  return buffered.filter((entry) => {
    if (!isBufferedDeletion(entry)) {
      return true;
    }
    if (!isAuthCookieName(entry.name)) {
      return true;
    }
    return deathConfirmed || rotationPresent;
  });
}

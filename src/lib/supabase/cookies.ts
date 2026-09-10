/**
 * cookies — นโยบาย cookie flags กลางของ auth session (SDS §5.1)
 *
 * @supabase/ssr ตั้ง default `httpOnly: false` (dist/utils/constants.js) —
 * JWT ใน cookie จะถูกอ่านได้จาก JavaScript ถ้าส่ง options ของ library ต่อตรง ๆ
 * (ความเสี่ยง XSS → token theft — ASVS V3.5) ฝั่งเราจึงบังคับ flags เองทุกจุดที่เขียน cookie:
 * ssr.ts (Server Action / Route Handler) และ middleware.ts (session refresh)
 *
 * - httpOnly: true เสมอ (browser คุยกับ Next BFF เท่านั้น — ไม่มี use case อ่าน cookie ฝั่ง JS)
 * - sameSite: "lax" (คู่กับ CSRF origin check ของ middleware — SDS §5.4)
 * - secure: เฉพาะ production (dev รันบน http://localhost — Secure cookie จะไม่ถูกส่งกลับ)
 * - path: "/" บังคับ — ไม่ยอมให้ options ของ library ตั้ง path อื่น (scope cookie
 *   ทั้ง origin ของ BFF ที่เดียว — ค่าอื่นคือค่าแปลกปลอมจาก library)
 */
import type { CookieOptions } from "@supabase/ssr";

/** รูป options ที่เขียน cookie จริงทุกจุดของแอป (หลัง harden) */
export interface HardenedCookieOptions extends CookieOptions {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly path: string;
  readonly secure: boolean;
}

/** บังคับ flags ความปลอดภัยทับ options ที่ library ส่งมา (SSR §5.1 — ไม่เชื่อ default ของ library) */
export function hardenedCookieOptions(options: CookieOptions | undefined): HardenedCookieOptions {
  return {
    ...options,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  };
}

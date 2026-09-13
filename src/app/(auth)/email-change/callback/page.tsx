/**
 * /email-change/callback — server shell ของหน้าผลลัพธ์ยืนยันการเปลี่ยนอีเมล
 *
 * gate r2 G2: nonce ของ CSP (middleware) ออกต่อ request — หน้าที่ Next
 * prerender เป็น static ไม่มี nonce ให้ inline bootstrap ของ React → script
 * โดน `script-src 'nonce-…' 'strict-dynamic'` บล็อก → ไม่มี hydration →
 * history.replaceState เคลียร์ token ออกจาก URL fragment (gate r1 F9) ไม่ได้
 * รัน · บังคับ dynamic rendering เพื่อให้ nonce ถูกฝังทุกครั้ง (เอกสาร
 * Next.js: nonce ใช้ได้เฉพาะ dynamic rendering) · ตัวตัดสิน fragment เป็น
 * client อยู่ที่ EmailChangeCallbackClient (GoTrue ตอบสถานะทาง fragment
 * เท่านั้น — server มองไม่เห็น)
 */
import { EmailChangeCallbackClient } from "@/components/auth/email-change-callback-client";

export const dynamic = "force-dynamic";

export default function EmailChangeCallbackPage() {
  return <EmailChangeCallbackClient />;
}

/**
 * schemas — /api/v1/me/password (AUTH-005 · Wave G P1 · D72)
 *
 * แยกไฟล์เพราะ Next.js route.ts export ได้เฉพาะ HTTP handlers — route.ts import จาก
 * "./schema" เท่านั้น (ไฟล์นี้ไม่ใช่ route — export schema ได้) — แบบเดียวกับ me/mfa/schema.ts
 */
import { z } from "zod";

import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_MESSAGE } from "@/lib/auth/password-change";

/**
 * body ของ POST /api/v1/me/password — strict (คีย์แปลกปลอม = 400 ERR-VAL-001)
 * - currentPassword: กรอกมาอย่างน้อย 1 อักขระ (ความถูกต้องตัดสินที่ GoTrue — ไม่ซ้ำซ้อน)
 * - newPassword: ≥12 ตาม GOTRUE_PASSWORD_MIN_LENGTH — ข้อความ policy เดียวกับหน้า register
 *   · "ซ้ำกับปัจจุบัน" ตรวจใน lib (validatePasswordChange) หลัง shape ผ่าน — ตอบ 400 ไทย
 */
export const PasswordChangeBody = z
  .object({
    currentPassword: z.string().min(1, "กรุณากรอกรหัสผ่านปัจจุบัน"),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_POLICY_MESSAGE),
  })
  .strict();

/** view ขาออกของเปลี่ยนรหัสผ่านสำเร็จ — changed=true + ข้อความไทย */
export const PasswordChangeView = z
  .object({
    changed: z.literal(true),
    message: z.string().min(1),
  })
  .strict();

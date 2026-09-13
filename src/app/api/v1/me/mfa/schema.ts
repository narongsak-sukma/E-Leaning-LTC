/**
 * schemas — /api/v1/me/mfa/* (Wave F · D-f-1)
 *
 * แยกไฟล์เพราะ Next.js route.ts export ได้เฉพาะ HTTP handlers — route.ts import จาก
 * "./schema" เท่านั้น (ไฟล์นี้ไม่ใช่ route — export schema ได้)
 */
import { z } from "zod";

/** รูปโค้ดสำรอง `xxxx-xxxx` — ชุดอักษรเดียวกับ mfa.ts (ไม่มี 0/1/i/l/o) */
const BACKUP_CODE_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/;

/** body ของ POST /me/mfa/enroll — ทั้งหมด optional · strict (body หายได้ = ค่า default) */
export const MfaEnrollBody = z
  .object({
    friendlyName: z.string().min(1).max(80).optional(),
  })
  .strict();

/** view ขาออกของ enroll — secret คืน "ครั้งเดียว" ตอน enroll เท่านั้น (GoTrue ไม่คืนซ้ำ) */
export const MfaEnrollView = z
  .object({
    factorId: z.string().min(1),
    secret: z.string().min(1),
    otpauthUri: z.string().startsWith("otpauth://"),
    qrCode: z.string().min(1).nullable().optional(),
  })
  .strict();

/** body ของ POST /me/mfa/verify — code = รหัส TOTP 6 หลัก (REST verify รับ TOTP เท่านั้น) */
export const MfaVerifyBody = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, "รหัสต้องเป็นตัวเลข 6 หลัก"),
    factorId: z.string().min(1).optional(),
  })
  .strict();

/** view ของ verify สำเร็จ */
export const MfaVerifyView = z.object({ verified: z.literal(true) }).strict();

/** view ของ disable สำเร็จ */
export const DisableView = z.object({ disabled: z.literal(true) }).strict();

/** view ของ GET /me/mfa/backups — metadata ล้วน (ห้ามมีโค้ด/hash ปรากฏ) */
export const BackupStatusView = z
  .object({
    generated: z.boolean(),
    unused: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    lastGeneratedAt: z.string().nullable(),
  })
  .strict();

/** view ของ POST /me/mfa/backups/regenerate — โค้ดล้วน (แสดงครั้งเดียว — ตอบ no-store) */
export const BackupCodesView = z
  .object({
    codes: z.array(z.string().regex(BACKUP_CODE_PATTERN)).min(8).max(12),
  })
  .strict();

/**
 * schemas — GET/PATCH /api/v1/me/notification-settings (Wave E Phase 4 · NTF-005 ·
 * API-SPECIFICATION §3.9)
 *
 * แยกไฟล์เพราะ Next.js route.ts export ได้เฉพาะ HTTP handlers — route.ts import จาก
 * "./schema" เท่านั้น (ไฟล์นี้ไม่ใช่ route — export schema/const ได้ ให้ test ใช้ตรวจสอบ)
 */
import { z } from "zod";

/** family enum — D-p4-5 (jsonb key = family ไม่ใช่ topic เต็ม) */
export const NOTIFICATION_FAMILIES = ["exam.result", "certificate", "credit", "renewal"] as const;

export type NotificationFamily = (typeof NOTIFICATION_FAMILIES)[number];

/** family enum เป็น zod (กุญแจของ partialRecord ขาเข้าและ record ขาออก) */
export const NotificationFamilyEnum = z.enum(NOTIFICATION_FAMILIES);

/** ค่าตั้งค่าครบช่องทางของหนึ่ง family (ขาออกจาก RPC — บังคับครบทั้งสองคีย์) */
export const FamilySettings = z.object({ in_app: z.boolean(), email: z.boolean() }).strict();

export type FamilySettingsParsed = z.infer<typeof FamilySettings>;

/** ช่องทางต่อ family ของ PATCH — ส่งบางส่วนได้แต่ต้องมีอย่างน้อย 1 คีย์ (boolean เท่านั้น) */
export const FamilySettingsPatch = z
  .object({
    in_app: z.boolean().optional(),
    email: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "ต้องระบุ in_app หรือ email อย่างน้อยหนึ่งช่องทาง",
  });

export type FamilySettingsPatchParsed = z.infer<typeof FamilySettingsPatch>;

/** body ของ PATCH — { settings: { family: {...} } } — ส่งบางส่วนได้ (partialRecord — zod 4:
 * record บน enum key บังคับครบทุก key) · อย่างน้อย 1 family · strict */
export const NotificationSettingsPatchBody = z
  .object({
    settings: z.partialRecord(NotificationFamilyEnum, FamilySettingsPatch),
  })
  .strict()
  .refine((v) => Object.keys(v.settings).length > 0, {
    message: "ต้องระบุ settings อย่างน้อยหนึ่ง family",
  });

export type NotificationSettingsPatchBodyParsed = z.infer<typeof NotificationSettingsPatchBody>;

/** view ขาออก — settings ครบทุก family ครบทั้งสองช่องทาง (RPC คืน default ครบเสมอ) */
export const NotificationSettingsView = z
  .object({
    settings: z.record(NotificationFamilyEnum, FamilySettings),
  })
  .strict();

export type NotificationSettingsViewParsed = z.infer<typeof NotificationSettingsView>;

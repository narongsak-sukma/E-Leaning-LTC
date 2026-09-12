/**
 * schemas — POST /api/v1/profile/delete + GET /profile/delete/confirm
 * (Wave E Phase 5 · D-p5-8 · #90) — แยกไฟล์แบบเดียวกับ consents/export schema.ts
 */
import { z } from "zod";

/** view ขาออกของ POST /profile/delete — 202 {requestId, expiresAt} เท่านั้น (ห้าม token) */
export const DeleteRequestView = z
  .object({
    requestId: z.uuid(),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type DeleteRequestViewParsed = z.infer<typeof DeleteRequestView>;

/** หน้าผลสำเร็จของ confirm — สาธารณะ (ผู้คลิกจากอีเมล) · ไทย-first */
export const ConfirmSuccessView = z
  .object({
    status: z.literal("confirmed"),
    message: z.string().min(1),
  })
  .strict();

/** หน้าผลลิงก์เสีย — generic เดียวทุกกรณี (ไม่เฉลยสถานะคำขอ — spec §3.2 แถว confirm) */
export const ConfirmInvalidView = z
  .object({
    status: z.literal("link_invalid"),
    message: z.string().min(1),
  })
  .strict();

/** token ขาเข้าจาก query — base64url 43 อักขระจากระบบ (ยืดหยุ่นช่วงยาว 20..200) */
export const ConfirmTokenQuery = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(20)
  .max(200);

export type ConfirmTokenQueryParsed = z.infer<typeof ConfirmTokenQuery>;

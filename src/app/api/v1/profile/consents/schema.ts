/**
 * schemas — GET/PATCH /api/v1/profile/consents (Wave E Phase 4 · PDPA D12-17 ·
 * API-SPECIFICATION §3.2 L142-143)
 *
 * แยกไฟล์เพราะ Next.js route.ts export ได้เฉพาะ HTTP handlers — route.ts import จาก
 * "./schema" เท่านั้น (ไฟล์นี้ไม่ใช่ route — export schema/const ได้ ให้ test ใช้ตรวจสอบ)
 */
import { z } from "zod";

/** type ที่เปิดให้ผู้ใช้จัดการเอง — เฉพาะ optional (pdpa_essential ไม่ใช่ consent เลือกได้) */
export const CONSENT_TYPES = ["marketing", "email_notify"] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

/** สถานะที่มาจาก action ล่าสุดของ type นั้น (append-only — 0003 §consents) */
export const CONSENT_STATUSES = ["granted", "revoked"] as const;

/** consent หนึ่งรายการใน section consents (§3.2 — {type,status,updated_at}) */
export const ConsentEntry = z
  .object({
    type: z.enum(CONSENT_TYPES),
    status: z.enum(CONSENT_STATUSES),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ConsentEntryParsed = z.infer<typeof ConsentEntry>;

/** view ขาออกของ GET — 2 sections ตามรูป §3.2 (notice_acknowledgments = [] — อ่านอย่างเดียว) */
export const ConsentsView = z
  .object({
    notice_acknowledgments: z.array(z.never()),
    consents: z.array(ConsentEntry),
  })
  .strict();

export type ConsentsViewParsed = z.infer<typeof ConsentsView>;

/** body ของ PATCH — strict { type, action } เท่านั้น */
export const ConsentsPatchBody = z
  .object({
    type: z.enum(CONSENT_TYPES),
    action: z.enum(["grant", "revoke"]),
  })
  .strict();

export type ConsentsPatchBodyParsed = z.infer<typeof ConsentsPatchBody>;

/** resource ขาออกของ PATCH — { type, status } */
export const ConsentStatusView = z
  .object({
    type: z.enum(CONSENT_TYPES),
    status: z.enum(CONSENT_STATUSES),
  })
  .strict();

export type ConsentStatusViewParsed = z.infer<typeof ConsentStatusView>;

/**
 * schemas — GET /api/v1/profile/export (Wave E Phase 5 · D-p5-7 · #90)
 * แยกไฟล์เพราะ route.ts export ได้เฉพาะ HTTP handlers (แบบแผน consents/schema.ts)
 */
import { z } from "zod";

/** สถานะเริ่มต้นของ job ที่ RPC my_request_data_export สร้าง */
export const EXPORT_JOB_STATUSES = ["pending"] as const;

/** view ขาออกของ 202 — ตรงสัญญา RPC {jobId, status} (§3.2 แถว /profile/export) */
export const ExportJobView = z
  .object({
    jobId: z.uuid(),
    status: z.enum(EXPORT_JOB_STATUSES),
  })
  .strict();

export type ExportJobViewParsed = z.infer<typeof ExportJobView>;

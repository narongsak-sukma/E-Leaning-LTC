/**
 * schemas/license — zod schemas กลางของโดเมน license (Wave E Phase 5 · D-p5-2/3/4)
 *
 * ใช้ร่วมกันทั้ง BFF endpoints (PUT/GET /me/license · GET/PATCH /admin/license-applications)
 * และ service libs (src/lib/license/{submit,decide}.ts) — รูปแบบตรง migration 0035:
 * - license_no `^\d{6,9}$` (ตรงเงื่อนไข RPC my_submit_license_application — ERR-VAL-001|license_no_format)
 * - ไฟล์หลักฐาน jpg/png/pdf ≤10MB (ตรงสัญญา API-SPEC §3.2 แถว PUT /me/license)
 * - action approve|reject + reason ≤500 (ตรงเงื่อนไข RPC admin_decide_license_application —
 *   reject บังคับ trim ≥10 ที่ชั้น BFF ก่อนเรียก RPC)
 * - view ขาออก (camelCase · strict ทุกชุด — drift → 503 ตามแบบแผน r6-L1)
 */
import { z } from "zod";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
export const IsoTimestamp = z.iso.datetime({ offset: true });

/** เลขที่ใบอนุญาต — ตัวเลข 6-9 หลัก (0035 §4 เงื่อนไขเดียวกัน) */
export const LICENSE_NO_REGEX = /^\d{6,9}$/;

export const LicenseNoSchema = z.string().trim().regex(LICENSE_NO_REGEX);

/** สถานะคำขอ (enum license_application_status 0001) */
export const LicenseApplicationStatus = z.enum(["pending", "approved", "rejected"]);

/** mime ที่ยอมรับของไฟล์หลักฐาน — jpg/png/pdf (API-SPEC §3.2) */
export const ALLOWED_EVIDENCE_MIME = ["image/jpeg", "image/png", "application/pdf"] as const;

/** ขนาดไฟล์หลักฐานสูงสุด — 10MB (API-SPEC §3.2) */
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * ไฟล์หลักฐาน — ตรวจชนิด mime กับขนาด (BFF ตรวจสองอย่างก่อนอัปโหลดบักเก็ตตาม D-p5-2)
 * ไฟล์ว่าง (size 0) ปฏิเสธด้วย — ไม่มีหลักฐานจริง
 */
export const EvidenceFileSchema = z
  .instanceof(File)
  .refine((file) => file.size > 0, { message: "file_empty" })
  .refine(
    (file) => (ALLOWED_EVIDENCE_MIME as readonly string[]).includes(file.type),
    { message: "file_type" },
  )
  .refine((file) => file.size <= EVIDENCE_MAX_BYTES, { message: "file_too_large" });

/**
 * body ของ PATCH /admin/license-applications/{id} — strict (key แปลกปลอม → 400)
 * reason ยาวสุขภาพ ≤500 ตาม RPC · บังคับ ≥10 (trim) เฉพาะ reject — ตรวจที่ handler ก่อน RPC
 */
export const LicenseDecisionBody = z
  .object({
    action: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type LicenseDecisionBodyParsed = z.infer<typeof LicenseDecisionBody>;

/** ผล 202 ของ PUT /me/license — คำขอที่เพิ่งยื่น (แถว jsonb ที่ RPC คืน) */
export const SubmittedLicenseApplication = z
  .object({
    applicationId: z.string().uuid(),
    status: LicenseApplicationStatus,
    submittedAt: IsoTimestamp,
  })
  .strict();

export type SubmittedLicenseApplicationParsed = z.infer<typeof SubmittedLicenseApplication>;

/** ผล 200 ของ RPC admin_decide_license_application (jsonb — reject ไม่มี key ใบ/role → null) */
export const LicenseDecisionResult = z
  .object({
    applicationId: z.string().uuid(),
    result: z.enum(["approved", "rejected"]),
    resultingLicenseId: z.string().uuid().nullable(),
    roleGranted: z.boolean().nullable(),
  })
  .strict();

export type LicenseDecisionResultParsed = z.infer<typeof LicenseDecisionResult>;

/** view สถานะของ GET /me/license (D-p5-4 · API-SPEC §3.2 แถว GET /me/license) */
export const MyLicenseStatusView = z
  .object({
    latestApplication: z
      .object({
        status: LicenseApplicationStatus,
        rejectedReason: z.string().min(1).nullable(),
        decidedAt: IsoTimestamp.nullable(),
        submittedAt: IsoTimestamp,
      })
      .strict()
      .nullable(),
    currentLicense: z
      .object({
        licenseNo: LicenseNoSchema,
        verifiedAt: IsoTimestamp.nullable(),
      })
      .strict()
      .nullable(),
    canResubmit: z.boolean(),
  })
  .strict();

export type MyLicenseStatusViewParsed = z.infer<typeof MyLicenseStatusView>;

/**
 * แถวของ GET /admin/license-applications — สัญญาตรงหน้า admin ของ lane F
 * (.omc/handoffs/lane-f-shared-edits.md §C ข้อ 2) · evidenceUrl = signed URL อายุสั้น
 * ของไฟล์หลักฐานในบักเก็ต private (null เมื่อไม่มีไฟล์/ลงนามไม่สำเร็จ)
 */
export const AdminLicenseApplicationRow = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().min(1).nullable(),
    email: z.string().min(1).nullable(),
    licenseNo: LicenseNoSchema,
    status: LicenseApplicationStatus,
    submittedAt: IsoTimestamp,
    decidedAt: IsoTimestamp.nullable(),
    reason: z.string().min(1).nullable(),
    evidenceUrl: z.string().min(1).nullable(),
  })
  .strict();

export type AdminLicenseApplicationRowParsed = z.infer<typeof AdminLicenseApplicationRow>;

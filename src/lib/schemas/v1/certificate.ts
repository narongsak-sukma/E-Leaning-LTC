/**
 * schemas/v1/certificate — contract ของประกาศนียบัตร (Wave D-2 · API-SPECIFICATION 1.0.3 §3.6)
 *
 * - CertificatePublicView — §4 #13 ตรงตัวอักษร: 4 ฟิลด์ snake_case เท่านั้น (ไม่มีชื่อเจ้าของ —
 *   holder_name_snapshot เป็น PII อยู่บน PDF ที่เจ้าของ/registrar ดาวน์โหลดเท่านั้น) ·
 *   ตอบ 200 เสมอ (D8/D11-14): ไม่พบ = 200 + status="not_found" (course_title/issued_at null
 *   **เฉพาะ**กรณี not_found — กัน enumeration)
 * - MyCertificateResource — รายการของตัวเอง (GET /me/certificates) — snake_case ตาม lane D-2
 *   (id, cert_no, course_title, issued_at, status) — ไม่มี holder_name (ของตัวเองก็ไม่จำเป็น)
 * - คอลัมน์อ้างค่าจริง: certificates (0006_cert_credit.sql L4-25) ·
 *   certificate_public_view (0009_views.sql L6-12) · certificate_verifications
 *   (0008_audit.sql L43-51) · enum certificate_status/verification_result (0001_extensions.sql L122/L124)
 */
import { z } from "zod";
import { AppError } from "../../errors";

/** สถานะประกาศนียบัตร — enum certificate_status (0001_extensions.sql L122) */
export const CERTIFICATE_STATUSES = ["valid", "revoked", "superseded"] as const;

export const CertificateStatus = z.enum(CERTIFICATE_STATUSES);

export type CertificateStatusValue = (typeof CERTIFICATE_STATUSES)[number];

/**
 * ผลตรวจ — enum verification_result (0001_extensions.sql L124) =
 * certificate_status + not_found (ค่าที่ตาราง certificate_verifications.result บันทึกได้)
 */
export const VERIFICATION_RESULTS = [...CERTIFICATE_STATUSES, "not_found"] as const;

export const VerificationResult = z.enum(VERIFICATION_RESULTS);

export type VerificationResultValue = (typeof VERIFICATION_RESULTS)[number];

/** เวลา ISO 8601 ของ resource (API-SPECIFICATION §1.1 — ยอมทั้ง Z และ +00:00) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/**
 * §4 #13 — ผลตรวจสาธารณะ 4 ฟิลด์ snake_case เท่านั้น (ไม่มี holder_name/revoked_at)
 * refine: course_title/issued_at เป็น null ได้เฉพาะ status="not_found"
 */
export const CertificatePublicView = z
  .object({
    code: z.string(),
    course_title: z.string().nullable(),
    issued_at: IsoTimestamp.nullable(),
    status: VerificationResult,
  })
  .refine(
    (v) => v.status === "not_found" || (v.course_title !== null && v.issued_at !== null),
    { message: 'course_title/issued_at เป็น null ได้เฉพาะ status="not_found"' },
  );

export type CertificatePublicViewParsed = z.infer<typeof CertificatePublicView>;

/**
 * resource ของ GET /me/certificates — snake_case ตาม lane D-2 · id/cert_no/course_title/
 * issued_at/status เท่านั้น — ห้าม holder_name (PII)
 */
export const MyCertificateResource = z
  .object({
    id: z.string().uuid(),
    cert_no: z.string().min(1),
    course_title: z.string().min(1),
    issued_at: IsoTimestamp,
    status: CertificateStatus,
  })
  .strict();

export type MyCertificateResourceParsed = z.infer<typeof MyCertificateResource>;

/** แถวจากตาราง certificates (snake_case ตามคอลัมน์จริง — 0006 L4-25) เฉพาะคอลัมน์ที่ resource ใช้ */
export interface MyCertificateRow {
  readonly id: string;
  readonly cert_no: string;
  readonly course_title_snapshot: string;
  readonly issued_at: string;
  readonly status: string;
}

/**
 * แถว DB ดิบตรวจก่อน map (0019-r2 F5 — mirror ฝั่ง admin-exam): แถว drift
 * (คอลัมน์เปลี่ยน/ค่าผิดชนิดจาก PostgREST) ต้องตายที่ขาเข้า ไม่ใช่ไหลผ่าน
 * `as` ลง mapper แล้วเลยไปเชื่อ status เป็นจริง
 */
export const MyCertificateRowSchema = z
  .object({
    id: z.string().uuid(),
    cert_no: z.string().min(1),
    course_title_snapshot: z.string().min(1),
    issued_at: IsoTimestamp,
    status: CertificateStatus,
  })
  .strict();

/** แถว certificates ดิบ → MyCertificateRow ที่ผ่านการตรวจแล้ว — drift → ERR-SYS-002 (opaque) */
export function parseMyCertificateRow(row: unknown): MyCertificateRow {
  const parsed = MyCertificateRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "my_certificate_row_drift" } });
  }
  return parsed.data;
}

/**
 * map แถว DB → resource (/me/certificates) — course_title มาจาก course_title_snapshot
 * (view certificate_public_view ใช้คอลัมน์เดียวกัน — 0009 L9) · status เป็น cast ได้เพราะ
 * DB enum กำหนดชุดค่าไว้แล้ว (0001 L122)
 */
export function toMyCertificateResource(row: MyCertificateRow): MyCertificateResourceParsed {
  return {
    id: row.id,
    cert_no: row.cert_no,
    course_title: row.course_title_snapshot,
    issued_at: row.issued_at,
    status: row.status as CertificateStatusValue,
  };
}

/** path param ของ GET /certificates/{id}/pdf — id = uuid (ต่างจาก public verify ที่ใช้ code) */
export const CertificateIdParams = z.object({ code: z.uuid() }).strict();

// ─── r6-L1: ขาออกของ admin certificate routes — strict ทุกชั้น (mirror lib/certificates
//     interfaces: IssuedCertificate/RevokedCertificate/ReissuedCertificate/EligibleAttempt) ·
//     route ครอบทุกทางออกด้วย parseOutgoingView(schema, …) → drift = 503 ไม่ strip เงียบ ───

/** ใบที่ออกแล้ว (POST /admin/certificates + .reissue → newCertificate) — holder PII เห็นได้
 *  เฉพาะ registrar/sa ที่ผ่าน requirePermission แล้วเท่านั้น */
export const IssuedCertificateResource = z
  .object({
    id: z.string().uuid(),
    certNo: z.string().min(1),
    verifyCode: z.string().min(1),
    enrollmentId: z.string().uuid(),
    userId: z.string().uuid(),
    courseId: z.string().uuid(),
    holderNameSnapshot: z.string().min(1),
    courseTitleSnapshot: z.string().min(1),
    creditSnapshot: z.number().int().min(0).nullable(),
    status: z.literal("valid"),
    issuedAt: IsoTimestamp,
    pdfMediaId: z.string().uuid().nullable(),
  })
  .strict();

export type IssuedCertificateResourceParsed = z.infer<typeof IssuedCertificateResource>;

/** ใบที่เพิกถอนแล้ว (POST /admin/certificates/{id}/revoke) */
export const RevokedCertificateResource = z
  .object({
    id: z.string().uuid(),
    certNo: z.string().min(1),
    status: z.literal("revoked"),
    revokedAt: IsoTimestamp,
    revokedReason: z.string().min(1),
  })
  .strict();

export type RevokedCertificateResourceParsed = z.infer<typeof RevokedCertificateResource>;

/** ผล reissue (POST /admin/certificates/{id}/reissue) — ใบใหม่ + lineage ใบเดิม */
export const ReissuedCertificateResource = z
  .object({
    newCertificate: IssuedCertificateResource,
    oldCertificateId: z.string().uuid(),
    oldStatus: z.literal("superseded"),
    oldSupersededBy: z.string().uuid(),
  })
  .strict();

export type ReissuedCertificateResourceParsed = z.infer<typeof ReissuedCertificateResource>;

/** แถวคิวงานออกใบ (GET /admin/certificates/eligible) — holder_name คำนวณฝั่ง SQL
 *  r7-M1: holderName เป็น z.string() (ไม่ .min(1)) — คิวคือข้อมูลให้ registrar เห็น
 *  ว่า profile ผู้เรียนคนไหนยังไม่มีชื่อ (display_name='' ได้ตาม DDL 0003); การออกใบ
 *  จริงถูกปฏิเสธที่ cert_issue_core (ERR-VAL-001|holder_name_missing) ก่อน mutation
 *  แล้ว — ห้าม .min(1) ตรงนี้เพราะจะทำทั้งหน้า 503 เพราะคนเดียวที่ยังไม่กรอกชื่อ */
export const EligibleAttemptResource = z
  .object({
    attemptId: z.string().uuid(),
    enrollmentId: z.string().uuid(),
    userId: z.string().uuid(),
    courseId: z.string().uuid(),
    holderName: z.string(),
    scorePct: z.number().int().min(0).max(100).nullable(),
    submittedAt: IsoTimestamp,
  })
  .strict();

export type EligibleAttemptResourceParsed = z.infer<typeof EligibleAttemptResource>;

// ─── r7-M2: ขาเข้าของ RPC certificates — mirror ผลตอบกลับจริงของ 0019 exact-key ───
//     (.strict() จับทั้งคีย์หาย คีย์เกิน และค่าผิดชนิด — drift = ERR-SYS-002 ที่ขาเข้า
//     ไม่ใช่ 200 หน้าว่าง/ค่า fabricated) · zod v4: required + .nullable() แยก
//     "ไม่มีคีย์" (fail) จาก null จริง (pass) — ตรงข้อ M2 เรื่อง missing vs null

/** cert_no = LTC-<ปี ค.ศ.>-<6 หลัก> (cert_issue_core สร้างเสมอ) — literal ซ้ำของ
 *  shared.ts เพราะไฟล์นั้น import "server-only" (lib schema ต้อง import ได้ทุกที่) */
const CERT_NO_PATTERN = /^LTC-\d{4}-\d{6}$/;

/** แถวของ cert_issue_core (9 คีย์ exact — jsonb_build_object ท้ายฟังก์ชัน) */
export const CertCoreRowSchema = z
  .object({
    id: z.string().uuid(),
    cert_no: z.string().regex(CERT_NO_PATTERN),
    verify_code: z.string().min(1),
    enrollment_id: z.string().uuid(),
    user_id: z.string().uuid(),
    course_id: z.string().uuid(),
    holder_name: z.string().min(1),
    course_title: z.string().min(1),
    issued_at: IsoTimestamp,
  })
  .strict();

/** แถวของ admin_reissue_certificate = core 9 คีย์ + superseded_cert_id (10 exact) */
export const ReissueRowSchema = z
  .object({
    ...CertCoreRowSchema.shape,
    superseded_cert_id: z.string().uuid(),
  })
  .strict();

/** แถวของ admin_revoke_certificate (3 คีย์ exact) */
export const RevokedRowSchema = z
  .object({
    id: z.string().uuid(),
    cert_no: z.string().regex(CERT_NO_PATTERN),
    revoked_at: IsoTimestamp,
  })
  .strict();

/** แถวของ admin_eligible_certificates (returns table 7 คอลัมน์ exact) —
 *  holder_name ไม่ nullable (fallback display_name NOT NULL ตาม DDL) แต่เป็น ''
 *  ได้ (คิว informational) · score_pct nullable จริง (smallint ของ attempt) */
export const EligibleAttemptRowSchema = z
  .object({
    attempt_id: z.string().uuid(),
    enrollment_id: z.string().uuid(),
    user_id: z.string().uuid(),
    course_id: z.string().uuid(),
    holder_name: z.string(),
    score_pct: z.number().int().min(0).max(100).nullable(),
    submitted_at: IsoTimestamp,
  })
  .strict();

/** แถวของ admin_attach_certificate_pdf (0019-r2 F2 — jsonb 2 คีย์ exact):
 *  pdf_media_id = uuid ของ media row ที่ INSERT ใน TX เดียวกัน (มีเสมอ) ·
 *  attached = true ครั้งแรก / false เมื่อ idempotent ซ้ำ (R12d)
 *  r9-O3: issue/reissue ต้องตรวจครบสองคีย์หลัง exact-one unwrap — คีย์เกิน/ขาด =
 *  drift ถือว่า attach ล้ม (คงใบ D36-O6) ไม่ใช่ดึง media id จากแถวเพี้ยน */
export const PdfAttachRowSchema = z
  .object({
    pdf_media_id: z.string().uuid(),
    attached: z.boolean(),
  })
  .strict();

export type CertCoreRowParsed = z.infer<typeof CertCoreRowSchema>;
export type ReissueRowParsed = z.infer<typeof ReissueRowSchema>;
export type RevokedRowParsed = z.infer<typeof RevokedRowSchema>;
export type EligibleAttemptRowParsed = z.infer<typeof EligibleAttemptRowSchema>;
export type PdfAttachRowParsed = z.infer<typeof PdfAttachRowSchema>;

export type CertificateIdParamsParsed = z.infer<typeof CertificateIdParams>;

/**
 * path param {code} ของ /certificates/{code}/pdf → uuid — ผิดรูปแบบ → ERR-VAL-001 ระบุ
 * field "code" (รูปแบบเดียวกับ parseCourseIdParam — schemas/v1/catalog)
 */
export function parseCertificateIdParam(code: string): string {
  const parsed = CertificateIdParams.safeParse({ code });
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["code"] } });
  }
  return parsed.data.code;
}

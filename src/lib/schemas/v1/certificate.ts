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
export const MyCertificateResource = z.object({
  id: z.string().uuid(),
  cert_no: z.string().min(1),
  course_title: z.string().min(1),
  issued_at: IsoTimestamp,
  status: CertificateStatus,
});

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

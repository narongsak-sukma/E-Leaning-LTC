/**
 * certificates — data layer UI ประกาศนียบัตร (Wave D-6 · API-SPECIFICATION 1.0.3 §3.6)
 *
 * - ตรวจสอบสาธารณะ GET /api/v1/certificates/{code} — BFF ตอบ 200 เสมอ (D8/D11-14) ด้วย
 *   4 ฟิลด์ snake_case {code, course_title, issued_at, status} — ไม่มี holder_name/PII
 *   เด็ดขาด (schema CertificatePublicView ตรวจซ้ำฝั่ง UI เพื่อ fail-closed ถ้า contract เพี้ยน)
 *   · {code} ยอมรับทั้ง cert_no (LTC-<ปี>-<6 หลัก> พิมพ์มือ — D10) และ verify_code (QR)
 * - รายการของตัวเอง GET /api/v1/me/certificates — envelope §1.2 { data, page } · snake_case
 *   ตาม lane D-2 (id, cert_no, course_title, issued_at, status) — ไม่มี holder_name
 * - ดาวน์โหลด PDF GET /api/v1/certificates/{id}/pdf — {id} = **uuid ของใบ** (ต่างจาก verify
 *   ที่ใช้ code) — UI ดาวน์โหลดด้วย <a> browser ปกติ ไม่ fetch อ่านเป็น text
 * - transport จำลองแบบ learning.ts (absolute-origin + cookie forward + x-ltc-bff-internal
 *   เมื่อเรียกจาก server) — แยกไฟล์เองเพราะ learning.ts เป็นกรรมสิทธิ์ lane C-7/D-0 (D4);
 *   รวมศูนย์ transport กลางเป็นธง Phase 1 เช่นเดียวกับ RPC-error parser ของ C-11
 * - ข้อความผู้ใช้ทั้งหมดเป็นภาษาไทย (ผ่าน pure helpers ที่ทดสอบได้)
 */
import { z } from "zod";

import {
  CertificatePublicView,
  MyCertificateResource,
  type CertificatePublicViewParsed,
  type CertificateStatusValue,
  type MyCertificateResourceParsed,
  type VerificationResultValue,
} from "@/lib/schemas/v1/certificate";

import { ApiError, type FetchCallOptions } from "./learning";

// ——— ทะเบียนข้อความไทย (pure — ทดสอบได้โดยไม่ต้อง stub อะไร) ———

/** ป้ายสถานะสั้นของใบ (หน้า "ประกาศนียบัตรของฉัน") — enum certificate_status (0001 L122) */
const CERTIFICATE_STATUS_THAI: Record<CertificateStatusValue, string> = {
  valid: "ใช้งานได้",
  revoked: "ถูกเพิกถอน",
  superseded: "ถูกแทนที่ด้วยใบใหม่",
};

/** ป้ายสถานะสั้น (badge ของรายการใบของตัวเอง) */
export function certificateStatusThai(status: CertificateStatusValue): string {
  return CERTIFICATE_STATUS_THAI[status];
}

/** โทนสี badge ตาม DESIGN-SYSTEM §5.6 — Record ครบทุก enum ให้ tsc บังคับครบ */
const CERTIFICATE_STATUS_TONE: Record<
  CertificateStatusValue,
  "success" | "warning" | "danger"
> = {
  valid: "success",
  revoked: "danger",
  superseded: "warning",
};

export function certificateStatusTone(
  status: CertificateStatusValue,
): "success" | "warning" | "danger" {
  return CERTIFICATE_STATUS_TONE[status];
}

/** หัวข้อผลตรวจสาธารณะ — enum verification_result (status + not_found) */
const VERIFICATION_HEADING_THAI: Record<VerificationResultValue, string> = {
  valid: "ตรวจสอบแล้ว — ประกาศนียบัตรถูกต้อง",
  revoked: "ตรวจสอบแล้ว — ประกาศนียบัตรถูกเพิกถอน",
  superseded: "ตรวจสอบแล้ว — ประกาศนียบัตรถูกแทนที่",
  not_found: "ตรวจสอบแล้ว — ไม่พบข้อมูลประกาศนียบัตร",
};

export function verificationHeadingThai(status: VerificationResultValue): string {
  return VERIFICATION_HEADING_THAI[status];
}

/** คำอธิบายใต้หัวข้อผลตรวจ — ภาษาไทยสุภาพตาม DESIGN-SYSTEM §5.12 */
const VERIFICATION_DETAIL_THAI: Record<VerificationResultValue, string> = {
  valid: "ประกาศนียบัตรฉบับนี้ออกโดยสภาทนายความแห่งประเทศไทย และมีผลใช้งานอยู่",
  revoked: "ประกาศนียบัตรฉบับนี้ถูกเพิกถอนโดยสภาทนายความแห่งประเทศไทย และไม่มีผลใช้งาน",
  superseded:
    "ประกาศนียบัตรฉบับนี้ถูกแทนที่ด้วยฉบับใหม่แล้ว กรุณาใช้ประกาศนียบัตรฉบับล่าสุดเท่านั้น",
  not_found:
    "ไม่พบข้อมูลตามรหัสที่ตรวจสอบ กรุณาตรวจทานรหัสอีกครั้ง หรือติดต่อเจ้าหน้าที่สภาทนายความฯ (โทร 0 2351 1128)",
};

export function verificationDetailThai(status: VerificationResultValue): string {
  return VERIFICATION_DETAIL_THAI[status];
}

/** วันที่ออกใบแบบพุทธศักราช "12 สิงหาคม 2569" — DS §9 I18N-003 (แบบเดียวกับ catalog.ts) */
export function formatIssuedAtThai(iso: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    calendar: "buddhist",
  }).format(new Date(iso));
}

// ——— URL builders (BFF-relative path เท่านั้น — API-SPECIFICATION §3.6) ———

/** GET /api/v1/certificates/{code} — ตรวจสาธารณะ (code = cert_no หรือ verify_code) */
export function verifyCertificateApiUrl(code: string): string {
  return `/api/v1/certificates/${encodeURIComponent(code)}`;
}

/** GET /api/v1/me/certificates — list endpoint ตอบเป็นหน้า (limit สูงสุดตาม §1.2 = 100) */
export function myCertificatesApiUrl(): string {
  return "/api/v1/me/certificates?limit=100";
}

/** GET /api/v1/certificates/{id}/pdf — id = uuid ของใบ (owner เท่านั้น — ดู pdf/route.ts) */
export function certificatePdfApiUrl(certificateId: string): string {
  return `/api/v1/certificates/${encodeURIComponent(certificateId)}/pdf`;
}

/** หน้าตรวจสอบสาธารณะ /verify/<code> — ลิงก์จาก QR และจากรายการใบของตัวเอง */
export function publicVerifyPageUrl(code: string): string {
  return `/verify/${encodeURIComponent(code)}`;
}

// ——— transport — absolute-origin + error envelope (§1.3) แบบเดียวกับ learning.ts ———

const TRANSPORT_FALLBACK_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";
const CONTRACT_MESSAGE = "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ข้อมูลขาออกของ BFF ผิดรูปตามสัญญา — opaque เหมือน internal error (SDS §6.1) */
function contractViolation(): ApiError {
  return new ApiError("ERR-SYS-001", 500, CONTRACT_MESSAGE);
}

function resolveOrigin(options?: FetchCallOptions): string {
  if (options?.origin !== undefined && options.origin.length > 0) {
    return options.origin;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  throw new Error("ต้องระบุ origin ใน FetchCallOptions เมื่อเรียก API จากฝั่ง server (RSC)");
}

/** เรียก BFF แบบ GET — คืน body ดิบ · non-2xx/parse ไม่ได้/network → ApiError (envelope §1.3) */
async function requestJson(
  path: string,
  options?: FetchCallOptions,
): Promise<{ status: number; body: unknown }> {
  const origin = resolveOrigin(options);
  const headers: Record<string, string> = { accept: "application/json" };
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
  // ขาเรียกจาก server (RSC) ประกาศตัวเป็นขาใน — middleware จะไม่หมุน token ใน request นี้
  // (เหมือน learning.ts — Set-Cookie ของขาในไม่มีทางถึง browser)
  if (typeof window === "undefined") {
    headers["x-ltc-bff-internal"] = "1";
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      method: "GET",
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const envelope = isRecord(body) && isRecord(body["error"]) ? body["error"] : null;
    const code =
      envelope !== null && typeof envelope["code"] === "string" && envelope["code"].length > 0
        ? envelope["code"]
        : `HTTP_${response.status}`;
    const message =
      envelope !== null &&
      typeof envelope["message"] === "string" &&
      envelope["message"].length > 0
        ? envelope["message"]
        : TRANSPORT_FALLBACK_MESSAGE;
    throw new ApiError(code, response.status, message);
  }
  return { status: response.status, body };
}

// ——— data layer ประกาศนียบัตร ———

/**
 * GET /api/v1/certificates/{code} — ผลตรวจสาธารณะ 4 ฟิลด์ (200 เสมอ — valid/revoked/
 * superseded/not_found รูปเดียวกัน) · ผิดสัญญา (คีย์เกิน/ขาด/enum แปลก) → ERR-SYS-001
 * fail-closed — ห้ามแสดงข้อมูลที่ไม่ผ่าน schema (กัน PII รั่วเข้าหน้าจอ)
 *
 * เช็คคีย์ exact 4 ฟิลด์ก่อน safeParse เอง: CertificatePublicView (schema กลางของ D-2)
 * ไม่ใช่ .strict() — zod จะตัดคีย์แปลกปลอมเงียบ ๆ (เช่น holder_name ที่รั่วขึ้นมา) แทนที่
 * จะ fail — UI จึงกั้นเองตามแบบเดียวกับ route ของ BFF (r4-H2c exact-keys)
 */
const CERTIFICATE_VIEW_KEYS = "code,course_title,issued_at,status";

export async function verifyCertificate(
  code: string,
  options?: FetchCallOptions,
): Promise<CertificatePublicViewParsed> {
  const { body } = await requestJson(verifyCertificateApiUrl(code), options);
  if (!isRecord(body) || Object.keys(body).sort().join(",") !== CERTIFICATE_VIEW_KEYS) {
    throw contractViolation();
  }
  const parsed = CertificatePublicView.safeParse(body);
  if (!parsed.success) {
    throw contractViolation();
  }
  return parsed.data;
}

export interface MyCertificatesPageResult {
  readonly certificates: readonly MyCertificateResourceParsed[];
  readonly hasMore: boolean;
}

/**
 * GET /api/v1/me/certificates — รายการใบของตัวเอง (ต้อง login + certificate:view)
 * · แถวใดผิดสัญญา → ERR-SYS-001 ทั้งหน้า (fail-closed แบบเดียวกับ route ขาออก BFF)
 */
export async function getMyCertificates(
  options?: FetchCallOptions,
): Promise<MyCertificatesPageResult> {
  const { body } = await requestJson(myCertificatesApiUrl(), options);
  if (!isRecord(body) || !Array.isArray(body["data"])) {
    throw contractViolation();
  }
  const certificates = parseContract(z.array(MyCertificateResource), body["data"]);
  const page = isRecord(body["page"]) ? body["page"] : null;
  const hasMore = page !== null && typeof page["hasMore"] === "boolean" ? page["hasMore"] : false;
  return { certificates, hasMore };
}

/** validate ข้อมูลขาออกของ BFF ด้วย schema กลาง — ไม่ผ่าน = contract ผิดรูป → ERR-SYS-001 */
function parseContract<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw contractViolation();
  }
  return parsed.data;
}

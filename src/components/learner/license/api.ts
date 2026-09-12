/**
 * api — ชั้นเรียก BFF ของหน้าใบอนุญาตว่าความ (Wave E Phase 5 · IDENT-002/005 · lane E)
 *
 * รวมการเรียก /api/v1/me/license ของหน้า my/license (D-p5-4) — อยู่ในโฟลเดอร์กรรมสิทธิ์ของ
 * lane E โดย mirror transport กลาง src/lib/api/transport.ts (แบบแผน requestJson ของ
 * components/learner/notifications/api.ts)
 *
 * สัญญา (API-SPECIFICATION §3.2 · D-p5-4):
 * - GET /me/license → คำขอล่าสุด (status pending|approved|rejected + submittedAt/decidedAt/
 *   rejectedReason) + ใบ verified ปัจจุบัน (licenseNo/verifiedAt) + canResubmit (ไม่มี pending)
 *   — ข้อจำกัดระบุชื่อฟิลด์ camelCase ไว้เป๊ะ (submittedAt/licenseNo/canResubmit ฯลฯ) —
 *   อ่านแบบ tolerant-read: รับทั้ง camelCase/snake_case แล้ว normalize เป็น camelCase ก่อน
 *   ตรวจ strict (ฟิลด์บังคับที่หาย = fail-closed ERR-SYS-001)
 * - PUT /me/license — **multipart**: ฟิลด์ `license_no` (^\d{6,9}$) + ไฟล์หลักฐาน jpg/png/pdf
 *   ≤10MB (ตรวจฝั่ง client ก่อนส่ง — BFF ตรวจซ้ำ) · 202 = ยื่นสำเร็จรอเจ้าหน้าที่ตรวจ ·
 *   มีคำขอ pending อยู่ = 409
 *
 * - origin: options.origin ก่อน → window.location.origin (browser) — server ไม่ส่ง origin = throw
 * - headers: accept เสมอ · cookieHeader > 1 ตัวอักษร → header cookie · server → x-ltc-bff-internal
 * - ผล: 2xx → { status, body } · non-2xx / parse ล้ม / network → ApiError (envelope §1.3)
 */
import { z } from "zod";

import { ApiError, type TransportCallOptions } from "@/lib/api/transport";

export { ApiError };
export type { TransportCallOptions };

const TRANSPORT_FALLBACK_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveOriginLike(options?: TransportCallOptions): string {
  if (options?.origin !== undefined && options.origin.length > 0) {
    return options.origin;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  throw new Error("ต้องระบุ origin ใน TransportCallOptions เมื่อเรียก API จากฝั่ง server (RSC)");
}

/** ผลสำเร็จแบบดิบ — เหมือน TransportResult ของ transport กลาง */
interface LicenseTransportResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * เรียก BFF แบบ JSON (GET) — mirror fetchJson ของ transport กลาง
 * (PUT เป็น multipart จึงมี requestMultipart แยกต่างหาก — ห้าม JSON.stringify)
 */
async function requestJson(
  path: string,
  options?: TransportCallOptions,
): Promise<LicenseTransportResult> {
  const origin = resolveOriginLike(options);
  const headers: Record<string, string> = { accept: "application/json" };
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
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
    throw envelopeToApiError(body, response.status);
  }
  return { status: response.status, body };
}

/** error envelope §1.3 → ApiError (message ไทยจาก BFF เมื่อมี ไม่งั้น fallback ที่ให้มา) */
function envelopeToApiError(
  body: unknown,
  status: number,
  fallbackMessage?: string,
): ApiError {
  const envelope = isRecord(body) && isRecord(body["error"]) ? body["error"] : null;
  const code =
    envelope !== null && typeof envelope["code"] === "string" && envelope["code"].length > 0
      ? envelope["code"]
      : `HTTP_${status}`;
  const message =
    envelope !== null &&
    typeof envelope["message"] === "string" &&
    envelope["message"].length > 0
      ? envelope["message"]
      : (fallbackMessage ?? TRANSPORT_FALLBACK_MESSAGE);
  return new ApiError(code, status, message);
}

/**
 * PUT /me/license แบบ multipart — FormData { license_no, file } (ตามข้อกำหนด §3.2 —
 * JSON ทำลาย binary ไม่ได้) · **ห้ามตั้ง content-type เอง** (fetch ใส่ boundary ให้)
 */
async function requestMultipart(
  path: string,
  form: FormData,
  options?: TransportCallOptions,
): Promise<LicenseTransportResult> {
  const origin = resolveOriginLike(options);
  const headers: Record<string, string> = { accept: "application/json" };
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
  if (typeof window === "undefined") {
    headers["x-ltc-bff-internal"] = "1";
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      method: "PUT",
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: form,
    });
  } catch {
    throw new ApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw envelopeToApiError(body, response.status);
  }
  return { status: response.status, body: null };
}

// ——— สัญญาข้อมูลขาออกของ GET /me/license (normalize แล้วเป็น camelCase) ———

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เหมือน IsoTimestamp ของ credits.ts) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** คำขอผูกใบอนุญาตล่าสุดของผู้ใช้ — normalize เป็น camelCase แล้ว */
export interface LicenseApplicationView {
  readonly status: "pending" | "approved" | "rejected";
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  readonly rejectedReason: string | null;
}

/** ใบอนุญาตว่าความที่ verified ปัจจุบัน — เลขเดิมตาม RLS เจ้าของ */
export interface LicenseCurrentView {
  readonly licenseNo: string;
  readonly verifiedAt: string;
}

/** ผล GET /me/license หลัง normalize — ของตัวเองตาม IDENT-005 */
export interface MyLicenseView {
  readonly application: LicenseApplicationView | null;
  readonly license: LicenseCurrentView | null;
  readonly canResubmit: boolean;
}

/**
 * เลือกค่า string จาก alias แรกที่เจอ (camelCase ก่อน snake_case) — tolerant-read
 * สำหรับฟิลด์ที่สะกดยังไม่ถูก pin รูปเดียวในข้อจำกัด · key ทั้งหมดต้องมาจากสองรูปนี้เท่านั้น
 */
function pickString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/** normalize คำขอล่าสุดจาก record ดิบ → LicenseApplicationView · ฟิลด์บังคับหาย = null (drift) */
export function normalizeLicenseApplication(
  raw: Record<string, unknown>,
): LicenseApplicationView | null {
  const status = pickString(raw, ["status"]);
  const submittedAt = pickString(raw, ["submittedAt", "submitted_at"]);
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    return null;
  }
  if (submittedAt === null) {
    return null;
  }
  const decidedAt = pickString(raw, ["decidedAt", "decided_at"]);
  const rejectedReason = pickString(raw, ["rejectedReason", "rejected_reason"]);
  return {
    status,
    submittedAt,
    decidedAt,
    rejectedReason,
  };
}

/** normalize ใบปัจจุบันจาก record ดิบ → LicenseCurrentView · ฟิลด์บังคับหาย = null (drift) */
export function normalizeLicenseCurrent(
  raw: Record<string, unknown>,
): LicenseCurrentView | null {
  const licenseNo = pickString(raw, ["licenseNo", "license_no"]);
  const verifiedAt = pickString(raw, ["verifiedAt", "verified_at"]);
  if (licenseNo === null || verifiedAt === null) {
    return null;
  }
  return { licenseNo, verifiedAt };
}

/**
 * normalize ผล GET /me/license ทั้งก้อน — ยอมทั้งแบบมี wrapper application/license และ
 * แบบแผงราบ (ฟิลด์คลี่อยู่ top-level ตามแถวข้อจำกัดที่อ่านเป็นรูปเดียว) · canResubmit
 * ไม่มา = derive เอง (ไม่มี pending) ตามนิยามในข้อจำกัด
 */
export function normalizeMyLicenseView(raw: Record<string, unknown>): MyLicenseView | null {
  const wrapper = isRecord(raw["application"]) ? raw["application"] : null;
  const licenseWrapper = isRecord(raw["license"]) ? raw["license"] : null;
  const application =
    wrapper !== null
      ? normalizeLicenseApplication(wrapper)
      : raw["application"] === null
        ? null
        : normalizeLicenseApplication(raw);
  const license =
    licenseWrapper !== null
      ? normalizeLicenseCurrent(licenseWrapper)
      : raw["license"] === null
        ? null
        : normalizeLicenseCurrent(raw);
  const canResubmitBool =
    typeof raw["canResubmit"] === "boolean"
      ? raw["canResubmit"]
      : typeof raw["can_resubmit"] === "boolean"
        ? raw["can_resubmit"]
        : undefined;
  return {
    application,
    license,
    canResubmit:
      canResubmitBool !== undefined
        ? canResubmitBool
        : !(application !== null && application.status === "pending"),
  };
}

/** zod — ตรวจรูป normalize แล้ว (fail-closed เมื่อชนิดเพี้ยนหลัง normalize) */
export const MyLicenseContract = z
  .object({
    application: z
      .object({
        status: z.enum(["pending", "approved", "rejected"]),
        submittedAt: IsoTimestamp,
        decidedAt: IsoTimestamp.nullable(),
        rejectedReason: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    license: z
      .object({
        licenseNo: z.string().min(1),
        verifiedAt: IsoTimestamp,
      })
      .strict()
      .nullable(),
    canResubmit: z.boolean(),
  })
  .strict();

// ——— URL builders + format helper ———

/** GET/PUT /api/v1/me/license */
export function myLicenseApiUrl(): string {
  return "/api/v1/me/license";
}

/** วันเวลาไทย — แบบเดียวกับหน้าอื่นของผู้เรียน (th-TH · Intl ฝั่ง browser/node) */
export function formatThaiDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

// ——— data layer ———

/** body 2xx ต้องเป็น envelope {data} (API-SPECIFICATION §1.1 · jsonOk) — อื่น = สัญญาผิดรูป */
function unwrapData(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return body["data"];
}

function parseContract<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success === false) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return parsed.data;
}

/** GET /me/license — สถานะคำขอล่าสุด + ใบปัจจุบัน + canResubmit (IDENT-005) */
export async function getMyLicense(options?: TransportCallOptions): Promise<MyLicenseView> {
  const { body } = await requestJson(myLicenseApiUrl(), options);
  const data = unwrapData(body);
  if (!isRecord(data)) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  const normalized = normalizeMyLicenseView(data);
  if (normalized === null) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return parseContract(MyLicenseContract, normalized);
}

/**
 * PUT /me/license — ยื่นคำขอผูก/แทนที่ใบอนุญาต (multipart: license_no + file) → 202
 * · มีคำขอ pending อยู่ = 409 (ApiError — envelope ข้อความไทยจาก BFF)
 * · สัญญา 202-ack: 2xx = ยอมรับ (caller จะ GET ซ้ำเพื่อแสดงสถานะล่าสุดเสมอ)
 */
export async function submitMyLicense(
  input: { readonly licenseNo: string; readonly file: File },
  options?: TransportCallOptions,
): Promise<void> {
  const form = new FormData();
  form.append("license_no", input.licenseNo);
  form.append("file", input.file);
  await requestMultipart(myLicenseApiUrl(), form, options);
}

/** กฎไฟล์แนบ — ชนิด jpg/png/pdf · ขนาด ≤10MB (mirror BFF ตรวจซ้ำ) ตาม §3.2 PUT /me/license */
export const LICENSE_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const LICENSE_FILE_ACCEPTED_MIME = [
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;

/** เลขใบอนุญาตว่าความ — ^\d{6,9}$ ตามข้อกำหนด */
export const LICENSE_NO_PATTERN = /^\d{6,9}$/;

/**
 * ตรวจไฟล์แนบฝั่ง client — MIME ตรงกลุ่ม jpg/png/pdf (ยอม .jpg/.jpeg/.png/.pdf เมื่อ
 * browser ไม่แนบ MIME) · ขนาด ≤10MB · คืนข้อความไทยเมื่อไม่ผ่าน · null = ผ่าน
 */
export function validateLicenseFile(file: File): string | null {
  if (file.size > LICENSE_FILE_MAX_BYTES) {
    return "ไฟล์แนบมีขนาดเกิน 10 เมกะไบต์ กรุณาแนบไฟล์ที่เล็กกว่า";
  }
  const mimeOk = (LICENSE_FILE_ACCEPTED_MIME as readonly string[]).includes(file.type);
  const nameOk = /\.(jpe?g|png|pdf)$/i.test(file.name);
  if (file.type !== "" && !mimeOk) {
    return "ชนิดไฟล์ต้องเป็น JPG, PNG หรือ PDF เท่านั้น";
  }
  if (file.type === "" && !nameOk) {
    return "ชนิดไฟล์ต้องเป็น JPG, PNG หรือ PDF เท่านั้น";
  }
  return null;
}

/** ตรวจเลขใบอนุญาตฝั่ง client — mirror ^\d{6,9}$ · คืนข้อความไทยเมื่อไม่ผ่าน · null = ผ่าน */
export function validateLicenseNo(licenseNo: string): string | null {
  if (!LICENSE_NO_PATTERN.test(licenseNo)) {
    return "เลขที่ใบอนุญาตต้องเป็นตัวเลข 6-9 หลัก";
  }
  return null;
}

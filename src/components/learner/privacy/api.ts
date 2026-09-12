/**
 * api — ชั้นเรียก BFF ของหน้าความเป็นส่วนตัว (Wave E Phase 5 · SEC-011/IDENT-008 · lane E)
 *
 * รวมการเรียก /api/v1/profile/* ของหน้า my/privacy (D-p5-13) — อยู่ในโฟลเดอร์กรรมสิทธิ์ของ
 * lane E โดย mirror transport กลาง src/lib/api/transport.ts (แบบแผน requestJson ของ
 * components/learner/notifications/api.ts — transport กลางรับเฉพาะ GET/POST จึงมีตัวเรียก
 * PATCH ของตนเอง)
 *
 * สัญญา (API-SPECIFICATION §3.2):
 * - GET /profile/consents → { notice_acknowledgments: [], consents: [{type,status,updated_at}] }
 *   (mirror schema ของ route /profile/consents ที่มีอยู่ — snake_case ตามตาราง)
 * - PATCH /profile/consents → body { type, action } → 200 { type, status } (เฉพาะ optional)
 * - GET /profile/export → 202 { jobId, status } — pending ซ้ำ = 409 · cooldown 24 ชม. = 429
 * - POST /profile/delete → 202 (รอยืนยันทางอีเมล) · guard บทบาทพนักงาน/ผู้สอน = 403
 *
 * ขาออก zod-parse ทุกครั้ง (strict) — ผิดสัญญา = ERR-SYS-001 fail-closed · export/delete
 * ตรวจสัญญาแบบ 202-ack ตามรูปที่ spec pin ได้ (jobId/status)
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
interface PrivacyTransportResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * เรียก BFF แบบ JSON (GET/POST/PATCH) — mirror fetchJson ของ transport กลาง
 * ต่างกันจุดเดียว: รับ PATCH เพิ่ม (transport กลางยังล็อก GET/POST ตามหัวไฟล์ admin-credit.ts)
 */
async function requestJson(
  path: string,
  init: { readonly method: "GET" | "POST" | "PATCH"; readonly body?: unknown },
  options?: TransportCallOptions,
): Promise<PrivacyTransportResult> {
  const origin = resolveOriginLike(options);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.method !== "GET") {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
  if (typeof window === "undefined") {
    headers["x-ltc-bff-internal"] = "1";
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      method: init.method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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

// ——— สัญญาข้อมูลขาออกของ BFF — ตรวจฝั่ง client ทุกครั้ง (strict) ———

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เหมือน IsoTimestamp ของ credits.ts) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** type ที่ผู้ใช้จัดการเองได้ — เฉพาะ optional (mirror ConsentsPatchBody ของ BFF) */
export const CONSENT_TYPES = ["marketing", "email_notify"] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

/** แถว consent หนึ่งรายการ — contract GET /profile/consents ({type,status,updated_at}) */
export const ConsentEntry = z
  .object({
    type: z.enum(CONSENT_TYPES),
    status: z.enum(["granted", "revoked"]),
    updated_at: IsoTimestamp,
  })
  .strict();

export type ConsentEntryParsed = z.infer<typeof ConsentEntry>;

/** view ขาออกของ GET /profile/consents — 2 sections (notice_acknowledgments อ่านอย่างเดียว) */
export const ConsentsView = z
  .object({
    notice_acknowledgments: z.array(z.never()),
    consents: z.array(ConsentEntry),
  })
  .strict();

export type ConsentsViewParsed = z.infer<typeof ConsentsView>;

/** ผล PATCH /profile/consents — { type, status } */
export const ConsentStatusView = z
  .object({
    type: z.enum(CONSENT_TYPES),
    status: z.enum(["granted", "revoked"]),
  })
  .strict();

export type ConsentStatusViewParsed = z.infer<typeof ConsentStatusView>;

/** ผล GET /profile/export 202 — { jobId, status } ตาม spec (แถว §3.2 PDPA) */
export const ExportJobView = z
  .object({
    jobId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

export type ExportJobViewParsed = z.infer<typeof ExportJobView>;

/** URL builders (BFF-relative path เท่านั้น — แบบแผน credits.ts) */
export function consentsApiUrl(): string {
  return "/api/v1/profile/consents";
}

export function profileExportApiUrl(): string {
  return "/api/v1/profile/export";
}

export function profileDeleteApiUrl(): string {
  return "/api/v1/profile/delete";
}

// ——— data layer ———

/** body 2xx ต้องเป็น envelope {data} (API-SPECIFICATION §1.1 · jsonOk) — อื่น = สัญญาผิดรูป */
function unwrapData(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return body["data"];
}

/**
 * แกะข้อมูลของ 202-ack แบบ tolerant — รูปที่ spec pin: envelope {data:{...}} ·
 * ยอม record ตรง ๆ (มี jobId) กรณี BFF ตอบไม่ห่อ envelope · อื่น = null
 */
function unwrapAck(body: unknown): Record<string, unknown> | null {
  if (isRecord(body) && isRecord(body["data"])) {
    return body["data"];
  }
  if (isRecord(body) && typeof body["jobId"] === "string") {
    return body;
  }
  return null;
}

function parseContract<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return parsed.data;
}

/** GET /profile/consents — 2 sections (notice_acknowledgments อ่านอย่างเดียว = [] ตาม route เดิม) */
export async function getMyConsents(
  options?: TransportCallOptions,
): Promise<ConsentsViewParsed> {
  const { body } = await requestJson(consentsApiUrl(), { method: "GET" }, options);
  return parseContract(ConsentsView, unwrapData(body));
}

/** PATCH /profile/consents — ให้/ถอนหนึ่ง type ต่อ request → 200 {type,status} */
export async function updateMyConsent(
  type: ConsentType,
  action: "grant" | "revoke",
  options?: TransportCallOptions,
): Promise<ConsentStatusViewParsed> {
  const { body } = await requestJson(
    consentsApiUrl(),
    { method: "PATCH", body: { type, action } },
    options,
  );
  return parseContract(ConsentStatusView, unwrapData(body));
}

/**
 * GET /profile/export — ขอส่งออกข้อมูลตัวเอง → 202 {jobId,status} (ไฟล์จัดส่งทางการแจ้งเตือน
 * พร้อม signed URL อายุ 7 วัน) · มี job pending อยู่ = 409 · cooldown 24 ชม. = 429 (ApiError)
 */
export async function requestMyDataExport(
  options?: TransportCallOptions,
): Promise<ExportJobViewParsed> {
  const { body } = await requestJson(profileExportApiUrl(), { method: "GET" }, options);
  const ack = unwrapAck(body);
  if (ack === null) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return parseContract(ExportJobView, ack);
}

/**
 * POST /profile/delete — ขอลบบัญชี → 202 (ระบบส่งอีเมลยืนยัน ลิงก์อายุ 24 ชม.)
 * · guard บทบาทพนักงาน/ผู้สอน/super_admin = 403 (ApiError ข้อความไทยจาก BFF)
 * · สัญญา 202-ack: 2xx + body null/record ใด ๆ = ยอมรับ (รูป body ยังไม่ถูก pin)
 */
export async function requestMyAccountDeletion(
  options?: TransportCallOptions,
): Promise<void> {
  await requestJson(profileDeleteApiUrl(), { method: "POST" }, options);
}

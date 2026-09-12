/**
 * api — ชั้นเรียก BFF ของหน้าโปรไฟล์ (Wave E Phase 5 · IDENT-001 · lane E)
 *
 * รวมการเรียก GET/PATCH /api/v1/me ของ ProfileForm — อยู่ในโฟลเดอร์กรรมสิทธิ์ของ lane E
 * โดย mirror transport กลาง src/lib/api/transport.ts เป๊ะ (แบบแผน patchJson ของ
 * src/lib/api/admin-credit.ts + requestJson ของ components/learner/notifications/api.ts —
 * transport กลางรับเฉพาะ GET/POST จึงมีตัวเรียก PATCH ของตนเอง)
 *
 * สัญญา (API-SPECIFICATION §3.2 · D-p5-13):
 * - GET /me — { id, email, displayName, roles, mfaVerified } (+ phone/preferredLocale/
 *   firstName/lastName ถ้า BFF ส่งมา — optional)
 * - PATCH /me — body { displayName, phone, preferredLocale } เท่านั้น (เขต self-edit ตาม
 *   guard 0010 — first/last_name เป็นข้อมูลนิติบุคคล แก้ผ่านเจ้าหน้าที่ ห้ามส่ง)
 *
 * ขาออก zod-parse ทุกครั้ง (strict) — ผิดสัญญา = ERR-SYS-001 fail-closed แบบเดียวกับ
 * src/lib/api/credits.ts · ฟิลด์ใหม่ที่ยังไม่แน่นอน (phone/preferredLocale/firstName/
 * lastName) รับทั้ง camelCase และ snake_case แล้ว normalize เป็น camelCase ก่อนตรวจ
 * (tolerant-read adapter — ให้หน้าใช้งานได้ทันทีไม่ว่าข้อตกลงชื่อคีย์ฝั่ง BFF จะเป็นแบบใด
 * ขณะที่ข้อมูลจำเพาะยังไม่ระบุรูป JSON เต็ม — คีย์ที่รู้จักปุ๊บ normalize เข้ารูปกลาง
 * คีย์แปลกปลอมทิ้ง · ฟิลด์บังคับของ GET /me เดิมตรวจ strict ตาม Wave C)
 *
 * - origin: options.origin ก่อน → window.location.origin (browser) — server ไม่ส่ง origin = throw
 *   (programming error ของ RSC — เหมือน transport กลาง)
 * - headers: accept เสมอ · content-type เฉพาะ PATCH · cookieHeader > 1 ตัวอักษร → header
 *   cookie · ขา server (typeof window === "undefined") → x-ltc-bff-internal: 1
 * - fetch: credentials same-origin + cache no-store · body JSON.stringify เอง
 * - ผล: 2xx → { status, body } ดิบ · non-2xx / parse ล้ม / network → ApiError (code จาก
 *   envelope §1.3 ถ้ามี ไม่งั้น HTTP_<status> · message ไทยจาก envelope ถ้ามี)
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
interface MeTransportResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * เรียก BFF แบบ JSON (GET/PATCH) — mirror fetchJson ของ transport กลางเป๊ะ
 * ต่างกันจุดเดียว: รับ PATCH เพิ่ม (transport กลางยังล็อก GET/POST)
 */
async function requestJson(
  path: string,
  init: { readonly method: "GET" | "PATCH"; readonly body?: unknown },
  options?: TransportCallOptions,
): Promise<MeTransportResult> {
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

// ——— สัญญาข้อมูล (GET /me) — ฟิลด์เดิม strict · ฟิลด์ใหม่ tolerant-read ———

/** path ของ /me — camelCase ตาม MeResource ของ BFF ตั้งแต่ Wave C */
const ME_URL = "/api/v1/me";

/** โปรไฟล์ของตัวเอง — ฟิลด์บังคับ 5 ตัวตาม GET /me (Wave C) · ฟิลด์เสริม normalize แล้ว */
export interface MeProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly mfaVerified: boolean;
  readonly phone: string | null;
  readonly preferredLocale: "th" | "en";
  readonly firstName: string | null;
  readonly lastName: string | null;
}

/** เลือกคีย์แรกที่มีค่า string จากรายชื่อ alias — normalize ก่อนตรวจ strict */
function pickString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/** คีย์บังคับ 5 ตัวของ GET /me (Wave C) — ส่งต่อดิบ ให้ MeView ตรวจชนิด strict ต่อ */
const ME_BASE_KEYS = ["id", "email", "displayName", "roles", "mfaVerified"] as const;

/**
 * normalize ฟิลด์เสริมของ GET /me จาก record ดิบ — รับทั้ง camelCase/snake_case
 * (preferredLocale | preferred_locale เป็นต้น) · preferred_locale ที่ไม่รู้จัก = "th"
 * (default ตาม DD §3.1) · คืน record รูปกลางที่ "เฉพาะคีย์ที่รู้จัก" (คีย์ alias ดิบ
 * เช่น preferred_locale ถูกทิ้ง — strict parse จะตีคีย์แปลกปลอม) ให้ MeView ตรวจ strict ต่อ
 */
export function normalizeMeExtras(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ME_BASE_KEYS) {
    if (key in raw) {
      out[key] = raw[key];
    }
  }
  const phone = pickString(raw, ["phone"]);
  if (phone !== null) {
    out.phone = phone;
  }
  const preferredLocale = pickString(raw, ["preferredLocale", "preferred_locale"]);
  if (preferredLocale !== null) {
    out.preferredLocale =
      preferredLocale === "th" || preferredLocale === "en" ? preferredLocale : "th";
  }
  const firstName = pickString(raw, ["firstName", "first_name"]);
  if (firstName !== null) {
    out.firstName = firstName;
  }
  const lastName = pickString(raw, ["lastName", "last_name"]);
  if (lastName !== null) {
    out.lastName = lastName;
  }
  return out;
}

/** zod — ฟิลด์บังคับของ GET /me ตาม Wave C + ฟิลด์เสริมที่ normalize แล้ว (strict) */
export const MeView = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    displayName: z.string().min(1),
    roles: z.array(z.string()),
    mfaVerified: z.boolean(),
    phone: z.string().min(1).optional(),
    preferredLocale: z.enum(["th", "en"]).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
  })
  .strict();

export type MeViewParsed = z.infer<typeof MeView>;

/** body ของ PATCH /me — เขต self-edit ตาม guard 0010 (camelCase mirror ขาออกของ /me) */
export interface UpdateMeInput {
  readonly displayName: string;
  readonly phone: string | null;
  readonly preferredLocale: "th" | "en";
}

// ——— data layer ———

/** body 200 ต้องเป็น envelope {data} (API-SPECIFICATION §1.1 · jsonOk) — อื่น = สัญญาผิดรูป */
function unwrapData(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return body["data"];
}

function parseContract<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  return parsed.data;
}

/** GET /me — โปรไฟล์ของตัวเอง (ฟิลด์เสริม normalize ทั้ง camelCase/snake_case ก่อนตรวจ) */
export async function getMyProfile(options?: TransportCallOptions): Promise<MeProfile> {
  const { body } = await requestJson(ME_URL, { method: "GET" }, options);
  const data = unwrapData(body);
  if (!isRecord(data)) {
    throw new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  }
  const parsed = parseContract(MeView, normalizeMeExtras(data));
  return {
    id: parsed.id,
    email: parsed.email,
    displayName: parsed.displayName,
    roles: parsed.roles,
    mfaVerified: parsed.mfaVerified,
    phone: parsed.phone ?? null,
    preferredLocale: parsed.preferredLocale ?? "th",
    firstName: parsed.firstName ?? null,
    lastName: parsed.lastName ?? null,
  };
}

/**
 * PATCH /me — บันทึกเขต self-edit (display_name/phone/preferred_locale) · 200 = สำเร็จ
 *
 * response ของ PATCH ยังไม่ถูก pin รูปในข้อจำกัดที่หน้าอ่านได้ — จึงถือ "200 + body เป็น
 * object/null = ยอมรับ" แล้วให้ caller โหลด GET /me ซ้ำเพื่อแสดงค่าจริงล่าสุดเสมอ
 * (แหล่งความจริงเดียว = GET — กันสถานะจอเพี้ยนถ้ารูป response ต่างจากที่คาด)
 * · non-2xx → ApiError ข้อความไทยจาก envelope (ERR-VAL-001 ฯลฯ)
 */
export async function updateMyProfile(
  input: UpdateMeInput,
  options?: TransportCallOptions,
): Promise<void> {
  await requestJson(
    ME_URL,
    {
      method: "PATCH",
      body: {
        displayName: input.displayName,
        ...(input.phone !== null ? { phone: input.phone } : {}),
        preferredLocale: input.preferredLocale,
      },
    },
    options,
  );
}

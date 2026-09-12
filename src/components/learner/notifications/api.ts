/**
 * api — ชั้นเรียก BFF ของ UI แจ้งเตือน (Wave E Phase 4 · NTF-001/005 · lane D)
 *
 * รวมทั้ง client component ของ lane D (กระดิ่ง/กล่องจดหมาย/ตั้งค่า) — อยู่ในโฟลเดอร์
 * กรรมสิทธิ์ของ lane เดียวกัน โดย mirror transport กลาง src/lib/api/transport.ts เป๊ะ
 * (แบบแผน patchJson ของ src/lib/api/admin-credit.ts — transport กลางรับเฉพาะ GET/POST
 * จึงมีตัวเรียก PATCH ของตนเองตามที่หัวไฟล์ admin-credit.ts ระบุ)
 *
 * - origin: options.origin ก่อน → window.location.origin (browser) — server ไม่ส่ง origin = throw
 *   (programming error ของ RSC — เหมือน transport กลาง)
 * - headers: accept เสมอ · content-type เฉพาะ POST/PATCH · cookieHeader > 1 ตัวอักษร → header
 *   cookie · ขา server (typeof window === "undefined") → x-ltc-bff-internal: 1 (ขาใน —
 *   middleware ไม่หมุน token)
 * - fetch: credentials same-origin + cache no-store · body JSON.stringify เอง
 * - ผล: 204 → { status: 204, body: null } · 2xx → { status, body } ดิบ · non-2xx / parse ล้ม /
 *   network → ApiError (code จาก envelope §1.3 ถ้ามี ไม่งั้น HTTP_<status> · message จาก
 *   envelope ถ้ามี ไม่งั้นข้อความกลางไทย)
 * - ขาออก zod-parse ทุกครั้ง (strict ทุกชั้น) — ผิดสัญญา = ERR-SYS-001 fail-closed
 *   แบบเดียวกับ src/lib/api/credits.ts · และตามแผน §5 lane B (zod strict ทั้งเข้า-ออก)
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
interface NotifTransportResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * เรียก BFF แบบ JSON (GET/POST/PATCH) — mirror fetchJson ของ transport กลางเป๊ะ
 * ต่างกันจุดเดียว: รับ PATCH เพิ่ม (transport กลางยังล็อก GET/POST ตามหัวไฟล์ admin-credit.ts)
 */
async function requestJson(
  path: string,
  init: { readonly method: "GET" | "POST" | "PATCH"; readonly body?: unknown },
  options?: TransportCallOptions,
): Promise<NotifTransportResult> {
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
  if (response.status === 204) {
    return { status: 204, body: null };
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

// ——— สัญญาข้อมูลขาออกของ BFF (ตรวจฝั่ง client ทุกครั้ง — strict ตามแผน §3 D-p4-5) ———

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เหมือน IsoTimestamp ของ credits.ts) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** ความรุนแรงของแจ้งเตือน — 4 ค่าตาม contract ของ GET /me/notifications */
export const NOTIF_SEVERITIES = ["info", "success", "warning", "error"] as const;

export type NotifSeverity = (typeof NOTIF_SEVERITIES)[number];

/** แถวแจ้งเตือนหนึ่งรายการ — contract ของ GET /api/v1/me/notifications (§5 lane B) */
export const NotificationItem = z
  .object({
    id: z.string().uuid(),
    recipient_id: z.string().uuid(),
    topic: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    severity: z.enum(NOTIF_SEVERITIES),
    ref_type: z.string().min(1).nullable(),
    ref_id: z.string().min(1).nullable(),
    created_at: IsoTimestamp,
    read_at: IsoTimestamp.nullable(),
  })
  .strict();

export type NotificationItemParsed = z.infer<typeof NotificationItem>;

/** ผล GET /me/notifications — keyset cursor แบบ opaque (ส่งต่อเป๊ะ ๆ ห้ามแกะ) */
export const NotificationsPage = z
  .object({
    items: z.array(NotificationItem),
    unread_count: z.number().int().min(0),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();

export type NotificationsPageParsed = z.infer<typeof NotificationsPage>;

/** family ของ settings (D-p4-5) — key ของ jsonb settings ไม่ใช่ topic เต็ม */
export const NOTIF_FAMILIES = ["exam.result", "certificate", "credit", "renewal"] as const;

export type NotifFamily = (typeof NOTIF_FAMILIES)[number];

/** ค่าต่อ family — สองช่องทาง in_app/email */
export const FamilyChannels = z
  .object({ in_app: z.boolean(), email: z.boolean() })
  .strict();

export type FamilyChannelsParsed = z.infer<typeof FamilyChannels>;

/** ผล GET/PATCH /me/notification-settings — settings ตาม jsonb ของ notification_settings */
export const SettingsView = z
  .object({ settings: z.record(z.string(), FamilyChannels) })
  .strict();

export type SettingsViewParsed = z.infer<typeof SettingsView>;

/**
 * ค่าที่ใช้จริงต่อ family หลัง normalize — "ไม่มีคีย์ = อนุญาต (default on)" ตาม D-p4-4
 * (ฝั่ง RPC my_notification_settings คืน default ครบทุก family อยู่แล้ว — normalize
 * เป็นเข็มขัดชั้นสองฝั่ง UI ให้ตรงความตัดสินใจเดียวกัน)
 */
export type SettingsByFamily = Readonly<Record<NotifFamily, FamilyChannelsParsed>>;

const SETTINGS_DEFAULT: FamilyChannelsParsed = { in_app: true, email: true };

/** เติม family ที่หายไปด้วย default on (D-p4-4) — key แปลกปลอมทิ้ง */
export function normalizeSettings(view: SettingsViewParsed): SettingsByFamily {
  const raw = view.settings;
  const out = {} as Record<NotifFamily, FamilyChannelsParsed>;
  for (const family of NOTIF_FAMILIES) {
    const entry = raw[family];
    out[family] =
      entry === undefined
        ? { ...SETTINGS_DEFAULT }
        : { in_app: entry.in_app, email: entry.email };
  }
  return out;
}

// ——— event ภายในหน้า — กระดิ่ง (header) รีเฟรชป้ายเมื่อมีรายการถูกอ่าน ———

/**
 * event name ของ window — inbox ยิงหลัง POST read สำเร็จ เพื่อให้กระดิ่งดึงเลขไม่อ่านใหม่
 * ทันที (ไม่ต้องรอรอบ poll 60 วินาที) — ไม่มี payload (e2e มองป้ายผ่าน data-testid เดิม)
 */
export const NOTIF_READ_CHANGED_EVENT = "ltc:notifications-read-changed";

// ——— URL builders (BFF-relative path เท่านั้น — แบบแผน credits.ts) ———
/** GET /api/v1/me/notifications?limit=&cursor= — cursor ไม่ส่ง = หน้าแรก */
export function myNotificationsApiUrl(query?: {
  readonly limit?: number;
  readonly cursor?: string;
}): string {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query?.cursor !== undefined) {
    params.set("cursor", query.cursor);
  }
  const qs = params.toString();
  return qs.length === 0 ? "/api/v1/me/notifications" : `/api/v1/me/notifications?${qs}`;
}

/** POST /api/v1/me/notifications/{id}/read — mark-read (204 · idempotent · NF-001) */
export function markNotificationReadApiUrl(notificationId: string): string {
  return `/api/v1/me/notifications/${encodeURIComponent(notificationId)}/read`;
}

/** GET/PATCH /api/v1/me/notification-settings */
export function notificationSettingsApiUrl(): string {
  return "/api/v1/me/notification-settings";
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

/** GET /me/notifications — หน้าแรก (ไม่ส่ง cursor) หรือหน้าถัดไป (ส่ง cursor ต่อจาก response ก่อน) */
export async function getMyNotifications(
  query: { readonly limit?: number; readonly cursor?: string },
  options?: TransportCallOptions,
): Promise<NotificationsPageParsed> {
  const { body } = await requestJson(myNotificationsApiUrl(query), { method: "GET" }, options);
  return parseContract(NotificationsPage, unwrapData(body));
}

/** POST /me/notifications/{id}/read — 204 เท่านั้นที่ไม่ throw (idempotent ตาม NF-001) */
export async function markNotificationRead(
  notificationId: string,
  options?: TransportCallOptions,
): Promise<void> {
  await requestJson(markNotificationReadApiUrl(notificationId), { method: "POST" }, options);
}

/** GET /me/notification-settings — normalize ให้ครบ 4 family (missing = default on · D-p4-4) */
export async function getNotificationSettings(
  options?: TransportCallOptions,
): Promise<SettingsByFamily> {
  const { body } = await requestJson(notificationSettingsApiUrl(), { method: "GET" }, options);
  return normalizeSettings(parseContract(SettingsView, unwrapData(body)));
}

/** PATCH /me/notification-settings — ส่งเฉพาะ family ที่เปลี่ยน → 200 {data:{settings}} */
export async function updateNotificationSettings(
  changed: Partial<Record<NotifFamily, FamilyChannelsParsed>>,
  options?: TransportCallOptions,
): Promise<SettingsByFamily> {
  const { body } = await requestJson(
    notificationSettingsApiUrl(),
    { method: "PATCH", body: { settings: changed } },
    options,
  );
  return normalizeSettings(parseContract(SettingsView, unwrapData(body)));
}

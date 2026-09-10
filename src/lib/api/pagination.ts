/**
 * pagination — cursor-based pagination กลาง (API-SPECIFICATION §1.2)
 *
 * - request: ?limit=20&cursor=<opaque> (PageQuery — lib/schemas/v1/common)
 * - response: { data, page: { nextCursor, hasMore } } ตาม doc §1.2
 * - cursor = base64url(JSON { sortKey, id }) + "." + HMAC-SHA256 → ปลอมไม่ได้ (signed ตาม §1.2)
 *   คีย์ HMAC จาก config.cursorHmacSecret (CURSOR_HMAC_SECRET — หมุนได้อิสระจาก service key)
 *   ไม่ตั้ง → fallback supabaseServiceRoleKey (dev-grade ตามสัญญา config.ts)
 *   HMAC ไม่เปิดเผยคีย์ต้นฉบับ (PRF) — ไม่ใช่การเปิดเผย service-role key
 * - cursor ผิดรูปแบบ/ถูกแก้/หมด field → ERR-VAL-001 (400)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors";
import { getConfig } from "../config";

/** ส่วนหัวของ cursor — (sort_key, id) ตาม doc §1.2 (เช่น created_at ISO UTC + UUID) */
export interface CursorPayload {
  readonly sortKey: string;
  readonly id: string;
}

export interface CursorOptions {
  /** override คีย์ HMAC (สำหรับ unit test) — default จาก config */
  readonly secret?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function cursorSecret(options?: CursorOptions): string {
  if (options?.secret !== undefined) return options.secret;
  const config = getConfig();
  // CURSOR_HMAC_SECRET หมุนแยกจาก service key ได้ (gate r1: ค่า config ต้องมีผลจริง)
  return config.cursorHmacSecret ?? config.supabaseServiceRoleKey;
}

/**
 * สร้าง signed cursor จาก (sortKey, id) — ส่งกลับ client ได้ (opaque + ปลอมไม่ได้)
 */
export function encodeCursor(payload: CursorPayload, options?: CursorOptions): string {
  const secret = cursorSecret(options);
  const body = base64UrlEncode(JSON.stringify({ k: payload.sortKey, i: payload.id }));
  return body + "." + sign(body, secret);
}

/**
 * แกะ/ตรวจ signed cursor — ผิดรูปแบบ ถูกแก้ หรือ field ไม่ครบ → throw ERR-VAL-001 (400)
 */
export function decodeCursor(cursor: string, options?: CursorOptions): CursorPayload {
  const parts = cursor.split(".");
  if (parts.length !== 2) {
    throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "malformed" } });
  }
  const [body, sig] = parts as [string, string];
  const expected = sign(body, cursorSecret(options));
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "bad_signature" } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "malformed" } });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "malformed" } });
  }
  const rec = parsed as Record<string, unknown>;
  const sortKey = rec["k"];
  const id = rec["i"];
  if (typeof sortKey !== "string" || sortKey.length < 1 || sortKey.length > 128) {
    throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "bad_sort_key" } });
  }
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new AppError("ERR-VAL-001", { details: { field: "cursor.id", reason: "bad_id" } });
  }
  return { sortKey, id };
}

/** envelope ของ list endpoint — ตรงรูป doc API-SPECIFICATION §1.2 */
export interface PageEnvelope<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface BuildPageOptions<T> {
  /** แถวที่ handler query มา — ควร query limit+1 แถวเรียงตาม (sortKey, id) เพื่อรู้ hasMore */
  readonly rows: readonly T[];
  readonly limit: number;
  readonly sortKeyOf: (row: T) => string;
  readonly idOf: (row: T) => string;
  readonly cursorOptions?: CursorOptions;
}

/**
 * สร้าง envelope { data, page } จากแถวที่ query มา (handler query limit+1 แถว → buildPage ตัดให้)
 * nextCursor ชี้ตำแหน่งแถวสุดท้ายของหน้านี้ — ส่ง decodeCursor(...) กลับมาได้ทุกรอบ
 */
export function buildPage<T>(options: BuildPageOptions<T>): PageEnvelope<T> {
  const { rows, limit, sortKeyOf, idOf, cursorOptions } = options;
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last !== undefined ? encodeCursor({ sortKey: sortKeyOf(last), id: idOf(last) }, cursorOptions) : null;
  return { data, page: { nextCursor, hasMore } };
}

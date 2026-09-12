/**
 * GET/PATCH /api/v1/me/notification-settings — ตั้งค่าแจ้งเตือนรายประเภท/ช่องทางของตัวเอง
 * (Wave E Phase 4 · NTF-005 · API-SPECIFICATION §3.9)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (เส้นข้อมูลของตัวเอง aal1 ใช้ได้)
 * - ไม่มี permission gate — RPC ทำ owner-check เองใน DB (auth.uid()) · handler ไม่ส่ง user_id
 *   เข้าไป · เรียก RPC ด้วย user JWT ผ่าน PostgREST เท่านั้น (ห้าม service key)
 * - family ตาม D-p4-5: "exam.result" | "certificate" | "credit" | "renewal" →
 *   { in_app: boolean, email: boolean } — jsonb settings key = family (ไม่ใช่ topic เต็ม)
 *   (RPC 0035 มี family ภายในเพิ่ม 'license'/'account' แต่สมาชิกทั้งชุดเป็นธุรกรรมบังคับ
 *    NTF-005 ที่ส่งเสมอ (0036 §12) = ไม่ใช่สวิตช์ผู้ใช้ → BFF กรองออก ตอบเฉพาะ 4 family นี้)
 * - GET: RPC my_notification_settings (คืน default ครบทุก family เมื่อไม่มีแถว) → 200 { settings }
 * - PATCH: body { settings: { family: { in_app?, email? } } } ส่งบางส่วนได้ (ต้องมีอย่างน้อย
 *   1 คีย์ต่อ family ที่ส่ง + อย่างน้อย 1 family) · boolean เท่านั้น · strict — key แปลกปลอม/
 *   ค่าผิดชนิด/ก้อนว่าง → 400 ERR-VAL-001 · PATCH ตอบค่าใหม่ทั้งก้อน (ครบ 4 family) ·
 *   drift → 503 ERR-SYS-002 · RPC โยน '(ERR-XXX-NNN|tag)' → map ตามทะเบียน · ไม่มีป้าย → 503 opaque
 * - rate = READ (§5: /me* ทุก method — 120/min ต่อ user_id + ip)
 */
import { NextResponse } from "next/server";

import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  NOTIFICATION_FAMILIES,
  NotificationSettingsPatchBody,
  NotificationSettingsView,
  type NotificationSettingsPatchBodyParsed,
} from "./schema";

/**
 * error ของ RPC → AppError — มีป้าย "(ERR-XXX-NNN|tag)" ที่อยู่ในทะเบียน = map ตรง
 * (สถานะ + ข้อความไทยจากทะเบียน lib/errors) · ไม่มีป้าย = ERR-SYS-002 opaque
 * (ไม่ leak ข้อความ SQL — SDS §6.1) — pattern เดียวกับ admin/credit-rules/[id]
 */
function mapRpcError(error: RpcErrorLike, fallbackReason: string): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: fallbackReason } });
}

/** จุดเดียวของ reason ที่ PATCH ใช้เมื่อ RPC ล้มแบบไม่มีป้าย */
const SETTINGS_UPDATE_FALLBACK = "notification_settings_update_failed";

/**
 * RPC อาจคืนก้อน settings ตรง ๆ (4 family เป็น key) หรือห่อ {settings: {...}} มา —
 * คลี่เป็นก้อน settings เปล่า ๆ ก่อนตรวจ strict (สองรูปเท่านั้น — อื่น ๆ = null → 503)
 */
function extractSettings(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const inner = record["settings"];
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return record;
}

/**
 * กรองก้อน settings ของ RPC เหลือเฉพาะ family ที่เป็นสัญญาของ API (4 family) —
 * 0035 เพิ่ม family ภายใน 'license'/'account' ให้ RPC แต่สมาชิกปัจจุบันทั้งชุดเป็น
 * ธุรกรรมบังคับ NTF-005 ("ที่ส่งเสมอ" — 0036 §12) จึงไม่ใช่สวิตช์ของผู้ใช้: แสดง
 * toggle ที่กดแล้วไม่มีผล = โกหกผู้ใช้ → BFF ตัดออกก่อนตอบ (GET/PATCH ใช้จุดเดียวกัน) ·
 * family ที่เป็นสัญญาหายไป = drift → 503 fail-closed (คืน null ให้ caller โยน)
 */
function toContractSettings(raw: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const family of NOTIFICATION_FAMILIES) {
    const value = raw[family];
    if (value === undefined) {
      return null;
    }
    out[family] = value;
  }
  return out;
}

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) — แบบ parseStatusBody */
async function parsePatchBody(request: Request): Promise<NotificationSettingsPatchBodyParsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
  }
  const parsed = NotificationSettingsPatchBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** query ขาเข้า = ต้องว่าง (ไม่มีพารามิเตอร์ — strict: key ใด ๆ → 400 แบบ /me/credits MINOR-2) */
function parseEmptyQuery(searchParams: URLSearchParams): void {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  if (Object.keys(raw).length > 0) {
    throw new AppError("ERR-VAL-001", {
      details: { fields: Object.keys(raw) },
    });
  }
}

/** GET — ตั้งค่าของตัวเอง (RPC คืน default ครบทุก family เมื่อไม่มีแถว) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session → 401 ERR-AUTH-001 (ไม่มี MFA gate — เส้นข้อมูลตัวเอง)
    const user = await requireUser();
    // 2) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) query ต้องว่าง — key ใด ๆ → 400 (แบบ /me/credits)
    parseEmptyQuery(new URL(request.url).searchParams);
    // 4) RPC my_notification_settings ด้วย user JWT — owner-check อยู่ใน RPC
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("my_notification_settings");
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    // 4) ขาออก zod strict — drift → 503 fail-closed (ไม่ส่ง payload เพี้ยน)
    //    (กรองเหลือ family ของสัญญาก่อน — ดู toContractSettings)
    const settingsBody = toContractSettings(extractSettings(data) ?? {});
    if (settingsBody === null) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "notification_settings_read_drift" },
      });
    }
    const view = parseOutgoingView(NotificationSettingsView, { settings: settingsBody }, "notification_settings_read_drift");
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/** PATCH — แก้ตั้งค่าบางส่วนต่อ family → ตอบค่าใหม่ทั้งก้อน (200) */
export async function PATCH(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session → 401 · 2) rate READ
    const user = await requireUser();
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) body strict — { settings: { family: { in_app?, email? } } }
    const body = await parsePatchBody(request);
    // 4) RPC my_notification_settings_update ด้วย user JWT — validate/upsert อยู่ใน SQL
    const supabase = await createSupabaseSsrClient();
    const rpc = await supabase.rpc("my_notification_settings_update", {
      p_settings: body.settings,
    });
    if (rpc.error !== null) {
      throw mapRpcError(rpc.error as RpcErrorLike, SETTINGS_UPDATE_FALLBACK);
    }
    // 5) PostgREST อาจ wrap scalar/jsonb เป็น array หลักเดียว (r8-N2) — คลี่ก่อนตรวจ strict
    const rawRow: unknown = Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
    const rawSettings = extractSettings(rawRow);
    if (rawSettings === null) {
      throw new AppError("ERR-SYS-002", { details: { reason: SETTINGS_UPDATE_FALLBACK } });
    }
    // family ของสัญญาขาดหลังกรอง = drift (เหมือนเดิม — ไม่ใช่ fallback ทั่วไป)
    const settingsBody = toContractSettings(rawSettings);
    if (settingsBody === null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "notification_settings_updated_drift" } });
    }
    // 6) ขาออก strict — ตอบค่าใหม่ทั้งก้อน (settings ครบ 4 family)
    const view = parseOutgoingView(NotificationSettingsView, { settings: settingsBody }, "notification_settings_updated_drift");
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

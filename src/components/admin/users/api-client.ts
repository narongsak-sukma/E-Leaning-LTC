/**
 * api-client — transport ฝั่ง client component ของ lane F (Wave E Phase 5)
 * สำหรับ method ที่ transport กลาง (src/lib/api/transport.ts — GET/POST เท่านั้น)
 * ยังไม่ครอบ: PATCH ของ /admin/users/{id} · POST/DELETE ของ /admin/users/{id}/roles ·
 * PATCH ของ /admin/license-applications/{id} (และ PATCH /admin/courses/{id} ใน handoff)
 *
 * - เรียกเฉพาะ same-origin (window.location.origin) — session อยู่ที่ httpOnly cookie ·
 *   Origin/Sec-Fetch-Site ผ่าน middleware CSRF ของ BFF เอง · cache no-store
 * - error ของ BFF → AdminApiError { code, status, fields } — คลาส/envelope-parser เดียวกับ
 *   exam-admin.client (ห้ามคิด code ใหม่ — D13-F12) · ข้อความไทยจาก envelope ของ BFF
 * - ไฟล์นี้ถูก import เข้า Client Component เท่านั้น — ห้าม import server-only/config
 */
import {
  AdminApiError,
  TRANSPORT_FALLBACK_MESSAGE,
} from "@/lib/exam-admin.client";

/** ตรวจว่าค่าเป็น object (ไม่ใช่ array/null) */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ดึงรายชื่อ field จาก details ของ envelope — รองรับ details.fields / details.field */
function valFieldsOf(details: unknown): readonly string[] {
  if (!isRecord(details)) {
    return [];
  }
  const fields = details["fields"];
  if (Array.isArray(fields)) {
    return fields.filter((field): field is string => typeof field === "string");
  }
  const field = details["field"];
  return typeof field === "string" ? [field] : [];
}

/** ประกอบ error จาก response ที่ non-2xx — อ่าน envelope §1.3 เมื่ออ่านได้ */
function errorOf(response: Response, parsed: unknown): AdminApiError {
  const envelope = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : null;
  const code =
    envelope !== null && typeof envelope["code"] === "string" && envelope["code"].length > 0
      ? envelope["code"]
      : `HTTP_${String(response.status)}`;
  const message =
    envelope !== null && typeof envelope["message"] === "string" && envelope["message"].length > 0
      ? envelope["message"]
      : TRANSPORT_FALLBACK_MESSAGE;
  const fields =
    envelope !== null && envelope["details"] !== undefined ? valFieldsOf(envelope["details"]) : [];
  return new AdminApiError(code, response.status, message, fields);
}

/**
 * แกนร่วมของ PATCH/POST/DELETE — สัญญาเดียวกับ postAdminJson ของ exam-admin.client:
 * - ไม่มี window (SSR) → AdminApiError ERR-SYS-001 ทันที (transport ฝั่ง browser เท่านั้น)
 * - network ล่ม → AdminApiError ERR-SYS-001 · JSON พัง → parsed = null (ตัดสินด้วย status
 *   ต่อ — 2xx ที่ body พัง = body null ให้ผู้เรียก fail-closed ต่อเอง ตามแบบ exam-admin.client)
 * - non-2xx → AdminApiError (code/message/fields จาก envelope เมื่ออ่านได้)
 */
async function sendAdminJson(
  method: "PATCH" | "POST" | "DELETE",
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (typeof window === "undefined") {
    throw new AdminApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, window.location.origin), {
      method,
      headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
      credentials: "same-origin",
      cache: "no-store",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new AdminApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw errorOf(response, parsed);
  }
  return { status: response.status, body: parsed };
}

/** PATCH JSON ไปยัง BFF same-origin — สัญญาเดียวกับ sendAdminJson ด้านบน */
export async function patchAdminJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return sendAdminJson("PATCH", path, body);
}

/** POST JSON — จุดเรียกเดียวของ lane F (ครอบ method เดียวกันหมด แทน import หลายจุด) */
export async function postAdminJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return sendAdminJson("POST", path, body);
}

/** DELETE JSON — role query ผูกใน path แล้ว (เช่น …/roles?role=lawyer) · 204 = body null */
export async function deleteAdminJson(path: string): Promise<{ status: number; body: unknown }> {
  return sendAdminJson("DELETE", path, undefined);
}

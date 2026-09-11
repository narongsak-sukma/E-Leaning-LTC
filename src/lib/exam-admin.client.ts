/**
 * exam-admin.client — transport ฝั่ง client component สำหรับ mutation หลังบ้านสอบ/ประกาศนียบัตร
 * (Wave D · D-7)
 *
 * - POST เฉพาะ same-origin (window.location.origin) — Origin/Sec-Fetch-Site ผ่าน middleware CSRF
 *   ของ BFF เอง · cache no-store · ไม่มี token ฝั่ง browser (session อยู่ที่ httpOnly cookie)
 * - error ของ BFF แปลงเป็น AdminApiError { code, status, fields } — code อ้างทะเบียน
 *   src/lib/errors (ห้ามคิด code ใหม่ — D13-F12) · ข้อความไทยจาก envelope ของ BFF
 * - ไฟล์นี้ถูก import เข้า Client Component เท่านั้น — ห้าม import server-only/config
 */

/** error ฝั่ง client — code อ้างทะเบียน src/lib/errors (§1.3) · fields = path ของ ERR-VAL-001 */
export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: readonly string[];

  constructor(code: string, status: number, message: string, fields: readonly string[] = []) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export const TRANSPORT_FALLBACK_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";

/** ตรวจว่าค่าเป็น object (ไม่ใช่ array/null) */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ดึงรายชื่อ field จาก details ของ envelope — รองรับ details.fields (array) / details.field */
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

/**
 * POST JSON ไปยัง BFF same-origin — คืน { status, body } เมื่อ 2xx · non-2xx/network/JSON พัง
 * → AdminApiError (code จาก envelope เสมอเมื่ออ่านได้)
 */
export async function postAdminJson(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (typeof window === "undefined") {
    throw new AdminApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, window.location.origin), {
      method: "POST",
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
    const envelope = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : null;
    const code =
      envelope !== null && typeof envelope["code"] === "string" && envelope["code"].length > 0
        ? envelope["code"]
        : "HTTP_" + String(response.status);
    const message =
      envelope !== null && typeof envelope["message"] === "string" && envelope["message"].length > 0
        ? envelope["message"]
        : TRANSPORT_FALLBACK_MESSAGE;
    const fields =
      envelope !== null && envelope["details"] !== undefined ? valFieldsOf(envelope["details"]) : [];
    throw new AdminApiError(code, response.status, message, fields);
  }
  return { status: response.status, body: parsed };
}

/** แตก { data } จาก envelope §1.1 — ไม่มี data = contract ผิดรูป → null (fail-closed) */
export function unwrapDataEnvelope(body: unknown): unknown | null {
  if (!isRecord(body) || !("data" in body)) {
    return null;
  }
  return body["data"];
}

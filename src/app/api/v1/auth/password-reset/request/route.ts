/**
 * POST /api/v1/auth/password-reset/request — ขอลิงก์ตั้งรหัสผ่านใหม่ (AUTH-004 · Wave G P1 · D72)
 *
 * - rate limit group PWD_RESET (5/ชม. — path จองไว้ rate-limit.ts:144-160) คีย์รอง
 *   = อีเมล normalized · เรียก enforceRateLimit ที่นี่เอง (middleware ไม่ wire ให้)
 *   ก่อนแตะ GoTrue ตามสัญญาร่วมของ lane
 * - body {email} → zod (trim+lowercase+email) ไม่ผ่าน = 400 ERR-VAL-001
 * - GoTrue POST {SUPABASE_URL}/auth/v1/recover — email ใน body + **redirect_to แนบ
 *   query param** เสมอ ({publicBaseUrl}/reset-password — GOTRUE_URI_ALLOW_LIST ครอบ
 *   อยู่แล้ว): GoTrue v2.164.0 ของ dev stack อ่าน redirect_to เฉพาะ query param
 *   (r.FormValue ไม่ parse JSON body) — ส่งใน body เพียงอย่างเดียวถูกปัดไป SITE_URL
 *   (พิสูจน์ด้วย probe จริง · แนบทั้งสองช่องทาง = เข้ากันได้กับทั้งเวอร์ชันเก่า/ใหม่)
 * - **ตอบ 200 ข้อความเดียวกันทุกกรณี** (PASSWORD_RESET_REQUEST_MESSAGE) — ผลของ
 *   recover (สำเร็จ/over_email_send_rate_limit/5xx) ห้ามปรากฏที่ response เด็ดขาด:
 *   over_email_send_rate_limit ของ GoTrue นับเฉพาะอีเมลผู้รับ การแปลงเป็น 429 จึง
 *   เปิดเผยว่าอีเมลนั้นมีบัญชี (enumeration) — การจำกัดที่ผู้ใช้เห็นคือชั้น PWD_RESET
 *   ของแอปเท่านั้น
 * - audit AUTH_PASSWORD_RESET_REQUEST ผ่าน service-role RPC append_audit_event —
 *   context = {ip_hash} เท่านั้นตาม allowlist (0008:470) ไม่มีอีเมล/user id ·
 *   audit ก่อน recover (gate r1 F3 — ห้ามมี mutation ไร้ audit) · ล้ม 2 ครั้ง =
 *   503 ERR-SYS-002 ไม่เรียก recover
 * - PII: อีเมล/รหัสผ่าน/JWT ห้ามลง log/response — response มีแค่ข้อความคงที่
 */
import { getConfig } from "@/lib/config";
import { jsonError, jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  buildResetPasswordUrl,
  ipHashOf,
  PASSWORD_RESET_REQUEST_MESSAGE,
  parsePasswordResetRequest,
  requestPasswordReset,
} from "@/lib/auth/password-reset";

/** options ของ response — สะท้อน x-request-id (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GoTrue recover — ผลใด ๆ ไม่ถูกใช้ตัดสิน response (ดูหมายเหตุ anti-enumeration ด้านบน) */
async function recoverViaGoTrue(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  redirectTo: string,
): Promise<unknown> {
  try {
    return await fetch(
      `${supabaseUrl}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
      {
        method: "POST",
        headers: { apikey: anonKey, "content-type": "application/json" },
        body: JSON.stringify({ email, redirect_to: redirectTo }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    // เครือข่าย/timeout — กลืนไว้ (response คงที่เสมอ) — อีเมลอาจไม่ออกเป็นครั้งคราว
    return null;
  }
}

/** audit AUTH_PASSWORD_RESET_REQUEST — context {ip_hash} เท่านั้น (0008:470) */
async function auditRequestFailClosed(
  ipHash: string,
  requestId: string | null,
): Promise<{ ok: true } | { ok: false }> {
  try {
    const service = createSupabaseServiceRoleClient();
    const { error } = await service.rpc("append_audit_event", {
      p_action: "AUTH_PASSWORD_RESET_REQUEST",
      p_entity_type: "user",
      p_entity_id: null,
      p_before: null,
      p_after: null,
      p_context: { ip_hash: ipHash },
      p_actor_roles: null,
      p_ip_hash: null,
      p_user_agent: null,
      p_request_id: requestId,
    });
    return error === null ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function POST(request: Request): Promise<ReturnType<typeof jsonOk>> {
  const options = optionsOf(request);
  try {
    const bodyText = await request.text();
    let body: unknown = null;
    if (bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        body = null;
      }
    }
    const parsed = parsePasswordResetRequest(body);
    if (!parsed.ok) {
      return jsonError("ERR-VAL-001", options);
    }
    // PWD_RESET — คีย์รอง = อีเมล (ก่อน GoTrue ตามสัญญา lane) · เกิน = 429 + Retry-After
    enforceRateLimit(request, { group: "PWD_RESET", secondaryKey: parsed.email });

    const { supabaseUrl, supabaseAnonKey, publicBaseUrl } = getConfig();
    const result = await requestPasswordReset(
      {
        email: parsed.email,
        redirectTo: buildResetPasswordUrl(publicBaseUrl),
        ipHash: ipHashOf(clientIpFrom(request)),
        requestId: request.headers.get("x-request-id"),
      },
      {
        recover: (email, redirectTo) => recoverViaGoTrue(supabaseUrl, supabaseAnonKey, email, redirectTo),
        audit: auditRequestFailClosed,
      },
    );
    if (!result.ok) {
      return jsonError(result.errorCode, options);
    }
    return jsonOk({ message: PASSWORD_RESET_REQUEST_MESSAGE }, options);
  } catch (error) {
    return jsonErrorResponse(error, options);
  }
}

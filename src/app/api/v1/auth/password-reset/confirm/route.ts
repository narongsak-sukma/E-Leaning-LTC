/**
 * POST /api/v1/auth/password-reset/confirm — ตั้งรหัสผ่านใหม่ (AUTH-004 · Wave G P1 · D72)
 *
 * ทำงานกับ session recovery ที่หน้า /reset-password ตั้งไว้ (fragment → server action
 * establishRecoverySession → setSession ตรวจกับ GoTrue แล้วเขียนลง cookie):
 * - rate limit group PWD_RESET (คีย์ IP) ก่อนแตะ GoTrue ตามสัญญาร่วมของ lane
 * - body {password} ≥ 12 (GOTRUE_PASSWORD_MIN_LENGTH) — ไม่ผ่าน = 400 ERR-VAL-001
 *   ด้วยข้อความ policy เดียวกับหน้า register
 * - ลำดับคงที่ (ห้ามสลับ): PUT /auth/v1/user {password} → logout scope=global
 *   (เพิกถอนทุกเซสชันทันที) → ล้าง cookie → audit AUTH_PASSWORD_RESET_DONE → 200
 * - ไม่มี session = 401 ERR-AUTH-001 · GoTrue ปฏิเสธ token (400/401/403 ที่ PUT) =
 *   ลิงก์หมดอายุ/ใช้แล้ว = 400 ERR-AUTH-005 + ล้าง cookie ที่ตายแล้ว · 422
 *   weak_password = 400 ERR-VAL-001 ข้อความ policy · 429/5xx/network = 503
 *   ERR-SYS-002 (คง cookie ไว้ให้กดใหม่ — แบบเดียวกับ logout route)
 * - audit ผ่าน service-role RPC append_audit_event context {ip_hash} เท่านั้น
 *   (0008:471) · PII (รหัสผ่าน/JWT/อีเมล) ห้ามลง log/response
 */
import { NextResponse } from "next/server";

import { getConfig } from "@/lib/config";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";
import { jsonError, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClientBuffered } from "@/lib/supabase/ssr";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { isDefinitiveAuthError } from "@/lib/supabase/auth-errors";
import {
  classifyGoTruePutUserFailure,
  confirmPasswordReset,
  goTrueErrorCodeOf,
  ipHashOf,
  PASSWORD_RESET_CONFIRM_ERROR_CODES,
  PASSWORD_RESET_DONE_MESSAGE,
  PASSWORD_RESET_POLICY_MESSAGE,
  parsePasswordResetConfirm,
} from "@/lib/auth/password-reset";

/** options ของ response — สะท้อน x-request-id (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/**
 * PUT /auth/v1/user {password} ด้วย Bearer ของ session recovery — อ่าน status +
 * error_code เอง (SDK กลืนสถานะ — แบบเดียวกับ revoke ตรงของ logout route)
 */
async function updatePasswordViaGoTrue(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
  password: string,
): Promise<{ status: number; errorCode: string | null }> {
  let status = 0;
  let bodyText: string | null = null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    bodyText = await res.text();
  } catch {
    status = 0;
    bodyText = null;
  }
  return { status, errorCode: goTrueErrorCodeOf(status, bodyText) };
}

/** POST /auth/v1/logout?scope=global — เพิกถอนทุกเซสชันของ user ทันที */
async function logoutGlobalViaGoTrue(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
): Promise<"ok" | "system"> {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/logout?scope=global`, {
      method: "POST",
      headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? "ok" : "system";
  } catch {
    return "system";
  }
}

/** audit AUTH_PASSWORD_RESET_DONE — context {ip_hash} เท่านั้น (0008:471) */
async function auditDoneFailClosed(
  userId: string | null,
  ipHash: string,
  requestId: string | null,
): Promise<{ ok: true } | { ok: false }> {
  try {
    const service = createSupabaseServiceRoleClient();
    const { error } = await service.rpc("append_audit_event", {
      p_action: "AUTH_PASSWORD_RESET_DONE",
      p_entity_type: "user",
      p_entity_id: userId,
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

export async function POST(request: Request): Promise<NextResponse> {
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
    const parsed = parsePasswordResetConfirm(body);
    if (!parsed.ok) {
      return jsonError(
        new AppError("ERR-VAL-001", { message: PASSWORD_RESET_POLICY_MESSAGE }),
        options,
      );
    }
    // PWD_RESET — ไม่มีอีเมลใน confirm → คีย์ IP (secondary ว่างโดน IP cap ก่อนเสมอ)
    enforceRateLimit(request, { group: "PWD_RESET" });

    const { supabaseUrl, supabaseAnonKey } = getConfig();
    const { client, commit, clearAuthCookies, hasPendingAuthWrite } =
      await createSupabaseSsrClientBuffered();

    // session recovery จาก cookie — ไม่มี (หรือตายยืนยันแล้ว) = 401
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError !== null && isDefinitiveAuthError(sessionError)) {
      clearAuthCookies();
      commit();
      return jsonError("ERR-AUTH-001", options);
    }
    if (sessionData.session === null) {
      commit();
      return jsonError("ERR-AUTH-001", options);
    }
    const session = sessionData.session;
    const userId = typeof session.user?.id === "string" ? session.user.id : null;

    const result = await confirmPasswordReset(
      {
        accessToken: session.access_token,
        password: parsed.password,
        ipHash: ipHashOf(clientIpFrom(request)),
        requestId: request.headers.get("x-request-id"),
      },
      {
        updatePassword: async (accessToken, password) => {
          const { status, errorCode } = await updatePasswordViaGoTrue(
            supabaseUrl,
            supabaseAnonKey,
            accessToken,
            password,
          );
          if (status === 0) return "system";
          if (status >= 200 && status < 300) return "ok";
          return classifyGoTruePutUserFailure(status, errorCode);
        },
        logoutGlobal: (accessToken) =>
          logoutGlobalViaGoTrue(supabaseUrl, supabaseAnonKey, accessToken),
        audit: (ipHash, requestId) => auditDoneFailClosed(userId, ipHash, requestId),
        clearCookies: clearAuthCookies,
      },
    );

    if (result.ok) {
      commit();
      return jsonOk({ message: PASSWORD_RESET_DONE_MESSAGE }, options);
    }
    if (result.failure === "expired_link") {
      // token ถูก GoTrue ปฏิเสธชัด ๆ (400/401/403) = ตายยืนยันแล้ว — ล้าง cookie ที่เหลือ
      clearAuthCookies();
      commit();
    } else if (result.failure === "system") {
      if (hasPendingAuthWrite()) {
        // เก็บ rotation ที่ getSession ทำไว้ก่อน 503 — cookie คงไว้ให้กดใหม่ (logout route)
        commit();
      }
    } else {
      // weak_password — session ยังมีชีวิต เผยแพร่ rotation ถ้ามี
      commit();
    }
    const code = PASSWORD_RESET_CONFIRM_ERROR_CODES[result.failure];
    const message = result.failure === "weak_password" ? PASSWORD_RESET_POLICY_MESSAGE : undefined;
    return jsonError(message === undefined ? code : new AppError(code, { message }), options);
  } catch (error: unknown) {
    const appError = fromUnknown(error);
    return NextResponse.json(toErrorBody(appError), { status: appError.httpStatus ?? 500 });
  }
}

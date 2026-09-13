/**
 * POST /api/v1/auth/password-reset/confirm — ตั้งรหัสผ่านใหม่ (AUTH-004 · Wave G P1 · D72)
 *
 * ทำงานกับ session recovery ที่หน้า /reset-password ตั้งไว้ (fragment → server action
 * establishRecoverySession → setSession ตรวจกับ GoTrue แล้วเขียนลง cookie):
 * - rate limit group PWD_RESET (คีย์ IP + คีย์รอง mirror IP) ก่อนแตะ GoTrue ตาม
 *   สัญญาร่วมของ lane
 * - body {password} ≥ 12 (GOTRUE_PASSWORD_MIN_LENGTH) — ไม่ผ่าน = 400 ERR-VAL-001
 *   ด้วยข้อความ policy เดียวกับหน้า register
 * - **หลักฐาน recovery (gate r1 B1)**: access token ต้องมี amr method "otp"
 *   (ลิงก์ recovery ของ GoTrue v2.164 · probe จริง) — session จาก login ปกติ
 *   (method "password") ถูกปฏิเสธ 400 ERR-AUTH-005 โดยไม่ล้าง cookie
 * - ลำดับคงที่ (ห้ามสลับ): PUT /auth/v1/user {password} → logout scope=global
 *   (เพิกถอนทุกเซสชันทันที) → ล้าง cookie → audit AUTH_PASSWORD_RESET_DONE → 200
 * - ไม่มี session = 401 ERR-AUTH-001 · error ที่ไม่ยืนยันตาย (429/5xx/network ที่
 *   getSession) = 503 คง cookie (M2) · GoTrue ปฏิเสธ token (400/401/403 ที่ PUT) =
 *   ลิงก์หมดอายุ/ใช้แล้ว = 400 ERR-AUTH-005 + ล้าง cookie ที่ตายแล้ว · 422
 *   weak_password = 400 ERR-VAL-001 ข้อความ policy · 429/5xx/network ที่ PUT/logout
 *   = 503 ERR-SYS-002 (คง cookie ไว้ให้กดใหม่ — แบบเดียวกับ logout route) · audit
 *   ล้มหลัง mutation สำเร็จ = 503 โดยการล้าง cookie ถูก flush จริง (M3)
 * - audit ผ่าน service-role RPC append_audit_event · actor = claim sub ของ
 *   access token (M4 — ไม่ใช่ user object ใน cookie ที่ปลอมได้) ส่งเป็น
 *   context.user_id ให้ RPC ยกเป็น actor แล้ว strip (0032) · context ที่เก็บจริง
 *   เหลือ {ip_hash} ตาม allowlist 0008:471 (gate r2 — เดิมไม่ส่ง user_id ทำให้
 *   actor เป็น null) · PII (รหัสผ่าน/JWT/อีเมล) ห้ามลง log/response
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
import { amrMethodsFromAccessToken, subFromAccessToken } from "@/lib/auth/token-claims";

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

/**
 * audit AUTH_PASSWORD_RESET_DONE — gate r2: ส่ง `user_id` (claim sub ของ token
 * ที่ GoTrue ผ่านใน request เดียวกัน) ให้ RPC ยกเป็น actor แล้ว strip ออกก่อน
 * strict allowlist (0032 — กลไกเดียวกับ AUTH_PASSWORD_CHANGE) · context ที่
 * เก็บจริงเหลือ {ip_hash} ตาม allowlist 0008:471
 */
async function auditDoneFailClosed(
  userId: string,
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
      p_context: { user_id: userId, ip_hash: ipHash },
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
    // PWD_RESET — ไม่มีอีเมลใน confirm → คีย์รอง mirror IP (gate r1 M1: rule ของ
    // PWD_RESET มีช่องรอง — ไม่ใส่ = bucket `g:PWD_RESET:` เดียวรวมทุก IP ทั้งระบบ)
    enforceRateLimit(request, { group: "PWD_RESET", secondaryKey: clientIpFrom(request) });

    const { supabaseUrl, supabaseAnonKey } = getConfig();
    const { client, commit, clearAuthCookies, hasPendingAuthWrite } =
      await createSupabaseSsrClientBuffered();

    // session recovery จาก cookie — ไม่มี (หรือตายยืนยันแล้ว) = 401
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError !== null) {
      if (isDefinitiveAuthError(sessionError)) {
        clearAuthCookies();
        commit();
        return jsonError("ERR-AUTH-001", options);
      }
      // gate r1 M2: 429/5xx/network ไม่ใช่หลักฐานว่า session ตาย — ห้ามล้าง
      // credential ที่ยังมีชีวิต (แบบเดียวกับ logout-all): 503 คง cookie เก็บ
      // rotation ถ้ามี ให้กดใหม่ภายหลัง
      if (hasPendingAuthWrite()) {
        commit();
      }
      throw new AppError("ERR-SYS-002");
    }
    if (sessionData.session === null) {
      commit();
      return jsonError("ERR-AUTH-001", options);
    }
    const session = sessionData.session;
    // gate r1 B1: session ต้องเป็น "session recovery จากลิงก์อีเมล" จริง — auth-js
    // ไม่ re-validate token ที่ยังไม่หมดอายุ การผ่าน getSession จึงไม่ใช่หลักฐาน
    // พอ · อ่าน amr จากตัว access token เอง: ลิงก์ recovery ของ GoTrue v2.164 =
    // method "otp" (probe จริง 2026-09-14 · refresh คง method ไว้ — guard รอด
    // ผ่าน rotation ของ middleware) · login ด้วยรหัสผ่านปกติ = "password" ต้อง
    // ถูกปฏิเสธ (ไม่งั้นผู้ถือ session ปกติเปลี่ยนรหัสผ่านโดยไม่ต้องพิสูจน์อะไรเลย —
    // ข้าม re-auth ของ AUTH-005) · ยอมรับ "recovery" ด้วยกันเวอร์ชัน GoTrue อื่น
    const amrMethods = amrMethodsFromAccessToken(session.access_token);
    const isRecoverySession =
      amrMethods !== null && amrMethods.some((m) => m === "otp" || m === "recovery");
    if (!isRecoverySession) {
      // session มีชีวิตแต่ไม่ได้มาจากลิงก์รีเซ็ต — ตอบแบบ "ลิงก์ไม่ถูกต้อง" โดยไม่
      // ล้าง cookie (อย่าถือว่า session ตายแล้ว log out ผู้ใช้ปกติ) เผยแพร่
      // rotation ที่ getSession ทำไว้ (ถ้ามี) ก่อนตอบ
      commit();
      return jsonError("ERR-AUTH-005", options);
    }
    // gate r1 M4: actor ของ audit จาก claim sub ของ token ที่ GoTrue จะได้ตรวจ
    // ใน request เดียวกัน (PUT/logout ด้านล่าง) — user object ใน cookie เป็น JSON
    // ฝังตัวที่ปลอมได้ ใช้เป็นตัวตนใน audit ไม่ได้
    const userId = subFromAccessToken(session.access_token);
    if (userId === null) {
      if (hasPendingAuthWrite()) {
        commit();
      }
      throw new AppError("ERR-SYS-002");
    }

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
    } else if (result.failure === "audit_failed") {
      // gate r1 M3: PUT+logout สำเร็จแล้ว — การล้าง cookie ที่ clearCookies วางไว้
      // ต้องถูก flush จริงแม้ audit ล้ม (hasPendingAuthWrite ไม่นับ "การลบ") ไม่งั้น
      // recovery session ตายแล้วยังค้างในเครื่องผู้ใช้ — commit ก่อน 503 เสมอ
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

/**
 * POST /api/v1/me/password — เปลี่ยนรหัสผ่านของตนเอง (AUTH-005 · Wave G P1 · D72)
 *
 * - ต้อง login (session ผู้ใช้ — แบบเดียวกับ /api/v1/me/mfa/*)
 * - body {currentPassword, newPassword} — strict (คีย์แปลกปลอม = 400)
 *   · newPassword ≥12 (ข้อความ policy เดียวกับหน้า register) · ซ้ำกับปัจจุบัน = 400 ไทย
 *   · รหัสปัจจุบันผิด = 401 ตรงสัญญา D72 "รหัสผ่านปัจจุบันไม่ถูกต้อง" (นับเข้า rate
 *     limit — enforceRateLimit กลุ่ม AUTH นับก่อนพิสูจน์เสมอ)
 * - ลำดับภายใน lib: validate → re-auth (standalone signInWithPassword) → PUT /auth/v1/user
 *   {password} ด้วย session ผู้ใช้ → audit AUTH_PASSWORD_CHANGE (service-role RPC,
 *   context strict ['method','session_id']) → 200 — เซสชันปัจจุบันคงไว้ (ห้าม sign out)
 * - rate: AUTH group (secondary = claim sub จาก cookie — นับ ip + user แยกกัน
 *   D12-11 · นับก่อนแตะ GoTrue/SDK ใด ๆ ตาม MINOR-2: อ่าน cookie เอง ไม่ผ่าน
 *   getSession ที่อาจ refresh ผ่าน network · gate g-p1-r3 + r4 MINOR-2:
 *   middleware ก็ข้าม refresh ของ POST เส้นนี้ด้วย — นับ quota ก่อน network
 *   แรกของ request · token หมดจริง SDK refresh เองหลังนับ (พลาด = 401))
 */
import { NextResponse } from "next/server";

import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { buildPasswordChangeDeps, changePassword, PASSWORD_CHANGE_MESSAGES, PASSWORD_POLICY_MESSAGE } from "@/lib/auth/password-change";
import { requireUser } from "@/lib/auth/session";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { accessTokenFromAuthCookie, subFromAccessToken } from "@/lib/auth/token-claims";
import { getConfig } from "@/lib/config";
import { readJwtSessionClaim } from "@/lib/schemas/v1/exam";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { PasswordChangeBody, PasswordChangeView } from "./schema";

/** x-request-id → envelope options */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** body → parsed (parse ไม่ผ่าน = ERR-VAL-001 พร้อม field) — แบบเดียวกับ me/mfa/verify */
async function parsePasswordBody(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
  }
  const parsed = PasswordChangeBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    // รหัสใหม่สั้น (< 12) ต้องตอบด้วยข้อความนโยบายเดียวกับหน้า register (D72) —
    // นอกเหนือจากนั้นคงข้อความกลางของทะเบียน (ห้ามปล่อยข้อความดิบของ zod หลุดออกนอกเครื่อง)
    const policyIssue = parsed.error.issues.find(
      (issue) => issue.message === PASSWORD_POLICY_MESSAGE,
    );
    // exactOptionalPropertyTypes: ห้ามส่ง message: undefined แบบ explicit — spread
    // เฉพาะเมื่อมีข้อความ policy (ไม่มี = ใช้ข้อความกลางของทะเบียน)
    throw new AppError("ERR-VAL-001", {
      ...(policyIssue !== undefined ? { message: PASSWORD_POLICY_MESSAGE } : {}),
      details: { fields: fields.length > 0 ? fields : ["body"] },
    });
  }
  return parsed.data;
}

/** POST — เปลี่ยนรหัสผ่านของตัวเอง (owner-check โดย session เสมอ) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // นับ quota AUTH ก่อนพิสูจน์รหัสผ่านเสมอ (กรอกผิดก็นับ — D72) และ**ก่อนแตะ
    // GoTrue/SDK ด้วย** (gate r1 MINOR-2 + r2: getSession ของ auth-js เช็ค
    // expires_at และอาจยิง refresh ผ่าน network เมื่อใกล้หมดอายุ — ไม่ใช่การอ่าน
    // cookie เปล่า ๆ) → อ่านคีย์รองเองจาก cookie header ตรง ๆ (decode ในเครื่อง
    // ล้วน ไม่มี network · ปลอม sub ได้แค่แยก bucket ของตัวเอง ขณะ bucket IP
    // หลักนับทุกครั้งเสมอ) · ไม่มี/อ่านไม่ได้ = mirror IP (แบบแผน lead fix ของ
    // reset action)
    const { supabaseUrl } = getConfig();
    const previewToken = accessTokenFromAuthCookie(request.headers.get("cookie"), supabaseUrl);
    const previewSub = subFromAccessToken(previewToken ?? "");
    enforceRateLimit(request, {
      group: "AUTH",
      secondaryKey: previewSub ?? clientIpFrom(request),
    });
    const supabase = await createSupabaseSsrClient();
    const user = await requireUser();
    const body = await parsePasswordBody(request);
    // claim session_id ของ session ปัจจุบัน (audit) — fail-closed เมื่อไม่มี session จริง
    const sessionId = await readJwtSessionClaim(supabase);
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email ?? null;
    if (email === null || email.length === 0) {
      // session พังกลางทาง — ถือว่าไม่มี session (แนวเดียวกับ email actions.ts)
      throw new AppError("ERR-AUTH-001");
    }
    const result = await changePassword(
      {
        userId: user.userId,
        email,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        sessionId,
      },
      buildPasswordChangeDeps(supabase, options.requestId ?? null),
    );
    if (!result.ok) {
      throw new AppError(result.errorCode, { message: result.errorMessage });
    }
    const view = parseOutgoingView(
      PasswordChangeView,
      { changed: true, message: PASSWORD_CHANGE_MESSAGES.changed },
      "password_change_drift",
    );
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/**
 * POST /api/v1/me/mfa/enroll — เริ่มผูก TOTP (Wave F · D-f-1)
 *
 * - ต้อง login (401 ERR-AUTH-001) — reachable ที่ aal1 (บทบาทบังคับ MFA ต้องผูกได้)
 * - มี factor verified อยู่แล้ว → 400 ERR-VAL-001|factor_exists
 * - rate: MFA group (explicit override — /me/* ปกติเป็น READ)
 * - สำเร็จ → 200 {factorId, secret, otpauthUri} — secret ปรากฏครั้งเดียว (GoTrue ไม่คืนซ้ำ)
 */
import { NextResponse } from "next/server";

import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { firstVerifiedTotpFactor } from "@/lib/auth/mfa";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { MfaEnrollBody, MfaEnrollView } from "../schema";

/** x-request-id → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** POST — enroll TOTP factor ใหม่ (บัญชีละหนึ่ง factor ที่ใช้งาน — มีอยู่แล้ว = 400) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    const user = await requireUser();
    enforceRateLimit(request, { group: "MFA", secondaryKey: user.userId });
    const supabase = await createSupabaseSsrClient();
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_enroll_list_failed" } });
    }
    if (firstVerifiedTotpFactor(factorsData?.all ?? []) !== null) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["factor"], reason: "factor_exists" } });
    }

    // body optional — รับได้ทั้ง no-body และ {friendlyName} (strict)
    let raw: unknown = null;
    try {
      raw = await request.json();
    } catch {
      raw = null;
    }
    let friendlyName: string | undefined;
    if (raw !== null) {
      const parsed = MfaEnrollBody.safeParse(raw);
      if (!parsed.success) {
        throw new AppError("ERR-VAL-001", { details: { fields: ["friendlyName"] } });
      }
      friendlyName = parsed.data.friendlyName;
    }

    // enroll บน session จริง (GoTrue คืน secret/uri ครั้งเดียว)
    const enroll = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: friendlyName ?? "ltc-totp",
    });
    if (enroll.error !== null || typeof enroll.data?.id !== "string") {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_enroll_failed" } });
    }
    const secret = enroll.data.totp?.secret;
    const otpauthUri = enroll.data.totp?.uri;
    if (typeof secret !== "string" || typeof otpauthUri !== "string") {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_enroll_drift" } });
    }
    const view = parseOutgoingView(
      MfaEnrollView,
      { factorId: enroll.data.id, secret, otpauthUri },
      "mfa_enroll_drift",
    );
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}


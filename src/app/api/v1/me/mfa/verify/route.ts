/**
 * POST /api/v1/me/mfa/verify — ตรวจรหัส TOTP 6 หลัก (Wave F · D-f-1)
 *
 * - ต้อง login — reachable ที่ aal1 (เช่น ยืนยัน enroll ครั้งแรกผ่าน REST ก็ได้)
 * - body {code, factorId?} — ไม่ส่ง factorId = ใช้ factor TOTP verified ตัวเดียวของบัญชี
 *   (0 factor → 404 ERR-NF-001 · หลายตัว → 400 ERR-VAL-001|multiple_factors)
 * - รหัสผิด → 400 ERR-VAL-001|mfa_code_invalid · สำเร็จ → 200 {verified:true}
 * - GoTrue หมุน refresh token ตอน verify — SDK persist ลง cookie เองผ่าน ssr.ts
 * - rate: MFA group
 */
import { NextResponse } from "next/server";

import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { challengeAndVerifyTotp } from "@/lib/auth/mfa";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { MfaVerifyBody, MfaVerifyView } from "../schema";

/** x-request-id → envelope options */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** body → parsed (parse ไม่ผ่าน = ERR-VAL-001 พร้อม field) */
async function parseVerifyBody(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
  }
  const parsed = MfaVerifyBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** POST — ตรวจรหัส TOTP กับ factor verified (ของตัวเอง — owner-check โดย session เสมอ) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    const user = await requireUser();
    enforceRateLimit(request, { group: "MFA", secondaryKey: user.userId });
    const body = await parseVerifyBody(request);
    const supabase = await createSupabaseSsrClient();
    // เลือก factor — จาก body หรือ "ตัวเดียวที่ verified"
    let factorId = body.factorId;
    if (factorId === undefined) {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (factorsError !== null) {
        throw new AppError("ERR-SYS-002", { details: { reason: "mfa_verify_list_failed" } });
      }
      const verified = (factorsData?.all ?? []).filter(
        (f) => f.factor_type === "totp" && f.status === "verified",
      );
      if (verified.length === 0) {
        throw new AppError("ERR-NF-001");
      }
      if (verified.length > 1) {
        throw new AppError("ERR-VAL-001", {
          details: { fields: ["factorId"], reason: "multiple_factors" },
        });
      }
      factorId = verified[0]!.id;
    }
    const verifiedSession = await challengeAndVerifyTotp(supabase, factorId, () => body.code);
    if (verifiedSession === null) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["code"], reason: "mfa_code_invalid" } });
    }
    const view = parseOutgoingView(MfaVerifyView, { verified: true }, "mfa_verify_drift");
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

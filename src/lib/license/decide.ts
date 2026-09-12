/**
 * decide — ตัดสินคำขอผูกเลขที่ใบอนุญาต (Wave E Phase 5 · D-p5-3 · API-SPEC §3.8 แถว 229)
 *
 * เป็น validator + caller อย่างเดียว — ทุกเงื่อนไขธุรกิจอยู่ใน RPC atomic
 * `admin_decide_license_application(p_app_id, p_action, p_reason, p_request_id)` (0035 §5 ·
 * SECURITY DEFINER · aal2 ตรวจในตัว): TX เดียว = lock แถว pending → reject (reason บังคับ
 * ≥10) → approve (ตรวจเลขซ้ำคนอื่นก่อน → INSERT lawyer_licenses verified + มอบ role lawyer
 * idempotent + audit LICENSE_VERIFY/ROLE_GRANT + event license.application.approved|rejected)
 *
 * error ป้าย "(ERR-XXX-NNN|tag)" → AppError ตามทะเบียน · เคสพิเศษ `license_no_conflict`
 * = ERR-VAL-001 + details.reason "license_no_conflict" (route แปลงเป็น 409 พร้อมข้อความไทย
 * ชี้ชัด constraint ตาม D-p5-3/§6) · ไม่มีป้าย = ERR-SYS-002 opaque (SDS §6.1)
 */
import "server-only";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import { AppError } from "@/lib/errors";
import {
  LicenseDecisionResult,
  type LicenseDecisionResultParsed,
} from "@/lib/schemas/license";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** ผลที่ RPC คืน (jsonb — PostgREST อาจ wrap scalar เป็น array หลักเดียว · r8-N2) */
interface DecisionRaw {
  readonly applicationId: unknown;
  readonly result: unknown;
  readonly resultingLicenseId: unknown;
  readonly roleGranted: unknown;
}

export interface DecideLicenseInput {
  readonly appId: string;
  readonly action: "approve" | "reject";
  /** reject = ข้อความที่ trim แล้ว ≥10 อักขระ (ตรวจที่ BFF ก่อน) · approve = null */
  readonly reason: string | null;
  /** x-request-id สะท้อนเข้า audit LICENSE_VERIFY/ROLE_GRANT (SDS §5.4) */
  readonly requestId: string | null;
}

/** error ของ RPC ตัดสิน → AppError — มีป้ายในทะเบียน = map ตรง · ไม่มีป้าย = opaque 503 */
function mapDecideRpcError(error: RpcErrorLike): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: AppError["details"] = {};
    if (parsed.reason !== null) {
      details["reason"] = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: "license_decide_failed" } });
}

/**
 * ตัดสินคำขอ (approve|reject) — สำเร็จคืนผลตามสัญญา RPC (applicationId/result/
 * resultingLicenseId/roleGranted) · โยน AppError ตามป้าย (ตาราง 0035 §5):
 * login_required → 401 · mfa_required → 403 ERR-AUTH-004 · license_forbidden → 403 ·
 * action_value/reason_required/reason_length → 400 · application_not_found → 404 ·
 * license_no_conflict → 400+reason (route เปลี่ยน 409) · อื่น ๆ = 503 opaque
 */
export async function decideLicenseApplication(
  input: DecideLicenseInput,
): Promise<LicenseDecisionResultParsed> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("admin_decide_license_application", {
    p_app_id: input.appId,
    p_action: p_actionOf(input.action),
    p_reason: input.reason,
    p_request_id: input.requestId,
  });
  if (rpc.error !== null) {
    throw mapDecideRpcError(rpc.error);
  }
  const raw = unwrapRpcRow(rpc.data);
  const parsed = LicenseDecisionResult.safeParse({
    applicationId: raw.applicationId,
    result: raw.result,
    resultingLicenseId: raw.resultingLicenseId,
    roleGranted: raw.roleGranted,
  });
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "license_decision_result_drift" } });
  }
  return parsed.data;
}

/** action → p_action (literal "approve"/"reject" — คง type ให้ตรงสัญญา RPC) */
function p_actionOf(action: "approve" | "reject"): string {
  return action;
}

function unwrapRpcRow(data: unknown): DecisionRaw {
  const rawRow: unknown = Array.isArray(data) && data.length === 1 ? data[0] : data;
  const record = rawRow !== null && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};
  return {
    applicationId: record["applicationId"] ?? null,
    result: record["result"] ?? null,
    resultingLicenseId: record["resultingLicenseId"] ?? null,
    roleGranted: record["roleGranted"] ?? null,
  };
}

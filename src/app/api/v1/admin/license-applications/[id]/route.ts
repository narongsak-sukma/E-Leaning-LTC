/**
 * /api/v1/admin/license-applications/[id] — PATCH ตัดสินคำขอ (Wave E Phase 5 · D-p5-3 ·
 * API-SPEC §3.8 แถว 229)
 *
 * PATCH — { action: "approve" | "reject", reason? } (strict · reason ≤500 ที่ schema)
 * - requirePermission("license:verify") — staff:registrar / super_admin (aal2 ตรวจซ้ำใน RPC)
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method)
 * - :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB
 * - reject: reason บังคับ (trim ≥10 — แบบแผน revoke) → 400 ERR-VAL-001 ก่อน RPC
 *   approve: reason เลือกได้ (trim แล้วส่ง null เมื่อว่าง)
 * - เรียก RPC atomic admin_decide_license_application ผ่าน lib decide (TX เดียว:
 *   lock แถว pending → ใบ verified + role lawyer + audit + event)
 * - error ป้าย "(ERR-XXX-NNN|tag)" → AppError ตามทะเบียน · เคส `license_no_conflict`
 *   = **409** พร้อมข้อความไทยชี้ชัด constraint uq_lawyer_licenses_license_no_active_license
 *   ให้ registrar ตัดสินเอง (D-p5-3/§6 — status 409 ตาม spec นอกทะเบียน → envelope
 *   ประกอบเองด้วย toErrorBody คงรูป §1.3) · ไม่มีป้าย = 503 opaque (SDS §6.1)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { toErrorBody, AppError } from "@/lib/errors";
import { LicenseDecisionBody, type LicenseDecisionBodyParsed } from "@/lib/schemas/license";
import { decideLicenseApplication } from "@/lib/license/decide";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** ข้อความไทยของ 409 — เอ่ยชื่อ constraint ให้ registrar อ่านได้ (D-p5-3 + plan §6) */
const LICENSE_NO_CONFLICT_MESSAGE =
  "เลขที่ใบอนุญาตนี้ถูกผูกกับบัญชีอื่นอยู่ (ข้อจำกัด uq_lawyer_licenses_license_no_active_license) — กรุณาตรวจสอบข้อมูลจริงก่อนตัดสิน";

function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** error envelope พร้อม status เฉพาะ (409 — status ตาม spec นอกทะเบียนของ code) */
function jsonErrorWithStatus(status: number, error: AppError, options: JsonResponseOptions): NextResponse {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (options.requestId !== undefined) {
    headers["x-request-id"] = options.requestId;
  }
  return new NextResponse(JSON.stringify(toErrorBody(error, options.requestId)), {
    status,
    headers,
  });
}

/** แยกเคส conflict ที่ lib โยน ERR-VAL-001 + details.reason กำกับ */
function isReasonError(error: unknown, reason: string): error is AppError {
  return error instanceof AppError && error.details?.["reason"] === reason;
}

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseDecisionBody(request: Request): Promise<LicenseDecisionBodyParsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = LicenseDecisionBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** PATCH — ตัดสินคำขอ (200) */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — license:verify (staff:registrar / super_admin)
    const { userId } = await requirePermission("license:verify");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) :id ผิดรูป uuid → 400 ก่อนแตะ DB
    const appId = (await context.params).id;
    if (!z.uuid().safeParse(appId).success) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["id"] } });
    }
    // 4) body strict — ผิดรูป → 400 ERR-VAL-001
    const body = await parseDecisionBody(request);
    // 5) reject: reason บังคับ (trim ≥10) ตรวจที่ประตู BFF ก่อน RPC (D-p5-3)
    let reason: string | null = null;
    if (body.action === "reject") {
      const trimmed = (body.reason ?? "").trim();
      if (trimmed.length < 10) {
        throw new AppError("ERR-VAL-001", { details: { fields: ["reason"] } });
      }
      reason = trimmed;
    } else if (body.reason !== undefined) {
      const trimmed = body.reason.trim();
      reason = trimmed.length > 0 ? trimmed : null;
    }
    // 6) RPC atomic ผ่าน lib จุดเดียว (validate+lock+ใบ+role+audit+event ใน TX เดียว)
    const result = await decideLicenseApplication({
      appId,
      action: body.action,
      reason,
      requestId: options.requestId ?? null,
    });
    return jsonOk(result, options);
  } catch (error: unknown) {
    // เลขซ้ำคนอื่น → 409 ชี้ชัด constraint (spec แถว 229) — envelope คงรูป §1.3
    if (isReasonError(error, "license_no_conflict")) {
      return jsonErrorWithStatus(
        409,
        new AppError("ERR-VAL-001", { message: LICENSE_NO_CONFLICT_MESSAGE, details: { reason: "license_no_conflict" } }),
        options,
      );
    }
    return jsonErrorResponse(error, options);
  }
}

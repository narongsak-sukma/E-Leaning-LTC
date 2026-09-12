/**
 * POST /api/v1/profile/delete — ขอลบบัญชี (SEC-012 soft-delete · D-p5-8 · #90)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (ข้อมูลของตัวเอง)
 * - rate = READ (§5 — /profile/* ทุก method 120/min ต่อ user_id + ip)
 * - ไม่มี body ตามสัญญา (ไม่ parse — สัญญาไม่มีพารามิเตอร์)
 * - ทางเข้า lib/pdpa/deletion.requestAccountDeletion — RPC
 *   `my_request_account_deletion` ด้วย user JWT + แทรกอีเมลธุรกรรม
 *   `account.delete.confirm` (token อยู่ในอีเมลเท่านั้น — ห้าม log / ห้าม
 *   ใส่ response — D24 · response = {requestId, expiresAt} เท่านั้น)
 * - map ตาม spec §3.2: SoD = 403 (ERR-RBAC-001 จากป้าย account_delete_sod) ·
 *   มีคำขอค้าง = 409 (ป้าย delete_pending — override สถานะเฉพาะเหตุผลนี้) ·
 *   ลบไปแล้ว = 400 ERR-VAL-001 (already_deleted) · ไม่มีป้าย → 503 opaque
 */
import { NextResponse } from "next/server";

import {
  jsonErrorResponse,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError, toErrorBody } from "@/lib/errors";
import { requireUser } from "@/lib/auth/session";
import { requestAccountDeletion } from "@/lib/pdpa/deletion";
import { enforceRateLimit } from "@/lib/rate-limit";
import { DeleteRequestView } from "./schema";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/**
 * สถานะ HTTP ทับ default ของทะเบียนตามเหตุผลเจาะจงของป้าย RPC (spec §3.2):
 * delete_pending → 409 (มีคำขอลบค้างรอยืนยัน)
 */
function statusOverrideOf(error: unknown): number | null {
  if (!(error instanceof AppError)) {
    return null;
  }
  const reason = error.details?.["reason"];
  return reason === "delete_pending" ? 409 : null;
}

/** ตอบ error envelope ของทะเบียนแต่บังคับสถานะเอง (409 — สัญญา spec แถว delete) */
function jsonErrorWithStatus(
  error: AppError,
  status: number,
  options: JsonResponseOptions,
): NextResponse {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (options.requestId !== undefined) {
    headers["x-request-id"] = options.requestId;
  }
  return new NextResponse(JSON.stringify(toErrorBody(error, options.requestId)), {
    status,
    headers,
  });
}

/** POST — สร้างคำขอลบ + อีเมลยืนยัน → 202 {requestId, expiresAt} (ไม่มี token — D24) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session → 401 · 2) rate READ (§5 /profile/*)
    const user = await requireUser();
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 2) ทางเข้า lib จุดเดียว — RPC + อีเมลธุรกรรม (token ไม่ออกจาก lib — D24)
    const outcome = await requestAccountDeletion(options.requestId ?? null);
    // 3) ขาออก strict — {requestId, expiresAt} · drift → 503 fail-closed
    const view = parseOutgoingView(DeleteRequestView, outcome, "delete_request_view_drift");
    return new NextResponse(JSON.stringify({ data: view }), {
      status: 202,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(options.requestId !== undefined ? { "x-request-id": options.requestId } : {}),
      },
    });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      const override = statusOverrideOf(err);
      if (override !== null) {
        return jsonErrorWithStatus(err, override, options);
      }
    }
    return jsonErrorResponse(err, options);
  }
}

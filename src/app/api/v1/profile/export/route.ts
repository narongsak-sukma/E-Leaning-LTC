/**
 * GET /api/v1/profile/export — ขอส่งออกข้อมูลส่วนบุคคล (IDENT-008 · D-p5-7 · #90)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (ข้อมูลของตัวเอง —
 *   aal1 ใช้ได้ แบบเดียวกับ consents)
 * - rate = EXPORT (§5 — /profile/export 10/ชม. ต่อ user_id + ip · rule มีอยู่แล้ว
 *   rate-limit.ts:150) — ยืนยันกลุ่มชัดเจน
 * - query ต้องว่าง (key ใด ๆ → 400 ERR-VAL-001 — แบบ /profile/consents)
 * - RPC `my_request_data_export(p_request_id)` ด้วย user JWT ผ่าน PostgREST เท่านั้น
 *   (RPC ตรวจ pending/cooldown เองใน DB) → ตอบ **202 {jobId, status}** ทันที —
 *   ไฟล์ไม่ได้ถูกสร้างใน request; worker /api/internal/jobs/pdpa-export รับช่วงต่อ
 * - map สถานะตาม spec §3.2: มี job pending อยู่ = **409** · cooldown 24 ชม. = **429**
 *   (override สถานะทับ default ของทะเบียนตามเหตุผลจากป้าย RPC เท่านั้น)
 * - RPC โยน '(ERR-XXX-NNN|tag)' → map ตามทะเบียน · ไม่มีป้าย → 503 opaque
 */
import { NextResponse } from "next/server";

import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import {
  jsonErrorResponse,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError, toErrorBody } from "@/lib/errors";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { ExportJobView } from "./schema";

/** reason กลางเมื่อ RPC ล้มแบบไม่มีป้าย */
const EXPORT_FALLBACK = "export_request_failed";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** query ขาเข้า = ต้องว่าง (key ใด ๆ → 400 ERR-VAL-001 — แบบ /profile/consents) */
function parseEmptyQuery(searchParams: URLSearchParams): void {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  if (Object.keys(raw).length > 0) {
    throw new AppError("ERR-VAL-001", {
      details: { fields: Object.keys(raw) },
    });
  }
}

/** map error ของ RPC → AppError — มีป้าย = map ตรง · ไม่มีป้าย = ERR-SYS-002 opaque */
function mapRpcError(error: RpcErrorLike, fallbackReason: string): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: fallbackReason } });
}

/**
 * สถานะ HTTP ทับ default ของทะเบียนตามเหตุผลเจาะจงของป้าย RPC (spec §3.2):
 * export_pending → 409 (มี job ค้าง) · export_cooldown → 429 (24 ชม. cooldown)
 */
function statusOverrideOf(error: unknown): number | null {
  if (!(error instanceof AppError)) {
    return null;
  }
  const reason = error.details?.["reason"];
  if (reason === "export_pending") {
    return 409;
  }
  if (reason === "export_cooldown") {
    return 429;
  }
  return null;
}

/** ตอบ error envelope ของทะเบียนแต่บังคับสถานะเอง (409/429 — สัญญา spec แถว export) */
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

/** GET — สร้าง job ส่งออก (worker รันต่อ) → 202 {jobId, status} */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session → 401 · 2) rate EXPORT (10/ชม.)
    const user = await requireUser();
    enforceRateLimit(request, { group: "EXPORT", secondaryKey: user.userId });
    // 3) query ต้องว่าง — key ใด ๆ → 400
    parseEmptyQuery(new URL(request.url).searchParams);
    // 4) RPC ด้วย user JWT — RPC ตรวจ pending/cooldown เองใน DB
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("my_request_data_export", {
      p_request_id: options.requestId ?? null,
    });
    if (error !== null) {
      throw mapRpcError(error as RpcErrorLike, EXPORT_FALLBACK);
    }
    // 5) r8-N2: PostgREST อาจห่อ jsonb เป็น array หลักเดียว — คลี่ก่อนตรวจ strict
    const rawRow: unknown = Array.isArray(data) && data.length === 1 ? data[0] : data;
    if (typeof rawRow !== "object" || rawRow === null || Array.isArray(rawRow)) {
      throw new AppError("ERR-SYS-002", { details: { reason: EXPORT_FALLBACK } });
    }
    // 6) ขาออก strict — {jobId, status} · drift → 503 fail-closed
    const view = parseOutgoingView(ExportJobView, rawRow, "export_job_view_drift");
    return new NextResponse(JSON.stringify({ data: view }), {
      status: 202,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(options.requestId !== undefined ? { "x-request-id": options.requestId } : {}),
      },
    });
  } catch (err: unknown) {
    // 409/429 เฉพาะเหตุผลจากป้าย RPC — สัญญาสถานะของ spec §3.2 แถว export
    if (err instanceof AppError) {
      const override = statusOverrideOf(err);
      if (override !== null) {
        return jsonErrorWithStatus(err, override, options);
      }
    }
    return jsonErrorResponse(err, options);
  }
}

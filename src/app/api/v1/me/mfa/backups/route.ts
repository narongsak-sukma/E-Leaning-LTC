/**
 * GET /api/v1/me/mfa/backups — สถานะชุดโค้ดสำรอง (Wave F · D-f-1)
 *
 * - ต้อง login · เฉพาะ GET (จุดอื่นของโค้ด/สร้างชุดใหม่ใช้ POST /backups/regenerate)
 * - RPC mfa_backup_codes_status — metadata ล้วน {generated, unused, total, lastGeneratedAt}
 *   ไม่มีโค้ดหรือ hash ปรากฏทาง REST เด็ดขาด
 * - rate: MFA group
 */
import { NextResponse } from "next/server";

import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { BackupStatusView } from "../schema";

/** x-request-id → envelope options */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** query strict — พารามิเตอร์ใด ๆ = ERR-VAL-001 */
function parseEmptyQuery(searchParams: URLSearchParams): void {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  if (Object.keys(raw).length > 0) {
    throw new AppError("ERR-VAL-001", { details: { fields: Object.keys(raw) } });
  }
}

/** GET — metadata ชุดโค้ดสำรองของตัวเอง (owner-check โดย RPC) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    const user = await requireUser();
    enforceRateLimit(request, { group: "MFA", secondaryKey: user.userId });
    parseEmptyQuery(new URL(request.url).searchParams);
    const supabase = await createSupabaseSsrClient();
    const rpc = await supabase.rpc("mfa_backup_codes_status");
    if (rpc.error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_backups_status_failed" } });
    }
    // PostgREST อาจห่อ scalar jsonb เป็น array 1 ชั้น — แกะก่อนตรวจ
    const value: unknown =
      Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
    const view = parseOutgoingView(BackupStatusView, value, "mfa_backups_status_drift");
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/**
 * GET /api/v1/me/attempts — ประวัติการสอบของตัวเอง (API-SPEC 1.0.3 §3.5)
 *
 * - ต้อง login + attempt:view (citizen/lawyer — "attempt:view (ตัวเอง)" RBAC-DESIGN §2.3 L71);
 *   ขอบเขตเจ้าของบังคับซ้ำ .eq("user_id", userId) + RLS attempts_owner_read (0010 L755)
 * - envelope §1.2 { data, page } — cursor signed (lib/api/pagination) · query ตรง PageQuery
 *   (default 20 max 100) · เรียง (started_at, id) มาก→น้อย (แบบเดียวกับ /me/enrollments)
 * - rate = READ (§5 — /me* → READ)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonPageOk, type JsonResponseOptions } from "@/lib/api/response";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import { parsePageQuery } from "@/lib/schemas/v1/common";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { toMyAttemptResource, type AttemptHistoryRow } from "@/lib/schemas/v1/exam";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — { data: MyAttempt[], page } ตาม §1.2 · เรียง (started_at, id) มาก→น้อย */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session + permission (ไม่ login → 401 AUTH-001 · ไม่มี attempt:view → 403 RBAC-001)
    const { userId } = await requirePermission("attempt:view");
    // 2) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: userId });
    // 3) query กลาง (limit default 20 max 100 — strict)
    const { limit, cursor } = parsePageQuery(new URL(request.url).searchParams);
    const supabase = await createSupabaseSsrClient();
    let query = supabase
      .from("assessment_attempts")
      .select(
        "id, assessment_id, attempt_no, status, started_at, expires_at, submitted_at, "
        + "score_pct, passed, question_count, correct_count",
      )
      // ขอบเขตเจ้าของบังคับซ้ำที่ handler + RLS attempts_owner_read (0010 L755)
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor !== undefined) {
      const payload = decodeCursor(cursor); // ผิดรูป/ถูกแก้ → ERR-VAL-001 (cursor signed)
      if (ISO_RE.test(payload.sortKey) === false) {
        throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "bad_sort_key" } });
      }
      // desc: หน้าถัดไป = (started_at < ts) OR (started_at = ts AND id < lastId)
      query = query.or(
        `started_at.lt.${payload.sortKey},and(started_at.eq.${payload.sortKey},id.lt.${payload.id})`,
      );
    }
    const { data, error } = await query;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempts_read_failed" } });
    }
    const rows = (data ?? []) as unknown as AttemptHistoryRow[];
    const page = buildPage({
      rows: rows.map(toMyAttemptResource),
      limit,
      sortKeyOf: (row) => row.startedAt,
      idOf: (row) => row.id,
    });
    return jsonPageOk(page, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

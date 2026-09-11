/**
 * GET /api/v1/admin/exams/statistics — สถิติผลสอบต่อชุดข้อสอบ
 * (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 229)
 *
 * - requirePermission("report:view") + assertRoleScope — staff:exam / staff:viewer /
 *   super_admin (sr โดน 403 ที่ BFF — D12-23)
 * - ข้อมูล = v_assessment_statistics (attempt_total/attempt_passed/pass_rate_pct) +
 *   avg score_pct ของ attempt ที่ submitted (PostgREST 12 aggregate ฝั่ง DB — ไม่เฉลี่ยใน JS)
 * - อ่านผ่าน user-JWT client เท่านั้น (view revoke จาก service_role — 0009:239-255)
 * - rate STAFF_WRITE (§5) — user_id + ip
 * - query: limit (default 100 cap 500) — strict · response: { data } + x-ltc-truncated
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { assertRoleScope, STATISTICS_ROLE_SCOPE } from "@/lib/reports/access";
import { getExamStatistics } from "@/lib/reports/monitoring";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  AssessmentReportQuery,
  ExamStatisticsResource,
  parseReportQuery,
} from "@/lib/schemas/v1/report";

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — สถิติผลสอบต่อชุดข้อสอบ (200 · cap pagination + x-ltc-truncated) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    const { userId, roles } = await requirePermission("report:view");
    assertRoleScope(roles, STATISTICS_ROLE_SCOPE, "report:view");
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    const query = parseReportQuery(AssessmentReportQuery, new URL(request.url).searchParams);
    const read = await getExamStatistics({ limit: query.limit });
    const headers =
      read.truncated === true
        ? { "x-ltc-truncated": "true" }
        : undefined;
    // r6-L1: ขาออกตรวจ strict ทุกแถว — drift แถวเดียว = 503 ไม่ strip เงียบ
    return jsonOk(
      read.rows.map((row) =>
        parseOutgoingView(ExamStatisticsResource, row, "exam_statistics_drift"),
      ),
      headers === undefined ? options : { ...options, headers },
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

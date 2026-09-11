/**
 * GET /api/v1/admin/reports/assessments — รายงานสถิติผลสอบ
 * (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 219)
 *
 * - requirePermission("report:view") + assertRoleScope — staff:exam / staff:viewer /
 *   super_admin (D12-23: se ได้เฉพาะ export ของ assessments · sv/sa)
 * - อ่าน v_assessment_statistics ผ่าน **user-JWT client** (views.ts)
 * - rate STAFF_WRITE (§5) — user_id + ip
 * - query: AssessmentReportQuery (limit เท่านั้น — view ไม่มี course_id/คอลัมน์เวลา)
 * - response: { data: AssessmentStatistics[] } + x-ltc-truncated: true เมื่อโดน cap
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { assertRoleScope, REPORT_ROLE_SCOPES } from "@/lib/reports/access";
import { listAssessmentStatistics } from "@/lib/reports/views";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  AssessmentReportQuery,
  AssessmentStatisticsResource,
  parseReportQuery,
} from "@/lib/schemas/v1/report";

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — รายงานสถิติผลสอบ (200 · cap pagination + x-ltc-truncated) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    const { userId, roles } = await requirePermission("report:view");
    assertRoleScope(roles, REPORT_ROLE_SCOPES.assessments, "report:view");
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    const query = parseReportQuery(AssessmentReportQuery, new URL(request.url).searchParams);
    const read = await listAssessmentStatistics({ limit: query.limit });
    const headers =
      read.truncated === true
        ? { "x-ltc-truncated": "true" }
        : undefined;
    return jsonOk(
      read.rows.map((row) =>
        parseOutgoingView(AssessmentStatisticsResource, row, "assessment_statistics_drift"),
      ),
      headers === undefined ? options : { ...options, headers },
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

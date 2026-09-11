/**
 * GET /api/v1/admin/reports/enrollments — รายงานความคืบหน้าการเรียน
 * (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 218)
 *
 * - requirePermission("report:view") + ชั้นบทบาท assertRoleScope — staff:viewer /
 *   super_admin เท่านั้น (staff:exam/registrar โดน 403 ที่ BFF แม้ RLS จะปล่อยเกิน)
 * - อ่าน v_enrollment_progress ผ่าน **user-JWT client** (views.ts) — view revoke จาก
 *   service_role แล้ว grant เฉพาะ authenticated (0009:239-255)
 * - rate STAFF_WRITE (§5 — STAFF_READ ไม่มีในทะเบียนกลุ่มของ repo จึงใช้กลุ่มที่
 *   endpoint admin GET ใช้ตามแบบแผน) — user_id + ip
 * - query: EnrollmentReportQuery (limit default 100 cap 500 · courseId optional) — strict
 * - response: { data: EnrollmentProgress[] } + header x-ltc-truncated: true เมื่อโดน cap
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { assertRoleScope, REPORT_ROLE_SCOPES } from "@/lib/reports/access";
import { listEnrollmentProgress } from "@/lib/reports/views";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  EnrollmentProgressResource,
  EnrollmentReportQuery,
  parseReportQuery,
} from "@/lib/schemas/v1/report";

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — รายงานความคืบหน้าการเรียน (200 · cap pagination + x-ltc-truncated) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC 2 ชั้น — permission กลาง + กรอบบทบาทต่อ endpoint (fail-closed ที่ BFF)
    const { userId, roles } = await requirePermission("report:view");
    assertRoleScope(roles, REPORT_ROLE_SCOPES.enrollments, "report:view");
    // 2) rate STAFF_WRITE — หลัง RBAC (user_id + ip)
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict — ผิดรูป/คีย์แปลกปลอม → ERR-VAL-001
    const query = parseReportQuery(
      EnrollmentReportQuery,
      new URL(request.url).searchParams,
    );
    // 4) อ่านผ่าน user-JWT client (cap limit+1 → truncated)
    const read = await listEnrollmentProgress({ limit: query.limit, courseId: query.courseId });
    // 5) r6-L1: ขาออกตรวจ strict ทุกแถวก่อนตอบ — drift แถวเดียว = 503 ไม่ strip เงียบ
    const headers =
      read.truncated === true
        ? { "x-ltc-truncated": "true" }
        : undefined;
    return jsonOk(
      read.rows.map((row) =>
        parseOutgoingView(EnrollmentProgressResource, row, "enrollment_progress_drift"),
      ),
      headers === undefined ? options : { ...options, headers },
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

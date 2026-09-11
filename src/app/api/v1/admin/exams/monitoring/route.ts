/**
 * GET /api/v1/admin/exams/monitoring — มอนิเตอร์คิวสอบที่ยังไม่ส่ง
 * (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 228)
 *
 * - requirePermission("attempt:view") + assertRoleScope — staff:exam / super_admin
 *   (sv/sr โดน 403 ที่ BFF — มอนิเตอร์คิวสอบเป็นของ staff:exam)
 * - คิว = assessment_attempts status='in_progress' (ยังไม่ submit) · กลุ่มย่อย "เกินเวลา"
 *   = expires_at < ตอนนี้ (cron 0020 close_expired_attempts ปิดให้เองทุก 1 นาที)
 * - นับแบบ SQL aggregate ฝั่ง DB (PostgREST 12: id.count() + group by assessment_id) —
 *   ไม่นับใน JS · ตอบเป็นสถิติรวมต่อ assessment/course — ห้ามแสดง user_id รายคน
 * - rate STAFF_WRITE (§5) — user_id + ip
 * - response: { data: ExamMonitoring } — generatedAt + summary + byAssessment + byCourse
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { assertRoleScope, MONITORING_ROLE_SCOPE } from "@/lib/reports/access";
import { getExamMonitoring } from "@/lib/reports/monitoring";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { ExamMonitoringResource } from "@/lib/schemas/v1/report";

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}
/** GET — มอนิเตอร์คิวสอบ (200 · สถิติรวม ไม่มี user_id รายคน) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    const { userId, roles } = await requirePermission("attempt:view");
    assertRoleScope(roles, MONITORING_ROLE_SCOPE, "attempt:view");
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    const monitoring = await getExamMonitoring();
    // r6-L1: ขาออกตรวจ strict ก่อนตอบ — drift = 503 ไม่ strip เงียบ
    return jsonOk(parseOutgoingView(ExamMonitoringResource, monitoring, "exam_monitoring_drift"), options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

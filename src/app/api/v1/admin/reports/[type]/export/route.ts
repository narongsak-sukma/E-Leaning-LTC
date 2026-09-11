/**
 * GET /api/v1/admin/reports/{type}/export — ส่งออกรายงาน CSV/JSON
 * (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 221 · D12-23)
 *
 * - requirePermission("report:export") + assertRoleScope ต่อประเภท:
 *   enrollments → sv/sa · assessments → se/sv/sa · credits → sr/sv/sa —
 *   บทบาทอื่นโดน 403 ที่ BFF แม้ RLS ปล่อยเกิน (BFF เข้มกว่า RLS ได้ กลับกันไม่ได้)
 * - rate group EXPORT (10 ครั้ง/ชม. ต่อ user_id+ip — ROUTE_RULES จับ path นี้เป็น EXPORT อยู่แล้ว)
 * - type นอก {enrollments,assessments,credits} → ERR-NF-001 (404)
 * - query: format=csv|json (default csv) + ตัวกรองต่อ type — strict · ผิดรูป → ERR-VAL-001
 * - เขียน report_exports ผ่าน service client (fail-closed — เขียนไม่ได้ = 503 ไม่ส่งข้อมูลออก)
 *   + audit ADMIN_EXPORT best-effort (ADMIN_EXPORT ยังไม่อยู่ใน allowlist ของ DB — ต้องเปิด DCR)
 * - 200 ตรงเป็นไฟล์: content-type ตาม format · content-disposition: attachment ·
 *   x-ltc-truncated: true เมื่อโดน cap 10,000 แถว
 */
import { NextResponse } from "next/server";
import { jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { assertRoleScope, REPORT_ROLE_SCOPES, type ReportType } from "@/lib/reports/access";
import { parseExportQuery, parseReportTypeParam, runExport } from "@/lib/reports/export";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — ส่งออกไฟล์รายงาน (200 เป็นไฟล์ CSV/JSON ตรง ๆ — ไม่ใช่ envelope {data}) */
export async function GET(
  request: Request,
  context: { params: Promise<{ type: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC 2 ชั้น — permission กลาง + กรอบบทบาทต่อประเภทรายงาน (D12-23)
    const { userId, roles } = await requirePermission("report:export");
    // 2) rate group EXPORT — หลัง RBAC (10/ชม. ต่อ user_id+ip)
    enforceRateLimit(request, { group: "EXPORT", secondaryKey: userId });
    // 3) type → 404 ทันทีเมื่อไม่รู้จัก (ก่อนใช้เป็นดัชนี schema/ขอบเขตบทบาท)
    const type: ReportType = parseReportTypeParam((await context.params).type);
    assertRoleScope(roles, REPORT_ROLE_SCOPES[type], "report:export");
    // 4) query strict ต่อ type — format + ตัวกรอง (ERR-VAL-001 เมื่อผิดรูป)
    const query = parseExportQuery(type, new URL(request.url).searchParams);
    // 5) ทำ export ครบวงจรใน lib (อ่าน view → payload → report_exports → audit)
    const result = await runExport({
      type,
      format: query.format,
      courseId: query.courseId,
      from: query.from,
      to: query.to,
      requestedBy: userId,
      requestId: options.requestId ?? null,
    });
    // 6) ตอบเป็นไฟล์ตรง — content-disposition + ธง truncated เมื่อโดน cap
    const headers: Record<string, string> = {
      "content-disposition": `attachment; filename="${result.filename}"`,
    };
    if (result.truncated) {
      headers["x-ltc-truncated"] = "true";
    }
    return new NextResponse(result.body, {
      status: 200,
      headers: { ...headers, "content-type": result.contentType },
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    });
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

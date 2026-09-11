/**
 * GET /api/v1/admin/reports/credits — รายงานยอดเครดิตคงเหลือ
 * (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 220)
 *
 * - requirePermission("report:view") + assertRoleScope — staff:registrar / staff:viewer /
 *   super_admin (D12-23: sr ได้เฉพาะ export ของ credits · sv/sa)
 * - อ่าน v_credit_balance ผ่าน **user-JWT client** (views.ts)
 * - rate STAFF_WRITE (§5) — user_id + ip
 * - query: CreditReportQuery (limit · from/to บน last_entry_at — คอลัมน์เวลาเดียวของ view)
 * - response: { data: CreditBalance[] } + x-ltc-truncated: true เมื่อโดน cap
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { assertRoleScope, REPORT_ROLE_SCOPES } from "@/lib/reports/access";
import { listCreditBalances } from "@/lib/reports/views";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  CreditBalanceResource,
  CreditReportQuery,
  parseReportQuery,
} from "@/lib/schemas/v1/report";

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — รายงานยอดเครดิตคงเหลือ (200 · cap pagination + x-ltc-truncated) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC 2 ชั้น — permission กลาง + กรอบบทบาทต่อ endpoint (fail-closed ที่ BFF)
    const { userId, roles } = await requirePermission("report:view");
    assertRoleScope(roles, REPORT_ROLE_SCOPES.credits, "report:view");
    // 2) rate STAFF_WRITE — หลัง RBAC (user_id + ip)
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict — from/to กรองบน last_entry_at (ERR-VAL-001 เมื่อผิดรูป)
    const query = parseReportQuery(CreditReportQuery, new URL(request.url).searchParams);
    // 4) อ่านผ่าน user-JWT client (cap limit+1 → truncated)
    const read = await listCreditBalances({ limit: query.limit, from: query.from, to: query.to });
    // 5) r6-L1: ขาออกตรวจ strict ทุกแถวก่อนตอบ — drift แถวเดียว = 503 ไม่ strip เงียบ
    const headers =
      read.truncated === true
        ? { "x-ltc-truncated": "true" }
        : undefined;
    return jsonOk(
      read.rows.map((row) =>
        parseOutgoingView(CreditBalanceResource, row, "credit_balance_drift"),
      ),
      headers === undefined ? options : { ...options, headers },
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

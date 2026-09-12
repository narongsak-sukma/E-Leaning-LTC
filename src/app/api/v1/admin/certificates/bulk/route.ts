/**
 * POST /api/v1/admin/certificates/bulk — ออกประกาศนียบัตรเป็นชุด (Wave E Phase 2 — E-4
 * · D36-O4 · D55-5 · DCR-8 · API-SPECIFICATION §3.6)
 *
 * - requirePermission("certificate:issue") — staff:registrar / super_admin เท่านั้น
 *   (staff:exam ไม่มี certificate:issue → 403 ERR-RBAC-001 — SoD T9)
 * - rate STAFF_WRITE (§5) — key user_id + ip (D12-11)
 * - body { courseId: uuid | null } (strict — extra key ปฏิเสธ) — null = ทุกหลักสูตร
 * - ขั้นตอน (โมเดล worker ของ 0027 — gate r1 M2): insert cert_bulk_jobs (created_by =
 *   ผู้เรียก, status 'pending') แล้วตอบ 202 ทันที **ไม่รันใน request** · worker
 *   `admin_cert_bulk_issue_step` ของ pg_cron (`ltc-cert-bulk-step` ทุกนาที) หยิบ job
 *   รันต่อใบ-commit — audit CERT_ISSUE mode='bulk' ต่อใบเกิดฝั่ง DB (request_id เป็น
 *   null เพราะไม่ได้ออกใน request ใด) ผู้เรียกตามผลด้วย GET …/{jobId} (worker pickup
 *   ≤1 นาที + รันตามคิว)
 * - 202 { data: { jobId, status, totalAttempts, issuedCount, failedCount } } — ขาออก
 *   zod strict (parseOutgoingView) — ค่านอกสัญญา = ERR-SYS-002 fail-closed แบบเดียวกับ
 *   issue.ts · insert ล้ม = ERR-SYS-002 ไทย ไม่ leak detail (dbFailed — job ไม่ถูกสร้าง)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonErrorResponse, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { BulkJobResultResource, createBulkJob } from "@/lib/certificates/bulk";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** body ของ POST — strict · courseId เป็น uuid หรือ null เท่านั้น (null = ทุกหลักสูตร) */
const BulkIssueBody = z.object({ courseId: z.uuid().nullable() }).strict();

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด / key เกิน → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseBody(request: Request): Promise<{ courseId: string | null }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = BulkIssueBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** POST — สร้าง job ออกใบเป็นชุด แล้ว worker รันต่อ (202 Accepted — §3.6) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — certificate:issue (staff:registrar / super_admin)
    const { userId } = await requirePermission("certificate:issue");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) body strict — { courseId: uuid | null }
    const { courseId } = await parseBody(request);
    // 4) เขียนผ่าน lib (service_role รวมศูนย์ใน lib — D36-O3) — insert job อย่างเดียว
    //    worker ของ pg_cron (≤1 นาที) หยิบไปรันต่อใบ-commit (0027 M2 — ไม่รันใน request)
    const job = await createBulkJob({ actorId: userId, courseId });
    // r6-L1: ขาออกตรวจ strict ก่อนตอบ — drift (คีย์เกิน/ผิดชนิดจาก lib) → 503 ไม่ strip เงียบ
    const view = parseOutgoingView(BulkJobResultResource, job, "bulk_job_result_drift");
    return new NextResponse(JSON.stringify({ data: view }), {
      status: 202,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(options.requestId !== undefined ? { "x-request-id": options.requestId } : {}),
      },
    });
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

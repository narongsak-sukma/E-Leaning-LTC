/**
 * GET /api/v1/admin/certificates/bulk/:jobId — สถานะ job ออกใบเป็นชุด (Wave E Phase 2
 * — E-4 · DCR-8 · API-SPECIFICATION §3.6)
 *
 * - role gate เดียวกับ POST — requirePermission("certificate:issue") (staff:registrar /
 *   super_admin) · rate STAFF_WRITE (§5)
 * - **การเห็น: เจ้าของ job (created_by = ผู้เรียก) หรือ super_admin เท่านั้น** —
 *   registrar คนอื่นเจอ job ของเพื่อน → 404 ERR-NF-001 (ตอบเหมือนไม่พบ ไม่เฉลยว่ามีจริง
 *   — กัน enumeration) · ตัดสินใน lib/getBulkJob จาก viewerId + isSuperAdmin
 * - jobId ไม่ใช่ uuid → 400 ERR-VAL-001 (ไม่ไล่ DB ด้วย id ที่ไม่มีรูปแบบ)
 * - 200 { data: { jobId, status, totalAttempts, issuedCount, failedCount, lastError
 *   (null ได้ — ตัดทอน 200 ตัวอักษร), createdAt, finishedAt (null ได้) } } — ขาออก zod
 *   strict (parseOutgoingView) — drift → 503 ERR-SYS-002 ไม่ strip เงียบ
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { BulkJobStatusResource, getBulkJob } from "@/lib/certificates/bulk";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** :jobId ต้องเป็น uuid — ผิดรูป → ERR-VAL-001 (ไม่ไล่ DB ด้วย id ที่ไม่มีรูปแบบ) */
function parseJobId(raw: string): string {
  if (!z.uuid().safeParse(raw).success) {
    throw new AppError("ERR-VAL-001", { details: { field: "jobId" } });
  }
  return raw;
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — สถานะ job ออกใบเป็นชุด (200) */
export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — certificate:issue (staff:registrar / super_admin)
    const { userId, roles } = await requirePermission("certificate:issue");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) :jobId — uuid เท่านั้น
    const jobId = parseJobId((await context.params).jobId);
    // 4) อ่านผ่าน lib — การเห็น: เจ้าของ หรือ super_admin (registrar อื่น = 404 เหมือนไม่พบ)
    const job = await getBulkJob({
      jobId,
      viewerId: userId,
      isSuperAdmin: roles.includes("super_admin"),
    });
    // r6-L1: ขาออกตรวจ strict ก่อนตอบ — drift → 503 ไม่ strip เงียบ
    return jsonOk(parseOutgoingView(BulkJobStatusResource, job, "bulk_job_status_drift"), options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

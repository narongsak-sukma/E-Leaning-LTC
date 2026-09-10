/**
 * GET /api/v1/admin/certificates/eligible — คิวงานออกประกาศนียบัตร
 * (Wave D — D-4 · API-SPECIFICATION §3.8 endpoint 82 · D12-23)
 *
 * - requirePermission("certificate:issue") — staff:registrar / super_admin
 * - rate STAFF_WRITE (§5) — user_id + ip (D12-11)
 * - query: PageQuery (limit/cursor — lib/schemas/v1/common) + courseId (optional uuid)
 * - audit PII_ACCESS — เพราะคิวแสดงชื่อผู้ผ่านเกณฑ์ (D12-23); คีย์ context ตรง allowlist
 *   ของ event นี้ (endpoint/target_user_id/purpose — 0008:451) · 0019 เปิดให้ service_role
 *   เขียน PII_ACCESS ได้ (entityId null เมื่อคิวว่าง — ไม่ใส่ค่าปลอมแทน)
 * - response: { data: EligibleAttempt[], page } — ไม่ log ชื่อผู้ถือ (SDS §6.2)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonErrorResponse, jsonPageOk, type JsonResponseOptions } from "@/lib/api/response";
import { auditCertificateEvent } from "@/lib/certificates/shared";
import { AppError } from "@/lib/errors";
import { listEligibleAttempts } from "@/lib/certificates/issue";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parsePageQuery } from "@/lib/schemas/v1/common";

/** courseId เป็น optional uuid (filter ตามหลักสูตร) */
const CourseIdSchema = z.uuid();

/** x-request-id → response options */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** query → { limit, cursor?, courseId? } — ผิดรูป → ERR-VAL-001 */
function parseQuery(searchParams: URLSearchParams): {
  limit: number;
  cursor?: string | undefined;
  courseId?: string | undefined;
} {
  // courseId เป็นพารามิเตอร์เฉพาะของ endpoint นี้ — ดึงออกก่อนเพื่อไม่ให้ PageQuery (.strict())
  // ถือว่าเป็น key แปลกปลอม แล้วจึง parse limit/cursor ตามสัญญา §4 #12
  const courseId = searchParams.get("courseId");
  searchParams.delete("courseId");
  if (courseId !== null && !CourseIdSchema.safeParse(courseId).success) {
    throw new AppError("ERR-VAL-001", { details: { field: "courseId" } });
  }
  const page = parsePageQuery(searchParams);
  return { limit: page.limit, cursor: page.cursor, courseId: courseId ?? undefined };
}

/** GET — คิวงานออกประกาศนียบัตร (audit PII_ACCESS) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    const { userId } = await requirePermission("certificate:issue");
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    const query = parseQuery(new URL(request.url).searchParams);
    const page = await listEligibleAttempts({
      limit: query.limit,
      cursor: query.cursor ?? null,
      courseId: query.courseId ?? null,
      requestId: options.requestId ?? null,
    });
    // audit PII_ACCESS — คิวแสดงชื่อผู้ผ่านเกณฑ์ (D12-23) · คีย์ตรง allowlist ของ event นี้
    // (endpoint/target_user_id/purpose — 0008:451) · `user_id` = actor ผู้เข้าถึง (0008:476-486)
    // — คิวเป็น aggregate (หลาย target) จึงไม่ส่ง target_user_id รายแถว
    await auditCertificateEvent({
      action: "PII_ACCESS",
      entityType: "assessment_attempt",
      entityId: page.data[0]?.attemptId ?? null,
      context: {
        endpoint: "/api/v1/admin/certificates/eligible",
        purpose: "certificate_issue_queue",
        user_id: userId,
      },
      actorId: userId,
      requestId: options.requestId ?? null,
    });
    return jsonPageOk(page, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

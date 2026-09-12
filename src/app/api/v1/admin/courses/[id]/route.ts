/**
 * PATCH /api/v1/admin/courses/{id} (Wave E Phase 5 · [#90] D-p5-10 · API-SPEC §3.6 แถว 195)
 *
 * - requirePermission("course:publish") — staff:content / super_admin (RBAC §2) ตรงกับ
 *   guard admin_course_staff_guard ของ RPC พอดี
 * - rate STAFF_WRITE (§5) — หลัง RBAC
 * - :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ RPC
 * - body strict zod: { action: publish|unpublish|return · comment? } — **action=return
 *   บังคับ comment 10-500 อักขระ → 400 ERR-VAL-001 ก่อนแตะ RPC** (RPC ตรวจซ้ำชั้นที่สอง
 *   ERR-VAL-001|comment_required)
 * - RPC admin_decide_course (0035 §9) ผ่าน user-JWT — transition ของสถานะ + audit
 *   COURSE_PUBLISH/COURSE_UNPUBLISH/COURSE_RETURN เขียน atomic ใน TX เดียวฝั่ง DB
 *   · แท็กผิดเงื่อนไข → mapAdminRpcError: invalid_transition/comment_required =
 *   400 · course_not_found = 404
 * - 200 { data: { courseId, status } } — สถานะหลัง transition (published/draft/returned)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { decideCourseViaRpc } from "@/lib/admin/users";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** รูปแบบ uuid ของ :id — ผิดรูป → 400 ก่อนแตะ RPC */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** resource ขาออก (strict) — ตรง jsonb ที่ RPC คืน */
const CourseDecisionResource = z
  .object({
    courseId: z.uuid(),
    status: z.enum(["draft", "pending_review", "published", "archived", "returned"]),
  })
  .strict();

/** body — strict · action=return บังคับ comment 10-500 (ตรวจ cross-field หลัง parse) */
const DecideBody = z
  .object({
    action: z.enum(["publish", "unpublish", "return"]),
    comment: z.string().trim().min(10).max(500).optional(),
  })
  .strict();

/** JSON body → parsed — พร้อม cross-field: return บังคับ comment 10-500 (400 ก่อนแตะ RPC) */
async function parseDecideBody(
  request: Request,
): Promise<{ action: "publish" | "unpublish" | "return"; comment: string | null }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  // parse — ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ routes อื่น
  const parsed = DecideBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  // cross-field — 400 ก่อนแตะ RPC (RPC ตรวจซ้ำชั้นที่สอง ERR-VAL-001|comment_required)
  if (parsed.data.action === "return") {
    const comment = parsed.data.comment;
    if (comment === undefined) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["comment"] } });
    }
    return { action: parsed.data.action, comment };
  }
  return { action: parsed.data.action, comment: parsed.data.comment ?? null };
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ RPC */
function parseCourseId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new AppError("ERR-VAL-001", { details: { field: "courseId" } });
  }
  return raw;
}

/** PATCH — ตัดสินสถานะคอร์ส (200 · staff:content/super_admin) */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — course:publish (staff:content/super_admin) — RPC guard ตรวจซ้ำชั้นที่สอง
    const { userId } = await requirePermission("course:publish");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) :id + body strict + cross-field comment
    const courseId = parseCourseId((await context.params).id);
    const body = await parseDecideBody(request);
    // 4) RPC atomic (transition + audit ใน TX เดียว) ผ่าน user-JWT
    const result = await decideCourseViaRpc({
      courseId,
      action: body.action,
      comment: body.comment,
      requestId: options.requestId ?? null,
    });
    // 5) ขาออก strict — drift → 503 ไม่ strip เงียบ (r6-L1)
    const resource = parseOutgoingView(CourseDecisionResource, result, "course_decision_drift");
    return jsonOk(resource, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}
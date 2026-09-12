/**
 * POST/DELETE /api/v1/admin/users/{id}/roles (Wave E Phase 5 · [#90] D-p5-5 · API-SPEC §3.7 แถว 214-215)
 *
 * POST — มอบบทบาท ผ่าน RPC atomic admin_grant_role (0035 §6 — mutation + audit ROLE_GRANT
 * TX เดียว · aal2 ตรวจใน RPC)
 * DELETE — ถอนบทบาท ผ่าน RPC atomic admin_revoke_role (เงื่อนไขสิทธิ์เดียวกัน)
 *
 * - requirePermission("role:grant"/"role:revoke") — sr/sa (RBAC §2)
 * - **BFF resource-scope (D-p5-5)** — ตรวจก่อนถึง RPC เสมอ: registrar มอบ/ถอนได้เฉพาะ
 *   'lawyer' (role อื่น = 403 ERR-RBAC-001 ก่อน RPC) · super_admin มอบ lawyer/instructor/
 *   staff:* ได้ · 'super_admin' ไม่อยู่ในชุด input ของ endpoint (bootstrap เท่านั้น —
 *   ผิดชุด = 400 ERR-VAL-001 ตรงป้าย RPC ERR-VAL-001|role_not_grantable)
 * - body strict: { role, reason } — reason บังคับ 10-500 (RPC บังคับ p_reason เช่นเดียวกัน)
 * - RPC error tag → AppError ผ่าน mapAdminRpcError: role_not_grantable/role_not_manageable/
 *   self_revoke/last_role/no_verified_license = 400 · role_scope = 403 · user_not_found/
 *   role_not_found = 404
 * - POST 201 { data: { userId, role, granted } } (granted=false = ถืออยู่แล้ว — idempotent)
 *   · DELETE 204 (RPC ล้มเงื่อนไขใด ๆ = error ตามป้าย ไม่มี 204 เงียบ)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { grantRoleViaRpc, revokeRoleViaRpc } from "@/lib/admin/users";
import { jsonErrorResponse, jsonNoContent, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { jsonCreated } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * ชุดบทบาทที่ endpoint รับ — ตรงชุดที่ RPC admin_grant_role ยอม (0035 §6) · super_admin
 * ไม่อยู่ในชุด (bootstrap เท่านั้น — D-p5-5)
 */
const GRANTABLE_ROLES = [
  "lawyer",
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
] as const;

/** รูปแบบ uuid ของ :id — ผิดรูป → 400 ก่อนแตะ RPC */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** resource ขาออกของ POST (strict) — ตรง jsonb ที่ RPC คืน (camelCase แล้วจาก DB) */
const RoleGrantResource = z
  .object({
    userId: z.uuid(),
    role: z.string().min(1),
    granted: z.boolean(),
  })
  .strict();

/** body ของ POST/DELETE — strict · reason บังคับ 10-500 (RPC บังคับเช่นเดียวกัน) */
const RoleBody = z
  .object({
    role: z.enum(GRANTABLE_ROLES),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseRoleBody(request: Request): Promise<z.infer<typeof RoleBody>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = RoleBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ RPC */
function parseUserId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new AppError("ERR-VAL-001", { details: { field: "userId" } });
  }
  return raw;
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/**
 * BFF resource-scope ก่อนถึง RPC (D-p5-5): ผู้เรียกไม่ใช่ super_admin = มอบ/ถอนได้เฉพาะ
 * 'lawyer' — role อื่น 403 ERR-RBAC-001 ที่ BFF (RPC ตรวจซ้ำเป็นชั้นที่สอง)
 */
function assertRoleScope(role: string, callerRoles: readonly string[], permission: "role:grant" | "role:revoke"): void {
  if (!callerRoles.includes("super_admin") && role !== "lawyer") {
    throw new AppError("ERR-RBAC-001", { details: { permission } });
  }
}

/** POST — มอบบทบาท (201 · idempotent: ถืออยู่แล้ว = granted:false ยัง 201) */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — role:grant (sr/sa)
    const { userId: actorId, roles } = await requirePermission("role:grant");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: actorId });
    // 3) :id + body strict
    const targetUserId = parseUserId((await context.params).id);
    const body = await parseRoleBody(request);
    // 4) BFF resource-scope — ก่อนถึง RPC เสมอ (D-p5-5)
    assertRoleScope(body.role, roles, "role:grant");
    // 5) RPC atomic (mutation + audit ROLE_GRANT ใน TX เดียว) ผ่าน user-JWT
    const result = await grantRoleViaRpc({
      targetUserId,
      role: body.role,
      reason: body.reason,
      requestId: options.requestId ?? null,
    });
    // 6) ขาออก strict — drift → 503 ไม่ strip เงียบ (r6-L1)
    const resource = parseOutgoingView(RoleGrantResource, result, "role_grant_drift");
    return jsonCreated(resource, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/** DELETE — ถอนบทบาท (204 · body {role, reason} — RPC บังคับเหตุผลเสมอ) */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — role:revoke (sr/sa)
    const { userId: actorId, roles } = await requirePermission("role:revoke");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: actorId });
    // 3) :id + body strict
    const targetUserId = parseUserId((await context.params).id);
    const body = await parseRoleBody(request);
    // 4) BFF resource-scope — ก่อนถึง RPC เสมอ (D-p5-5)
    assertRoleScope(body.role, roles, "role:revoke");
    // 5) RPC atomic (mutation + audit ROLE_REVOKE ใน TX เดียว) ผ่าน user-JWT
    const result = await revokeRoleViaRpc({
      targetUserId,
      role: body.role,
      reason: body.reason,
      requestId: options.requestId ?? null,
    });
    // ผล RPC ตรวจ contract แล้วใน lib — 204 ไม่มี body
    void result;
    return jsonNoContent(options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}
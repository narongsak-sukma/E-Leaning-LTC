/**
 * PATCH /api/v1/admin/users/{id} (Wave E Phase 5 · [#90] D-p5-6 · API-SPEC §3.7 แถว 212)
 *
 * - requirePermission("user:disable") — super_admin เท่านั้น (RBAC §2 — user:disable ถือโดย
 *   super_admin ชุดเดียว) · registrar แก้ "ข้อมูลสมาชิก" ของ spec แถว 212 ไม่ใช่ปิด-เปิดบัญชี
 * - rate STAFF_WRITE (§5) — หลัง RBAC
 * - :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB/GoTrue
 * - body strict zod: { is_active: boolean, reason?: string } — reason **บังคับ 10-500
 *   อักขระเมื่อ is_active=false** (แบบแผน revoke) · เปิดใช้งานไม่บังคับเหตุผล
 * - guard: เป้าหมายเป็น super_admin เมื่อผู้เรียกไม่ใช่ = 403 ERR-RBAC-001 (BFF guard
 *   ก่อนแตะ GoTrue — lib ตรวจผ่าน role_assignments ชั้น RLS ra_read 0010)
 * - ปิดใช้งานบังคับจริงด้วย GoTrue ban (ban_duration '876000h' — 100 ปี ตามตัวอย่างทางการ
 *   supabase-js) + profiles.is_active=false · เปิดใช้งาน = unban ('none') +
 *   is_active=true — ลำดับ ban ก่อน profiles เสมอ (ล้มหลัง ban = ค้างถูกแบน fail-closed)
 * - profiles.is_active + audit USER_DISABLE (ปิด·มี reason) / USER_UPDATE (เปิด)
 *   atomic ใน TX เดียวผ่าน RPC admin_set_user_active (0038 — gate p5-r1 B4) หลัง ban
 *   — retry จำกัด 3 (guard 4xx ไม่ retry) · ค้างหลัง ban = 503 fail-closed
 * - 200 { data: { userId, isActive } }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { setUserActive } from "@/lib/admin/users";
import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** รูปแบบ uuid ของ :id — ผิดรูป → 400 ก่อนแตะ DB/GoTrue */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** resource ขาออก (strict) */
const UserActiveResource = z
  .object({
    userId: z.uuid(),
    isActive: z.boolean(),
  })
  .strict();

/** body — strict · reason บังคับเมื่อปิดใช้งาน (ตรวจ cross-field หลัง parse) */
const SetActiveBody = z
  .object({
    is_active: z.boolean(),
    reason: z.string().trim().min(10).max(500).optional(),
  })
  .strict();

/** JSON body → parsed — พร้อม cross-field: ปิดใช้งานบังคับ reason 10-500 (แบบแผน revoke) */
async function parseSetActiveBody(
  request: Request,
): Promise<{ isActive: boolean; reason: string | null }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = SetActiveBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  if (parsed.data.is_active === false) {
    const reason = parsed.data.reason;
    if (reason === undefined) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["reason"] } });
    }
    return { isActive: false, reason };
  }
  return { isActive: true, reason: parsed.data.reason ?? null };
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB/GoTrue */
function parseUserId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new AppError("ERR-VAL-001", { details: { field: "userId" } });
  }
  return raw;
}

/** PATCH — ปิด/เปิดใช้งานบัญชี (200 · super_admin เท่านั้น) */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — user:disable (super_admin เท่านั้น)
    const { userId: actorId, roles } = await requirePermission("user:disable");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: actorId });
    // 3) :id ผิดรูป → 400 ก่อนแตะ DB/GoTrue
    const targetUserId = parseUserId((await context.params).id);
    // 4) body strict + cross-field reason
    const { isActive, reason } = await parseSetActiveBody(request);
    // 5) lib: guard SA + GoTrue ban/unban + profiles.is_active + audit best-effort
    const result = await setUserActive({
      targetUserId,
      isActive,
      reason,
      callerIsSuperAdmin: roles.includes("super_admin"),
      actorId,
      requestId: options.requestId ?? null,
    });
    // 6) ขาออก strict — drift → 503 ไม่ strip เงียบ (r6-L1)
    const resource = parseOutgoingView(
      UserActiveResource,
      { userId: result.userId, isActive: result.isActive },
      "user_active_drift",
    );
    return jsonOk(resource, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

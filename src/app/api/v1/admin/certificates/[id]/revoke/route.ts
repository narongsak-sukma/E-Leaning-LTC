/**
 * POST /api/v1/admin/certificates/:id/revoke — เพิกถอนประกาศนียบัตร
 * (Wave D — D-4 · API-SPECIFICATION §3.8 endpoint 80)
 *
 * - requirePermission("certificate:revoke") — staff:registrar / super_admin เท่านั้น
 *   (staff:exam ไม่มี → 403 ERR-RBAC-001 — SoD T9)
 * - rate STAFF_WRITE (§5) — key user_id + ip (D12-11)
 * - body { reason } (strict, ≥10 ตัวอักษร) — ผิดรูป/สั้นเกิน → 400 ERR-VAL-001
 * - 200 { data: certificate } — เขียนผ่าน lib/certificates/revoke เท่านั้น (D36-O3)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { MIN_REASON_LENGTH, revokeCertificate } from "@/lib/certificates/revoke";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** body ของ POST — strict · reason ≥10 (trim) ตรวจที่นี่และซ้ำใน lib (defense in depth) */
const RevokeBody = z
  .object({ reason: z.string().trim().min(MIN_REASON_LENGTH) })
  .strict();

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** :id ต้องเป็น uuid — ผิดรูป → ERR-VAL-001 (ไม่ไล่ DB ด้วย id ที่ไม่มีรูปแบบ) */
function parseId(raw: string): string {
  if (!z.uuid().safeParse(raw).success) {
    throw new AppError("ERR-VAL-001", { details: { field: "id" } });
  }
  return raw;
}

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseBody(request: Request): Promise<{ reason: string }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = RevokeBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** POST — เพิกถอนประกาศนียบัตร (200) */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — certificate:revoke (staff:registrar / super_admin)
    const { userId } = await requirePermission("certificate:revoke");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) :id + body
    const certificateId = parseId((await context.params).id);
    const { reason } = await parseBody(request);
    // 4) เขียนผ่าน lib (service_role รวมศูนย์ใน lib — D36-O3)
    const certificate = await revokeCertificate({
      actorId: userId,
      certificateId,
      reason,
      requestId: options.requestId ?? null,
    });
    return jsonOk(certificate, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/**
 * POST /api/v1/admin/certificates/:id/reissue — ออกใบใหม่แทนใบเดิม
 * (Wave D — D-4 · API-SPECIFICATION §3.8 endpoint 81 · SDS §3.4d CRT-007)
 *
 * - requirePermission("certificate:revoke") — ใช้สิทธิ์เดียวกับการเพิกถอน (staff:registrar /
 *   super_admin); staff:exam ไม่มี → 403 ERR-RBAC-001 (SoD T9)
 * - rate STAFF_WRITE (§5) — key user_id + ip (D12-11)
 * - body: ไม่ใช้ (ใบใหม่อ้างอิง enrollment ของใบเดิมทั้งหมด) — ถ้าส่ง body มาจะถูกอ่านแล้วทิ้ง
 * - 201 { data: { newCertificate, oldCertificateId, oldStatus, oldSupersededBy } } —
 *   เขียนผ่าน lib/certificates/reissue เท่านั้น (D36-O3)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  jsonCreated,
  jsonErrorResponse,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { reissueCertificate } from "@/lib/certificates/reissue";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { ReissuedCertificateResource } from "@/lib/schemas/v1/certificate";

/** :id ต้องเป็น uuid — ผิดรูป → ERR-VAL-001 (ไม่ไล่ DB ด้วย id ที่ไม่มีรูปแบบ) */
function parseId(raw: string): string {
  if (!z.uuid().safeParse(raw).success) {
    throw new AppError("ERR-VAL-001", { details: { field: "id" } });
  }
  return raw;
}

/** x-request-id → response options (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** POST — ออกใบใหม่แทนใบเดิม (201 · ใบเดิม superseded + lineage ทั้งสองทิศ) */
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
    // 3) :id (body ไม่ใช้ — ดู header)
    const certificateId = parseId((await context.params).id);
    // 4) เขียนผ่าน lib (service_role รวมศูนย์ใน lib — D36-O3)
    const result = await reissueCertificate({
      actorId: userId,
      certificateId,
      requestId: options.requestId ?? null,
    });
    // r6-L1: ขาออกตรวจ strict ทุกชั้น (รวม newCertificate) ก่อนตอบ — drift → 503
    return jsonCreated(
      parseOutgoingView(ReissuedCertificateResource, result, "reissued_certificate_drift"),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

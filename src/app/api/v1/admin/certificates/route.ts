/**
 * POST /api/v1/admin/certificates — ออกประกาศนียบัตรรายใบ (Wave D — D-4 · API-SPECIFICATION §3.8 endpoint 79)
 *
 * - requirePermission("certificate:issue") — staff:registrar / super_admin เท่านั้น
 *   (staff:exam ไม่มี certificate:issue → 403 ERR-RBAC-001 — SoD T9)
 * - rate STAFF_WRITE (§5) — key user_id + ip (D12-11)
 * - body { enrollmentId } (strict) — ผิดรูป → 400 ERR-VAL-001
 * - 201 { data: certificate } — เขียนผ่าน lib/certificates/issue เท่านั้น
 *   (service_role รวมศูนย์ใน lib — D36-O3; route ห้าม import service client ตรง)
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
import { issueCertificate } from "@/lib/certificates/issue";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { IssuedCertificateResource } from "@/lib/schemas/v1/certificate";

/** body ของ POST — strict ตามสไตล์ schema กลางของ repo */
const IssueCertificateBody = z.object({ enrollmentId: z.uuid() }).strict();

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseBody(request: Request): Promise<{ enrollmentId: string }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = IssueCertificateBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** POST — ออกประกาศนียบัตรรายใบ (201) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — certificate:issue (staff:registrar / super_admin)
    const { userId } = await requirePermission("certificate:issue");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) body
    const { enrollmentId } = await parseBody(request);
    // 4) เขียนผ่าน lib (service_role รวมศูนย์ใน lib — D36-O3)
    const certificate = await issueCertificate({
      actorId: userId,
      enrollmentId,
      requestId: options.requestId ?? null,
    });
    // r6-L1: ขาออกตรวจ strict ก่อนตอบ — drift (คีย์เกิน/ผิดชนิดจาก lib) → 503 ไม่ strip เงียบ
    return jsonCreated(
      parseOutgoingView(IssuedCertificateResource, certificate, "issued_certificate_drift"),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/**
 * /api/v1/admin/certificates (Wave D — D-4 · Wave E — PB-20 · API-SPECIFICATION §3.8)
 *
 * POST — ออกประกาศนียบัตรรายใบ (endpoint 79 · พฤติกรรมเดิมทุกอย่างคงเดิม)
 * - requirePermission("certificate:issue") — staff:registrar / super_admin เท่านั้น
 *   (staff:exam ไม่มี certificate:issue → 403 ERR-RBAC-001 — SoD T9)
 * - rate STAFF_WRITE (§5) — key user_id + ip (D12-11)
 * - body { enrollmentId } (strict) — ผิดรูป → 400 ERR-VAL-001
 * - 201 { data: certificate } — เขียนผ่าน lib/certificates/issue เท่านั้น
 *   (service_role รวมศูนย์ใน lib — D36-O3; route ห้าม import service client ตรง)
 *
 * GET — ทะเบียนใบที่ออกแล้ว + ค้นหา (endpoint 81 · Wave E · PB-20 · v1.0.4)
 * - role-gate ตรง (D55-2): staff:registrar / super_admin เท่านั้น — ไม่สร้าง permission
 *   ใหม่ ไม่ยืม certificate:issue (requireCertificateRegistryRole — list คือการอ่านทะเบียน)
 * - rate STAFF_WRITE (§5 — กลุ่ม canonical ของ /admin/* · ไม่มีกลุ่ม STAFF_READ ให้ใช้)
 * - query strict-zod: after_issued_at/after_id (keyset ตรง) · cert_no (prefix) ·
 *   verify_code (ตรงตัว) · status · holder_user_id · course_id · limit · cursor
 *   — ผิดรูป → 400 ERR-VAL-001 (รูปแบบ fields เดียวกับ parsePageQuery §4 #12)
 * - 200 { data: CertificateListRow[], page: { nextCursor, hasMore } } — keyset
 *   (issued_at, id) DESC ใน SQL · cursor encode แบบเดียวกับ eligible · อ่านผ่าน
 *   lib/certificates/list เท่านั้น (audit PII_ACCESS เขียนใน lib — แบบแผน eligible)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  jsonCreated,
  jsonErrorResponse,
  jsonPageOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import {
  CertificateListRowResource,
  listCertificates,
  requireCertificateRegistryRole,
  type CertificateListRow,
} from "@/lib/certificates/list";
import { issueCertificate } from "@/lib/certificates/issue";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { CertificateStatus, IssuedCertificateResource } from "@/lib/schemas/v1/certificate";

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

/* ─── GET — ทะเบียนใบที่ออกแล้ว + ค้นหา (Wave E · PB-20 · endpoint 81) ─── */

/**
 * query ของ GET — strict (key แปลกปลอม → 400 ERR-VAL-001) ตามสไตล์ schema กลางของ repo
 * - limit 1..100 default 20 — canonical PageQuery (API-SPECIFICATION §4 #12) เดียวกับ
 *   eligible: lib ขอ limit+1 ให้ buildPage เทียบ hasMore พอดี clamp 101 ของ RPC (0023);
 *   ถ้าอนุญาต 101 จะทำให้หน้า limit=101 ประเมิน hasMore ผิดเพราะ +1 โดน clamp
 * - status ใช้ enum CertificateStatus (0001_extensions L122) — ค่านอกชุด → 400
 */
const ListCertificatesQuerySchema = z
  .object({
    after_issued_at: z.iso.datetime({ offset: true }).optional(),
    after_id: z.uuid().optional(),
    cert_no: z.string().trim().min(1).max(64).optional(),
    verify_code: z.string().trim().min(1).max(64).optional(),
    status: CertificateStatus.optional(),
    holder_user_id: z.uuid().optional(),
    course_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** query → parsed (ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ parsePageQuery §4 #12) */
function parseListQuery(searchParams: URLSearchParams): {
  afterIssuedAt?: string | undefined;
  afterId?: string | undefined;
  certNo?: string | undefined;
  verifyCode?: string | undefined;
  status?: CertificateListRow["status"] | undefined;
  holderUserId?: string | undefined;
  courseId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
} {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  // ค่าว่าง = "ไม่ระบุ" (ฟอร์ม GET ส่งช่องว่างเมื่อไม่กรอก) — ตัดก่อน parse
  // ไม่งั้นช่องค้นหาที่เว้นว่างกลายเป็น 400 ทั้งหน้าค้นหา
  for (const key of Object.keys(raw)) {
    if (raw[key] === "") {
      delete raw[key];
    }
  }
  const parsed = ListCertificatesQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : "query";
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return {
    afterIssuedAt: parsed.data.after_issued_at,
    afterId: parsed.data.after_id,
    certNo: parsed.data.cert_no,
    verifyCode: parsed.data.verify_code,
    status: parsed.data.status,
    holderUserId: parsed.data.holder_user_id,
    courseId: parsed.data.course_id,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  };
}

/** GET — ทะเบียนใบที่ออกแล้ว + ค้นหา (200 + keyset page) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — role-gate ตรง (D55-2): staff:registrar / super_admin เท่านั้น
    const { userId } = await requireCertificateRegistryRole();
    // 2) rate STAFF_WRITE — กลุ่ม rate canonical ของ /admin/* (§5) หลัง RBAC เหมือน POST
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict — ผิดรูป → 400 ERR-VAL-001
    const query = parseListQuery(new URL(request.url).searchParams);
    // 4) list + audit PII_ACCESS ผ่าน lib (service_role รวมศูนย์ใน lib — D36-O3)
    const page = await listCertificates({
      actorId: userId,
      query: { ...query, requestId: options.requestId },
    });
    // r6-L1: ขาออกตรวจ strict ทุกแถวก่อนตอบ — drift แถวเดียว = 503 ไม่ strip เงียบ
    return jsonPageOk(
      {
        data: page.data.map((row) =>
          parseOutgoingView(CertificateListRowResource, row, "certificate_list_row_drift"),
        ),
        page: page.page,
      },
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

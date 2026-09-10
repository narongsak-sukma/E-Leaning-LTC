/**
 * GET /api/v1/me/certificates — ประกาศนียบัตรของตัวเอง (Wave D-2 · API-SPECIFICATION 1.0.3 §3.6)
 *
 * - ต้อง login + permission "certificate:view" (มีจริงใน rbac.ts — citizen/lawyer/instructor/
 *   super_admin) — ไม่ login → 401 ERR-AUTH-001 · ไม่มี permission → 403 ERR-RBAC-001
 *   (requirePermission บังคับ MFA fail-closed กับบทบาท staff/instructor ให้ด้วย — D25-O4)
 * - รายการ "ของตัวเอง" บังคับสองชั้น: RLS certs_owner_read (0010 L781-783 — owner OR
 *   staff:registrar/super_admin) + filter .eq("user_id", userId) ฝั่ง handler เพราะ /me*
 *   ต้องแคบกว่า RLS (registrar ที่ยิง /me/certificates ต้องเห็นแค่ใบของตัวเอง)
 * - envelope ตาม §1.2: { data: [...], page: { nextCursor, hasMore } } · cursor signed
 *   (lib/api/pagination) · query ตรง PageQuery (§4 #12 — default 20, max 100)
 * - ฟิลด์: id, cert_no, course_title, issued_at, status (snake_case ตาม lane D-2) —
 *   ไม่มี holder_name (PII) แม้เป็นของตัวเอง
 * - rate = READ (ตาราง §5: /me* → READ 120/min, user_id + ip)
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonPageOk, type JsonResponseOptions } from "@/lib/api/response";
import { decodeCursor, buildPage } from "@/lib/api/pagination";
import { parsePageQuery } from "@/lib/schemas/v1/common";
import { toMyCertificateResource, type MyCertificateRow } from "@/lib/schemas/v1/certificate";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select ของ list — 5 คอลัมน์จริงของ certificates (0006 L4-25) · course_title มาจาก course_title_snapshot (0009 L9) */
const MY_CERTIFICATES_SELECT = "id,cert_no,course_title_snapshot,issued_at,status";

/** รูปแบบเวลาใน cursor (เราใส่เองจาก issued_at) — กันค่าแปลกปลอมเข้า filter (เดียวกับ /me/enrollments) */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/**
 * GET — { data: MyCertificate[], page } ตาม §1.2 · เรียง (issued_at, id) มาก→น้อย
 * cursor = ตำแหน่งแถวสุดท้ายของหน้าก่อน
 */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) ต้อง login + certificate:view (401/403 ตามทะเบียน)
    const auth = await requirePermission("certificate:view");
    // 2) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: auth.userId });
    // 3) query กลาง (limit default 20 max 100 — strict)
    const { limit, cursor } = parsePageQuery(new URL(request.url).searchParams);
    const supabase = await createSupabaseSsrClient();
    let query = supabase
      .from("certificates")
      .select(MY_CERTIFICATES_SELECT)
      // ขอบเขต "ของตัวเอง" ซ้ำฝั่ง handler — RLS ยังเปิดให้ registrar/super_admin เห็นของคนอื่น
      // แต่ /me* ต้องแคบกว่านั้นเสมอ
      .eq("user_id", auth.userId)
      .order("issued_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor !== undefined) {
      const payload = decodeCursor(cursor); // ผิดรูป/ถูกแก้ → ERR-VAL-001 (cursor signed)
      if (ISO_RE.test(payload.sortKey) === false) {
        throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "bad_sort_key" } });
      }
      // desc: หน้าถัดไป = (issued_at < ts) OR (issued_at = ts AND id < lastId)
      query = query.or(
        `issued_at.lt.${payload.sortKey},and(issued_at.eq.${payload.sortKey},id.lt.${payload.id})`,
      );
    }
    const { data, error } = await query;
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    const rows = (data ?? []) as unknown as readonly MyCertificateRow[];
    const resources = rows.map(toMyCertificateResource);
    const page = buildPage({
      rows: resources,
      limit,
      sortKeyOf: (row) => row.issued_at,
      idOf: (row) => row.id,
    });
    // list endpoint ตอบ { data, page } ตรง §1.2 — helper กลางของ lib/api/response
    return jsonPageOk(page, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/**
 * GET /api/v1/me/enrollments — รายการที่ลงทะเบียนของตัวเอง (Wave C-3 · API-SPEC 1.0.1 §3.3)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001; ขอบเขต "เฉพาะของตัวเอง" บังคับที่ RPC
 *   my_active_enrollments (0017 — e.user_id = auth.uid() ฝั่ง DB) · PB-7/M2+M3:
 *   รายการตัดการลงทะเบียนของหลักสูตรที่ถูก soft-delete ออก โดยตรวจเงื่อนไขเดียวที่
 *   ตั้งใจจริง (c.deleted_at is null) — ห้ามใช้ `courses!inner` embed เพราะ embed
 *   ทำให้แถวตกใต้ RLS ของ courses (published-only) → หลักสูตรถูก archive หลังผู้เรียน
 *   ลงทะเบียนแล้ว = ประวัติการเรียนหายเกินขอบเขต soft-delete
 * - envelope ตาม §1.2: { data: [...], page: { nextCursor, hasMore: true } }
 *   cursor signed (lib/api/pagination) · query ตรง PageQuery (§4 #12 — default 20, max 100)
 * - rate = READ (ตาราง §5: /me* → READ 120/min, user_id + ip)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonPageOk, type JsonResponseOptions } from "@/lib/api/response";
import { decodeCursor, buildPage } from "@/lib/api/pagination";
import { parsePageQuery } from "@/lib/schemas/v1/common";
import { requireMfaForRoles } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { toEnrollmentResource, type EnrollmentRow } from "@/lib/schemas/v1/enrollment";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** รูปแบบเวลาใน cursor (เราใส่เองจาก enrolled_at) — กันค่าแปลกปลอมเข้า filter */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * GET — { data: Enrollment[], page } ตาม §1.2 · เรียง (enrolled_at, id) มาก→น้อย
 * cursor = ตำแหน่งแถวสุดท้ายของหน้าก่อน
 */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) ต้อง login (ไม่ login → 401 ตาม §3.3 Errors = AUTH-001) + MFA gate:
    //    บทบาทบังคับ MFA ที่ยัง aal1 = state enrollment-only — endpoint นี้ไม่อยู่
    //    ใน allowlist ของ AUTH-007 (มีแค่ /auth/mfa/*, /auth/logout, GET /me) → 403 ERR-AUTH-004
    const { user } = await requireMfaForRoles();
    // 2) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) query กลาง (limit default 20 max 100 — strict)
    const { limit, cursor } = parsePageQuery(new URL(request.url).searchParams);
    const supabase = await createSupabaseSsrClient();
    let query = supabase
      // PB-7 (M2+M3 แก้รูป): RPC security-definer ของ 0017 — ขอบเขตเจ้าของ +
      // กรอง soft-delete ของหลักสูตรอยู่ใน SQL ฝั่ง DB (e.user_id = auth.uid() ·
      // join courses c ... c.deleted_at is null) จึงไม่ต้อง (และไม่ควร) ใส่
      // .eq("user_id") หรือ embed courses ซ้ำที่นี่ · RPC เป็น STABLE → PostgREST
      // อนุญาตให้ chain .select/.order/.limit/.or บนผลลัพธ์ได้
      .rpc("my_active_enrollments")
      .select("id, course_id, status, enrolled_at, expires_at, completed_at")
      .order("enrolled_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor !== undefined) {
      const payload = decodeCursor(cursor); // ผิดรูป/ถูกแก้ → ERR-VAL-001 (cursor signed)
      if (ISO_RE.test(payload.sortKey) === false) {
        throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "bad_sort_key" } });
      }
      // desc: หน้าถัดไป = (enrolled_at < ts) OR (enrolled_at = ts AND id < lastId)
      query = query.or(
        `enrolled_at.lt.${payload.sortKey},and(enrolled_at.eq.${payload.sortKey},id.lt.${payload.id})`,
      );
    }
    const { data, error } = await query;
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    const rows = (data ?? []) as EnrollmentRow[];
    const resources = rows.map(toEnrollmentResource);
    const page = buildPage({
      rows: resources,
      limit,
      sortKeyOf: (row) => row.enrolledAt,
      idOf: (row) => row.id,
    });
    // list endpoint ตอบ { data, page } ตรง §1.2 — helper กลางของ lib/api/response (C-11)
    return jsonPageOk(page, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

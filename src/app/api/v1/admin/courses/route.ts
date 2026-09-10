/**
 * GET /api/v1/admin/courses — ทุกหลักสูตรทุกสถานะสำหรับหลังบ้าน (Wave C-5 · API-SPECIFICATION §3.8)
 *
 * - requirePermission("course:view") — กันหน้าบ้านที่ไม่ผ่าน RBAC; ขอบเขต "ทุกสถานะ"
 *   บังคับที่ RLS (courses_staff_read — DD §3.2: staff:viewer/staff:content/super_admin
 *   เห็นทุกสถานะ; instructor/registrar/citizen/lawyer ที่ถือ course:view เห็นเฉพาะแถว
 *   ตาม policy ของตัวเอง) — handler ไม่เช็คสถานะซ้ำใน JS (D26)
 * - Rate limit กลุ่ม STAFF_WRITE (§5 — /api/v1/admin/* ทุก method = 60/min ต่อบัญชี + ip;
 *   ตรง ROUTE_RULES ของ lib/rate-limit) — เรียกเองใน handler (middleware ไม่ wire ให้)
 * - cursor (§1.2) = signed (created_at, id) — เรียง created_at desc, id desc; query
 *   limit+1 แถวเพื่อให้ buildPage ตัดสิน hasMore/nextCursor
 * - shape ตรง fixture AdminCourse ที่ UI หลังบ้านใช้ (ผ่าน schemas/admin-catalog) —
 *   ตัดฟิลด์ที่ไม่มีแหล่งในตาราง (updatedAt/credits/learnerCount — เหตุผลที่
 *   schemas/admin-catalog.ts)
 */
import { NextResponse } from "next/server";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import { jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import {
  parseAdminCoursesQuery,
  toAdminCourseResource,
  type AdminCourseRow,
} from "@/lib/schemas/admin-catalog";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select ของ list — category ผูก !left ชัดเจน (ห้ามทิ้งแถวหลักสูตรเมื่อหมวดถูก RLS บังคับ) */
const ADMIN_COURSE_LIST_SELECT =
  "id,code,title_th,title_en,summary,category_id,status,is_public,level,version,language," +
  "published_at,created_at," +
  "category:course_categories!left(id,slug,name_th)," +
  "course_modules(lessons(duration_sec))";

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** or-filter เลื่อน cursor แบบ row-wise (created_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  return `created_at.lt.${payload.sortKey},and(created_at.eq.${payload.sortKey},id.lt.${payload.id})`;
}

/** GET — รายการหลักสูตรทุกสถานะ (RLS กรองตามบทบาท) เรียง created_at ล่าสุดก่อน + cursor */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — ไม่ login → 401 ERR-AUTH-001 · บทบาทบังคับ MFA ยัง aal1 → 403 ERR-AUTH-004 ·
    //    ไม่มี course:view → 403 ERR-RBAC-001
    const { userId } = await requirePermission("course:view");
    // 2) rate STAFF_WRITE (§5 — /admin/* · user_id + ip — D12-11) — หลัง RBAC เพื่อไม่นับ
    //    คำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query กลาง (limit default 20 max 100 — strict)
    const url = new URL(request.url);
    const query = parseAdminCoursesQuery(url.searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const supabase = await createSupabaseSsrClient();
    let builder = supabase
      .from("courses")
      .select(ADMIN_COURSE_LIST_SELECT)
      // ตัดโมดูล/บทเรียนที่ soft-delete ออกจาก metrics (deleted_at — DD §3.2)
      .filter("course_modules.deleted_at", "is", null)
      .filter("course_modules.lessons.deleted_at", "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit + 1);
    if (query.status !== undefined) {
      builder = builder.eq("status", query.status);
    }
    if (query.categoryId !== undefined) {
      builder = builder.eq("category_id", query.categoryId);
    }
    if (query.q !== undefined) {
      // PostgREST or-list ใช้ , ( ) เป็นตัวคั่น — ตัดออกจากคำค้นก่อนฝัง (กันรื้อ syntax)
      const term = query.q.replace(/[,()]/g, " ").trim();
      if (term.length > 0) {
        builder = builder.or(`code.ilike.%${term}%,title_th.ilike.%${term}%`);
      }
    }
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "admin_courses_query_failed" } });
    }
    const rows = (data ?? []) as unknown as readonly AdminCourseRow[];
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => row.created_at,
      idOf: (row) => row.id,
    });
    return new NextResponse(
      JSON.stringify({ data: page.data.map(toAdminCourseResource), page: page.page }),
      { status: 200, headers: jsonResponseHeaders(options) },
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/** header กลางของ 200 — content-type + x-request-id (เหมือน c2/c3) */
function jsonResponseHeaders(options: JsonResponseOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (options.requestId !== undefined) {
    headers["x-request-id"] = options.requestId;
  }
  return headers;
}

/**
 * GET /api/v1/admin/categories — หมวดหลักสูตรทุกสถานะสำหรับหลังบ้าน (Wave C-5 · API-SPECIFICATION §3.8)
 *
 * - requirePermission("course:view") เช่นเดียวกับ /admin/courses; ขอบเขต "ทุกสถานะ"
 *   (รวม is_active=false) บังคับที่ RLS — policy เสริม `cc_read_admin` (DCR-4 · migration
 *   เป็นงานของ C-9) ให้ staff:viewer/staff:content/super_admin เห็นทุกแถว; ก่อน migration
 *   ขึ้น cc_read เดิมจะกรอง is_active=false ออกทั้งที่ผู้ใช้เป็น staff
 * - Rate limit กลุ่ม STAFF_WRITE (§5 — /api/v1/admin/* ทุก method = 60/min ต่อบัญชี + ip;
 *   ตรง ROUTE_RULES ของ lib/rate-limit) — เรียกเองใน handler
 * - courseCount = จำนวนหลักสูตรทุกสถานะในหมวด (นับที่ DB แบบ count exact head ต่อหมวด —
 *   DD §3.2 ไม่มี RPC/view นับ — วนเฉพาะจำนวนหมวดที่ได้มา ซึ่งน้อย — bounded;
 *   RLS กรองหลักสูตรตามบทบาทให้เอง) — pattern เดียวกับ GET /categories ของ c2
 * - shape ตรง fixture AdminCategory (schemas/admin-catalog)
 */
import { NextResponse } from "next/server";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import {
  toAdminCategoryResource,
  type AdminCategoryResourceParsed,
  type AdminCategoryRow,
} from "@/lib/schemas/admin-catalog";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — หมวดทุกสถานะเรียง sort_order แล้ว slug + courseCount ต่อหมวด */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    const { userId } = await requirePermission("course:view");
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase
      .from("course_categories")
      .select("id, slug, name_th, name_en, parent_id, sort_order, is_active")
      .order("sort_order", { ascending: true })
      .order("slug", { ascending: true });
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "admin_categories_query_failed" } });
    }
    const rows = (data ?? []) as readonly AdminCategoryRow[];
    const categories: AdminCategoryResourceParsed[] = [];
    for (const row of rows) {
      const { count, error: countError } = await supabase
        .from("courses")
        .select("id", { count: "exact", head: true })
        .eq("category_id", row.id);
      if (countError !== null) {
        throw new AppError("ERR-SYS-002", { details: { reason: "course_count_query_failed" } });
      }
      categories.push(toAdminCategoryResource(row, count ?? 0));
    }
    return jsonOk(categories, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

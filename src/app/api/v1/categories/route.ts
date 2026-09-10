/**
 * GET /api/v1/categories — รายการหมวดหลักสูตร (Wave C-2 · API-SPECIFICATION §3.3)
 *
 * - Rate limit กลุ่ม PUBLIC_READ (§5) — endpoint เรียกเองใน handler (middleware ไม่ wire ให้)
 * - ทุก query ผ่าน user/anon-JWT client canonical (D26 — src/lib/supabase/ssr) —
 *   RLS ให้เห็นเฉพาะหมวดที่ is_active (DD §3.2) — ไม่เช็คซ้ำใน JS
 * - courseCount = จำนวนหลักสูตรต่อหมวด (นับที่ DB แบบ count exact head ต่อหมวด —
 *   DD §3.2 ไม่มี RPC/view นับ — วนเฉพาะจำนวนหมวดที่ได้มา ซึ่งน้อย — bounded)
 * - shape ตรง fixture แคตตาล็อกที่ UI ใช้: { id, slug, nameTh, nameEn, courseCount }
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** แถว course_categories ที่ handler อ่าน (คอลัมน์จริง snake_case — DD §3.2) */
interface CategoryRow {
  readonly id: string;
  readonly slug: string;
  readonly name_th: string;
  readonly name_en: string | null;
}

/** รูป response ต่อหมวด — ตรง fixture CatalogCategory (camelCase ตาม fixture) */
interface CatalogCategoryItem {
  readonly id: string;
  readonly slug: string;
  readonly nameTh: string;
  readonly nameEn: string | null;
  readonly courseCount: number;
}

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — รายการหมวดเรียงตาม sort_order แล้ว slug (DD §3.2) */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { group: "PUBLIC_READ" });
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase
      .from("course_categories")
      .select("id, slug, name_th, name_en")
      .order("sort_order", { ascending: true })
      .order("slug", { ascending: true });
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "categories_query_failed" } });
    }
    const rows = (data ?? []) as readonly CategoryRow[];
    const categories: CatalogCategoryItem[] = [];
    for (const row of rows) {
      const { count, error: countError } = await supabase
        .from("courses")
        .select("id", { count: "exact", head: true })
        .eq("category_id", row.id);
      if (countError !== null) {
        throw new AppError("ERR-SYS-002", { details: { reason: "course_count_query_failed" } });
      }
      categories.push({
        id: row.id,
        slug: row.slug,
        nameTh: row.name_th,
        nameEn: row.name_en,
        courseCount: count ?? 0,
      });
    }
    return jsonOk(categories, optionsOf(request));
  } catch (error: unknown) {
    return jsonErrorResponse(error, optionsOf(request));
  }
}

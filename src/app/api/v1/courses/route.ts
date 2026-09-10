/**
 * GET /api/v1/courses — แคตตาล็อกหลักสูตร + cursor pagination (Wave C-2 · API-SPECIFICATION §3.3)
 *
 * - Rate limit กลุ่ม PUBLIC_READ (§5) — endpoint เรียกเองใน handler (middleware ไม่ wire ให้)
 * - ทุก query ผ่าน user/anon-JWT client canonical (D26 — src/lib/supabase/ssr) —
 *   RLS ให้เฉพาะ published (guest เห็นเฉพาะ published ตาม DD §3.2) — ไม่เช็คสถานะซ้ำใน JS
 * - cursor (§1.2) = signed (published_at, id) จาก lib/api/pagination (helper ของ C-1) —
 *   เรียง published_at desc, id desc; query limit+1 แถวเพื่อให้ buildPage ตัดสิน hasMore/nextCursor
 * - shape ตรง fixture CourseListItem ที่ UI ใช้ (CAT-002) — ยกเว้นฟิลด์ที่ไม่มีแหล่งใน
 *   DATA-DICTIONARY §3.2: level (ไม่มีคอลัมน์), credits (credit_rules — นอกขอบเขต §3.3),
 *   learnerCount (enrollments ไม่มี SELECT policy ให้ guest — DD §3.2)
 */
import { NextResponse } from "next/server";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import { jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parseCatalogCoursesQuery } from "@/lib/schemas/v1/catalog";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select ของ list — category แบบ !inner + modules→lessons เพื่อ derive lessonCount/durationHours */
const COURSE_LIST_SELECT =
  "id,code,title_th,title_en,summary,status,is_public,published_at," +
  "category:course_categories!inner(id,slug,name_th)," +
  "course_modules(lessons(duration_sec))";

/** แถวที่ handler อ่าน (snake_case ตามคอลัมน์จริง — DD §3.2) */
interface CourseListRow {
  readonly id: string;
  readonly code: string;
  readonly title_th: string;
  readonly title_en: string | null;
  readonly summary: string | null;
  readonly status: string;
  readonly is_public: boolean;
  readonly published_at: string;
  readonly category: {
    readonly id: string;
    readonly slug: string;
    readonly name_th: string;
  };
  readonly course_modules:
    | readonly {
        readonly lessons: readonly { readonly duration_sec: number | null }[];
      }[]
    | null;
}

/** รูป response ต่อรายการ — ตรง fixture CourseListItem (ตัดฟิลด์ที่ไม่มีแหล่งใน DD — ดูหัวไฟล์) */
interface CourseListItem {
  readonly id: string;
  readonly code: string;
  readonly titleTh: string;
  readonly titleEn: string | null;
  readonly summary: string | null;
  readonly category: {
    readonly id: string;
    readonly slug: string;
    readonly nameTh: string;
  };
  readonly status: string;
  readonly isPublic: boolean;
  readonly lessonCount: number;
  readonly durationHours: number;
  readonly publishedAt: string;
}

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** จำนวนบทเรียน + ชั่วโมงเรียน (sum duration_sec — บท document/quiz เป็น NULL จึงเท่า video — fixture) */
function metricsOf(row: CourseListRow): { lessonCount: number; durationHours: number } {
  const lessons = (row.course_modules ?? []).flatMap((module) => module.lessons ?? []);
  const totalSec = lessons.reduce((sum, lesson) => sum + (lesson.duration_sec ?? 0), 0);
  return {
    lessonCount: lessons.length,
    durationHours: Math.round((totalSec / 3600) * 10) / 10,
  };
}

function toListItem(row: CourseListRow): CourseListItem {
  const { lessonCount, durationHours } = metricsOf(row);
  return {
    id: row.id,
    code: row.code,
    titleTh: row.title_th,
    titleEn: row.title_en,
    summary: row.summary,
    category: { id: row.category.id, slug: row.category.slug, nameTh: row.category.name_th },
    status: row.status,
    isPublic: row.is_public,
    lessonCount,
    durationHours,
    publishedAt: row.published_at,
  };
}

/** or-filter เลื่อน cursor แบบ row-wise (published_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  return `published_at.lt.${payload.sortKey},and(published_at.eq.${payload.sortKey},id.lt.${payload.id})`;
}

/** GET — รายการหลักสูตร published (RLS) เรียง published_at ล่าสุดก่อน + cursor pagination */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { group: "PUBLIC_READ" });
    const url = new URL(request.url);
    const query = parseCatalogCoursesQuery(url.searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const supabase = await createSupabaseSsrClient();
    let builder = supabase
      .from("courses")
      .select(COURSE_LIST_SELECT)
      // ตัดโมดูล/บทเรียนที่ soft-delete ออกจาก metrics (deleted_at — DD §3.2)
      .filter("course_modules.deleted_at", "is", null)
      .filter("course_modules.lessons.deleted_at", "is", null)
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit + 1);
    if (query.category !== undefined) {
      builder = builder.eq("course_categories.slug", query.category);
    }
    if (query.q !== undefined) {
      // PostgREST or-list ใช้ , ( ) เป็นตัวคั่น — ตัดออกจากคำค้นก่อนฝัง (กันรื้อ syntax)
      const term = query.q.replace(/[,()]/g, " ").trim();
      if (term.length > 0) {
        builder = builder.or(
          `title_th.ilike.%${term}%,title_en.ilike.%${term}%,summary.ilike.%${term}%`,
        );
      }
    }
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "courses_query_failed" } });
    }
    const rows = (data ?? []) as unknown as readonly CourseListRow[];
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => row.published_at,
      idOf: (row) => row.id,
    });
    const body = {
      data: page.data.map(toListItem),
      page: page.page,
    };
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    const requestId = request.headers.get("x-request-id");
    if (requestId !== null) {
      headers["x-request-id"] = requestId;
    }
    return new NextResponse(JSON.stringify(body), { status: 200, headers });
  } catch (error: unknown) {
    return jsonErrorResponse(error, optionsOf(request));
  }
}

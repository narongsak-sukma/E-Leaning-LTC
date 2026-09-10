/**
 * GET /api/v1/courses — แคตตาล็อกหลักสูตร + cursor pagination (Wave C-2 · API-SPECIFICATION §3.3)
 *
 * - Rate limit กลุ่ม PUBLIC_READ (§5) — endpoint เรียกเองใน handler (middleware ไม่ wire ให้)
 * - ทุก query ผ่าน user/anon-JWT client canonical (D26 — src/lib/supabase/ssr) —
 *   RLS ให้เฉพาะ published (guest เห็นเฉพาะ published ตาม DD §3.2) — ไม่เช็คสถานะซ้ำใน JS
 * - cursor (§1.2) = signed (published_at, id) จาก lib/api/pagination (helper ของ C-1) —
 *   เรียง published_at desc, id desc; query limit+1 แถวเพื่อให้ buildPage ตัดสิน hasMore/nextCursor
 * - shape ตรง CourseListItem ที่ UI ใช้ (CAT-002) — รวมฟิลด์ DCR-4: level (courses.level) +
 *   credits/learnerCount จาก view course_public_stats (query แยกด้วย in-list ของ course ids
 *   แล้ว merge ใน JS — view ไม่มี FK ไป courses จึง embed ไม่ได้ — DD §3.2 views)
 */
import { NextResponse } from "next/server";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import { jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parseCatalogCoursesQuery } from "@/lib/schemas/v1/catalog";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** client ของ request ปัจจุบัน (อนุมานชนิดจาก factory — untyped schema จึง from() ได้ทุกตาราง/view) */
type SupabaseSsr = Awaited<ReturnType<typeof createSupabaseSsrClient>>;

/** select ของ list — category แบบ !inner + modules→lessons เพื่อ derive lessonCount/durationHours */
const COURSE_LIST_SELECT =
  "id,code,title_th,title_en,summary,status,is_public,level,published_at," +
  "category:course_categories!inner(id,slug,name_th)," +
  "course_modules(lessons(duration_sec))";

/** select ของ view course_public_stats (DCR-4) — learner_count + credits ต่อหลักสูตร published */
const COURSE_STATS_SELECT = "course_id,learner_count,credits";

/** แถวที่ handler อ่าน (snake_case ตามคอลัมน์จริง — DD §3.2) */
interface CourseListRow {
  readonly id: string;
  readonly code: string;
  readonly title_th: string;
  readonly title_en: string | null;
  readonly summary: string | null;
  readonly status: string;
  readonly is_public: boolean;
  readonly level: string;
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

/** รูป response ต่อรายการ — ตรง CourseListItem ของ UI (CAT-002 + DCR-4) */
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
  readonly level: string;
  readonly lessonCount: number;
  readonly durationHours: number;
  readonly credits: number;
  readonly learnerCount: number;
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

function toListItem(row: CourseListRow, stats: CourseStats): CourseListItem {
  const { lessonCount, durationHours } = metricsOf(row);
  // ไม่มีแถวใน view (หรือไม่มีกฎ credit ที่ active) → 0 ตามค่าเริ่มต้นของการแสดงผล
  const statsOfCourse = stats.get(row.id);
  return {
    id: row.id,
    code: row.code,
    titleTh: row.title_th,
    titleEn: row.title_en,
    summary: row.summary,
    category: { id: row.category.id, slug: row.category.slug, nameTh: row.category.name_th },
    status: row.status,
    isPublic: row.is_public,
    level: row.level,
    lessonCount,
    durationHours,
    credits: statsOfCourse?.credits ?? 0,
    learnerCount: statsOfCourse?.learnerCount ?? 0,
    publishedAt: row.published_at,
  };
}

/** ผลรวมต่อหลักสูตรจาก view course_public_stats — key ด้วย course_id (merge ใน JS) */
type CourseStats = Map<string, { learnerCount: number; credits: number }>;

/** แถว view course_public_stats (DCR-4) — credits NULL เมื่อไม่มีกฎ credit ที่ active */
interface PublicStatsRow {
  readonly course_id: string;
  readonly learner_count: number;
  readonly credits: number | null;
}

/**
 * อ่าน view course_public_stats ด้วย in-list ของ course ids ของหน้าปัจจุบัน —
 * view ไม่มี FK ไป courses จึง embed ใน select ของ courses ไม่ได้ ต้อง query แยกแล้ว merge
 */
async function statsOf(supabase: SupabaseSsr, ids: readonly string[]): Promise<CourseStats> {
  const stats: CourseStats = new Map();
  if (ids.length === 0) return stats;
  const { data, error } = await supabase
    .from("course_public_stats")
    .select(COURSE_STATS_SELECT)
    .in("course_id", [...ids]);
  if (error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "course_stats_query_failed" } });
  }
  const rows = (data ?? []) as unknown as readonly PublicStatsRow[];
  for (const row of rows) {
    stats.set(row.course_id, { learnerCount: row.learner_count, credits: row.credits ?? 0 });
  }
  return stats;
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
    const stats = await statsOf(supabase, page.data.map((row) => row.id));
    const body = {
      data: page.data.map((row) => toListItem(row, stats)),
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

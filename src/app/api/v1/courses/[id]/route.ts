/**
 * GET /api/v1/courses/{id} — รายละเอียดหลักสูตร + โครงสร้างโมดูล/บทเรียน (Wave C-2 · API-SPECIFICATION §3.3)
 *
 * - Rate limit กลุ่ม PUBLIC_READ (§5) — endpoint เรียกเองใน handler (middleware ไม่ wire ให้)
 * - ทุก query ผ่าน user/anon-JWT client canonical (D26 — src/lib/supabase/ssr) —
 *   RLS บังคับการมองเห็นเอง: guest เห็นเฉพาะ published (draft ของ guest = ไม่พบแถว →
 *   ERR-CRS-001 404 ตาม TC-005 — ไม่เปิดเผยการมีอยู่); draft มองเห็นเฉพาะเจ้าของ/staff:content
 *   ผ่าน RLS เท่านั้น (DD §3.2 courses) — ไม่เช็คสถานะซ้ำใน JS
 * - {id} ไม่ใช่ UUID → ERR-VAL-001 400 (CourseIdParams — lib/schemas/v1/catalog)
 * - shape ตรง CourseDetail ที่ UI ใช้ (CAT-004) — รวมฟิลด์ DCR-4: level + outcomes
 *   (courses.outcome_highlights — NULL → []) + credits/learnerCount (view course_public_stats)
 *   + instructors (view course_instructors_public — เฉพาะ display_name/title/bio ห้าม PII อื่น)
 *   + exam (view course_exam_summary — NULL เมื่อไม่มี assessment ปลายหลักสูตรที่ active)
 */
import { NextResponse } from "next/server";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parseCourseIdParam } from "@/lib/schemas/v1/catalog";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** client ของ request ปัจจุบัน (อนุมานชนิดจาก factory — untyped schema จึง from() ได้ทุกตาราง/view) */
type SupabaseSsr = Awaited<ReturnType<typeof createSupabaseSsrClient>>;

/** select ของ detail — โมดูล + บทเรียนแบบ embedded (RLS สืบตาม courses — DD §3.2) + ฟิลด์ DCR-4 */
const COURSE_DETAIL_SELECT =
  "id,code,title_th,title_en,summary,description_md,status,is_public,level," +
  "outcome_highlights,published_at," +
  "category:course_categories!inner(id,slug,name_th)," +
  "course_modules(id,title_th,sort_order,is_preview,lessons(" +
  "id,type,title_th,duration_sec,is_preview,sort_order))";

/** select ของ views สาธารณะ (DCR-4) — เปิดเฉพาะคอลัมน์ display ตาม DD §3.2 views */
const COURSE_STATS_SELECT = "course_id,learner_count,credits";
const COURSE_INSTRUCTORS_SELECT = "display_name,title,bio";
const COURSE_EXAM_SELECT = "question_count,time_limit_minutes,pass_score_pct,max_attempts";

interface CourseDetailRow {
  readonly id: string;
  readonly code: string;
  readonly title_th: string;
  readonly title_en: string | null;
  readonly summary: string | null;
  readonly description_md: string | null;
  readonly status: string;
  readonly is_public: boolean;
  readonly level: string;
  readonly outcome_highlights: readonly string[] | null;
  readonly published_at: string;
  readonly category: {
    readonly id: string;
    readonly slug: string;
    readonly name_th: string;
  };
  readonly course_modules:
    | readonly {
        readonly id: string;
        readonly title_th: string;
        readonly sort_order: number;
        readonly is_preview: boolean;
        readonly lessons:
          | readonly {
              readonly id: string;
              readonly type: string;
              readonly title_th: string;
              readonly duration_sec: number | null;
              readonly is_preview: boolean;
              readonly sort_order: number;
            }[]
          | null;
      }[]
    | null;
}

interface CourseDetailItem {
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
  readonly categorySlug: string;
  readonly status: string;
  readonly isPublic: boolean;
  readonly level: string;
  readonly lessonCount: number;
  readonly durationHours: number;
  readonly credits: number;
  readonly learnerCount: number;
  readonly publishedAt: string;
  readonly description: string;
  readonly outcomes: readonly string[];
  readonly instructors: readonly {
    readonly nameTh: string;
    readonly titleTh: string | null;
    readonly bio: string | null;
  }[];
  readonly exam:
    | {
        readonly questionCount: number;
        readonly timeLimitMinutes: number;
        readonly passScorePct: number;
        readonly maxAttempts: number;
      }
    | null;
  readonly modules: {
    readonly id: string;
    readonly titleTh: string;
    readonly sortOrder: number;
    readonly isPreview: boolean;
    readonly lessons: {
      readonly id: string;
      readonly type: string;
      readonly titleTh: string;
      readonly durationSec: number | null;
      readonly isPreview: boolean;
    }[];
  }[];
}

/** แถว views สาธารณะ (DCR-4) — snake_case ตามคอลัมน์ view จริง (DD §3.2) */
interface PublicStatsRow {
  readonly course_id: string;
  readonly learner_count: number;
  readonly credits: number | null;
}
interface PublicInstructorRow {
  readonly display_name: string;
  readonly title: string | null;
  readonly bio: string | null;
}
interface PublicExamRow {
  readonly question_count: number;
  readonly time_limit_minutes: number;
  readonly pass_score_pct: number;
  readonly max_attempts: number;
}

function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** จำนวนบทเรียน + ชั่วโมงเรียน (1 ตำแหน่ง) — รูปเดียวกับ deriveCourseMetrics เดิม */
function metricsOf(row: CourseDetailRow): { lessonCount: number; durationHours: number } {
  const lessons = (row.course_modules ?? []).flatMap((module) => module.lessons ?? []);
  const totalSec = lessons.reduce((sum, lesson) => sum + (lesson.duration_sec ?? 0), 0);
  return {
    lessonCount: lessons.length,
    durationHours: Math.round((totalSec / 3600) * 10) / 10,
  };
}

/** เรียงโมดูล/บทเรียนตาม sort_order (DD §3.2 — UNIQUE(module_id, sort_order)) */
function orderedModulesOf(row: CourseDetailRow): CourseDetailItem["modules"] {
  const modules = [...(row.course_modules ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((module) => ({
      id: module.id,
      titleTh: module.title_th,
      sortOrder: module.sort_order,
      isPreview: module.is_preview,
      lessons: [...(module.lessons ?? [])]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((lesson) => ({
          id: lesson.id,
          type: lesson.type,
          titleTh: lesson.title_th,
          durationSec: lesson.duration_sec,
          isPreview: lesson.is_preview,
        })),
    }));
  return modules;
}

/** แถว view course_public_stats → { credits, learnerCount } (credits NULL เมื่อไม่มีกฎ → 0) */
function statsItemOf(row: PublicStatsRow): { credits: number; learnerCount: number } {
  return { credits: row.credits ?? 0, learnerCount: row.learner_count };
}

/** แถว view course_instructors_public → { nameTh, titleTh, bio } — title ที่ view ไม่มี → null */
function instructorOf(row: PublicInstructorRow): CourseDetailItem["instructors"][number] {
  return { nameTh: row.display_name, titleTh: row.title ?? null, bio: row.bio ?? null };
}

/** แถว view course_exam_summary → เงื่อนไขสอบ (CAT-004 AC) — null เมื่อไม่มี assessment active */
function examOf(row: PublicExamRow): NonNullable<CourseDetailItem["exam"]> {
  return {
    questionCount: row.question_count,
    timeLimitMinutes: row.time_limit_minutes,
    passScorePct: row.pass_score_pct,
    maxAttempts: row.max_attempts,
  };
}

/**
 * query views สาธารณะของหลักสูตร (DCR-4) คู่ขนาน — stats + instructors + exam
 * error ใด ๆ ของ view → ERR-SYS-002 แบบ opaque (เหมือน error ของ courses เอง)
 */
async function publicExtrasOf(
  supabase: SupabaseSsr,
  courseId: string,
): Promise<{
  stats: { credits: number; learnerCount: number } | null;
  instructors: CourseDetailItem["instructors"];
  exam: CourseDetailItem["exam"];
}> {
  const [stats, instructors, exam] = await Promise.all([
    supabase
      .from("course_public_stats")
      .select(COURSE_STATS_SELECT)
      .eq("course_id", courseId)
      .maybeSingle(),
    supabase
      .from("course_instructors_public")
      .select(COURSE_INSTRUCTORS_SELECT)
      .eq("course_id", courseId),
    supabase
      .from("course_exam_summary")
      .select(COURSE_EXAM_SELECT)
      .eq("course_id", courseId)
      .maybeSingle(),
  ]);
  if (stats.error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "course_stats_query_failed" } });
  }
  if (instructors.error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "course_instructors_query_failed" } });
  }
  if (exam.error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "course_exam_query_failed" } });
  }
  return {
    stats: stats.data === null ? null : statsItemOf(stats.data as unknown as PublicStatsRow),
    instructors: ((instructors.data ?? []) as unknown as readonly PublicInstructorRow[]).map(instructorOf),
    exam: exam.data === null ? null : examOf(exam.data as unknown as PublicExamRow),
  };
}

function toDetailItem(
  row: CourseDetailRow,
  extras: {
    stats: { credits: number; learnerCount: number } | null;
    instructors: CourseDetailItem["instructors"];
    exam: CourseDetailItem["exam"];
  },
): CourseDetailItem {
  const { lessonCount, durationHours } = metricsOf(row);
  const stats = extras.stats;
  return {
    id: row.id,
    code: row.code,
    titleTh: row.title_th,
    titleEn: row.title_en,
    summary: row.summary,
    category: { id: row.category.id, slug: row.category.slug, nameTh: row.category.name_th },
    categorySlug: row.category.slug,
    status: row.status,
    isPublic: row.is_public,
    level: row.level,
    lessonCount,
    durationHours,
    credits: stats?.credits ?? 0,
    learnerCount: stats?.learnerCount ?? 0,
    publishedAt: row.published_at,
    description: row.description_md ?? "",
    outcomes: row.outcome_highlights ?? [],
    instructors: extras.instructors,
    exam: extras.exam,
    modules: orderedModulesOf(row),
  };
}

/** GET — รายละเอียดหลักสูตร; ไม่พบ/ไม่ published (RLS) → ERR-CRS-001 404 ไม่เปิดเผยการมีอยู่ */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { group: "PUBLIC_READ" });
    const { id } = await params;
    const courseId = parseCourseIdParam(id);
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase
      .from("courses")
      .select(COURSE_DETAIL_SELECT)
      // ตัดโมดูล/บทเรียนที่ soft-delete ออกจากโครงสร้าง/metrics (deleted_at — DD §3.2)
      .filter("course_modules.deleted_at", "is", null)
      .filter("course_modules.lessons.deleted_at", "is", null)
      .eq("id", courseId)
      .maybeSingle();
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "course_query_failed" } });
    }
    if (data === null) {
      throw new AppError("ERR-CRS-001");
    }
    const row = data as unknown as CourseDetailRow;
    const extras = await publicExtrasOf(supabase, courseId);
    const course = toDetailItem(row, extras);
    return jsonOk(course, optionsOf(request));
  } catch (error: unknown) {
    return jsonErrorResponse(error, optionsOf(request));
  }
}

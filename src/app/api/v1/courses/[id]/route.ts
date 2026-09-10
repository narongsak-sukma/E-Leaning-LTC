/**
 * GET /api/v1/courses/{id} — รายละเอียดหลักสูตร + โครงสร้างโมดูล/บทเรียน (Wave C-2 · API-SPECIFICATION §3.3)
 *
 * - Rate limit กลุ่ม PUBLIC_READ (§5) — endpoint เรียกเองใน handler (middleware ไม่ wire ให้)
 * - ทุก query ผ่าน user/anon-JWT client canonical (D26 — src/lib/supabase/ssr) —
 *   RLS บังคับการมองเห็นเอง: guest เห็นเฉพาะ published (draft ของ guest = ไม่พบแถว →
 *   ERR-CRS-001 404 ตาม TC-005 — ไม่เปิดเผยการมีอยู่); draft มองเห็นเฉพาะเจ้าของ/staff:content
 *   ผ่าน RLS เท่านั้น (DD §3.2 courses) — ไม่เช็คสถานะซ้ำใน JS
 * - {id} ไม่ใช่ UUID → ERR-VAL-001 400 (CourseIdParams — lib/schemas/v1/catalog)
 * - shape ตรง fixture CourseDetail (CAT-004) — ยกเว้นฟิลด์ที่ไม่มีแหล่งใน DD §3.2:
 *   outcomes (ไม่มีคอลัมน์), instructors (profiles = PII — RLS ให้เฉพาะเจ้าของแถว/staff
 *   ตาม DD §3.1 จึงเปิดจาก endpoint สาธารณะไม่ได้), exam (assessments — ขอบเขต
 *   GET /assessments/{id} ตาม §3.5 ไม่ใช่ §3.3)
 */
import { NextResponse } from "next/server";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parseCourseIdParam } from "@/lib/schemas/v1/catalog";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select ของ detail — โมดูล + บทเรียนแบบ embedded (RLS สืบตาม courses — DD §3.2) */
const COURSE_DETAIL_SELECT =
  "id,code,title_th,title_en,summary,description_md,status,is_public,published_at," +
  "category:course_categories!inner(id,slug,name_th)," +
  "course_modules(id,title_th,sort_order,is_preview,lessons(" +
  "id,type,title_th,duration_sec,is_preview,sort_order))";

interface CourseDetailRow {
  readonly id: string;
  readonly code: string;
  readonly title_th: string;
  readonly title_en: string | null;
  readonly summary: string | null;
  readonly description_md: string | null;
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
  readonly lessonCount: number;
  readonly durationHours: number;
  readonly publishedAt: string;
  readonly description: string;
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

function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** จำนวนบทเรียน + ชั่วโมงเรียน (1 ตำแหน่ง) — รูปเดียวกับ fixture deriveCourseMetrics */
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

function toDetailItem(row: CourseDetailRow): CourseDetailItem {
  const { lessonCount, durationHours } = metricsOf(row);
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
    lessonCount,
    durationHours,
    publishedAt: row.published_at,
    description: row.description_md ?? "",
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
    const course = toDetailItem(row);
    return jsonOk(course, optionsOf(request));
  } catch (error: unknown) {
    return jsonErrorResponse(error, optionsOf(request));
  }
}

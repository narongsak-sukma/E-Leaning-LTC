/**
 * schemas/admin-catalog — contract ของ Admin catalog BFF (Wave C-5 · API-SPECIFICATION §3.8)
 *
 * - GET /admin/courses → AdminCoursesQuery = PageQuery (§4 #12 — default 20, max 100, strict)
 *   + ฟิลเตอร์ q / status / categoryId ของหลังบ้าน (§3.8 "ทุกหลักสูตรทุกสถานะ")
 * - resource (camelCase ตาม convention §1.1) อิงรูป AdminCourse/AdminCategory ของ
 *   src/lib/fixtures/admin.ts แต่ใช้เฉพาะฟิลด์ที่มีแหล่งจริงในตาราง (DD §3.2 courses /
 *   course_categories):
 *   - `level` — คอลัมน์ courses.level (DD §3.2 DCR-4 · enum course_level) — migration
 *     เติมคอลัมน์นี้เป็นงานของ C-9 (DCR-4); ก่อน migration ขึ้น ตารางยังไม่มีคอลัมน์นี้
 *   - `createdAt` แทน `updatedAt` ของ fixture — ตาราง courses ไม่มีคอลัมน์ updated_at
 *     (มีแค่ created_at / published_at — DD §3.2)
 *   - `credits` / `learnerCount` ไม่มีใน response — ไม่มีแหล่งในตาราง courses; ค่ารวมอยู่ที่
 *     view `course_public_stats` (DCR-4) ซึ่งครอบเฉพาะหลักสูตร published (DD §3.2) จึงไม่ครอบ
 *     แถว draft/pending/archived ของหลังบ้าน
 * - parse ไม่ผ่านทุกกรณี → AppError ERR-VAL-001 (400) พร้อมรายชื่อ field (§2)
 */
import { z } from "zod";
import { AppError } from "../errors";
import { PageQuery } from "./v1/common";

/** สถานะหลักสูตร — enum `course_status` (DD §2 + migration 0001) */
export const ADMIN_COURSE_STATUSES = ["draft", "pending_review", "published", "archived"] as const;

/** ระดับชั้นหลักสูตร — enum `course_level` (DD §2 DCR-4) */
export const ADMIN_COURSE_LEVELS = ["beginner", "intermediate", "advanced"] as const;

/** query ของ GET /admin/courses — limit/cursor มาจาก PageQuery (default 20, max 100 — §1.2) */
export const AdminCoursesQuery = z
  .object({
    ...PageQuery.shape,
    /** ค้นหา code / title_th — handler ตัด `,()` ก่อนฝัง or-syntax (เหมือน c2) */
    q: z.string().trim().min(1).max(120).optional(),
    /** กรองสถานะตาม enum course_status */
    status: z.enum(ADMIN_COURSE_STATUSES).optional(),
    /** กรองตามหมวด — uuid ของ course_categories.id */
    categoryId: z.uuid().optional(),
  })
  .strict();

export type AdminCoursesQueryParsed = z.infer<typeof AdminCoursesQuery>;

/** path/query ของ issue → รายชื่อ field — รูปแบบเดียวกับ parsePageQuery (path ว่าง = "query") */
function valErrorFields(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0 ? path : "query";
      }),
    ),
  ];
}

/** URLSearchParams → parsed AdminCoursesQuery — ผิดรูปแบบทุกกรณี → ERR-VAL-001 + fields */
export function parseAdminCoursesQuery(searchParams: URLSearchParams): AdminCoursesQueryParsed {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = AdminCoursesQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: valErrorFields(parsed.error) } });
  }
  return parsed.data;
}


/** เวลา ISO 8601 (API-SPECIFICATION §1.1 — ยอมทั้ง Z และ +00:00) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** หมวดที่ฝังมากับหลักสูตร — nullable เมื่อ RLS ฝั่งหมวดยังบังคับ (cc_read_admin รอ migration) */
export const AdminCourseCategoryRef = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  nameTh: z.string(),
});

/** resource ของ /admin/courses — อิง fixture AdminCourse + ฟิลด์ที่มีแหล่งจริง (ดูหัวไฟล์) */
export const AdminCourseResource = z.object({
  id: z.string().uuid(),
  code: z.string(),
  titleTh: z.string(),
  titleEn: z.string().nullable(),
  summary: z.string().nullable(),
  categoryId: z.string().uuid(),
  category: AdminCourseCategoryRef.nullable(),
  status: z.enum(ADMIN_COURSE_STATUSES),
  isPublic: z.boolean(),
  level: z.enum(ADMIN_COURSE_LEVELS),
  version: z.number().int(),
  language: z.string(),
  lessonCount: z.number().int().min(0),
  durationHours: z.number(),
  publishedAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
});

export type AdminCourseResourceParsed = z.infer<typeof AdminCourseResource>;

/** แถว courses ที่ handler อ่าน (snake_case ตามคอลัมน์จริง — DD §3.2 · embeds แบบ PostgREST) */
export interface AdminCourseRow {
  readonly id: string;
  readonly code: string;
  readonly category_id: string;
  title_th: string;
  title_en: string | null;
  readonly summary: string | null;
  status: string;
  is_public: boolean;
  level: string;
  version: number;
  language: string;
  published_at: string | null;
  created_at: string;
  readonly category: {
    readonly id: string;
    readonly slug: string;
    readonly name_th: string;
  } | null;
  readonly course_modules:
    | readonly {
        readonly lessons: readonly { readonly duration_sec: number | null }[];
      }[]
    | null;
}

/** จำนวนบทเรียน + ชั่วโมงเรียน (sum duration_sec — 1 ตำแหน่ง) — สูตรเดียวกับ c2 (courses list) */
export function deriveAdminCourseMetrics(
  row: Pick<AdminCourseRow, "course_modules">,
): { lessonCount: number; durationHours: number } {
  const lessons = (row.course_modules ?? []).flatMap((module) => module.lessons ?? []);
  const totalSec = lessons.reduce((sum, lesson) => sum + (lesson.duration_sec ?? 0), 0);
  return {
    lessonCount: lessons.length,
    durationHours: Math.round((totalSec / 3600) * 10) / 10,
  };
}

/** map แถว DB → resource (camelCase) — status/level เป็น cast ได้เพราะ DB enum กำหนดชุดค่าไว้ */
export function toAdminCourseResource(row: AdminCourseRow): AdminCourseResourceParsed {
  const { lessonCount, durationHours } = deriveAdminCourseMetrics(row);
  const category = row.category;
  return {
    id: row.id,
    code: row.code,
    titleTh: row.title_th,
    titleEn: row.title_en,
    summary: row.summary,
    categoryId: row.category_id,
    category:
      category === null
        ? null
        : { id: category.id, slug: category.slug, nameTh: category.name_th },
    status: row.status as AdminCourseResourceParsed["status"],
    isPublic: row.is_public,
    level: row.level as AdminCourseResourceParsed["level"],
    version: row.version,
    language: row.language,
    lessonCount,
    durationHours,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

/** resource ของ /admin/categories — อิง fixture AdminCategory + courseCount (§3.8 ทุกสถานะ) */
export const AdminCategoryResource = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  parentId: z.string().uuid().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  courseCount: z.number().int().min(0),
});

export type AdminCategoryResourceParsed = z.infer<typeof AdminCategoryResource>;

/** แถว course_categories ที่ handler อ่าน (คอลัมน์จริง snake_case — DD §3.2) */
export interface AdminCategoryRow {
  readonly id: string;
  readonly slug: string;
  readonly name_th: string;
  readonly name_en: string | null;
  readonly parent_id: string | null;
  readonly sort_order: number;
  readonly is_active: boolean;
}

/**
 * map แถว DB → resource — isActive คงค่าจริง (หลังบ้านเห็นทุกสถานะรวม is_active=false);
 * courseCount นับที่ handler (count exact head ต่อหมวด — RLS กรองตามบทบาทให้เอง)
 */
export function toAdminCategoryResource(
  row: AdminCategoryRow,
  courseCount: number,
): AdminCategoryResourceParsed {
  return {
    id: row.id,
    slug: row.slug,
    nameTh: row.name_th,
    nameEn: row.name_en,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    courseCount,
  };
}

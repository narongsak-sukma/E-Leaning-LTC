/**
 * แคตตาล็อกหลักสูตร — ชั้นอ่านข้อมูลของ UI (lane C-6 Phase 1)
 *
 * Phase 1: body ของ getPublishedCourses()/getCategories()/findPublishedCourse() เป็นการ
 * fetch BFF จริง (GET /api/v1/courses · GET /api/v1/categories · GET /api/v1/courses/{id} —
 * API-SPECIFICATION 1.0.2 §3.3 + DCR-4) — ลายเซ็น (signatures) คงเดิม component ไม่ต้องรื้อโครง
 *
 * - ข้อมูลจำลอง (fixture) ถูกถอดออกจาก production path ทั้งหมด — เหลือเฉพาะ type + ผู้ช่วยแสดงผล
 * - ไฟล์นี้ client-safe: ห้าม import next/headers/server-only (CourseCard ฝั่ง client
 *   import ผู้ช่วยแสดงผลจากที่นี่) — Server Component ใช้ catalog.server.ts ซึ่งผูก origin
 *   จาก config + forward cookie ให้ (แบบเดียวกับ learning.ts ↔ learning.server.ts)
 * - ทุกการอ่านข้อมูลผ่าน BFF เท่านั้น — RLS บังคับการมองเห็นฝั่ง DB (guest เห็นเฉพาะ published)
 */

export type CourseStatus = "draft" | "pending_review" | "published" | "archived";
export type LessonType = "video" | "document" | "quiz";
export type CourseLevel = "beginner" | "intermediate" | "advanced";

/** GET /categories → { data } — DD §3.2 course_categories (โครง 1 ระดับ) */
export interface CatalogCategory {
  id: string;
  slug: string;
  nameTh: string;
  nameEn: string | null;
  courseCount: number;
}

/** วิทยากร (CAT-004 AC: แสดงชื่อวิทยากร) — view course_instructors_public (DCR-4) */
export interface CourseInstructor {
  nameTh: string;
  /** view ไม่มีคอลัมน์ title (หรือ NULL) → null */
  titleTh: string | null;
  bio: string | null;
}

/** เงื่อนไขสอบปลายหลักสูตร (CAT-004 AC: จำนวนครั้ง เกณฑ์ผ่าน เวลา) — view course_exam_summary */
export interface CourseExam {
  questionCount: number;
  timeLimitMinutes: number;
  passScorePct: number;
  maxAttempts: number;
}

/** บทเรียน — DD §3.2 lessons (type เป็น enum ของ DD) */
export interface CourseLesson {
  id: string;
  type: LessonType;
  titleTh: string;
  /** วินาที (type="video") — null สำหรับ document/quiz */
  durationSec: number | null;
  isPreview: boolean;
}

/** โมดูล — DD §3.2 course_modules */
export interface CourseModule {
  id: string;
  titleTh: string;
  sortOrder: number;
  isPreview: boolean;
  lessons: CourseLesson[];
}

/** GET /courses → { data: CourseListItem[], page } — CAT-002 AC (ชื่อ/หมวด/ชั่วโมง/credit/กลุ่มเป้าหมาย) */
export interface CourseListItem {
  id: string;
  code: string;
  titleTh: string;
  titleEn: string | null;
  summary: string | null;
  category: { id: string; slug: string; nameTh: string };
  status: CourseStatus;
  /** false = เฉพาะทนายความที่ผูกใบอนุญาต (CAT-007) */
  isPublic: boolean;
  level: CourseLevel;
  lessonCount: number;
  /** ชั่วโมงเรียน (1 ตำแหน่ง) */
  durationHours: number;
  credits: number;
  learnerCount: number;
  publishedAt: string;
}

/** GET /courses/{id} → { data: CourseDetail } — CAT-004 (โครงสร้างโมดูล/บทเรียน + เงื่อนไขสอบ + วิทยากร) */
export interface CourseDetail extends CourseListItem {
  categorySlug: string;
  description: string;
  /** จุดเด่นหลักสูตร (ต้นแบบ "สิ่งที่จะได้เรียนรู้") — courses.outcome_highlights (NULL → []) */
  outcomes: string[];
  instructors: CourseInstructor[];
  exam: CourseExam | null;
  modules: CourseModule[];
}

/** Envelope §1.2 (cursor-based) — รูปเดียวกับ BFF GET /api/v1/courses */
export interface CourseListResponse {
  data: CourseListItem[];
  page: { nextCursor: string | null; hasMore: boolean };
}

/** ───────────────────────── การเรียก BFF (absolute-origin helper) ───────────────────────── */

/**
 * ตัวเลือกของการเรียก API — browser ไม่ต้องส่ง (same-origin เอง);
 * server/RSC ต้องส่ง origin (+ cookieHeader ถ้าต้องการ session) ผ่าน catalog.server.ts
 */
export interface CatalogFetchOptions {
  /** origin สัมบูรณ์ — บังคับเมื่อเรียกจากฝั่ง server (RSC) */
  origin?: string;
  /** ค่า header Cookie ที่ forward จาก request ปัจจุบัน (server เท่านั้น) */
  cookieHeader?: string;
}

/** หา origin ของการเรียก — บังคับ fail-loud ฝั่ง server ที่ไม่ส่ง (กันหลุดไป localhost โดยไม่ตั้งใจ) */
function resolveOrigin(options?: CatalogFetchOptions): string {
  if (options?.origin !== undefined && options.origin.length > 0) {
    return options.origin;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  throw new Error("ต้องระบุ origin ใน CatalogFetchOptions เมื่อเรียก API แคตตาล็อกจากฝั่ง server (RSC) — ใช้ catalog.server.ts");
}

/** รูปที่ BFF ตอบ (camelCase) — status/level เป็น string ของ enum ใน DD §3.2 ที่ UI ต้องการแคบลง */
type CourseListItemWire = Omit<CourseListItem, "status" | "level"> & {
  status: string;
  level: string;
};

/** รูปที่ BFF ตอบสำหรับ detail — เหมือน list แต่เพิ่มฟิลด์ CAT-004/DCR-4 */
type CourseDetailWire = Omit<CourseDetail, "status" | "level"> & {
  status: string;
  level: string;
};

/** แคบ string ของ DB enum (DD §3.2) ให้เป็น union ที่ UI ใช้ — ค่านอกชุด = ค่า default ของ DD */
function toCourseListItem(item: CourseListItemWire): CourseListItem {
  return {
    ...item,
    status: item.status as CourseStatus,
    level: item.level as CourseLevel,
  };
}

/** แคบ string ของ DB enum + normalize ค่าที่เป็น null ได้ (outcomes/instructors/exam) */
function toCourseDetail(item: CourseDetailWire): CourseDetail {
  return {
    ...item,
    status: item.status as CourseStatus,
    level: item.level as CourseLevel,
    outcomes: item.outcomes ?? [],
    instructors: item.instructors ?? [],
    exam: item.exam ?? null,
  };
}

/** fetch BFF — no-store (ข้อมูลแคตตาล็อกต้องสด) + คืน Response ให้ผู้เรียกตรวจ status เอง */
async function fetchCatalog(path: string, options?: CatalogFetchOptions): Promise<Response> {
  const origin = resolveOrigin(options);
  const headersInit: Record<string, string> = {};
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headersInit.cookie = options.cookieHeader;
  }
  // gate-cleanup r1 M1: ขาเรียกจาก server (RSC loader) ประกาศตัวเป็นขาใน — middleware
  // เห็น header นี้แล้วจะไม่หมุน token (Set-Cookie ของขาในไม่มีทางถึง browser — RSC
  // ตั้ง cookie เองไม่ได้ หมุนตรงนั้น = ทิ้ง rotation กลางอากาศ) · เฉพาะฝั่ง server
  // เท่านั้น (typeof window) — บราวเซอร์เรียกโมดูลนี้เองได้แบบไม่มี cookieHeader
  if (typeof window === "undefined") {
    headersInit["x-ltc-bff-internal"] = "1";
  }
  try {
    return await fetch(`${origin}${path}`, {
      cache: "no-store",
      credentials: "same-origin",
      ...(Object.keys(headersInit).length > 0 ? { headers: headersInit } : {}),
    });
  } catch (cause: unknown) {
    throw new Error(`เรียก API แคตตาล็อกไม่สำเร็จ (${path})`, { cause });
  }
}

/** ───────────────────────── ตัวอ่านข้อมูลหลัก (options สำหรับฝั่ง server — ดู catalog.server.ts) ───────────────────────── */

/** GET /api/v1/courses → { data, page } — คืนเฉพาะ published (RLS) เรียง published_at ล่าสุดก่อน */
export async function getPublishedCourses(
  options?: CatalogFetchOptions,
): Promise<CourseListResponse> {
  const response = await fetchCatalog("/api/v1/courses", options);
  if (!response.ok) {
    throw new Error(`API แคตตาล็อกตอบ ${response.status} (GET /api/v1/courses)`);
  }
  const body = (await response.json()) as { data: CourseListItemWire[]; page: CourseListResponse["page"] };
  return {
    data: body.data.map(toCourseListItem),
    page: body.page,
  };
}

/** GET /api/v1/categories → { data } — เฉพาะหมวดที่ is_active (RLS) พร้อม courseCount */
export async function getCategories(options?: CatalogFetchOptions): Promise<CatalogCategory[]> {
  const response = await fetchCatalog("/api/v1/categories", options);
  if (!response.ok) {
    throw new Error(`API แคตตาล็อกตอบ ${response.status} (GET /api/v1/categories)`);
  }
  const body = (await response.json()) as { data: CatalogCategory[] };
  return body.data;
}

/**
 * GET /api/v1/courses/{id} → { data } — ไม่เจอ (404 ERR-CRS-001: draft/ไม่มีจริง) = undefined
 * → หน้าเว็บ notFound(); error อื่น (เช่น 5xx) throw เป็นภาษาไทยให้ error boundary จัดการ
 */
export async function findPublishedCourse(
  id: string,
  options?: CatalogFetchOptions,
): Promise<CourseDetail | undefined> {
  const response = await fetchCatalog(`/api/v1/courses/${encodeURIComponent(id)}`, options);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`API แคตตาล็อกตอบ ${response.status} (GET /api/v1/courses/{id})`);
  }
  const body = (await response.json()) as { data: CourseDetailWire };
  return toCourseDetail(body.data);
}

/** ───────────────────────── ผู้ช่วยแสดงผล (ภาษาไทย) ───────────────────────── */

const LEVEL_LABELS: Record<CourseLevel, string> = {
  beginner: "ระดับเริ่มต้น",
  intermediate: "ระดับกลาง",
  advanced: "ระดับสูง",
};

export function courseLevelLabel(level: CourseLevel): string {
  return LEVEL_LABELS[level];
}

/** "6 ชั่วโมง" / "4.4 ชั่วโมง" — ตัวเลขอารบิก ตาม DS §9 */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ชั่วโมง`;
}

/** "25:00" จากวินาที — tabular-nums */
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** วันที่พุทธศักราช "12 สิงหาคม 2569" — DS §9 (Intl th-TH + buddhist calendar) */
export function formatThaiDate(iso: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    calendar: "buddhist",
  }).format(new Date(iso));
}

/** จำนวนผู้เรียน "3,412" — อารบิก + คั่นหลักตามแนวราชการ */
export function formatLearnerCount(n: number): string {
  return new Intl.NumberFormat("th-TH").format(n);
}

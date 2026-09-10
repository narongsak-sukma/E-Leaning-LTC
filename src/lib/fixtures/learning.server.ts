/**
 * learning.server — loaders ฝั่ง Server Component (RSC) ของผู้เรียน (Phase 1)
 *
 * - ประสาน data layer ใน ./learning ผ่าน BFF: แนบ origin จาก config (PUBLIC_BASE_URL)
 *   และ forward cookie ของ request ให้ BFF เสมอ (fetch จาก RSC ไม่แนบ cookie ให้เอง)
 * - เนื้อหาบทเรียน (PB-12): §3.4 ยังไม่มี endpoint เนื้อหาบทเรียน/media จึงอ่าน lessons
 *   ตรงจาก DB ด้วย JWT ของผู้ใช้ (createSupabaseSsrClient — แบบเดียวกับ route ของ BFF)
 *   RLS เป็นผู้ตัดสินการมองเห็นเสมอ (lessons_read / media_read)
 * - server-only: ห้าม import เข้า Client Component (ป้องกัน config/cookie เข้า browser bundle)
 * - แผนที่ error ของ BFF เป็นสถานะหน้าเว็บ: ไม่ login → unauthenticated · ยังไม่ลงทะเบียน →
 *   not_enrolled · ไม่พบหลักสูตร/บทเรียน → not_found · อื่น ๆ → unavailable
 */
import "server-only";

import { cookies } from "next/headers";

import { getConfig } from "@/lib/config";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

import {
  ApiError,
  buildCourseOutline,
  buildEnrolledCourseCard,
  findLessonNeighbors,
  getCourseDetail,
  getCourseProgress,
  getLessonQuiz,
  getMyEnrollments,
  lessonLabelInOutline,
  resolveCurrentLesson,
  type CourseDetailSummary,
  type EnrolledCourseCard,
  type CourseOutline,
  type CourseProgress,
  type EnrollmentSummary,
  type FetchCallOptions,
  type LessonQuizView,
  type LessonSummary,
  type OutlineLesson,
} from "./learning";

/** สถานะผิดพลาดของหน้า — UI แสดงข้อความไทยต่างกันตามชนิด (DESIGN-SYSTEM §5.12) */
export type LearnerPageError =
  | { kind: "unauthenticated" }
  | { kind: "not_enrolled" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

/** ข้อมูลหน้า "หลักสูตรของฉัน" — สถานะว่าง/ผิดพลาด/พร้อมแสดง */
export type MyCoursesPageData =
  | { kind: "empty" }
  | { kind: "error" }
  | { kind: "ready"; courses: readonly EnrolledCourseCard[]; hasMore: boolean };

/** แบบทดสอบที่พร้อมทำ — โจทย์จาก GET /lessons/{id}/quiz (ไม่มีเฉลย — DCR-5) */
export interface QuizPanelData {
  lessonId: string;
  title: string;
  passPct: number;
  maxAttempts: number | null;
  questions: LessonQuizView["questions"];
}

/**
 * เนื้อหาบทเรียนที่หน้า learn เรนเดอร์ตามชนิดบทเรียน — src/paragraphs มาจากข้อมูลจริง
 * (lessons.content_md / media_assets ที่ RLS ให้อ่านได้) ไม่ใช่ค่า hardcode (PB-12)
 */
export type LessonContent =
  | {
      kind: "video";
      lessonId: string;
      title: string;
      /** URL วิดีโอจาก media_assets ที่ RLS ให้อ่านได้ — null = ไม่มี URL ที่อ่านได้ (placeholder ไทย) */
      src: string | null;
      durationSeconds: number;
      initialPositionSeconds: number;
    }
  | {
      kind: "document";
      lessonId: string;
      title: string;
      documentTitle: string;
      paragraphs: readonly string[];
    }
  | { kind: "quiz"; panel: QuizPanelData }
  | { kind: "quiz_unavailable"; lessonId: string; title: string };

export interface LessonWorkspaceData {
  outline: CourseOutline;
  currentLessonId: string;
  breadcrumbLabel: string;
  prev: LessonSummary | null;
  next: LessonSummary | null;
  lesson: LessonContent;
}

export type LessonWorkspace = { kind: "ready"; data: LessonWorkspaceData } | LearnerPageError;

/**
 * สถานะผู้ชมของหลักสูตรบนหน้ารายละเอียด (PB-12) — กำหนด CTA:
 * guest → /login?next= · not_enrolled → ปุ่มลงทะเบียน · enrolled → เข้าเรียนต่อ
 */
export type CourseViewerGate =
  | { kind: "guest" }
  | { kind: "not_enrolled" }
  | { kind: "enrolled"; status: EnrollmentSummary["status"] };

/**
 * ตรวจสถานะการลงทะเบียนของผู้ชมต่อหลักสูตร (หน้ารายละเอียดหลักสูตร — PB-12)
 *
 * - ผ่าน BFF จริง (GET /me/enrollments — RLS เจ้าของ): 401 = guest · พบแถว = enrolled
 * - แถวที่ expired/cancelled นับเป็น not_enrolled เพราะ RPC enroll() ปฏิเสธซ้ำด้วย
 *   ERR-ENR-001 อยู่แล้ว (0011_functions.sql unique_violation) — ให้ผู้เรียนเห็นปุ่ม
 *   ลงทะเบียนและได้ข้อความจริงจาก BFF แทนการเดาแทน
 * - ระบบขัดข้อง (ไม่ใช่ 401) → not_enrolled: ปุ่มลงทะเบียนยังแสดงและจะได้ error
 *   จริงจาก envelope ของ BFF ตอนกด (ไม่ปิดกั้นการใช้งานด้วยข้อผิดพลาดของการตรวจสถานะ)
 */
export async function loadCourseViewerGate(courseId: string): Promise<CourseViewerGate> {
  const context = await serverContext();
  try {
    const page = await getMyEnrollments(context);
    const existing = page.enrollments.find((enrollment) => enrollment.courseId === courseId);
    if (existing === undefined) {
      return { kind: "not_enrolled" };
    }
    if (existing.status === "expired" || existing.status === "cancelled") {
      return { kind: "not_enrolled" };
    }
    return { kind: "enrolled", status: existing.status };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: "guest" };
    }
    return { kind: "not_enrolled" };
  }
}

/**
 * แถวบทเรียนที่ผู้เรียนอ่านได้จริง (RLS lessons_read) — เนื้อหาเอกสาร + media ที่ฝังผ่าน
 * lessons.media_id (media ฝังได้เท่าที่ RLS media_read อนุญาต — ผู้เรียนยังไม่ผ่าน policy
 * จึงเป็น null และหน้าเว็บแสดง placeholder ไทยแทน URL ปลอม)
 */
interface LessonSourceRow {
  readonly contentMd: string | null;
  readonly media: {
    readonly provider: string;
    readonly bucket: string;
    readonly storagePath: string;
    readonly status: string;
  } | null;
}

/** อ่านบทเรียนจาก DB ด้วย JWT ของผู้ใช้ — query ล้มเหลว = ไม่มีเนื้อหา (placeholder) ไม่พังหน้า */
async function loadLessonSourceRow(lessonId: string): Promise<LessonSourceRow | null> {
  const supabase = await createSupabaseSsrClient();
  const { data } = await supabase
    .from("lessons")
    .select("content_md, media:media_assets(provider,bucket,storage_path,status)")
    .eq("id", lessonId)
    .maybeSingle();
  if (data === null || typeof data !== "object") {
    return null;
  }
  const row = data as unknown as {
    content_md: unknown;
    media: {
      provider: unknown;
      bucket: unknown;
      storage_path: unknown;
      status: unknown;
    } | null;
  };
  const media =
    row.media === null || typeof row.media !== "object"
      ? null
      : {
          provider: typeof row.media.provider === "string" ? row.media.provider : "",
          bucket: typeof row.media.bucket === "string" ? row.media.bucket : "",
          storagePath: typeof row.media.storage_path === "string" ? row.media.storage_path : "",
          status: typeof row.media.status === "string" ? row.media.status : "",
        };
  return {
    contentMd: typeof row.content_md === "string" ? row.content_md : null,
    media:
      media !== null && media.bucket.length > 0 && media.storagePath.length > 0 ? media : null,
  };
}

/**
 * แยกเนื้อหา markdown (lessons.content_md) เป็นย่อหน้าสำหรับ DocumentViewer —
 * ย่อหน้าคั่นด้วยบรรทัดว่าง · ตัดมาร์กอัปหัวข้อ/บุลเล็ต/อ้างอิงหัวแถวออกให้เหลือข้อความ
 * (DocumentViewer เรนเดอร์เป็น <p> ข้อความ — ไม่มี markdown renderer ใน Phase 1)
 */
export function paragraphsOfContentMd(contentMd: string | null): readonly string[] {
  if (contentMd === null || contentMd.trim().length === 0) {
    return [];
  }
  return contentMd
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?)/, "").trim())
        .join(" ")
        .trim(),
    )
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * URL วิดีโอจากแถว media_assets ที่ RLS ให้อ่านได้จริง — เฉพาะ supabase_storage สถานะ ready
 * (สร้าง signed URL ด้วยสิทธิ์ผู้ใช้ — TTL ตาม config MEDIA_SIGNED_URL_TTL_SEC) ·
 * อ่านไม่ได้/provider อื่น (r2/stream ยังไม่มี CDN config) = null → placeholder ไทย ห้ามปลอม URL
 */
export async function resolveLessonMediaUrl(
  media: LessonSourceRow["media"],
): Promise<string | null> {
  if (media === null || media.status !== "ready") {
    return null;
  }
  const config = getConfig();
  if (config.mediaProvider !== "supabase_storage" || media.provider !== "supabase_storage") {
    return null;
  }
  const supabase = await createSupabaseSsrClient();
  const { data } = await supabase.storage
    .from(media.bucket)
    .createSignedUrl(media.storagePath, config.mediaSignedUrlTtlSec);
  return data?.signedUrl ?? null;
}

/** แผนที่ unknown → สถานะหน้า (401/LRN-001/404/unavailable) — ข้อความไทยเขียนที่หน้าเว็บ */
function toPageError(error: unknown): LearnerPageError {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return { kind: "unauthenticated" };
    }
    if (error.code === "ERR-LRN-001") {
      return { kind: "not_enrolled" };
    }
    if (error.code === "ERR-CRS-001" || error.status === 404) {
      return { kind: "not_found" };
    }
  }
  return { kind: "unavailable" };
}

/** บริบทการเรียก BFF จาก RSC — origin จาก config + forward cookie session ของ request ปัจจุบัน */
async function serverContext(): Promise<FetchCallOptions> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return cookieHeader.length > 0
    ? { origin: getConfig().publicBaseUrl, cookieHeader }
    : { origin: getConfig().publicBaseUrl };
}

/** หน้า "หลักสูตรของฉัน" — รวม enrollments + โครงสร้างหลักสูตร + ความคืบหน้าต่อหลักสูตร */
export async function loadMyCoursesPageData(): Promise<MyCoursesPageData> {
  const context = await serverContext();
  let page: { enrollments: readonly EnrollmentSummary[]; hasMore: boolean };
  try {
    page = await getMyEnrollments(context);
  } catch {
    // 401 ตรงนี้ = session หมดระหว่างทาง — แสดงสถานะ error ให้ผู้เรียน reload แทนการเดา
    return { kind: "error" };
  }
  if (page.enrollments.length === 0) {
    return { kind: "empty" };
  }
  const courses = await Promise.all(
    page.enrollments.map(async (enrollment) => {
      const [detail, progress] = await Promise.all([
        getCourseDetail(enrollment.courseId, context).catch(() => null),
        getCourseProgress(enrollment.courseId, context).catch(() => null),
      ]);
      return buildEnrolledCourseCard(enrollment, detail, progress);
    }),
  );
  return { kind: "ready", courses, hasMore: page.hasMore };
}

/**
 * หน้าบทเรียน — รวมโครงสร้างหลักสูตร + ความคืบหน้า + โจทย์ quiz ของบทปัจจุบัน
 * (โจทย์ fetch ฝั่ง server แล้วส่งเป็น props ให้ QuizPanel — เฉลยไม่เคยอยู่ฝั่ง client ก่อนส่ง — DCR-5)
 */
export async function loadLessonWorkspace(
  courseId: string,
  lessonIdParam: string | undefined,
): Promise<LessonWorkspace> {
  const context = await serverContext();
  let detail: CourseDetailSummary;
  let progress: CourseProgress;
  try {
    [detail, progress] = await Promise.all([
      getCourseDetail(courseId, context),
      getCourseProgress(courseId, context),
    ]);
  } catch (error: unknown) {
    return toPageError(error);
  }
  const outline = buildCourseOutline(detail, progress);
  const requestedId =
    lessonIdParam !== undefined && lessonIdParam.length > 0 ? lessonIdParam : null;
  // ระบุ lessonId → ค้นแบบเข้ม (ไม่พบ = ไม่พบจริง) · ไม่ระบุ → บทที่ค้าง แล้ว fallback บทแรก (LRN-009)
  const current = requestedId !== null
    ? findOutlineLesson(outline, requestedId)
    : resolveCurrentLesson(outline, undefined);
  if (current === null) {
    return { kind: "not_found" };
  }
  const neighbors = findLessonNeighbors(outline, current.lesson.id);
  const label = lessonLabelInOutline(outline, current.lesson.id) ?? current.lesson.title;
  let lesson: LessonContent;
  if (current.lesson.type === "quiz") {
    let quiz: LessonQuizView | null;
    try {
      quiz = await getLessonQuiz(current.lesson.id, context);
    } catch {
      quiz = null;
    }
    lesson =
      quiz === null
        ? { kind: "quiz_unavailable", lessonId: current.lesson.id, title: current.lesson.title }
        : {
            kind: "quiz",
            panel: {
              lessonId: current.lesson.id,
              title: current.lesson.title,
              passPct: quiz.passPct,
              maxAttempts: quiz.maxAttempts,
              questions: quiz.questions,
            },
          };
  } else if (current.lesson.type === "document") {
    // เนื้อหาเอกสารจริงจาก lessons.content_md (RLS lessons_read — ผู้เรียนที่ลงทะเบียน
    // หรือบท is_preview อ่านได้เอง) — §3.4 ยังไม่มี endpoint เนื้อหาบทเรียน จึงอ่านตรงจาก
    // DB ด้วย JWT ของผู้ใช้ (แบบเดียวกับ route ของ BFF) · อ่านไม่ได้/ไม่มีเนื้อหา =
    // ย่อหน้าว่าง → DocumentViewer แสดงสถานะว่างภาษาไทยและยังไม่เปิดยืนยันการอ่าน
    const source = await loadLessonSourceRow(current.lesson.id);
    lesson = {
      kind: "document",
      lessonId: current.lesson.id,
      title: current.lesson.title,
      documentTitle: current.lesson.title,
      paragraphs: paragraphsOfContentMd(source?.contentMd ?? null),
    };
  } else {
    // วิดีโอ — URL จาก media_assets ที่ฝังผ่าน lessons.media_id (RLS media_read ปัจจุบัน
    // จำกัด instructor/staff — ผู้เรียนยังไม่ผ่าน policy จึงได้ null → placeholder ไทย
    // ห้ามปลอม URL ผ่าน) เมื่อ Wave ถัดไปเปิดสิทธิ์ media/storage ให้ผู้เรียน URL ไหลผ่านเส้นนี้ทันที
    const source = await loadLessonSourceRow(current.lesson.id);
    const durationSeconds = durationOf(detail, current.lesson.id) ?? 0;
    const initialPositionSeconds =
      current.lesson.status === "completed" || durationSeconds <= 0
        ? 0
        : Math.min(durationSeconds, Math.round((current.lesson.watchPct / 100) * durationSeconds));
    lesson = {
      kind: "video",
      lessonId: current.lesson.id,
      title: current.lesson.title,
      src: await resolveLessonMediaUrl(source?.media ?? null),
      durationSeconds,
      initialPositionSeconds,
    };
  }
  return {
    kind: "ready",
    data: {
      outline,
      currentLessonId: current.lesson.id,
      breadcrumbLabel: label,
      prev: neighbors?.prev ?? null,
      next: neighbors?.next ?? null,
      lesson,
    },
  };
}

/** ความยาววิดีโอของบทเรียนจากโครงสร้างหลักสูตร (GET /courses/{id}) — ไม่พบ = null */
function durationOf(detail: CourseDetailSummary, lessonId: string): number | null {
  for (const moduleRow of detail.modules) {
    for (const lesson of moduleRow.lessons) {
      if (lesson.id === lessonId) {
        return lesson.durationSeconds;
      }
    }
  }
  return null;
}

/** ค้นบทเรียนใน outline แบบเข้ม (ใช้เมื่อผู้เรียนระบุ lessonId มาเอง — ไม่พบ = null) */
function findOutlineLesson(outline: CourseOutline, lessonId: string): { lesson: OutlineLesson } | null {
  for (const moduleRow of outline.modules) {
    const found = moduleRow.lessons.find((lesson) => lesson.id === lessonId);
    if (found !== undefined) {
      return { lesson: found };
    }
  }
  return null;
}

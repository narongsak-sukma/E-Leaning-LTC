/**
 * learning.server — loaders ฝั่ง Server Component (RSC) ของผู้เรียน (Phase 1)
 *
 * - ประสาน data layer ใน ./learning ให้หน้า learner: แนบ origin จาก config (PUBLIC_BASE_URL)
 *   และ forward cookie ของ request ให้ BFF เสมอ (fetch จาก RSC ไม่แนบ cookie ให้เอง)
 * - server-only: ห้าม import เข้า Client Component (ป้องกัน config/cookie เข้า browser bundle)
 * - แผนที่ error ของ BFF เป็นสถานะหน้าเว็บ: ไม่ login → unauthenticated · ยังไม่ลงทะเบียน →
 *   not_enrolled · ไม่พบหลักสูตร/บทเรียน → not_found · อื่น ๆ → unavailable
 */
import "server-only";

import { cookies } from "next/headers";

import { getConfig } from "@/lib/config";

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

/** เนื้อหาบทเรียนที่หน้า learn เรนเดอร์ตามชนิดบทเรียน */
export type LessonContent =
  | {
      kind: "video";
      lessonId: string;
      title: string;
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
    // เนื้อหาเอกสารอยู่นอก /api/v1 (SDS §1-1) — §3.4 ยังไม่มี endpoint เนื้อหาบทเรียน
    lesson = {
      kind: "document",
      lessonId: current.lesson.id,
      title: current.lesson.title,
      documentTitle: current.lesson.title,
      paragraphs: [],
    };
  } else {
    // วิดีโอ — media URL ยังไม่มี endpoint ตาม spec (media เสิร์ฟผ่าน Storage/CDN โดยตรง)
    const durationSeconds = durationOf(detail, current.lesson.id) ?? 0;
    const initialPositionSeconds =
      current.lesson.status === "completed" || durationSeconds <= 0
        ? 0
        : Math.min(durationSeconds, Math.round((current.lesson.watchPct / 100) * durationSeconds));
    lesson = {
      kind: "video",
      lessonId: current.lesson.id,
      title: current.lesson.title,
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

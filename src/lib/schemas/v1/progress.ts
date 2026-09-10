/**
 * schemas/v1/progress — zod contract ของ Learning & Progress (API-SPECIFICATION §3.4)
 *
 * - LessonProgressRequest = §4 #5 ตรงตัวอักษร (D12-12: ไม่มี field `completed` — สถานะ "จบบท"
 *   ตัดสินฝั่ง server ใน record_lesson_progress เท่านั้น)
 * - QuizSubmitRequest = §4 #6 ตรงตัวอักษร — คำตอบเท่านั้น ห้ามมี is_correct/คะแนนจาก client
 *   (grading = server ล้วน ผ่าน RPC record_quiz_attempt — F2/D12)
 * - *View = ขาออก — validate ด้วย zod ก่อนส่งทุกครั้ง (§1-4: zod validate input และ output)
 * - parse* = helper แปลง path param / body → ERR-VAL-001 เมื่อไม่ผ่าน (แบบเดียวกับ parsePageQuery
 *   ของ common.ts)
 */
import { z } from "zod";
import { AppError } from "../../errors";

// ─── §4 #5 — บันทึกความคืบหน้าบทเรียน (heartbeat วิดีโอ XOR attestation เอกสาร) ───
export const LessonProgressRequest = z
  .object({
    positionSeconds: z.number().int().min(0).optional(), // วิดีโอ — ตำแหน่งเล่นสัมบูรณ์ (วินาที)
    documentRead: z.boolean().optional(), // เอกสาร — client attestation เท่านั้น (D12-12)
  })
  .refine(
    (v) => (v.positionSeconds !== undefined) !== (v.documentRead !== undefined),
    { message: "ส่งอย่างใดอย่างหนึ่งเท่านั้น: positionSeconds (วิดีโอ) XOR documentRead (เอกสาร)" },
  );

export type LessonProgressRequestParsed = z.infer<typeof LessonProgressRequest>;

// ─── §4 #6 — ส่งแบบทดสอบย่อย (ไม่มีเฉลย/คะแนนจาก client) ───
export const QuizSubmitRequest = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().uuid(),
        choiceIds: z.array(z.string().uuid()).min(1).max(10),
      }),
    )
    .min(1)
    .max(100),
});

export type QuizSubmitRequestParsed = z.infer<typeof QuizSubmitRequest>;

// ─── path params ───
export const CourseProgressParams = z.object({ courseId: z.string().uuid() });
export const LessonIdParams = z.object({ id: z.string().uuid() });

export type CourseProgressParamsParsed = z.infer<typeof CourseProgressParams>;
export type LessonIdParamsParsed = z.infer<typeof LessonIdParams>;

// ─── ผลลัพธ์ jsonb ของ RPC record_quiz_attempt (migrations/0011_functions.sql — return
//     jsonb_build_object('attempt_id', …, 'score_pct', …, 'passed', …)) — validate ก่อนใช้ ───
export const RecordQuizAttemptResult = z.object({
  attempt_id: z.string().uuid(),
  score_pct: z.number().int().min(0).max(100),
  passed: z.boolean(),
});

export type RecordQuizAttemptResultParsed = z.infer<typeof RecordQuizAttemptResult>;

// ─── ขาออก: ผลส่ง quiz (เฉพาะที่ RPC เปิดเผย — คะแนน + ผ่าน/ไม่ผ่าน; ไม่มีเฉลยรายข้อ) ───
export const QuizSubmitView = z.object({
  attemptId: z.string().uuid(),
  scorePct: z.number().int().min(0).max(100),
  passed: z.boolean(),
});

export type QuizSubmitViewParsed = z.infer<typeof QuizSubmitView>;

// ─── ขาออก: ผล heartbeat บทเรียน (อ่านแถว lesson_progress ของตัวเองหลัง RPC) ───
export const LessonProgressView = z.object({
  lessonId: z.string().uuid(),
  status: z.enum(["not_started", "in_progress", "completed"]),
  watchPct: z.number().int().min(0).max(100),
  videoMaxPositionSec: z.number().int().min(0).nullable(),
  dwellSec: z.number().int().min(0),
  quizScorePct: z.number().int().min(0).max(100).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type LessonProgressViewParsed = z.infer<typeof LessonProgressView>;

// ─── ขาออก: สรุปความคืบหน้าต่อบทเรียนในหลักสูตร ───
export const CourseLessonProgressView = z.object({
  lessonId: z.string().uuid(),
  lessonType: z.enum(["video", "document", "quiz"]),
  status: z.enum(["not_started", "in_progress", "completed"]),
  watchPct: z.number().int().min(0).max(100),
  quizScorePct: z.number().int().min(0).max(100).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type CourseLessonProgressViewParsed = z.infer<typeof CourseLessonProgressView>;

// ─── ขาออก: ความคืบหน้าต่อโมดูล (§3.4 — "% ต่อโมดูล") ───
export const CourseModuleProgressView = z.object({
  moduleId: z.string().uuid(),
  title: z.string(),
  sortOrder: z.number().int(),
  lessonTotal: z.number().int().min(0),
  lessonCompleted: z.number().int().min(0),
  progressPct: z.number().int().min(0).max(100),
  lessons: z.array(CourseLessonProgressView),
});

export type CourseModuleProgressViewParsed = z.infer<typeof CourseModuleProgressView>;

// ─── ขาออก: สรุปความคืบหน้าของตัวเองในหลักสูตร (GET /courses/{id}/progress) ───
export const CourseProgressView = z.object({
  courseId: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  enrollmentStatus: z.enum(["active", "completed", "expired", "cancelled"]),
  lessonTotal: z.number().int().min(0),
  lessonCompleted: z.number().int().min(0),
  progressPct: z.number().int().min(0).max(100),
  modules: z.array(CourseModuleProgressView),
});

export type CourseProgressViewParsed = z.infer<typeof CourseProgressView>;

// ─── parse helpers — ERR-VAL-001 พร้อมรายชื่อ field เมื่อไม่ผ่าน (แบบ common.ts) ───
function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  fallbackField: string,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : fallbackField;
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return parsed.data;
}

/** path param ของ GET /courses/{id}/progress — courseId ไม่ใช่ UUID → ERR-VAL-001 400 */
export function parseCourseProgressParams(raw: unknown): CourseProgressParamsParsed {
  return parseOrThrow(CourseProgressParams, raw, "courseId");
}

/** path param ของ POST /lessons/{id}/progress และ POST /lessons/{id}/quiz/submit */
export function parseLessonIdParams(raw: unknown): LessonIdParamsParsed {
  return parseOrThrow(LessonIdParams, raw, "id");
}

/** body ของ POST /lessons/{id}/progress — XOR ผิด → ERR-VAL-001 400 */
export function parseLessonProgressBody(raw: unknown): LessonProgressRequestParsed {
  return parseOrThrow(LessonProgressRequest, raw, "body");
}

/** body ของ POST /lessons/{id}/quiz/submit — answers/choiceIds ผิดขอบเขต → ERR-VAL-001 400 */
export function parseQuizSubmitBody(raw: unknown): QuizSubmitRequestParsed {
  return parseOrThrow(QuizSubmitRequest, raw, "body");
}

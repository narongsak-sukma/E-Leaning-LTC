/**
 * progress.test — unit test ของ schemas/v1/progress.ts (contract ของ API-SPECIFICATION §3.4)
 * pure — ไม่ mock Supabase (schema ไม่พึ่ง server-only module)
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../../errors";
import {
  CourseLessonProgressView,
  CourseModuleProgressView,
  CourseProgressView,
  LessonProgressRequest,
  LessonProgressView,
  QuizSubmitRequest,
  QuizSubmitView,
  RecordQuizAttemptResult,
  parseCourseProgressParams,
  parseLessonIdParams,
  parseLessonProgressBody,
  parseQuizSubmitBody,
} from "./progress";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const TS = "2026-09-08T10:00:00+00:00";

describe("LessonProgressRequest (API-SPEC §4 #5) — XOR วิดีโอ/เอกสาร", () => {
  it("positionSeconds อย่างเดียว → ผ่าน", () => {
    expect(LessonProgressRequest.safeParse({ positionSeconds: 90 }).success).toBe(true);
  });

  it("documentRead อย่างเดียว → ผ่าน", () => {
    expect(LessonProgressRequest.safeParse({ documentRead: true }).success).toBe(true);
  });

  it("ส่งทั้งคู่ → ไม่ผ่าน (XOR)", () => {
    expect(LessonProgressRequest.safeParse({ positionSeconds: 10, documentRead: true }).success).toBe(false);
  });

  it("ไม่ส่งอะไรเลย → ไม่ผ่าน (XOR)", () => {
    expect(LessonProgressRequest.safeParse({}).success).toBe(false);
  });

  it("positionSeconds ติดลบ/ทศนิยม → ไม่ผ่าน", () => {
    expect(LessonProgressRequest.safeParse({ positionSeconds: -1 }).success).toBe(false);
    expect(LessonProgressRequest.safeParse({ positionSeconds: 1.5 }).success).toBe(false);
  });

  it("documentRead: false อย่างเดียว → ผ่านตาม schema (boolean optional ตาม §4 #5)", () => {
    // attestation ที่ตั้งใจคือ documentRead = true (D12-12) — false = dwell telemetry อย่างเดียว
    expect(LessonProgressRequest.safeParse({ documentRead: false }).success).toBe(true);
  });
});

describe("QuizSubmitRequest (API-SPEC §4 #6)", () => {
  it("คำตอบครบรูปแบบ → ผ่าน", () => {
    expect(QuizSubmitRequest.safeParse({ answers: [{ questionId: UUID, choiceIds: [UUID2] }] }).success).toBe(true);
  });

  it("answers ว่าง → ไม่ผ่าน (min 1)", () => {
    expect(QuizSubmitRequest.safeParse({ answers: [] }).success).toBe(false);
  });

  it("answers เกิน 100 ข้อ → ไม่ผ่าน", () => {
    const answers = Array.from({ length: 101 }, () => ({ questionId: UUID, choiceIds: [UUID2] }));
    expect(QuizSubmitRequest.safeParse({ answers }).success).toBe(false);
  });

  it("choiceIds ว่าง → ไม่ผ่าน (min 1)", () => {
    expect(QuizSubmitRequest.safeParse({ answers: [{ questionId: UUID, choiceIds: [] }] }).success).toBe(false);
  });

  it("choiceIds เกิน 10 ตัวเลือก → ไม่ผ่าน", () => {
    const choiceIds = Array.from({ length: 11 }, () => UUID2);
    expect(QuizSubmitRequest.safeParse({ answers: [{ questionId: UUID, choiceIds }] }).success).toBe(false);
  });

  it("questionId ไม่ใช่ UUID → ไม่ผ่าน", () => {
    expect(QuizSubmitRequest.safeParse({ answers: [{ questionId: "not-uuid", choiceIds: [UUID2] }] }).success).toBe(false);
  });

  it("ห้ามมีคะแนน/เฉลยจาก client — schema รับเฉพาะ questionId + choiceIds (grading = server ล้วน)", () => {
    // รูปแบบของ §4 #6 มีเฉพาะสอง field นี้ — ค่าแปลกปลอมที่ client พยายามส่งเข้ามา
    // ถูกตัดทิ้งตอน parse (non-strict ตาม spec) ไม่ถึงมือ RPC
    const parsed = parseQuizSubmitBody({
      answers: [{ questionId: UUID, choiceIds: [UUID2], is_correct: true, score: 100 }],
    });
    expect(parsed.answers[0]).toEqual({ questionId: UUID, choiceIds: [UUID2] });
  });
});

describe("path params + parse helpers — ผิดรูปแบบ → ERR-VAL-001 (แบบ parsePageQuery)", () => {
  it("parseCourseProgressParams: courseId ไม่ใช่ UUID → ERR-VAL-001 fields=[courseId]", () => {
    const err = (() => {
      try {
        parseCourseProgressParams({ courseId: "abc" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-VAL-001");
    expect((err as AppError).details).toEqual({ fields: ["courseId"] });
  });

  it("parseLessonIdParams: id ไม่ใช่ UUID → ERR-VAL-001 fields=[id]", () => {
    const err = (() => {
      try {
        parseLessonIdParams({ id: "xyz" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AppError).code).toBe("ERR-VAL-001");
    expect((err as AppError).details).toEqual({ fields: ["id"] });
  });

  it("parseLessonProgressBody: XOR ทั้งคู่ → ERR-VAL-001 fields=[body] (refine ไม่มี path)", () => {
    const err = (() => {
      try {
        parseLessonProgressBody({ positionSeconds: 5, documentRead: true });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AppError).code).toBe("ERR-VAL-001");
    expect((err as AppError).details).toEqual({ fields: ["body"] });
  });

  it("parseQuizSubmitBody: ผ่าน → คืนคำตอบที่แปลงแล้ว", () => {
    expect(parseQuizSubmitBody({ answers: [{ questionId: UUID, choiceIds: [UUID2] }] })).toEqual({
      answers: [{ questionId: UUID, choiceIds: [UUID2] }],
    });
  });
});

describe("View schemas — ขาออก validate ก่อนส่ง (§1-4)", () => {
  it("LessonProgressView: ผล heartbeat ครบช่วงค่า", () => {
    expect(
      LessonProgressView.safeParse({
        lessonId: UUID,
        status: "in_progress",
        watchPct: 40,
        videoMaxPositionSec: 120,
        dwellSec: 0,
        quizScorePct: null,
        completedAt: null,
      }).success,
    ).toBe(true);
    expect(
      LessonProgressView.safeParse({
        lessonId: UUID,
        status: "completed",
        watchPct: 100,
        videoMaxPositionSec: 600,
        dwellSec: 700,
        quizScorePct: 85,
        completedAt: TS,
      }).success,
    ).toBe(true);
  });

  it("LessonProgressView: watchPct เกิน 100 / status นอก enum → ไม่ผ่าน", () => {
    const base = {
      lessonId: UUID,
      status: "in_progress",
      watchPct: 40,
      videoMaxPositionSec: 120,
      dwellSec: 0,
      quizScorePct: null,
      completedAt: null,
    };
    expect(LessonProgressView.safeParse({ ...base, watchPct: 101 }).success).toBe(false);
    expect(LessonProgressView.safeParse({ ...base, status: "done" }).success).toBe(false);
  });

  it("RecordQuizAttemptResult: ตรง jsonb ของ record_quiz_attempt (0011) → ผ่าน", () => {
    expect(
      RecordQuizAttemptResult.safeParse({ attempt_id: UUID, score_pct: 80, passed: true }).success,
    ).toBe(true);
    expect(RecordQuizAttemptResult.safeParse({ attempt_id: "x", score_pct: 80, passed: true }).success).toBe(false);
  });

  it("QuizSubmitView + CourseLessonProgressView: รูปร่างขาออกของ quiz/summary", () => {
    expect(QuizSubmitView.safeParse({ attemptId: UUID, scorePct: 60, passed: true }).success).toBe(true);
    expect(
      CourseLessonProgressView.safeParse({
        lessonId: UUID,
        lessonType: "video",
        status: "completed",
        watchPct: 100,
        videoMaxPositionSec: 599,
        quizScorePct: null,
        completedAt: TS,
      }).success,
    ).toBe(true);
  });

  it("CourseLessonProgressView: videoMaxPositionSec (D85) — 0/null ผ่าน · ขาด field/ติดลบ/ทศนิยม → ไม่ผ่าน", () => {
    const base = {
      lessonId: UUID,
      lessonType: "video",
      status: "in_progress",
      watchPct: 40,
      quizScorePct: null,
      completedAt: null,
    };
    // 0 เป็นค่าจริง (ตำแหน่งสูงสุดที่เคยบันทึก = 0) · null = แถว legacy ก่อนมีคอลัมน์ — ทั้งคู่ผ่าน
    expect(CourseLessonProgressView.safeParse({ ...base, videoMaxPositionSec: 0 }).success).toBe(true);
    expect(CourseLessonProgressView.safeParse({ ...base, videoMaxPositionSec: null }).success).toBe(true);
    // ขาด field → ไม่ผ่าน (ทุกแถวต้องส่ง field นี้ออกเสมอ)
    expect(CourseLessonProgressView.safeParse(base).success).toBe(false);
    // ติดลบ/ทศนิยม → ไม่ผ่าน (int ≥ 0 เท่านั้น)
    expect(CourseLessonProgressView.safeParse({ ...base, videoMaxPositionSec: -1 }).success).toBe(false);
    expect(CourseLessonProgressView.safeParse({ ...base, videoMaxPositionSec: 1.5 }).success).toBe(false);
  });

  it("CourseModuleProgressView + CourseProgressView: ต้นไม้ความคืบหน้าเต็ม", () => {
    const lesson = {
      lessonId: UUID,
      lessonType: "quiz",
      status: "completed",
      watchPct: 0,
      videoMaxPositionSec: null,
      quizScorePct: 80,
      completedAt: TS,
    };
    const mod = {
      moduleId: UUID2,
      title: "โมดูล 1",
      sortOrder: 1,
      lessonTotal: 1,
      lessonCompleted: 1,
      progressPct: 100,
      lessons: [lesson],
    };
    expect(CourseModuleProgressView.safeParse(mod).success).toBe(true);
    const view = {
      courseId: UUID2,
      enrollmentId: UUID,
      enrollmentStatus: "active",
      lessonTotal: 1,
      lessonCompleted: 1,
      progressPct: 100,
      modules: [mod],
    };
    expect(CourseProgressView.safeParse(view).success).toBe(true);
    expect(CourseProgressView.safeParse({ ...view, enrollmentStatus: "paused" }).success).toBe(false);
  });
});

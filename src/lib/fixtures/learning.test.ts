/**
 * learning.test — unit test ของ data layer ผู้เรียน (mock fetch)
 *
 * - ครอบ shape mapping + error envelope (§1.3) + contract violation + ไม่มี enrollment
 * - ยืนยันว่า request ที่ส่งไป BFF สะอาด: มีเฉพาะคำตอบ (questionId/choiceIds) — ไม่มีเฉลย/คะแนน
 * - ยืนยันว่าเฉลยไม่อยู่ใน client path — ดู learning.client-bundle-guard.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  authLogoutUrl,
  buildCourseOutline,
  buildEnrolledCourseCard,
  courseDetailUrl,
  courseProgressUrl,
  findLessonNeighbors,
  getCourseDetail,
  getCourseProgress,
  getLessonQuiz,
  getMyEnrollments,
  lessonLabelInOutline,
  lessonProgressUrl,
  lessonQuizSubmitUrl,
  lessonQuizUrl,
  logout,
  meEnrollmentsUrl,
  pickContinueLesson,
  resolveCurrentLesson,
  saveLessonProgress,
  submitLessonQuiz,
} from "./learning";
import type { CourseDetailSummary, CourseProgress, EnrollmentSummary } from "./learning";

// ——— fixture กลาง — uuid จริงรูปแบบ v4 ทั้งหมด (id ต้องมาจาก BFF ไม่ใช่ slug) ———
const COURSE = "00000000-0000-4000-8000-000000000001";
const MODULE_A = "00000000-0000-4000-8000-000000000002";
const MODULE_B = "00000000-0000-4000-8000-000000000003";
const LESSON_V = "00000000-0000-4000-8000-000000000011";
const LESSON_D = "00000000-0000-4000-8000-000000000012";
const LESSON_Q = "00000000-0000-4000-8000-000000000013";
const CHOICE_A = "00000000-0000-4000-8000-000000000021";
const CHOICE_B = "00000000-0000-4000-8000-000000000022";
const CHOICE_C = "00000000-0000-4000-8000-000000000023";
const QUESTION_1 = "00000000-0000-4000-8000-000000000061";
const QUESTION_2 = "00000000-0000-4000-8000-000000000062";
const ENROLLMENT = "00000000-0000-4000-8000-000000000031";
const ATTEMPT = "00000000-0000-4000-8000-000000000041";
const ISO = "2026-09-10T03:00:00+07:00";
const ORIGIN = "https://learn.example.com";

const DETAIL_BODY = {
  id: COURSE,
  titleTh: "หลักสูตรจริยธรรมทนายความ",
  category: { id: "00000000-0000-4000-8000-000000000051", nameTh: "จริยธรรม" },
  modules: [
    {
      id: MODULE_A,
      titleTh: "โมดูลที่ 1",
      lessons: [
        { id: LESSON_V, titleTh: "วิดีโอแนะนำหลักสูตร", type: "video", durationSec: 600 },
        { id: LESSON_D, titleTh: "เอกสารจรรยาบรรณทนายความ", type: "document", durationSec: null },
      ],
    },
    {
      id: MODULE_B,
      titleTh: "โมดูลที่ 2",
      lessons: [{ id: LESSON_Q, titleTh: "แบบทดสอบย่อยท้ายหลักสูตร", type: "quiz", durationSec: null }],
    },
  ],
};

const PROGRESS_BODY = {
  courseId: COURSE,
  enrollmentId: ENROLLMENT,
  enrollmentStatus: "active",
  lessonTotal: 3,
  lessonCompleted: 1,
  progressPct: 33,
  modules: [
    {
      moduleId: MODULE_A,
      title: "โมดูลที่ 1",
      sortOrder: 1,
      lessonTotal: 2,
      lessonCompleted: 1,
      progressPct: 50,
      lessons: [
        {
          lessonId: LESSON_V,
          lessonType: "video",
          status: "completed",
          watchPct: 100,
          quizScorePct: null,
          completedAt: ISO,
        },
        {
          lessonId: LESSON_D,
          lessonType: "document",
          status: "in_progress",
          watchPct: 0,
          quizScorePct: null,
          completedAt: null,
        },
      ],
    },
    {
      moduleId: MODULE_B,
      title: "โมดูลที่ 2",
      sortOrder: 2,
      lessonTotal: 1,
      lessonCompleted: 0,
      progressPct: 0,
      lessons: [
        {
          lessonId: LESSON_Q,
          lessonType: "quiz",
          status: "not_started",
          watchPct: 0,
          quizScorePct: null,
          completedAt: null,
        },
      ],
    },
  ],
};

const ENROLLMENT_BODY = {
  id: ENROLLMENT,
  courseId: COURSE,
  status: "active",
  enrolledAt: ISO,
  expiresAt: null,
  completedAt: null,
};

const QUIZ_BODY = {
  passPct: 70,
  maxAttempts: 3,
  questions: [
    {
      id: "00000000-0000-4000-8000-000000000061",
      prompt: "ข้อใดเป็นพฤติกรรมที่ต้องห้ามตามจรรยาบรรณ",
      choices: [
        { id: CHOICE_A, label: "รับโอนสินจ้างเกินอัตราที่ตกลงกันไว้" },
        { id: CHOICE_B, label: "แจ้งความประพฤติของตนเองให้ลูกความทราบ" },
      ],
    },
    {
      id: "00000000-0000-4000-8000-000000000062",
      prompt: "การรับโอนสินจ้างเกินอัตราที่ตกลงกันไว้ มีโทษอย่างไร",
      choices: [{ id: CHOICE_C, label: "ต้องรับโทษทางวินัยตามระเบียบสภาทนายความฯ" }],
    },
  ],
};

const QUIZ_RESULT_BODY = { attemptId: ATTEMPT, scorePct: 100, passed: true };

const PROGRESS_RESULT_BODY = {
  lessonId: LESSON_V,
  status: "in_progress",
  watchPct: 20,
  videoMaxPositionSec: 120,
  dwellSec: 130,
  quizScorePct: null,
  completedAt: null,
};

// ——— mock fetch — จำลอง BFF ตามลำดับการเรียก ———
interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly keepalive: boolean;
}

let calls: RecordedCall[] = [];

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stubFetch(handler: (callIndex: number) => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : String(input);
      const headers: Record<string, string> = {};
      if (init?.headers !== undefined) {
        for (const [key, value] of Object.entries(init.headers)) {
          if (typeof value === "string") {
            headers[key] = value;
          }
        }
      }
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
        keepalive: init?.keepalive === true,
      });
      return handler(calls.length - 1);
    }),
  );
}

function callAt(index: number): RecordedCall {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`ไม่พบการเรียก fetch ลำดับที่ ${index}`);
  }
  return call;
}

const okAlways = (body: unknown) => () => jsonResponse(200, body);

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ——— URL builders — path ตรง API-SPECIFICATION §3 ———
describe("URL builders", () => {
  it("สร้าง path BFF ตรงตาม spec", () => {
    expect(courseDetailUrl(COURSE)).toBe(`/api/v1/courses/${COURSE}`);
    expect(courseProgressUrl(COURSE)).toBe(`/api/v1/courses/${COURSE}/progress`);
    expect(meEnrollmentsUrl()).toBe("/api/v1/me/enrollments?limit=100");
    expect(lessonQuizUrl(LESSON_V)).toBe(`/api/v1/lessons/${LESSON_V}/quiz`);
    expect(lessonQuizSubmitUrl(LESSON_Q)).toBe(`/api/v1/lessons/${LESSON_Q}/quiz/submit`);
    expect(lessonProgressUrl(LESSON_V)).toBe(`/api/v1/lessons/${LESSON_V}/progress`);
    expect(authLogoutUrl()).toBe("/api/v1/auth/logout");
  });
});

// ——— getMyEnrollments — mapping + หน้า + error envelope ———
describe("getMyEnrollments", () => {
  it("แปลงรายการ enrollment + hasMore และเรียก absolute URL", async () => {
    stubFetch(() => jsonResponse(200, { data: [ENROLLMENT_BODY], page: { hasMore: true } }));
    const result = await getMyEnrollments({ origin: ORIGIN });
    expect(result.hasMore).toBe(true);
    expect(result.enrollments).toHaveLength(1);
    const enrollment = result.enrollments[0];
    expect(enrollment?.id).toBe(ENROLLMENT);
    expect(enrollment?.courseId).toBe(COURSE);
    expect(enrollment?.status).toBe("active");
    expect(callAt(0).url).toBe(`${ORIGIN}/api/v1/me/enrollments?limit=100`);
    expect(callAt(0).method).toBe("GET");
  });

  it("ตอบ 401 envelope → ApiError ERR-AUTH-001 พร้อมข้อความไทยจาก server", async () => {
    stubFetch(() => jsonResponse(401, { error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบ" } }));
    const error = await getMyEnrollments({ origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-AUTH-001");
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("กรุณาเข้าสู่ระบบ");
  });

  it("200 แต่ข้อมูลขาออกไม่มี data → contract violation ERR-SYS-001", async () => {
    stubFetch(() => jsonResponse(200, { page: { hasMore: false } }));
    const error = await getMyEnrollments({ origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });

  it("fetch ล้มเหลว (เครือข่าย) → ERR-SYS-001 status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const error = await getMyEnrollments({ origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
    expect((error as ApiError).status).toBe(0);
  });
});

// ——— getCourseDetail — mapping โครงสร้างหลักสูตร ———
describe("getCourseDetail", () => {
  it("แปลง titleTh/category.nameTh/modules/lessons + นับจำนวนบทเรียน", async () => {
    stubFetch(okAlways(DETAIL_BODY));
    const detail = await getCourseDetail(COURSE, { origin: ORIGIN });
    expect(detail.id).toBe(COURSE);
    expect(detail.title).toBe("หลักสูตรจริยธรรมทนายความ");
    expect(detail.category).toBe("จริยธรรม");
    expect(detail.lessonCount).toBe(3);
    expect(detail.modules).toHaveLength(2);
    const firstLesson = detail.modules[0]?.lessons[0];
    expect(firstLesson).toMatchObject({
      id: LESSON_V,
      title: "วิดีโอแนะนำหลักสูตร",
      type: "video",
      durationSeconds: 600,
    });
  });

  it("titleTh หายไป → contract violation ERR-SYS-001", async () => {
    const broken = { ...DETAIL_BODY, titleTh: undefined };
    stubFetch(okAlways(broken));
    const error = await getCourseDetail(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });
});

// ——— getCourseProgress — zod contract + ไม่มี enrollment ———
describe("getCourseProgress", () => {
  it("200 ผ่าน zod contract (CourseProgressView)", async () => {
    stubFetch(okAlways(PROGRESS_BODY));
    const progress = await getCourseProgress(COURSE, { origin: ORIGIN });
    expect(progress.courseId).toBe(COURSE);
    expect(progress.lessonTotal).toBe(3);
    expect(progress.modules).toHaveLength(2);
    expect(progress.modules[0]?.lessons[0]?.status).toBe("completed");
    expect(progress.modules[1]?.lessons[0]?.lessonType).toBe("quiz");
  });

  it("403 ไม่มีการลงทะเบียน → ApiError ERR-LRN-001", async () => {
    stubFetch(() =>
      jsonResponse(403, { error: { code: "ERR-LRN-001", message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน" } }),
    );
    const error = await getCourseProgress(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-LRN-001");
    expect((error as ApiError).status).toBe(403);
  });

  it("progressPct เกิน 100 → contract violation ERR-SYS-001", async () => {
    const broken = { ...PROGRESS_BODY, progressPct: 150 };
    stubFetch(okAlways(broken));
    const error = await getCourseProgress(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });
});

// ——— getLessonQuiz — โจทย์เท่านั้น ไม่มีเฉลย (DCR-5) ———
describe("getLessonQuiz", () => {
  it("แปลงโจทย์ + ตัวเลือกมีเฉพาะ id/label", async () => {
    stubFetch(okAlways(QUIZ_BODY));
    const quiz = await getLessonQuiz(LESSON_Q, { origin: ORIGIN });
    expect(quiz.lessonId).toBe(LESSON_Q);
    expect(quiz.passPct).toBe(70);
    expect(quiz.maxAttempts).toBe(3);
    expect(quiz.questions).toHaveLength(2);
    const choice = quiz.questions[0]?.choices[0];
    expect(choice).toEqual({ id: CHOICE_A, label: "รับโอนสินจ้างเกินอัตราที่ตกลงกันไว้" });
  });

  it("maxAttempts ไม่ส่งมา → null", async () => {
    const noMax = { ...QUIZ_BODY, maxAttempts: undefined };
    stubFetch(okAlways(noMax));
    const quiz = await getLessonQuiz(LESSON_Q, { origin: ORIGIN });
    expect(quiz.maxAttempts).toBeNull();
  });

  it("passPct หายไป → contract violation ERR-SYS-001", async () => {
    const broken = { ...QUIZ_BODY, passPct: undefined };
    stubFetch(okAlways(broken));
    const error = await getLessonQuiz(LESSON_Q, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });
});

// ——— submitLessonQuiz — ส่งเฉพาะคำตอบ (questionId/choiceIds) ไม่มีเฉลย ———
describe("submitLessonQuiz", () => {
  const answers = [
    { questionId: QUESTION_1, choiceIds: [CHOICE_A] },
    { questionId: QUESTION_2, choiceIds: [CHOICE_C] },
  ];

  it("POST เฉพาะ answers + แปลงผลคะแนน/ผ่านเกณฑ์จาก server", async () => {
    stubFetch(okAlways(QUIZ_RESULT_BODY));
    const result = await submitLessonQuiz(LESSON_Q, { answers }, { origin: ORIGIN });
    expect(result).toEqual(QUIZ_RESULT_BODY);
    expect(callAt(0).method).toBe("POST");
    expect(callAt(0).url).toBe(`${ORIGIN}/api/v1/lessons/${LESSON_Q}/quiz/submit`);
    const parsed = JSON.parse(callAt(0).body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["answers"]);
    const first = (parsed["answers"] as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(["questionId", "choiceIds"]);
  });

  it("422 → ApiError ERR-LRN-002", async () => {
    stubFetch(() =>
      jsonResponse(422, { error: { code: "ERR-LRN-002", message: "หมดจำนวนครั้งที่ทำได้" } }),
    );
    const error = await submitLessonQuiz(LESSON_Q, { answers }, { origin: ORIGIN }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-LRN-002");
    expect((error as ApiError).status).toBe(422);
  });
});

// ——— saveLessonProgress — XOR payload + keepalive ———
describe("saveLessonProgress", () => {
  it("heartbeat วิดีโอ: POST { positionSeconds } แบบ keepalive", async () => {
    stubFetch(okAlways(PROGRESS_RESULT_BODY));
    const view = await saveLessonProgress(LESSON_V, { positionSeconds: 120 }, { origin: ORIGIN });
    expect(view.status).toBe("in_progress");
    expect(view.watchPct).toBe(20);
    expect(callAt(0).method).toBe("POST");
    expect(callAt(0).keepalive).toBe(true);
    const parsed = JSON.parse(callAt(0).body ?? "{}") as Record<string, unknown>;
    expect(parsed).toEqual({ positionSeconds: 120 });
    expect("documentRead" in parsed).toBe(false);
    expect("completed" in parsed).toBe(false);
  });

  it("อ่านจบเอกสาร: POST { documentRead: true }", async () => {
    stubFetch(okAlways(PROGRESS_RESULT_BODY));
    const view = await saveLessonProgress(LESSON_D, { documentRead: true }, { origin: ORIGIN });
    expect(view.status).toBe("in_progress");
    const parsed = JSON.parse(callAt(0).body ?? "{}") as Record<string, unknown>;
    expect(parsed).toEqual({ documentRead: true });
  });

  it("429 → ApiError ERR-RATE-001", async () => {
    stubFetch(() => jsonResponse(429, { error: { code: "ERR-RATE-001", message: "ลองใหม่ภายหลัง" } }));
    const error = await saveLessonProgress(LESSON_V, { positionSeconds: 60 }, { origin: ORIGIN }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-RATE-001");
    expect((error as ApiError).status).toBe(429);
  });
});

// ——— logout — 204 สำเร็จ / 401 ———
describe("logout", () => {
  it("POST /auth/logout → 204 resolve ไม่มีค่าส่งกลับ", async () => {
    stubFetch(() => jsonResponse(204, null));
    await expect(logout({ origin: ORIGIN })).resolves.toBeUndefined();
    expect(callAt(0).method).toBe("POST");
    expect(callAt(0).url).toBe(`${ORIGIN}/api/v1/auth/logout`);
  });

  it("401 → ApiError ERR-AUTH-001", async () => {
    stubFetch(() => jsonResponse(401, { error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบ" } }));
    const error = await logout({ origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-AUTH-001");
    expect((error as ApiError).status).toBe(401);
  });
});

// ——— cookie forwarding (RSC → BFF) ———
describe("cookieHeader forwarding", () => {
  it("เรียกจาก server ส่ง origin + cookieHeader ถึง BFF", async () => {
    stubFetch(okAlways(PROGRESS_BODY));
    await getCourseProgress(COURSE, { origin: ORIGIN, cookieHeader: "sb-session=abc123" });
    expect(callAt(0).url).toBe(`${ORIGIN}/api/v1/courses/${COURSE}/progress`);
    expect(callAt(0).headers["cookie"]).toBe("sb-session=abc123");
    expect(callAt(0).headers["accept"]).toBe("application/json");
  });
});

// ——— helpers — ผูก outline + บทที่ค้าง + บทก่อน/ถัดไป + การ์ดหลักสูตรของฉัน ———
describe("pure helpers", () => {
  const detailTyped: CourseDetailSummary = {
    id: COURSE,
    title: "หลักสูตรจริยธรรมทนายความ",
    category: "จริยธรรม",
    lessonCount: 3,
    modules: [
      {
        id: MODULE_A,
        title: "โมดูลที่ 1",
        lessons: [
          { id: LESSON_V, title: "วิดีโอแนะนำหลักสูตร", type: "video", durationSeconds: 600 },
          { id: LESSON_D, title: "เอกสารจรรยาบรรณทนายความ", type: "document", durationSeconds: null },
        ],
      },
      {
        id: MODULE_B,
        title: "โมดูลที่ 2",
        lessons: [{ id: LESSON_Q, title: "แบบทดสอบย่อยท้ายหลักสูตร", type: "quiz", durationSeconds: null }],
      },
    ],
  };

  const emptyProgress: CourseProgress = {
    courseId: COURSE,
    enrollmentId: ENROLLMENT,
    enrollmentStatus: "active",
    lessonTotal: 2,
    lessonCompleted: 0,
    progressPct: 0,
    modules: [],
  };

  it("buildCourseOutline: บทที่ไม่มีใน progress = not_started/watchPct 0", () => {
    const outline = buildCourseOutline(detailTyped, emptyProgress);
    expect(outline.lessonCount).toBe(3);
    expect(outline.completedCount).toBe(0);
    expect(outline.progressPercent).toBe(0);
    const lesson = outline.modules[0]?.lessons[0];
    expect(lesson?.status).toBe("not_started");
    expect(lesson?.watchPct).toBe(0);
  });

  it("buildCourseOutline: ผูกสถานะจาก progress และนับจำนวนเรียนจบ + เปอร์เซ็นต์", () => {
    const outline = buildCourseOutline(detailTyped, PROGRESS_BODY as CourseProgress);
    expect(outline.lessonCount).toBe(3);
    expect(outline.completedCount).toBe(1);
    expect(outline.progressPercent).toBe(33);
    const first = outline.modules[0]?.lessons[0];
    expect(first?.status).toBe("completed");
    expect(first?.watchPct).toBe(100);
  });

  it("pickContinueLesson: in_progress ก่อน แล้ว not_started แรก — เรียนจบหมด = null", () => {
    const outline = buildCourseOutline(detailTyped, PROGRESS_BODY as CourseProgress);
    const picked = pickContinueLesson(outline);
    expect(picked?.lesson.id).toBe(LESSON_D);
    expect(picked?.label).toBe("บทเรียน 1.2");
    const doneOutline = buildCourseOutline(detailTyped, {
      ...emptyProgress,
      lessonTotal: 3,
      lessonCompleted: 3,
      progressPct: 100,
      modules: [
        {
          moduleId: MODULE_A,
          title: "โมดูลที่ 1",
          sortOrder: 1,
          lessonTotal: 2,
          lessonCompleted: 2,
          progressPct: 100,
          lessons: [
            { lessonId: LESSON_V, lessonType: "video", status: "completed", watchPct: 100, quizScorePct: null, completedAt: ISO },
            { lessonId: LESSON_D, lessonType: "document", status: "completed", watchPct: 100, quizScorePct: null, completedAt: ISO },
          ],
        },
        {
          moduleId: MODULE_B,
          title: "โมดูลที่ 2",
          sortOrder: 2,
          lessonTotal: 1,
          lessonCompleted: 1,
          progressPct: 100,
          lessons: [
            { lessonId: LESSON_Q, lessonType: "quiz", status: "completed", watchPct: 100, quizScorePct: 100, completedAt: ISO },
          ],
        },
      ],
    });
    expect(pickContinueLesson(doneOutline)).toBeNull();
  });

  it("lessonLabelInOutline + resolveCurrentLesson + findLessonNeighbors", () => {
    const outline = buildCourseOutline(detailTyped, PROGRESS_BODY as CourseProgress);
    expect(lessonLabelInOutline(outline, LESSON_Q)).toBe("บทเรียน 2.1");
    expect(lessonLabelInOutline(outline, "no-such-id")).toBeNull();
    expect(resolveCurrentLesson(outline, LESSON_Q)?.lesson.id).toBe(LESSON_Q);
    // ไม่ระบุ id → บทที่ค้าง (in_progress = LESSON_D)
    expect(resolveCurrentLesson(outline, undefined)?.lesson.id).toBe(LESSON_D);
    // ระบุ id ที่ไม่มีใน outline → fallback บทที่ค้าง
    expect(resolveCurrentLesson(outline, "no-such-id")?.lesson.id).toBe(LESSON_D);
    const neighbors = findLessonNeighbors(outline, LESSON_D);
    expect(neighbors?.prev?.id).toBe(LESSON_V);
    expect(neighbors?.next?.id).toBe(LESSON_Q);
    expect(findLessonNeighbors(outline, "missing")).toBeNull();
  });

  it("buildEnrolledCourseCard: ครบทั้ง detail+progress → title/ความคืบหน้า/บทที่ค้าง/isLoaded", () => {
    const outline = buildCourseOutline(detailTyped, PROGRESS_BODY as CourseProgress);
    expect(outline.progressPercent).toBe(33);
    const card = buildEnrolledCourseCard(
      ENROLLMENT_BODY as EnrollmentSummary,
      detailTyped,
      PROGRESS_BODY as CourseProgress,
    );
    expect(card.id).toBe(COURSE);
    expect(card.title).toBe("หลักสูตรจริยธรรมทนายความ");
    expect(card.category).toBe("จริยธรรม");
    expect(card.enrollmentStatus).toBe("active");
    expect(card.lessonCount).toBe(3);
    expect(card.completedCount).toBe(1);
    expect(card.progressPercent).toBe(33);
    expect(card.continueLesson?.id).toBe(LESSON_D);
    expect(card.isLoaded).toBe(true);
  });

  it("buildEnrolledCourseCard: detail โหลดไม่สำเร็จ → ชื่อ fallback + isLoaded false", () => {
    const card = buildEnrolledCourseCard(ENROLLMENT_BODY as EnrollmentSummary, null, null);
    expect(card.id).toBe(COURSE);
    expect(card.title).toBe("หลักสูตรที่ลงทะเบียน");
    expect(card.category).toBe("");
    expect(card.lessonCount).toBe(0);
    expect(card.continueLesson).toBeNull();
    expect(card.isLoaded).toBe(false);
  });
});

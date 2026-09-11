/**
 * learning.test — unit test ของ data layer ผู้เรียน (mock fetch)
 *
 * - ครอบ shape mapping + error envelope (§1.3) + contract violation + ไม่มี enrollment
 * - fixture ทุก 200 = wire จริงของ BFF: single-resource ห่อ `{data}` (§1.1 · gate r7 M3)
 *   ส่วน quiz ใช้ชื่อ field ตาม producer (text/options — gate r7 M4) คู่กับ route.test.ts
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
  enrollCourse,
  enrollCourseUrl,
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

// ——— (gate r8 m2) producer↔consumer จริง: รัน handler จริงของ GET /lessons/{id}/quiz —
// mock เฉพาะ DB/auth/transport ตามแบบ route.test.ts ของ endpoint นั้น (mock module
// ไม่กระทบ reader ซึ่งเป็น client-safe — ไม่มี import ร่วมกันนอก test นี้)
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  // gate r12: getUser ของ session.ts ใช้ buffered client — wrapper อ่าน stub จาก
  // createSupabaseSsrClient ณ เวลาถูกเรียก (mockResolvedValue ตั้งทีหลังได้)
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

// env ขั้นต่ำที่ lib/config ต้องใช้เมื่อรัน handler (rate limit อ่าน config ตอน enforce)
process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:53227";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

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

// ——— quiz ตาม wire จริงของ BFF (gate r7 MAJOR-3/4) ———
// jsonOk ห่อ {data} (§1.1) และชื่อ field ตาม QuizView ของ route: questions[].`text` /
// options[].`text` + type/points/shuffleQuestions/sortOrder ที่ view model ผู้เรียนไม่ใช้
// literal นี้จับคู่กับที่ route.test.ts ยึด producer ไว้ (expect(body.data).toEqual(...)) —
// แก้ฝั่งใดฝั่งหนึ่งโดยไม่แก้อีกฝั่ง คู่ test นี้ต้องแตก (แบบเดียวกับ contract r4)
const QUIZ_WIRE_BODY = {
  title: "แบบทดสอบย่อยท้ายหลักสูตร",
  passPct: 70,
  maxAttempts: 3,
  shuffleQuestions: false,
  questions: [
    {
      id: QUESTION_1,
      text: "ข้อใดเป็นพฤติกรรมที่ต้องห้ามตามจรรยาบรรณ",
      type: "single_choice",
      points: 1,
      options: [
        { id: CHOICE_A, text: "รับโอนสินจ้างเกินอัตราที่ตกลงกันไว้", sortOrder: 1 },
        { id: CHOICE_B, text: "แจ้งความประพฤติของตนเองให้ลูกความทราบ", sortOrder: 2 },
      ],
    },
    {
      id: QUESTION_2,
      text: "การรับโอนสินจ้างเกินอัตราที่ตกลงกันไว้ มีโทษอย่างไร",
      type: "single_choice",
      points: 1,
      options: [{ id: CHOICE_C, text: "ต้องรับโทษทางวินัยตามระเบียบสภาทนายความฯ", sortOrder: 1 }],
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
    expect(enrollCourseUrl(COURSE)).toBe(`/api/v1/courses/${COURSE}/enroll`);
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
    stubFetch(okAlways({ data: DETAIL_BODY }));
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
    const broken = { data: { ...DETAIL_BODY, titleTh: undefined } };
    stubFetch(okAlways(broken));
    const error = await getCourseDetail(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });

  it("200 ไม่มี envelope {data} (ข้อมูลอยู่ root) → ERR-SYS-001 ไม่ใช่ข้อมูลครึ่ง ๆ (gate r7 M3)", async () => {
    stubFetch(okAlways(DETAIL_BODY)); // เหมือน shape เก่าที่ producer ไม่เคยส่ง
    const error = await getCourseDetail(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });
});

// ——— getCourseProgress — zod contract + ไม่มี enrollment ———
describe("getCourseProgress", () => {
  it("200 ผ่าน zod contract (CourseProgressView)", async () => {
    stubFetch(okAlways({ data: PROGRESS_BODY }));
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
    const broken = { data: { ...PROGRESS_BODY, progressPct: 150 } };
    stubFetch(okAlways(broken));
    const error = await getCourseProgress(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });

  it("200 ไม่มี envelope {data} → ERR-SYS-001 (gate r7 M3)", async () => {
    stubFetch(okAlways(PROGRESS_BODY));
    const error = await getCourseProgress(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });
});

// ——— getLessonQuiz — โจทย์เท่านั้น ไม่มีเฉลย (DCR-5) ———
// fixture = wire จริงของ route (ดู QUIZ_WIRE_BODY) → ชุดนี้คือ contract test
// producer–consumer คู่กับ route.test.ts ของ GET /lessons/{id}/quiz (gate r7 M4)
describe("getLessonQuiz", () => {
  it("wire ของ route (text/options) → view prompt/choices/label ครบทุกข้อ ทุกตัวเลือก", async () => {
    stubFetch(okAlways({ data: QUIZ_WIRE_BODY }));
    const quiz = await getLessonQuiz(LESSON_Q, { origin: ORIGIN });
    expect(quiz.lessonId).toBe(LESSON_Q);
    expect(quiz.passPct).toBe(70);
    expect(quiz.maxAttempts).toBe(3);
    expect(quiz.questions).toHaveLength(2);
    expect(quiz.questions.map((q) => q.prompt)).toEqual([
      "ข้อใดเป็นพฤติกรรมที่ต้องห้ามตามจรรยาบรรณ",
      "การรับโอนสินจ้างเกินอัตราที่ตกลงกันไว้ มีโทษอย่างไร",
    ]);
    expect(quiz.questions[0]?.choices.map((c) => c.label)).toEqual([
      "รับโอนสินจ้างเกินอัตราที่ตกลงกันไว้",
      "แจ้งความประพฤติของตนเองให้ลูกความทราบ",
    ]);
    // id ผ่านตรง ๆ ทั้งข้อและตัวเลือก — submit ตัดสินด้วย id คู่กันเจอ
    expect(quiz.questions.map((q) => q.id)).toEqual([QUESTION_1, QUESTION_2]);
    expect(quiz.questions[0]?.choices.map((c) => c.id)).toEqual([CHOICE_A, CHOICE_B]);
    // ไม่มีเฉลยหลุดมากับ view (DCR-5)
    expect(JSON.stringify(quiz)).not.toContain("is_correct");
    expect(JSON.stringify(quiz)).not.toContain("explanation");
  });

  it("maxAttempts ไม่ส่งมา → null", async () => {
    const noMax = { data: { ...QUIZ_WIRE_BODY, maxAttempts: undefined } };
    stubFetch(okAlways(noMax));
    const quiz = await getLessonQuiz(LESSON_Q, { origin: ORIGIN });
    expect(quiz.maxAttempts).toBeNull();
  });

  it("passPct หายไป → contract violation ERR-SYS-001", async () => {
    const broken = { data: { ...QUIZ_WIRE_BODY, passPct: undefined } };
    stubFetch(okAlways(broken));
    const error = await getLessonQuiz(LESSON_Q, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });

  it("200 ไม่มี envelope {data} → ERR-SYS-001 (gate r7 M3)", async () => {
    stubFetch(okAlways(QUIZ_WIRE_BODY));
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
    stubFetch(okAlways({ data: QUIZ_RESULT_BODY }));
    const result = await submitLessonQuiz(LESSON_Q, { answers }, { origin: ORIGIN });
    expect(result).toEqual(QUIZ_RESULT_BODY);
    expect(callAt(0).method).toBe("POST");
    expect(callAt(0).url).toBe(`${ORIGIN}/api/v1/lessons/${LESSON_Q}/quiz/submit`);
    const parsed = JSON.parse(callAt(0).body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["answers"]);
    const first = (parsed["answers"] as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(["questionId", "choiceIds"]);
  });

  it("200 ไม่มี envelope {data} → ERR-SYS-001 (gate r7 M3)", async () => {
    stubFetch(okAlways(QUIZ_RESULT_BODY));
    const error = await submitLessonQuiz(LESSON_Q, { answers }, { origin: ORIGIN }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
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
    stubFetch(okAlways({ data: PROGRESS_RESULT_BODY }));
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
    stubFetch(okAlways({ data: PROGRESS_RESULT_BODY }));
    const view = await saveLessonProgress(LESSON_D, { documentRead: true }, { origin: ORIGIN });
    expect(view.status).toBe("in_progress");
    const parsed = JSON.parse(callAt(0).body ?? "{}") as Record<string, unknown>;
    expect(parsed).toEqual({ documentRead: true });
  });

  it("200 ไม่มี envelope {data} → ERR-SYS-001 (gate r7 M3)", async () => {
    stubFetch(okAlways(PROGRESS_RESULT_BODY));
    const error = await saveLessonProgress(LESSON_V, { positionSeconds: 60 }, { origin: ORIGIN }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
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

// ——— enrollCourse — ลงทะเบียนเรียน (PB-12): 201 ใหม่ / 200 ซ้ำ idempotent (DCR-3) ———
describe("enrollCourse", () => {
  it("POST 201 ใหม่ → resource ตาม contract (EnrollmentResource)", async () => {
    stubFetch(() => jsonResponse(201, { data: ENROLLMENT_BODY }));
    const enrollment = await enrollCourse(COURSE, { origin: ORIGIN });
    expect(enrollment).toEqual(ENROLLMENT_BODY);
    expect(callAt(0).method).toBe("POST");
    expect(callAt(0).url).toBe(`${ORIGIN}/api/v1/courses/${COURSE}/enroll`);
    expect(callAt(0).body).toBeUndefined();
  });

  it("ลงทะเบียนซ้ำ 200 → resource เดิม (DCR-3 idempotent)", async () => {
    stubFetch(() => jsonResponse(200, { data: ENROLLMENT_BODY }));
    const enrollment = await enrollCourse(COURSE, { origin: ORIGIN });
    expect(enrollment.courseId).toBe(COURSE);
    expect(enrollment.status).toBe("active");
  });

  it("resource ผิดรูป (courseId ไม่ใช่ uuid) → contract violation ERR-SYS-001", async () => {
    stubFetch(okAlways({ data: { ...ENROLLMENT_BODY, courseId: "not-a-uuid" } }));
    const error = await enrollCourse(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
  });

  it("401 → ERR-AUTH-001", async () => {
    stubFetch(() => jsonResponse(401, { error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบ" } }));
    const error = await enrollCourse(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-AUTH-001");
  });

  it("422 → ERR-ENR-002 (หลักสูตรเฉพาะทนายความ)", async () => {
    stubFetch(() => jsonResponse(422, { error: { code: "ERR-ENR-002", message: "เฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว" } }));
    const error = await enrollCourse(COURSE, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-ENR-002");
    expect((error as ApiError).status).toBe(422);
  });
});

// ——— cookie forwarding (RSC → BFF) ———
describe("cookieHeader forwarding", () => {
  it("เรียกจาก server ส่ง origin + cookieHeader ถึง BFF", async () => {
    stubFetch(okAlways({ data: PROGRESS_BODY }));
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

// ——— producer↔consumer จริง (gate r8 m2) — handler จริงส่งตรงเข้า reader ———
// คู่ contract เดิม (QUIZ_WIRE_BODY ↔ route.test.ts) ยึด "literal สองฝั่ง" ไว้ด้วยกัน
// แต่ถ้า producer เปลี่ยน wire พร้อมแก้ expected ของตัวเอง ฝั่ง consumer ยังผ่านได้
// ด้วย literal เก่า — test นี้ตัด literal ทิ้ง: รัน GET handler จริง (mock เฉพาะ
// DB/auth) แล้วส่ง response จริงเข้า getLessonQuiz — wire ไม่ตรงกันเมื่อไหร่แตกทันที
import { GET as getLessonQuizHandler } from "@/app/api/v1/lessons/[id]/quiz/route";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const QUIZ_ID = "00000000-0000-4000-8000-000000000063";
const OWNER = "00000000-0000-4000-8000-000000000099";

/** builder จำลอง PostgREST แบบย่อ (เหมือน route.test.ts ของ quiz) — ผลลัพธ์คงที่รายตาราง */
function pgBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
  };
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

describe("producer↔consumer จริง: GET /lessons/{id}/quiz → getLessonQuiz (gate r8 m2)", () => {
  it("response จริงของ handler ผ่าน reader ได้ครบทุก field (ไม่มี literal คั่นกลาง)", async () => {
    // แถว DB ตามที่ handler อ่านจริง (snake_case) — ครบทั้ง 5 ตาราง
    const lessonRow = {
      id: LESSON_Q,
      type: "quiz",
      quiz_id: QUIZ_ID,
      course_modules: { course_id: COURSE },
    };
    const quizRow = {
      title: "แบบทดสอบย่อยท้ายหลักสูตร",
      pass_pct: 70,
      max_attempts: 3,
      shuffle_questions: false,
      status: "active",
    };
    const questionRows = [
      { id: QUESTION_1, question_text: "ข้อใดเป็นพฤติกรรมที่ต้องห้ามตามจรรยาบรรณ", type: "single_choice", points: 1, sort_order: 1 },
      { id: QUESTION_2, question_text: "การรับโอนสินจ้างเกินอัตราที่ตกลงกันไว้ มีโทษอย่างไร", type: "true_false", points: 2, sort_order: 2 },
    ];
    const optionRows = [
      { id: CHOICE_A, question_id: QUESTION_1, option_text: "รับโอนสินจ้างเกินอัตราที่ตกลงกันไว้", sort_order: 1 },
      { id: CHOICE_B, question_id: QUESTION_1, option_text: "แจ้งความประพฤติของตนเองให้ลูกความทราบ", sort_order: 2 },
      { id: CHOICE_C, question_id: QUESTION_2, option_text: "ต้องรับโทษทางวินัยตามระเบียบสภาทนายความฯ", sort_order: 1 },
    ];
    const ok = (data: unknown) => ({ data, error: null });
    const ssrStub = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: OWNER } }, error: null })),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: "aal1", nextLevel: null, currentAuthenticationMethods: [] },
            error: null,
          })),
        },
      },
      rpc: vi.fn(async (fn: string) =>
        fn === "my_roles" ? { data: ["citizen"], error: null } : { data: null, error: null }),
      from: vi.fn((table: string) =>
        table === "profiles"
          ? pgBuilder(ok({ is_active: true, deleted_at: null }))
          : table === "lessons"
            ? pgBuilder(ok(lessonRow))
            : pgBuilder(ok({ id: ENROLLMENT }))),
    };
    const serviceStub = {
      from: vi.fn((table: string) =>
        table === "lesson_quizzes"
          ? pgBuilder(ok(quizRow))
          : table === "quiz_questions"
            ? pgBuilder(ok(questionRows))
            : pgBuilder(ok(optionRows))),
    };
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(ssrStub as never);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceStub as never);

    // 1) รัน producer จริง (shuffle=false → ลำดับ deterministic)
    const handlerResponse = await getLessonQuizHandler(
      new Request(`http://localhost:3000/api/v1/lessons/${LESSON_Q}/quiz`),
      { params: Promise.resolve({ id: LESSON_Q }) },
    );
    expect(handlerResponse.status).toBe(200);

    // 2) response จริงของ handler คือสิ่งที่ reader ประมวลผล — ไม่มี fixture คั่นกลาง
    stubFetch(() => handlerResponse);
    const quiz = await getLessonQuiz(LESSON_Q, { origin: ORIGIN });

    expect(quiz.lessonId).toBe(LESSON_Q);
    expect(quiz.passPct).toBe(70);
    expect(quiz.maxAttempts).toBe(3);
    expect(quiz.questions.map((q) => q.prompt)).toEqual([
      "ข้อใดเป็นพฤติกรรมที่ต้องห้ามตามจรรยาบรรณ",
      "การรับโอนสินจ้างเกินอัตราที่ตกลงกันไว้ มีโทษอย่างไร",
    ]);
    // id ผ่านตรงทั้งข้อและตัวเลือก — submit ตัดสินด้วย id คู่กันต้องเจอกัน
    expect(quiz.questions.map((q) => q.id)).toEqual([QUESTION_1, QUESTION_2]);
    expect(quiz.questions[0]?.choices.map((c) => c.id)).toEqual([CHOICE_A, CHOICE_B]);
    expect(quiz.questions[0]?.choices.map((c) => c.label)).toEqual([
      "รับโอนสินจ้างเกินอัตราที่ตกลงกันไว้",
      "แจ้งความประพฤติของตนเองให้ลูกความทราบ",
    ]);
    expect(quiz.questions[1]?.choices.map((c) => c.id)).toEqual([CHOICE_C]);
    // เฉลยไม่หลุดมากับเส้นนี้ (DCR-5)
    expect(JSON.stringify(quiz)).not.toContain("is_correct");
    expect(JSON.stringify(quiz)).not.toContain("explanation");
  });
});

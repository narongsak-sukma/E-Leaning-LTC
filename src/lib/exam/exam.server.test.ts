/**
 * exam.server.test — unit test loaders ฝั่ง RSC ของเส้นการสอบ (แบบเดียวกับ learning.server.test)
 *
 * - loadAssessmentDetail: 200 ตามสัญญา → ready + แนบ cookie/x-ltc-bff-internal ให้ BFF ·
 *   401 → unauthenticated · ERR-NF-001/404 → not_found · schema drift (คีย์เกิน/ขาด data)
 *   → unavailable (fail-closed ไม่ strip เงียบ)
 * - loadMyAttemptsPage: list envelope {data, page} → ready · cursor ต่อท้าย URL · แถวใดแถวหนึ่ง
 *   ผิดสัญญา = ทั้งหน้า unavailable (fail-closed) · 401 → unauthenticated
 * - loadAttemptResult: ส่งตาม BFF ตอบเป๊ะ (ธง lead ข้อ 4) — content:null (ยังไม่เปิดเฉลย) และ
 *   เปิดแล้ว (isCorrect/pointsEarned/explanation) ผ่านต่อเท่านั้น ไม่เดา · 404 → not_found
 * - formatThaiDateTime: ปฏิทินพุทธศักราช + Asia/Bangkok · ผิดรูป = null (ไม่เดา)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [{ name: "ltc-auth", value: "tok-123" }] }),
}));

// env ขั้นต่ำที่ lib/config ต้องใช้ (แบบเดียวกับ learning.server.test)
process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:53227";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  formatThaiDateTime,
  loadAssessmentDetail,
  loadAttemptResult,
  loadMyAttemptsPage,
} from "./exam.server";

const COURSE = "00000000-0000-4000-8000-0000000000c1";
const ASM = "00000000-0000-4000-8000-0000000000a1";
const ATTEMPT = "00000000-0000-4000-8000-0000000000b1";
const Q1 = "00000000-0000-4000-8000-0000000000d1";
const A = "00000000-0000-4000-8000-0000000000e1";
const B = "00000000-0000-4000-8000-0000000000e2";
const ISO = "2026-09-10T03:00:00+07:00";

// ─── fixtures ตาม zod contract ขาออก (schemas/v1/exam — strict ทุกชั้น) ───

const DETAIL = {
  id: ASM,
  courseId: COURSE,
  code: "EXAM-101",
  title: "การสอบขอบเขตวิชาทนายความ",
  description: null,
  isFinal: true,
  status: "published",
  publishedAt: ISO,
  rules: {
    version: 3,
    passPct: 70,
    timeLimitMinutes: 60,
    questionCount: 2,
    maxAttempts: 2,
    attemptCooldownMinutes: 30,
    shuffleQuestions: true,
    shuffleOptions: true,
    requireCourseComplete: true,
    proctoringMode: "none",
    effectiveFrom: ISO,
  },
};

const MY_ROW = {
  id: ATTEMPT,
  assessmentId: ASM,
  attemptNo: 1,
  status: "passed",
  startedAt: ISO,
  expiresAt: ISO,
  submittedAt: ISO,
  scorePct: 85,
  passed: true,
  questionCount: 2,
  correctCount: 2,
};

/** ผลสอบช่วงที่ view ยังไม่เปิดเฉลย — content/explanation/isCorrect เป็น null ตาม view */
const RESULT_CLOSED = {
  attemptId: ATTEMPT,
  assessmentId: ASM,
  attemptNo: 1,
  status: "passed",
  startedAt: ISO,
  expiresAt: ISO,
  submittedAt: ISO,
  scorePct: 85,
  passed: true,
  questionCount: 1,
  questions: [
    {
      questionId: Q1,
      seq: 1,
      selectedOptionIds: [A, B],
      answeredAt: ISO,
      isCorrect: null,
      pointsEarned: null,
      explanation: null,
      content: null,
    },
  ],
};

/** ผลสอบช่วงที่เปิดเฉลยแล้ว — ส่งตาม BFF เป๊ะ (ธง lead ข้อ 4) */
const RESULT_OPEN = {
  ...RESULT_CLOSED,
  questions: [
    {
      questionId: Q1,
      seq: 1,
      selectedOptionIds: [A],
      answeredAt: ISO,
      isCorrect: true,
      pointsEarned: 2,
      explanation: "ตอบถูกตามเฉลยของข้อนี้",
      content: {
        version: 2,
        text: "ข้อใดเป็นข้อสอบแบบหลายตัวเลือก",
        points: 2,
        options: [
          { id: A, text: "ตัวเลือกที่ถูกต้อง", isCorrect: true, points: 2 },
          { id: B, text: "ตัวเลือกที่ไม่ถูกต้อง", isCorrect: false, points: 1 },
        ],
      },
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** stub fetch ที่จับ URL/init รอบล่าสุดไว้ตรวจ (cookie forward / internal header / path) */
function stubBff(body: unknown, status = 200): { url: () => string; init: () => RequestInit | null } {
  let capturedUrl = "";
  let capturedInit: RequestInit | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input instanceof URL ? input.href : input);
      capturedInit = init ?? null;
      return jsonResponse(status, body);
    }),
  );
  return {
    url: () => capturedUrl,
    init: () => capturedInit,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ——— formatThaiDateTime — วันเวลาแบบไทย (พ.ศ. + Asia/Bangkok) ———
describe("formatThaiDateTime", () => {
  it("จัดรูปวันเวลาไทย (ปฏิทินพุทธศักราช + เขตเวลา Asia/Bangkok)", () => {
    const text = formatThaiDateTime(ISO);
    if (text === null) {
      throw new Error("ISO ถูกรูปควรจัดรูปได้");
    }
    expect(text).toContain("กันยายน");
    expect(text).toContain("2569");
  });

  it("ISO ผิดรูป → null (ไม่เดา)", () => {
    expect(formatThaiDateTime("ไม่ใช่วันที่")).toBeNull();
  });
});

// ——— loadAssessmentDetail — หน้ากติกาก่อนสอบ ———
describe("loadAssessmentDetail", () => {
  it("200 ตามสัญญา → ready พร้อมกติกาครบ + forward cookie + internal header ให้ BFF", async () => {
    const bff = stubBff({ data: DETAIL });
    const page = await loadAssessmentDetail(ASM);
    expect(page.kind).toBe("ready");
    if (page.kind !== "ready") {
      throw new Error("ควร ready");
    }
    expect(page.detail.id).toBe(ASM);
    expect(page.detail.courseId).toBe(COURSE);
    expect(page.detail.title).toBe("การสอบขอบเขตวิชาทนายความ");
    expect(page.detail.rules.passPct).toBe(70);
    expect(page.detail.rules.timeLimitMinutes).toBe(60);
    expect(page.detail.rules.questionCount).toBe(2);
    expect(page.detail.rules.maxAttempts).toBe(2);
    expect(page.detail.rules.attemptCooldownMinutes).toBe(30);
    expect(page.detail.rules.requireCourseComplete).toBe(true);
    expect(bff.url()).toBe(`http://test.local/api/v1/assessments/${ASM}`);
    const init = bff.init();
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("ltc-auth=tok-123");
    expect(headers.get("x-ltc-bff-internal")).toBe("1");
  });

  it("401 → unauthenticated", async () => {
    stubBff({ error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบ" } }, 401);
    expect(await loadAssessmentDetail(ASM)).toEqual({ kind: "unauthenticated" });
  });

  it("404 ERR-NF-001 → not_found", async () => {
    stubBff({ error: { code: "ERR-NF-001", message: "ไม่พบข้อมูล" } }, 404);
    expect(await loadAssessmentDetail(ASM)).toEqual({ kind: "not_found" });
  });

  it("BFF ตอบเพี้ยนสัญญา → unavailable ทั้งหมด (fail-closed)", async () => {
    // ขาด envelope data
    stubBff({ foo: 1 });
    expect(await loadAssessmentDetail(ASM)).toEqual({ kind: "unavailable" });
    // data มีคีย์เกิน (strict)
    stubBff({ data: { ...DETAIL, extra: true } });
    expect(await loadAssessmentDetail(ASM)).toEqual({ kind: "unavailable" });
    // rules มีคีย์เกิน (strict ทุกชั้น)
    stubBff({ data: { ...DETAIL, rules: { ...DETAIL.rules, drift: 1 } } });
    expect(await loadAssessmentDetail(ASM)).toEqual({ kind: "unavailable" });
  });
});

// ——— loadMyAttemptsPage — หน้าประวัติการสอบ ———
describe("loadMyAttemptsPage", () => {
  it("200 → ready ตาม envelope + cursor ต่อท้าย URL เมื่อระบุ", async () => {
    const bff = stubBff({ data: [MY_ROW], page: { hasMore: true, nextCursor: "cur-2" } });
    const page = await loadMyAttemptsPage(undefined);
    expect(page).toEqual({
      kind: "ready",
      attempts: [MY_ROW],
      hasMore: true,
      nextCursor: "cur-2",
    });
    expect(bff.url()).toBe("http://test.local/api/v1/me/attempts?limit=100");

    const bff2 = stubBff({ data: [], page: { hasMore: false } });
    expect(await loadMyAttemptsPage("cur-2")).toEqual({
      kind: "ready",
      attempts: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(bff2.url()).toBe("http://test.local/api/v1/me/attempts?limit=100&cursor=cur-2");
  });

  it("แถวใดแถวหนึ่งผิดสัญญา (คีย์เกิน) → ทั้งหน้า unavailable (fail-closed)", async () => {
    stubBff({
      data: [MY_ROW, { ...MY_ROW, id: "00000000-0000-4000-8000-0000000000b2", drift: 1 }],
      page: { hasMore: false },
    });
    expect(await loadMyAttemptsPage(undefined)).toEqual({ kind: "unavailable" });
  });

  it("data ไม่ใช่ array / envelope ไม่ใช่ object → unavailable", async () => {
    stubBff({ data: "not-an-array" });
    expect(await loadMyAttemptsPage(undefined)).toEqual({ kind: "unavailable" });
    stubBff("not-an-object");
    expect(await loadMyAttemptsPage(undefined)).toEqual({ kind: "unavailable" });
  });

  it("401 → unauthenticated", async () => {
    stubBff({ error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบ" } }, 401);
    expect(await loadMyAttemptsPage(undefined)).toEqual({ kind: "unauthenticated" });
  });
});

// ——— loadAttemptResult — หน้าผลสอบ (แสดงตาม BFF ตอบเท่านั้น) ———
describe("loadAttemptResult", () => {
  it("เฉลยยังไม่เปิด (content null ตาม view) → ready ส่งต่อ null ทุกช่องเฉลย", async () => {
    const bff = stubBff({ data: RESULT_CLOSED });
    const page = await loadAttemptResult(ATTEMPT);
    expect(page.kind).toBe("ready");
    if (page.kind !== "ready") {
      throw new Error("ควร ready");
    }
    expect(page.result.attemptId).toBe(ATTEMPT);
    expect(page.result.scorePct).toBe(85);
    expect(page.result.passed).toBe(true);
    expect(page.result.questions).toHaveLength(1);
    const question = page.result.questions[0];
    if (question === undefined) {
      throw new Error("ควรมี 1 ข้อ");
    }
    expect(question.content).toBeNull();
    expect(question.isCorrect).toBeNull();
    expect(question.pointsEarned).toBeNull();
    expect(question.explanation).toBeNull();
    expect(question.selectedOptionIds).toEqual([A, B]);
    expect(bff.url()).toBe(`http://test.local/api/v1/attempts/${ATTEMPT}/result`);
  });

  it("เฉลยเปิดแล้ว → ready ส่งต่อเนื้อหา/เฉลยตาม BFF เป๊ะ (ไม่ filter ไม่เดา)", async () => {
    stubBff({ data: RESULT_OPEN });
    const page = await loadAttemptResult(ATTEMPT);
    if (page.kind !== "ready") {
      throw new Error("ควร ready");
    }
    const question = page.result.questions[0];
    if (question === undefined) {
      throw new Error("ควรมี 1 ข้อ");
    }
    expect(question.isCorrect).toBe(true);
    expect(question.pointsEarned).toBe(2);
    expect(question.explanation).toBe("ตอบถูกตามเฉลยของข้อนี้");
    expect(question.content?.points).toBe(2);
    expect(question.content?.options[0]?.isCorrect).toBe(true);
    expect(question.content?.options[1]?.isCorrect).toBe(false);
  });

  it("404 ERR-NF-001 → not_found", async () => {
    stubBff({ error: { code: "ERR-NF-001", message: "ไม่พบ attempt" } }, 404);
    expect(await loadAttemptResult(ATTEMPT)).toEqual({ kind: "not_found" });
  });

  it("BFF ตอบเพี้ยนสัญญา (คีย์เกิน top level / ใน question) → unavailable", async () => {
    stubBff({ data: { ...RESULT_CLOSED, drift: true } });
    expect(await loadAttemptResult(ATTEMPT)).toEqual({ kind: "unavailable" });
    stubBff({
      data: {
        ...RESULT_CLOSED,
        questions: [{ ...RESULT_CLOSED.questions[0], drift: 1 }],
      },
    });
    expect(await loadAttemptResult(ATTEMPT)).toEqual({ kind: "unavailable" });
  });
});

/**
 * route.test — GET /api/v1/lessons/{id}/quiz (อ่านโจทย์แบบทดสอบย่อย — DCR-5)
 *
 * mock "@/lib/supabase/ssr" + "@/lib/supabase/server" ตามแบบ rbac.test.ts (D26) —
 * ทดสอบ: โจทย์+ตัวเลือกเท่านั้น (ไม่มี is_correct/explanation ทุกชั้น), auth/MFA,
 * enrollment gate, lesson ไม่ใช่ quiz, quiz ไม่ active, rate group READ
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { enforceRateLimit, resetRateLimitStore } from "@/lib/rate-limit";
import { GET } from "./route";

// ─── env ขั้นต่ำที่ lib/config ต้องใช้ (rate limit อ่าน config ตอน enforce) ───
process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:53227";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

// session.ts import "server-only" — stub ใน vitest (แบบเดียวกับ route.test.ts อื่น)
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
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: vi.fn(actual.enforceRateLimit) };
});

const LESSON_ID = "a1111111-1111-4111-8111-111111111111";
const COURSE_ID = "c1111111-1111-4111-8111-111111111111";
const QUIZ_ID = "d1111111-1111-4111-8111-111111111111";
const USER_ID = "u1111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;
/** ผลลัพธ์ builder จำลอง — รูปเดียวกับ PostgREST (single | list | error) */
type QueryResult = { data: Row | Row[] | null; error: { message: string } | null };

interface StubSpec {
  user?: { id: string } | null;
  roles?: readonly string[];
  aal?: "aal1" | "aal2";
  /** ผล .maybeSingle() ของ lessons — null = RLS มองไม่เห็น */
  lesson?: Row | null;
  /** ผล .maybeSingle() ของ enrollments — null = ไม่มี enrollment active */
  enrollment?: Row | null;
  /** ผล .maybeSingle() ของ lesson_quizzes (service path) */
  quiz?: Row | null;
  questions?: Row[];
  options?: Row[];
  /** ตาราง service-path ที่ให้อ่านล้ม (สำหรับทดสอบ ERR-SYS-002 opaque) */
  serviceError?: "lesson_quizzes" | "quiz_questions" | "quiz_options";
}

const QUIZ_LESSON = {
  id: LESSON_ID,
  type: "quiz",
  quiz_id: QUIZ_ID,
  course_modules: { course_id: COURSE_ID },
};
const ENROLLMENT_ROW = { id: "e1111111-1111-4111-8111-111111111111" };
const QUIZ_ROW = {
  title: "แบบทดสอบท้ายบท",
  pass_pct: 60,
  max_attempts: 2,
  shuffle_questions: false,
  status: "active",
};

/** ข้อสอบ 2 ข้อ + ตัวเลือกข้อละ 2 ตัว (sort_order ไล่ 1,2) */
const QUESTION_ROWS: Row[] = [
  { id: "11111111-1111-4111-8111-111111111111", question_text: "ข้อ 1", type: "single_choice", points: 1, sort_order: 1 },
  { id: "22222222-2222-4222-8222-222222222222", question_text: "ข้อ 2", type: "true_false", points: 2, sort_order: 2 },
];
const OPTION_ROWS: Row[] = [
  { id: "b1111111-1111-4111-8111-111111111111", question_id: "11111111-1111-4111-8111-111111111111", option_text: "ข้อ 1 ตัวเลือก A", sort_order: 1 },
  { id: "b2222222-2222-4222-8222-222222222222", question_id: "11111111-1111-4111-8111-111111111111", option_text: "ข้อ 1 ตัวเลือก B", sort_order: 2 },
  { id: "b3333333-3333-4333-8333-333333333333", question_id: "22222222-2222-4222-8222-222222222222", option_text: "ข้อ 2 ตัวเลือก A", sort_order: 1 },
  { id: "b4444444-4444-4444-8444-444444444444", question_id: "22222222-2222-4222-8222-222222222222", option_text: "ข้อ 2 ตัวเลือก B", sort_order: 2 },
];

/** builder จำลอง PostgREST — maybeSingle = แถวเดียว, then = list (คล้ายของจริง) */
function makeBuilder(
  single: Row | null,
  list: Row[] | undefined,
  fail: boolean,
): { builder: Record<string, unknown>; selectCalls: string[] } {
  const selectCalls: string[] = [];
  const builder: Record<string, unknown> = {
    select: vi.fn((columns: string) => {
      selectCalls.push(columns);
      return builder;
    }),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
  };
  const result: QueryResult = fail
    ? { data: null, error: { message: "mock read failure" } }
    : {
        // โหมดชัดเจน: ส่ง list = อ่านหลายแถว (data=list) · ไม่ส่ง list = maybeSingle
        // (data=single — null คือ "ไม่พบแถว" จริง ๆ ห้ามกลืนเป็น [] เหมือน ??)
        data: list !== undefined ? list : (single ?? null),
        error: null,
      };
  builder.maybeSingle = vi.fn(async (): Promise<QueryResult> => result);
  if (list !== undefined) {
    builder.then = (resolve: (value: QueryResult) => unknown) =>
      Promise.resolve(result).then(resolve);
  }
  return { builder, selectCalls };
}

/** สร้างคู่ client — ssr (user JWT) สำหรับ profiles/lessons/enrollments, service สำหรับตาราง quiz */
function makeStub(spec: StubSpec = {}) {
  const lesson = makeBuilder(spec.lesson === undefined ? QUIZ_LESSON : spec.lesson, undefined, false);
  const enrollment = makeBuilder(
    spec.enrollment === undefined ? ENROLLMENT_ROW : spec.enrollment,
    undefined,
    false,
  );
  const quiz = makeBuilder(
    spec.quiz === undefined ? QUIZ_ROW : spec.quiz,
    undefined,
    spec.serviceError === "lesson_quizzes",
  );
  const questions = makeBuilder(
    null,
    spec.questions ?? QUESTION_ROWS,
    spec.serviceError === "quiz_questions",
  );
  const options = makeBuilder(
    null,
    spec.options ?? OPTION_ROWS,
    spec.serviceError === "quiz_options",
  );
  const selects: Record<string, string[]> = {
    lesson_quizzes: quiz.selectCalls,
    quiz_questions: questions.selectCalls,
    quiz_options: options.selectCalls,
  };
  const ssr = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: spec.user === undefined ? { id: USER_ID } : spec.user },
        error: null,
      })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: {
            currentLevel: spec.aal ?? "aal1",
            nextLevel: null,
            currentAuthenticationMethods: [],
          },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles"
        ? { data: spec.roles ?? ["citizen"], error: null }
        : { data: null, error: null }),
    from: vi.fn((table: string) =>
      table === "profiles"
        ? makeBuilder({ is_active: true, deleted_at: null }, undefined, false).builder
        : table === "lessons"
          ? lesson.builder
          : enrollment.builder),
  };
  const service = {
    from: vi.fn((table: string) =>
      table === "lesson_quizzes"
        ? quiz.builder
        : table === "quiz_questions"
          ? questions.builder
          : options.builder),
  };
  return { ssr, service, selects, lessonBuilder: lesson.builder };
}

function makeRequest(): Request {
  return new Request("http://localhost:3000/api/v1/lessons/" + LESSON_ID + "/quiz", {
    headers: { "x-request-id": "req-quiz" },
  });
}

function context() {
  return { params: Promise.resolve({ id: LESSON_ID }) };
}

async function callRoute(spec: StubSpec = {}) {
  const stub = makeStub(spec);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.ssr as never);
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(stub.service as never);
  const response = await GET(makeRequest(), context());
  return { response, ...stub };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("GET /lessons/{id}/quiz — happy path + กันเฉลย (DCR-5)", () => {
  it("200 — โจทย์+ตัวเลือกตามรูป (camelCase) และไม่มี is_correct/explanation ทุกชั้น", async () => {
    const { response, selects } = await callRoute();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      title: "แบบทดสอบท้ายบท",
      passPct: 60,
      maxAttempts: 2,
      shuffleQuestions: false,
      questions: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          text: "ข้อ 1",
          type: "single_choice",
          points: 1,
          options: [
            { id: "b1111111-1111-4111-8111-111111111111", text: "ข้อ 1 ตัวเลือก A", sortOrder: 1 },
            { id: "b2222222-2222-4222-8222-222222222222", text: "ข้อ 1 ตัวเลือก B", sortOrder: 2 },
          ],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          text: "ข้อ 2",
          type: "true_false",
          points: 2,
          options: [
            { id: "b3333333-3333-4333-8333-333333333333", text: "ข้อ 2 ตัวเลือก A", sortOrder: 1 },
            { id: "b4444444-4444-4444-8444-444444444444", text: "ข้อ 2 ตัวเลือก B", sortOrder: 2 },
          ],
        },
      ],
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain("is_correct");
    expect(json).not.toContain("explanation");
    expect(JSON.stringify(selects.quiz_questions)).not.toContain("explanation");
    expect(JSON.stringify(selects.quiz_options)).not.toContain("is_correct");
    expect(response.headers.get("x-request-id")).toBe("req-quiz");
  });

  it("select ของ service path เป็นคอลัมน์โจทย์เท่านั้น (ตัดคอลัมน์เฉลยที่ต้นทาง)", async () => {
    const { selects } = await callRoute();
    expect(selects["lesson_quizzes"]).toEqual(["title, pass_pct, max_attempts, shuffle_questions, status"]);
    expect(selects["quiz_questions"]).toEqual(["id, question_text, type, points, sort_order"]);
    expect(selects["quiz_options"]).toEqual(["id, question_id, option_text, sort_order"]);
  });
});

describe("GET /lessons/{id}/quiz — shuffle และรูปรอง", () => {
  it("shuffle_questions=true → ครบทุกข้อ (ชุด id เท่ากัน) + ตัวเลือกของแต่ละข้อคงเดิม", async () => {
    const { response } = await callRoute({
      quiz: { ...QUIZ_ROW, shuffle_questions: true },
      questions: [
        ...QUESTION_ROWS,
        { id: "33333333-3333-4333-8333-333333333333", question_text: "ข้อ 3", type: "multiple_choice", points: 1, sort_order: 3 },
      ],
      options: [
        ...OPTION_ROWS,
        { id: "b5555555-5555-4555-8555-555555555555", question_id: "33333333-3333-4333-8333-333333333333", option_text: "ข้อ 3 ตัวเลือก A", sort_order: 1 },
        { id: "b6666666-6666-4666-8666-666666666666", question_id: "33333333-3333-4333-8333-333333333333", option_text: "ข้อ 3 ตัวเลือก B", sort_order: 2 },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { shuffleQuestions: boolean; questions: Array<{ id: string; options: Array<{ id: string }> }> };
    };
    expect(body.data.shuffleQuestions).toBe(true);
    const ids = body.data.questions.map((q) => q.id).sort();
    expect(ids).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);
    for (const question of body.data.questions) {
      expect(question.options.length).toBe(2);
    }
  });

  it("max_attempts=null (ไม่จำกัดครั้ง) → maxAttempts: null", async () => {
    const { response } = await callRoute({ quiz: { ...QUIZ_ROW, max_attempts: null } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { maxAttempts: number | null } };
    expect(body.data.maxAttempts).toBeNull();
  });
});

describe("GET /lessons/{id}/quiz — auth / MFA / rate", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่อ่านตารางใด)", async () => {
    const { response, service } = await callRoute({ user: null });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-AUTH-001");
    expect(service.from).not.toHaveBeenCalled();
  });

  it("staff:viewer aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004 (D25-O4)", async () => {
    const { response } = await callRoute({ roles: ["staff:viewer"] });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-AUTH-004");
  });

  it("เรียก rate กลุ่ม READ ด้วยคีย์ user_id (D12-11 — pattern เดียวกับ GET progress)", async () => {
    await callRoute();
    const call = vi.mocked(enforceRateLimit).mock.calls[0];
    const result = vi.mocked(enforceRateLimit).mock.results[0];
    expect(call?.[1]?.["secondaryKey"]).toBe(USER_ID);
    expect(result && result.type === "return" ? result.value.group : undefined).toBe("READ");
  });
});

describe("GET /lessons/{id}/quiz — enrollment + lesson/quiz validation", () => {
  it("บทเรียนมองไม่เห็น (RLS) → 403 ERR-LRN-001", async () => {
    const { response } = await callRoute({ lesson: null });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
  });

  it("soft-delete filter (gate r2): อ่าน lessons ต้องส่ง .is(deleted_at, null) เสมอ", async () => {
    const { lessonBuilder } = await callRoute();
    const isCalls = (lessonBuilder.is as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(isCalls).toContainEqual(["deleted_at", null]);
  });

  it("ไม่มี enrollment active (ไม่ลงทะเบียน/หมดอายุ) → 403 ERR-LRN-001", async () => {
    const { response, service } = await callRoute({ enrollment: null });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
    expect(service.from).not.toHaveBeenCalled(); // ไม่ยื่นมือเข้า service path ถ้าไม่ลงทะเบียน
  });

  it("บทเรียนที่เห็นไม่ใช่บท quiz → 404 ERR-CRS-001", async () => {
    const { response } = await callRoute({
      lesson: { id: LESSON_ID, type: "video", quiz_id: null, course_modules: { course_id: COURSE_ID } },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-CRS-001");
  });

  it("quiz ไม่พบ (service path) → 404 ERR-CRS-001", async () => {
    const { response } = await callRoute({ quiz: null });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-CRS-001");
  });

  it("quiz ยัง draft → 404 ERR-CRS-001", async () => {
    const { response } = await callRoute({ quiz: { ...QUIZ_ROW, status: "draft" } });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-CRS-001");
  });

  it("quiz ไม่มีโจทย์ active → 404 ERR-CRS-001", async () => {
    const { response } = await callRoute({ questions: [] });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-CRS-001");
  });

  it("path param ไม่ใช่ UUID → 400 ERR-VAL-001", async () => {
    const stub = makeStub();
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.ssr as never);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(stub.service as never);
    const request = new Request("http://localhost:3000/api/v1/lessons/not-a-uuid/quiz", {
      headers: { "x-request-id": "req-quiz" },
    });
    const response = await GET(request, { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("service path อ่านล้ม (lesson_quizzes) → 503 ERR-SYS-002 แบบ opaque", async () => {
    const { response } = await callRoute({ serviceError: "lesson_quizzes" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-SYS-002");
    expect(JSON.stringify(body)).not.toContain("mock read failure");
  });

  it("service path อ่านล้ม (quiz_questions) → 503 ERR-SYS-002", async () => {
    const { response } = await callRoute({ serviceError: "quiz_questions" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-SYS-002");
  });

  it("service path อ่านล้ม (quiz_options) → 503 ERR-SYS-002", async () => {
    const { response } = await callRoute({ serviceError: "quiz_options" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-SYS-002");
  });
});

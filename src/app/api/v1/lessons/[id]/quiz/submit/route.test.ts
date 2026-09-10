/**
 * route.test — POST /api/v1/lessons/{id}/quiz/submit (ส่งแบบทดสอบย่อย)
 *
 * mock "@/lib/supabase/ssr" ตามแบบ rbac.test.ts (D26) — client stub ตอบตามตาราง;
 * ทดสอบ: answers แปลงเป็น contract ของ RPC (snake_case, ไม่มี is_correct — grading server ล้วน),
 * error mapping จาก RPC 0011_functions.sql และกลุ่ม rate LEARN_WRITE (§5)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { enforceRateLimit, resetRateLimitStore } from "@/lib/rate-limit";
import { POST } from "./route";

// ─── env ขั้นต่ำที่ lib/config ต้องใช้ ───
process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

// session.ts (โหลดผ่าน rbac.loadSessionFromSupabase) import "server-only" — stub ใน vitest
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => ({ createSupabaseSsrClient: vi.fn() }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: vi.fn(actual.enforceRateLimit) };
});

const LESSON_ID = "a1111111-1111-4111-8111-111111111111";
const QUIZ_ID = "q1111111-1111-4111-8111-111111111111";
const QUESTION_ID = "11111111-1111-4111-8111-111111111111";
const CHOICE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "u1111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

interface StubOptions {
  user?: { id: string } | null;
  myRoles?: readonly string[];
  single?: Record<string, Row | null | Array<Row | null>>;
  rpc?: Record<string, { data?: unknown; error?: { message: string } | null }>;
}

function makeStubClient(options: StubOptions = {}) {
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const builders: Record<string, Record<string, unknown>> = {};
  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.user === undefined ? { id: USER_ID } : options.user },
        error: null,
      })),
      mfa: {
        // ของ session.getUser (kernel) — aal1 ค่าตั้งต้น (ผู้เรียนไม่ถูกบังคับ MFA)
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1", nextLevel: null, currentAuthenticationMethods: [] },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string, args: Row) => {
      if (fn === "my_roles") {
        // ของ rbac (kernel) — ไม่นับเป็น RPC ของ lane นี้
        return { data: options.myRoles ?? ["citizen"], error: null };
      }
      rpcCalls.push({ fn, args });
      return options.rpc?.[fn] ?? { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "in", "order", "limit"] as const) {
        builder[method] = vi.fn(() => builder);
      }
      builder.maybeSingle = vi.fn(async () => ({
        // profiles ของ session.getUser (SDS §5.5) — default = บัญชี active; override ผ่าน single.profiles ได้
        data: options.single?.[table] ?? (table === "profiles" ? { is_active: true, deleted_at: null } : null),
        error: null,
      }));
      builders[table] = builder;
      return builder;
    }),
  };
  return {
    client: client as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>>,
    rpcCalls,
    builders,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/lessons/" + LESSON_ID + "/quiz/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-test" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: LESSON_ID }) };
}

const QUIZ_LESSON = { id: LESSON_ID, type: "quiz", quiz_id: QUIZ_ID };
const RPC_RESULT = { attempt_id: "33333333-3333-4333-8333-333333333333", score_pct: 80, passed: true };
const BODY = { answers: [{ questionId: QUESTION_ID, choiceIds: [CHOICE_ID] }] };

async function callRoute(options: StubOptions, body: unknown) {
  const stub = makeStubClient(options);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.client);
  const response = await POST(makeRequest(body), context());
  return { response, ...stub };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("POST /lessons/{id}/quiz/submit — ส่งคำตอบผ่าน RPC (grading server ล้วน)", () => {
  it("200 — p_quiz_id + p_answers เป็น contract ของ RPC (snake_case, ไม่มี is_correct/คะแนน)", async () => {
    const { response, rpcCalls } = await callRoute(
      { single: { lessons: QUIZ_LESSON }, rpc: { record_quiz_attempt: { data: RPC_RESULT } } },
      BODY,
    );
    expect(response.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("record_quiz_attempt");
    expect(rpcCalls[0]?.args).toEqual({
      p_quiz_id: QUIZ_ID,
      p_answers: [{ question_id: QUESTION_ID, selected_option_ids: [CHOICE_ID] }],
    });
    expect(JSON.stringify(rpcCalls[0]?.args)).not.toContain("is_correct");
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      attemptId: "33333333-3333-4333-8333-333333333333",
      scorePct: 80,
      passed: true,
    });
  });

  it("200 — หลายข้อ/หลายตัวเลือก (choiceIds หลายค่า) ส่งถึง RPC ครบตามลำดับ", async () => {
    const CHOICE2 = "44444444-4444-4444-8444-444444444444";
    const { rpcCalls } = await callRoute(
      { single: { lessons: QUIZ_LESSON }, rpc: { record_quiz_attempt: { data: RPC_RESULT } } },
      { answers: [
        { questionId: QUESTION_ID, choiceIds: [CHOICE_ID, CHOICE2] },
        { questionId: "55555555-5555-4555-8555-555555555555", choiceIds: [CHOICE_ID] },
      ] },
    );
    expect(rpcCalls[0]?.args["p_answers"]).toEqual([
      { question_id: QUESTION_ID, selected_option_ids: [CHOICE_ID, CHOICE2] },
      { question_id: "55555555-5555-4555-8555-555555555555", selected_option_ids: [CHOICE_ID] },
    ]);
  });

  it("200 — RPC คืน passed=false (ไม่ผ่าน) ก็สะท้อนตามจริง", async () => {
    const { response } = await callRoute(
      { single: { lessons: QUIZ_LESSON }, rpc: { record_quiz_attempt: { data: { ...RPC_RESULT, passed: false, score_pct: 40 } } } },
      BODY,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data["passed"]).toBe(false);
    expect(body.data["scorePct"]).toBe(40);
  });

  it("RPC คืน jsonb ผิด contract (ไม่มี attempt_id) → 503 ERR-SYS-002 แบบ opaque", async () => {
    const { response } = await callRoute(
      { single: { lessons: QUIZ_LESSON }, rpc: { record_quiz_attempt: { data: { score_pct: 80, passed: true } } } },
      BODY,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-SYS-002");
  });
});

describe("POST /lessons/{id}/quiz/submit — validation + auth", () => {
  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    const { response } = await callRoute({ user: null }, BODY);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-AUTH-001");
  });

  it("บทเรียนมองไม่เห็น (RLS) → 403 ERR-LRN-001 (ตอบเหมือนไม่มีจริง)", async () => {
    const { response } = await callRoute({ single: { lessons: null } }, BODY);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
  });

  it("soft-delete filter (gate r2): อ่าน lessons ต้องส่ง .is(deleted_at, null) เสมอ", async () => {
    const { builders } = await callRoute({ single: { lessons: QUIZ_LESSON }, rpc: { record_quiz_attempt: { data: RPC_RESULT } } }, BODY);
    const isCalls = (builders["lessons"]?.is as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(isCalls).toContainEqual(["deleted_at", null]);
  });

  it("บทเรียนที่เห็นไม่ใช่บท quiz → 404 ERR-NF-001 (ไม่มี quiz ให้ส่ง)", async () => {
    const { response } = await callRoute(
      { single: { lessons: { id: LESSON_ID, type: "video", quiz_id: null } } },
      BODY,
    );
    expect(response.status).toBe(404);
    const body = (await quizSubmitJson(response)) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-NF-001");
  });

  it("answers ว่าง → 400 ERR-VAL-001 (schema min 1)", async () => {
    const { response } = await callRoute({}, { answers: [] });
    expect(response.status).toBe(400);
    const body = (await quizSubmitJson(response)) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("choiceIds ว่าง → 400 ERR-VAL-001 (schema min 1 ต่อข้อ)", async () => {
    const { response } = await callRoute({}, { answers: [{ questionId: QUESTION_ID, choiceIds: [] }] });
    expect(response.status).toBe(400);
    const body = (await quizSubmitJson(response)) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("body ไม่ใช่ JSON → 400 ERR-VAL-001", async () => {
    const stub = makeStubClient({});
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.client);
    const request = new Request("http://localhost:3000/api/v1/lessons/" + LESSON_ID + "/quiz/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const response = await POST(request, context());
    expect(response.status).toBe(400);
    const body = (await quizSubmitJson(response)) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });
});

/** helper — NextResponse บางเวอร์ชันไม่มี .json() ใช้ได้กับ expect ตรง ๆ (อ่านผ่าน Response) */
async function quizSubmitJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

describe("POST /lessons/{id}/quiz/submit — error mapping จาก RPC 0011_functions.sql", () => {
  it("RPC: ตัวเลือกไม่อยู่ในข้อ (ERR-VAL-001) → 400 ตามทะเบียน", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: QUIZ_LESSON },
        rpc: { record_quiz_attempt: { error: { message: "ตัวเลือกไม่ตรงกับข้อสอบ (ERR-VAL-001)" } } },
      },
      BODY,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("RPC: เกินจำนวนครั้งที่สอบได้ (ERR-ASM-001) → 422 ตามทะเบียน", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: QUIZ_LESSON },
        rpc: { record_quiz_attempt: { error: { message: "ส่งแบบทดสอบเกินจำนวนครั้งที่กำหนด (ERR-ASM-001)" } } },
      },
      BODY,
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-ASM-001");
  });

  it("RPC: ไม่มี enrollment active (ERR-LRN-001) → 403 ตามทะเบียน", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: QUIZ_LESSON },
        rpc: { record_quiz_attempt: { error: { message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)" } } },
      },
      BODY,
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
  });

  it("RPC: quiz ไม่พบ/ไม่ active (ERR-NF-001) → 404 ตามทะเบียน", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: QUIZ_LESSON },
        rpc: { record_quiz_attempt: { error: { message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)" } } },
      },
      BODY,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-NF-001");
  });

  it("RPC error ไม่มี code ทะเบียน → 500 ERR-SYS-001 แบบ opaque (ไม่ leak SQL)", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: QUIZ_LESSON },
        rpc: { record_quiz_attempt: { error: { message: 'SQLSTATE 23505: duplicate key value violates unique constraint "qa_unique"' } } },
      },
      BODY,
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-SYS-001");
    expect(JSON.stringify(body)).not.toContain("SQLSTATE");
    expect(JSON.stringify(body)).not.toContain("qa_unique");
  });
});

describe("POST /lessons/{id}/quiz/submit — rate limit (§5)", () => {
  it("enforceRateLimit ถูกเรียกกลุ่ม LEARN_WRITE ด้วยคีย์ user_id (D12-11)", async () => {
    await callRoute(
      { single: { lessons: QUIZ_LESSON }, rpc: { record_quiz_attempt: { data: RPC_RESULT } } },
      BODY,
    );
    const call = vi.mocked(enforceRateLimit).mock.calls[0];
    const result = vi.mocked(enforceRateLimit).mock.results[0];
    expect(call?.[1]?.["group"]).toBe("LEARN_WRITE");
    expect(call?.[1]?.["secondaryKey"]).toBe(USER_ID);
    expect(result && result.type === "return" ? result.value.group : undefined).toBe("LEARN_WRITE");
  });
});

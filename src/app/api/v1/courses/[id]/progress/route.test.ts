/**
 * route.test — GET /api/v1/courses/{id}/progress (สรุปความคืบหน้าของตัวเองในหลักสูตร)
 *
 * mock "@/lib/supabase/ssr" ตามแบบ rbac.test.ts (D26) — client stub ตอบตามตาราง;
 * ทดสอบการประกอบ summary (สูตร pct เดียวกับ v_enrollment_progress), การตรวจสิทธิ์,
 * error mapping และกลุ่ม rate limit (§5 — GET /courses/* → PUBLIC_READ)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { enforceRateLimit, resetRateLimitStore } from "@/lib/rate-limit";
import { GET } from "./route";

// ─── env ขั้นต่ำที่ lib/config ต้องใช้ ───
process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

// session.ts (โหลดผ่าน rbac.loadSessionFromSupabase) import "server-only" — stub ใน vitest
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
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: vi.fn(actual.enforceRateLimit) };
});

const COURSE_ID = "c1111111-1111-4111-8111-111111111111";
const ENROLLMENT_ID = "e1111111-1111-4111-8111-111111111111";
const USER_ID = "u1111111-1111-4111-8111-111111111111";
const MODULE1_ID = "b1111111-1111-4111-8111-111111111111";
const MODULE2_ID = "b2222222-2222-4222-8222-222222222222";
const LESSON1_ID = "a1111111-1111-4111-8111-111111111111";
const LESSON2_ID = "a2222222-2222-4222-8222-222222222222";
const LESSON3_ID = "a3333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;

interface StubOptions {
  user?: { id: string } | null;
  myRoles?: readonly string[];
  /** ผล .maybeSingle() ต่อตาราง — array = ลำดับการเรียก */
  single?: Record<string, Row | null | Array<Row | null>>;
  /** ผลการ await builder (in()/order()) ต่อตาราง */
  list?: Record<string, Row[]>;
  rpc?: Record<string, { data?: unknown; error?: { message: string } | null }>;
}

function makeStubClient(options: StubOptions = {}) {
  const queues: Record<string, Array<Row | null>> = {};
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
    rpc: vi.fn(async (fn: string) => {
      if (fn === "my_roles") {
        // ของ rbac (kernel) — ไม่นับเป็น RPC ของ lane นี้
        return { data: options.myRoles ?? ["citizen"], error: null };
      }
      return options.rpc?.[fn] ?? { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "in", "order", "limit"] as const) {
        builder[method] = vi.fn(() => builder);
      }
      builder.maybeSingle = vi.fn(async () => {
        const spec = options.single?.[table];
        if (Array.isArray(spec)) {
          const queue = queues[table] ?? spec;
          const [first, ...rest] = queue;
          queues[table] = rest;
          return { data: first ?? null, error: null };
        }
        // profiles ของ session.getUser (SDS §5.5) — default = บัญชี active; override ผ่าน single.profiles ได้
        return { data: spec ?? (table === "profiles" ? { is_active: true, deleted_at: null } : null), error: null };
      });
      builder.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: options.list?.[table] ?? [], error: null }).then(resolve);
      return builder;
    }),
  };
  return {
    client: client as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>>,
  };
}

function makeRequest(): Request {
  return new Request("http://localhost:3000/api/v1/courses/" + COURSE_ID + "/progress", {
    headers: { "x-request-id": "req-test" },
  });
}

function context() {
  return { params: Promise.resolve({ id: COURSE_ID }) };
}

const ENROLLMENT = { id: ENROLLMENT_ID, status: "active", enrolled_at: "2026-09-01T00:00:00+00:00" };
const MODULES = [
  { id: MODULE1_ID, title_th: "โมดูล 1", sort_order: 1 },
  { id: MODULE2_ID, title_th: "โมดูล 2", sort_order: 2 },
];
const LESSONS = [
  { id: LESSON1_ID, module_id: MODULE1_ID, type: "video", sort_order: 1 },
  { id: LESSON2_ID, module_id: MODULE1_ID, type: "document", sort_order: 2 },
  { id: LESSON3_ID, module_id: MODULE2_ID, type: "quiz", sort_order: 1 },
];
/** L1 จบแล้ว, L3 กำลังเรียน — L2 ยังไม่เริ่ม (ไม่มีแถวความคืบหน้า) */
const PROGRESS = [
  {
    lesson_id: LESSON1_ID,
    status: "completed",
    watch_pct: 100,
    quiz_score_pct: null,
    completed_at: "2026-09-05T00:00:00+00:00",
  },
  {
    lesson_id: LESSON3_ID,
    status: "in_progress",
    watch_pct: 0,
    quiz_score_pct: null,
    completed_at: null,
  },
];

async function callRoute(options: StubOptions) {
  const stub = makeStubClient(options);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.client);
  const response = await GET(makeRequest(), context());
  return { response };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /courses/{id}/progress — ประกอบ summary", () => {
  it("200 — นับเฉพาะบทที่เห็นจริง: โมดูล 1 = 1/2 (50%), โมดูล 2 = 0/1 (0%), รวม 1/3 (33%)", async () => {
    const { response } = await callRoute({
      single: { enrollments: ENROLLMENT },
      list: { course_modules: MODULES, lessons: LESSONS, lesson_progress: PROGRESS },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data["courseId"]).toBe(COURSE_ID);
    expect(body.data["enrollmentId"]).toBe(ENROLLMENT_ID);
    expect(body.data["enrollmentStatus"]).toBe("active");
    expect(body.data["lessonTotal"]).toBe(3);
    expect(body.data["lessonCompleted"]).toBe(1);
    expect(body.data["progressPct"]).toBe(33); // round(100*1/3)
    const modules = body.data["modules"] as Array<Record<string, unknown>>;
    expect(modules).toHaveLength(2);
    expect(modules[0]?.["title"]).toBe("โมดูล 1");
    expect(modules[0]?.["lessonTotal"]).toBe(2);
    expect(modules[0]?.["lessonCompleted"]).toBe(1);
    expect(modules[0]?.["progressPct"]).toBe(50); // round(100*1/2)
    const lessons1 = modules[0]?.["lessons"] as Array<Record<string, unknown>>;
    expect(lessons1).toHaveLength(2);
    expect(lessons1[0]).toEqual({
      lessonId: LESSON1_ID,
      lessonType: "video",
      status: "completed",
      watchPct: 100,
      quizScorePct: null,
      completedAt: "2026-09-05T00:00:00+00:00",
    });
    // บทที่ไม่มีแถวความคืบหน้า = not_started ด้วยค่า default
    expect(lessons1[1]).toEqual({
      lessonId: LESSON2_ID,
      lessonType: "document",
      status: "not_started",
      watchPct: 0,
      quizScorePct: null,
      completedAt: null,
    });
    expect(modules[1]?.["progressPct"]).toBe(0);
  });

  it("หลักสูตรไม่มีโมดูล → lessonTotal 0 + progressPct 0 (ไม่ query lessons ซ้ำ)", async () => {
    const { response } = await callRoute({
      single: { enrollments: ENROLLMENT },
      list: { course_modules: [] },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data["lessonTotal"]).toBe(0);
    expect(body.data["lessonCompleted"]).toBe(0);
    expect(body.data["progressPct"]).toBe(0);
    expect(body.data["modules"]).toEqual([]);
  });

  it("enrollment สถานะ completed ก็อ่านสรุปได้ (อ่านทุกสถานะ — client แสดงสถานะเอง)", async () => {
    const { response } = await callRoute({
      single: { enrollments: { ...ENROLLMENT, status: "completed" } },
      list: { course_modules: MODULES, lessons: LESSONS, lesson_progress: PROGRESS },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data["enrollmentStatus"]).toBe("completed");
  });
});

describe("GET /courses/{id}/progress — ตรวจสิทธิ์ + error", () => {
  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    const { response } = await callRoute({ user: null });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-AUTH-001");
  });

  it("ไม่มี enrollment ของตัวเอง (ไม่ลงทะเบียน) → 403 ERR-LRN-001", async () => {
    const { response } = await callRoute({ single: { enrollments: null } });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
  });

  it("courseId ใน path ไม่ใช่ UUID → 400 ERR-VAL-001", async () => {
    const stub = makeStubClient({});
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.client);
    const request = new Request("http://localhost:3000/api/v1/courses/not-a-uuid/progress");
    const response = await GET(request, { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("ข้อมูลจาก DB ผิด contract (สถานะนอก enum) → 503 ERR-SYS-002 แบบ opaque", async () => {
    const { response } = await callRoute({
      single: { enrollments: { ...ENROLLMENT, status: "paused" } },
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-SYS-002");
    expect(JSON.stringify(body)).not.toContain("paused");
  });

  it("rate limit เรียกเองด้วยคีย์ user — กลุ่มตาม resolver ของ path (§5)", async () => {
    const { response } = await callRoute({
      single: { enrollments: ENROLLMENT },
      list: { course_modules: MODULES, lessons: LESSONS, lesson_progress: PROGRESS },
    });
    expect(response.status).toBe(200);
    const call = vi.mocked(enforceRateLimit).mock.calls[0];
    const result = vi.mocked(enforceRateLimit).mock.results[0];
    expect(call?.[1]?.["secondaryKey"]).toBe(USER_ID);
    // GET /courses/* → PUBLIC_READ ตาม resolver (handler ไม่ hardcode group)
    expect(result && result.type === "return" ? result.value.group : undefined).toBe("PUBLIC_READ");
  });
});

/**
 * route.test — POST /api/v1/lessons/{id}/progress (heartbeat วิดีโอ/เอกสาร)
 *
 * mock "@/lib/supabase/ssr" ตามแบบ rbac.test.ts (D26) — client stub ตอบตามตาราง;
 * ทดสอบ O-2 (delta คำนวณฝั่ง server), XOR, error mapping จาก RPC, rate group
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { enforceRateLimit, resetRateLimitStore } from "@/lib/rate-limit";
import { POST } from "./route";

// ─── env ขั้นต่ำที่ lib/config ต้องใช้ (rate limit อ่าน config ตอน enforce) ───
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
const COURSE_ID = "c1111111-1111-4111-8111-111111111111";
const ENROLLMENT_ID = "e1111111-1111-4111-8111-111111111111";
const USER_ID = "u1111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

interface StubOptions {
  user?: { id: string } | null;
  myRoles?: readonly string[];
  /** ผล .maybeSingle() ต่อตาราง — array = ลำดับการเรียก (heartbeat อ่านแถวเดิม→เรียก RPC→อ่านซ้ำ) */
  single?: Record<string, Row | null | Array<Row | null>>;
  list?: Record<string, Row[]>;
  rpc?: Record<string, { data?: unknown; error?: { message: string } | null }>;
}

function makeStubClient(options: StubOptions = {}) {
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const readTables: string[] = [];
  const queues: Record<string, Array<Row | null>> = {};
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
      readTables.push(table);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "in", "order", "limit"] as const) {
        builder[method] = vi.fn(() => builder);
      }
      builder.maybeSingle = vi.fn(async () => {
        const spec = options.single?.[table];
        if (Array.isArray(spec)) {
          // ลำดับการอ่าน — ดึงทีละค่า (heartbeat: แถวเดิม → RPC → แถวหลัง RPC)
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
      builders[table] = builder;
      return builder;
    }),
  };
  return {
    client: client as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>>,
    rpcCalls,
    readTables,
    builders,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/lessons/" + LESSON_ID + "/progress", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-test" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: LESSON_ID }) };
}

const VIDEO_LESSON = { id: LESSON_ID, type: "video", course_modules: { course_id: COURSE_ID } };
const DOC_LESSON = { id: LESSON_ID, type: "document", course_modules: { course_id: COURSE_ID } };
const ENROLLMENT = { id: ENROLLMENT_ID };
/** แถวเดิม + แถวหลัง RPC (อ่านสองรอบ — ใช้ลำดับใน stub) */
const PROGRESS_ROWS: Array<Row | null> = [
  { video_max_position_sec: 100, updated_at: "2026-09-08T00:00:00+00:00" },
  {
    status: "in_progress",
    watch_pct: 20,
    video_max_position_sec: 130,
    dwell_sec: 30,
    quiz_score_pct: null,
    completed_at: null,
  },
];

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

describe("POST /lessons/{id}/progress — heartbeat วิดีโอ (O-2: delta คำนวณฝั่ง server)", () => {
  it("position 130 บนแถวเดิม max 100 → RPC ได้ delta 30 + position ใหม่", async () => {
    const { response, rpcCalls, readTables } = await callRoute(
      {
        single: {
          lessons: VIDEO_LESSON,
          enrollments: ENROLLMENT,
          lesson_progress: PROGRESS_ROWS,
        },
      },
      { positionSeconds: 130 },
    );
    expect(response.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("record_lesson_progress");
    expect(rpcCalls[0]?.args).toEqual({
      p_enrollment_id: ENROLLMENT_ID,
      p_lesson_id: LESSON_ID,
      p_video_max_position_sec: 130,
      p_watch_sec_delta: 30,
      p_dwell_sec_delta: 0,
    });
    // อ่านแถวเดิมก่อนเรียก RPC (O-2) — readTables มี lesson_progress ก่อน rpc ถูกเรียก
    expect(readTables).toContain("lesson_progress");
    // ขาออกตาม LessonProgressView (แถวหลัง RPC)
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      lessonId: LESSON_ID,
      status: "in_progress",
      watchPct: 20,
      videoMaxPositionSec: 130,
      dwellSec: 30,
      quizScorePct: null,
      completedAt: null,
    });
  });

  it("position ไม่เพิ่ม → delta = 0 (ห้ามติดลบ)", async () => {
    const { response, rpcCalls } = await callRoute(
      {
        single: {
          lessons: VIDEO_LESSON,
          enrollments: ENROLLMENT,
          lesson_progress: [
            { video_max_position_sec: 500, updated_at: "2026-09-08T00:00:00+00:00" },
            { status: "in_progress", watch_pct: 60, video_max_position_sec: 500, dwell_sec: 10, quiz_score_pct: null, completed_at: null },
          ],
        },
      },
      { positionSeconds: 500 },
    );
    expect(response.status).toBe(200);
    expect(rpcCalls[0]?.args["p_watch_sec_delta"]).toBe(0);
    expect(rpcCalls[0]?.args["p_video_max_position_sec"]).toBe(500);
  });

  it("heartbeat แรก (ยังไม่มีแถว) → delta เต็มจาก position + อ่านสถานะหลัง RPC ได้", async () => {
    const { response, rpcCalls } = await callRoute(
      {
        single: {
          lessons: VIDEO_LESSON,
          enrollments: ENROLLMENT,
          lesson_progress: [
            null,
            { status: "in_progress", watch_pct: 5, video_max_position_sec: 42, dwell_sec: 0, quiz_score_pct: null, completed_at: null },
          ],
        },
      },
      { positionSeconds: 42 },
    );
    expect(response.status).toBe(200);
    expect(rpcCalls[0]?.args["p_watch_sec_delta"]).toBe(42);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data["watchPct"]).toBe(5);
  });
});

describe("POST /lessons/{id}/progress — เอกสาร (documentRead = attestation D12-12)", () => {
  it("documentRead: true → position null + dwell เท่านั้น (จากเวลาจริงนับแต่ heartbeat ก่อน)", async () => {
    const { response, rpcCalls } = await callRoute(
      {
        single: {
          lessons: DOC_LESSON,
          enrollments: ENROLLMENT,
          lesson_progress: [
            { video_max_position_sec: null, updated_at: "2020-01-01T00:00:00+00:00" },
            { status: "completed", watch_pct: 0, video_max_position_sec: null, dwell_sec: 900, quiz_score_pct: null, completed_at: "2026-09-08T00:00:01+00:00" },
          ],
        },
      },
      { documentRead: true },
    );
    expect(response.status).toBe(200);
    expect(rpcCalls[0]?.args).toEqual({
      p_enrollment_id: ENROLLMENT_ID,
      p_lesson_id: LESSON_ID,
      p_video_max_position_sec: null,
      p_watch_sec_delta: 0,
      p_dwell_sec_delta: 900, // เวลาจริงยาวมาก → ตัดที่เพดาน 900 วิ/ครั้ง ของ RPC
    });
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data["status"]).toBe("completed");
  });

  it("heartbeat แรกของเอกสาร (ไม่มีแถวเดิม) → dwell = 0 (ไม่มีตัวตั้งเวลาจริง)", async () => {
    const { rpcCalls } = await callRoute(
      {
        single: {
          lessons: DOC_LESSON,
          enrollments: ENROLLMENT,
          lesson_progress: [
            null,
            { status: "in_progress", watch_pct: 0, video_max_position_sec: null, dwell_sec: 0, quiz_score_pct: null, completed_at: null },
          ],
        },
      },
      { documentRead: true },
    );
    expect(rpcCalls[0]?.args["p_dwell_sec_delta"]).toBe(0);
    expect(rpcCalls[0]?.args["p_video_max_position_sec"]).toBeNull();
  });
});

describe("POST /lessons/{id}/progress — validation + auth", () => {
  it("XOR ทั้งคู่ → 400 ERR-VAL-001 พร้อม fields", async () => {
    const { response } = await callRoute({}, { positionSeconds: 10, documentRead: true });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
    expect((body.error["details"] as Record<string, unknown>)["fields"]).toEqual(["body"]);
  });


  it("ไม่ส่งอะไรเลย → 400 ERR-VAL-001", async () => {
    const { response } = await callRoute({}, {});
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("body ไม่ใช่ JSON → 400 ERR-VAL-001", async () => {
    const stub = makeStubClient({});
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.client);
    const request = new Request("http://localhost:3000/api/v1/lessons/" + LESSON_ID + "/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const response = await POST(request, context());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("path param ไม่ใช่ UUID → 400 ERR-VAL-001", async () => {
    const stub = makeStubClient({});
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.client);
    const request = new Request("http://localhost:3000/api/v1/lessons/not-a-uuid/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds: 10 }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });

  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    const { response } = await callRoute({ user: null }, { positionSeconds: 10 });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-AUTH-001");
  });

  it("ไม่มี enrollment ที่ active (ไม่ลงทะเบียน/หมดอายุ/ยกเลิก) → 403 ERR-LRN-001", async () => {
    const { response, rpcCalls } = await callRoute(
      { single: { lessons: VIDEO_LESSON, enrollments: null } },
      { positionSeconds: 10 },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
    expect(rpcCalls.filter((c) => c.fn !== "my_roles")).toHaveLength(0); // ไม่ถึงมือ RPC ของ lane นี้
  });

  it("บทเรียนมองไม่เห็น (RLS) → 403 ERR-LRN-001 (ตอบเหมือนไม่มีจริง)", async () => {
    const { response } = await callRoute(
      { single: { lessons: null } },
      { positionSeconds: 10 },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
  });

  it("soft-delete filter (gate r2): อ่าน lessons ต้องส่ง .is(deleted_at, null) เสมอ", async () => {
    const { builders } = await callRoute({ single: { lessons: VIDEO_LESSON } }, { positionSeconds: 10 });
    const isCalls = (builders["lessons"]?.is as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(isCalls).toContainEqual(["deleted_at", null]);
  });

  it("บทเรียนชนิดไม่ตรง (video แต่ส่ง documentRead) → 400 ERR-VAL-001", async () => {
    const { response, rpcCalls } = await callRoute(
      { single: { lessons: VIDEO_LESSON, enrollments: ENROLLMENT } },
      { documentRead: true },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
    expect((body.error["details"] as Record<string, unknown>)["rule"]).toBe("lesson_type_mismatch");
    expect(rpcCalls.filter((c) => c.fn !== "my_roles")).toHaveLength(0);
  });

  it("บทเรียนชนิด quiz → 400 ERR-VAL-001 (จบด้วย record_quiz_attempt เท่านั้น)", async () => {
    const { response } = await callRoute(
      { single: { lessons: { id: LESSON_ID, type: "quiz", course_modules: { course_id: COURSE_ID } }, enrollments: ENROLLMENT } },
      { positionSeconds: 10 },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-VAL-001");
  });
});

describe("POST /lessons/{id}/progress — error mapping จาก RPC (0011_functions.sql)", () => {
  it("RPC: enrollment ไม่ active (เช่น หมดอายุระหว่าง call) → 403 ERR-LRN-001 + ข้อความไทยจากทะเบียน", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: VIDEO_LESSON, enrollments: ENROLLMENT, lesson_progress: [null, null] },
        rpc: { record_lesson_progress: { error: { message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)" } } },
      },
      { positionSeconds: 10 },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-LRN-001");
    expect(body.error["message"]).toBe("ต้องลงทะเบียนหลักสูตรก่อนเรียน");
  });

  it("RPC: lesson ไม่อยู่ในหลักสูตรของ enrollment → 404 ERR-NF-001", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: VIDEO_LESSON, enrollments: ENROLLMENT, lesson_progress: [null, null] },
        rpc: { record_lesson_progress: { error: { message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)" } } },
      },
      { positionSeconds: 10 },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-NF-001");
  });

  it("RPC error ไม่มี code ทะเบียน → 500 ERR-SYS-001 แบบ opaque (ไม่ leak SQL)", async () => {
    const { response } = await callRoute(
      {
        single: { lessons: VIDEO_LESSON, enrollments: ENROLLMENT, lesson_progress: [null, null] },
        rpc: { record_lesson_progress: { error: { message: 'SQLSTATE 23514: new row violates check constraint "lp_check"' } } },
      },
      { positionSeconds: 10 },
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-SYS-001");
    expect(body.error["message"]).not.toContain("SQLSTATE");
    expect(JSON.stringify(body)).not.toContain("lp_check");
  });
});

describe("POST /lessons/{id}/progress — rate limit (§5)", () => {
  it("enforceRateLimit ถูกเรียกกลุ่ม LEARN_WRITE ด้วยคีย์ user_id (D12-11)", async () => {
    await callRoute(
      { single: { lessons: VIDEO_LESSON, enrollments: ENROLLMENT, lesson_progress: PROGRESS_ROWS } },
      { positionSeconds: 130 },
    );
    const call = vi.mocked(enforceRateLimit).mock.calls[0];
    const result = vi.mocked(enforceRateLimit).mock.results[0];
    expect(call?.[1]?.["group"]).toBe("LEARN_WRITE");
    expect(call?.[1]?.["secondaryKey"]).toBe(USER_ID);
    expect(result && result.type === "return" ? result.value.group : undefined).toBe("LEARN_WRITE");
  });

  it("เกินขีด LEARN_WRITE (120/min) → 429 ERR-RATE-001 + Retry-After", async () => {
    const stub = makeStubClient({
      single: { lessons: VIDEO_LESSON, enrollments: ENROLLMENT, lesson_progress: PROGRESS_ROWS },
    });
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stub.client);
    let response: Response = null as unknown as Response;
    for (let i = 0; i < 121; i++) {
      response = await POST(makeRequest({ positionSeconds: 130 }), context());
    }
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["code"]).toBe("ERR-RATE-001");
    expect(response.headers.get("retry-after")).not.toBeNull();
  });

});

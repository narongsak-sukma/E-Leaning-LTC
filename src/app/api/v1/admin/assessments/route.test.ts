/**
 * route.test — unit test ของ GET/POST /api/v1/admin/assessments (Wave D · D-3 · contract-first)
 *
 * mock client ตามแบบ src/app/api/v1/admin/courses/route.test.ts (vi.mock supabase/ssr;
 * auth.getUser + mfa aal2 + profiles.is_active + rpc my_roles) — result ต่อตารางผ่านคิว
 * (ทุก from(table) ใหม่ดึง result ถัดไปของตารางนั้น — จำลอง insert → insert rules → reload)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { errorDefinition } from "@/lib/errors";
import { AdminAssessmentResource } from "@/lib/schemas/v1/admin-exam";
import { GET, POST } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const COURSE_ID = "c0000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-01T00:00:00+00:00";

/** result ต่อการ await builder 1 ครั้ง (data/error ตามรูป PostgrestError) */
interface StubResult {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

interface RecordedCall {
  table: string;
  select?: string;
  method: string;
  payload?: unknown;
  filters: Array<{ column: string; value: unknown }>;
  orders: Array<{ column: string; options: Record<string, unknown> }>;
  limits: unknown[];
}

/** client stub — from(table) คืน builder ใหม่ที่ดึง result ถัดไปของคิวตารางนั้น + จดทุก call */
function mockClient(
  queues: Record<string, StubResult[]>,
  roles: readonly string[] = ["staff:exam"],
): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const profilesBuilder = {
    select: () => profilesBuilder,
    eq: () => profilesBuilder,
    maybeSingle: async () => ({ data: { is_active: true, deleted_at: null }, error: null }),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal2" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles" ? { data: [...roles], error: null } : { data: null, error: null }),
    from: (table: string) => {
      if (table === "profiles") {
        return profilesBuilder;
      }
      const entry: RecordedCall = {
        table,
        method: "select",
        filters: [],
        orders: [],
        limits: [],
      };
      const builder = {
        select: (s: string) => {
          entry.select = s;
          return builder;
        },
        insert: (payload: unknown) => {
          entry.method = "insert";
          entry.payload = payload;
          return builder;
        },
        update: (payload: unknown) => {
          entry.method = "update";
          entry.payload = payload;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          entry.filters.push({ column, value });
          return builder;
        },
        or: () => builder,
        order: (column: string, opts: Record<string, unknown> = {}) => {
          entry.orders.push({ column, options: opts });
          return builder;
        },
        limit: (n: unknown) => {
          entry.limits.push(n);
          return builder;
        },
        maybeSingle: () => builder,
        single: () => builder,
        then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
          const queue = queues[table] ?? [];
          const next = queue.length > 0 ? (queue.shift() as StubResult) : { data: null, error: null };
          return Promise.resolve(resolve({ data: next.data ?? null, error: next.error ?? null }));
        },
      };
      calls.push(entry);
      return builder;
    },
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { calls };
}

/** แถว assessments + embed (course owner + กติกาล่าสุด) ตาม select ของ route */
function assessmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    code: "FIN-01",
    title: "สอบจบหลักสูตร",
    description: null,
    is_final: true,
    status: "draft",
    course_id: COURSE_ID,
    created_at: CREATED_AT,
    course: { id: COURSE_ID, created_by: USER_ID },
    assessment_rules: [
      {
        version: 1,
        pass_pct: 70,
        time_limit_minutes: 90,
        question_count: 30,
        max_attempts: 3,
        attempt_cooldown_minutes: 1440,
        shuffle_questions: true,
        shuffle_options: true,
        proctoring_mode: "basic",
        exam_review_mode: "after_final_attempt",
        effective_from: CREATED_AT,
      },
    ],
    ...overrides,
  };
}

function adminUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/assessments" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d3-1" },
  });
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/admin/assessments", {
    method: "POST",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d3-1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_RULES = { passPct: 70, timeLimitMinutes: 90, maxAttempts: 2 };

/** กติกา embed ที่ drift (pass_pct null) — จำลองคอลัมน์เพี้ยนจาก DB สำหรับ B4 */
function driftedRules(): Array<Record<string, unknown>> {
  const base = assessmentRow()["assessment_rules"] as Array<Record<string, unknown>>;
  return [{ ...base[0]!, pass_pct: null }];
}

const VALID_BODY = {
  courseId: COURSE_ID,
  code: "FIN-01",
  title: "สอบจบหลักสูตร",
  rules: VALID_RULES,
};

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/assessments — สิทธิ์ + envelope §1.2", () => {
  it("staff:exam → 200 { data, page } · createdBy จาก course owner + สรุปกติกาล่าสุด", async () => {
    mockClient({ assessments: [{ data: [assessmentRow()] }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-d3-1");
    const body = (await res.json()) as { data: unknown[]; page: { nextCursor: string | null; hasMore: boolean } };
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(body.data).toHaveLength(1);
    expect(() => AdminAssessmentResource.parse(body.data[0])).not.toThrow();
    const row = body.data[0] as { createdBy: string | null; rules: { timeLimitMinutes: number } | null };
    expect(row.createdBy).toBe(USER_ID);
    expect(row.rules?.timeLimitMinutes).toBe(90);
  });

  it("embed กติกาเรียง effective_from desc + limit 1 ที่ embed (ไม่กระทบ limit หน้าหลัก)", async () => {
    const { calls } = mockClient({ assessments: [{ data: [assessmentRow()] }] });
    await GET(adminUrl());
    const call = calls.find((item) => item.table === "assessments");
    expect(call?.select).toContain("assessment_rules");
    // pass_pct เปิดตั้งแต่ 0019 (column grant สะสม) — ต้องอยู่ใน embed · is_correct ยังห้าม
    expect(call?.select?.includes("pass_pct")).toBe(true);
    // exam_review_mode เปิดตั้งแต่ 0049 (Wave G P3) — ต้องอยู่ใน embed ให้ mapper เดียวใช้สองทาง
    expect(call?.select?.includes("exam_review_mode")).toBe(true);
    expect(call?.select?.includes("is_correct")).toBe(false);
    expect(call?.orders).toContainEqual({
      column: "effective_from",
      options: { referencedTable: "assessment_rules", ascending: false },
    });
    expect(call?.limits).toContain(1);
    expect(call?.limits).toContain(21); // limit default 20 + 1 เพื่อคำนวณ hasMore
  });

  it("staff:content ไม่มี assessment:view → 403 ERR-RBAC-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({ assessments: [{ data: [] }] }, ["staff:content"]);
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(errorDefinition("ERR-RBAC-001").httpStatus).toBe(403);
    expect(calls.some((call) => call.table === "assessments")).toBe(false);
  });

  it("staff:viewer มี assessment:view → 200 (ขอบเขตให้ RLS กรอง)", async () => {
    mockClient({ assessments: [{ data: [] }] }, ["staff:viewer"]);
    const res = await GET(adminUrl("?status=draft"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("B4: แถว drift (กติกา embed pass_pct null) → 503 ERR-SYS-002 fail-closed ไม่รั่ง 200 เพี้ยน", async () => {
    const drifted = assessmentRow({ assessment_rules: driftedRules() });
    mockClient({ assessments: [{ data: [drifted] }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessment_row_drift"); // F5: ตายที่ขาเข้าก่อน map
  });

  it("r8-N1: สำเร็จแต่ data null → 503 admin_assessments_rows_not_array ไม่ใช่ 200 หน้าว่าง", async () => {
    mockClient({ assessments: [{ data: null }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessments_rows_not_array");
  });
});

describe("POST /admin/assessments — สร้าง draft + กติกา", () => {
  it("staff:exam สร้างพร้อมกติกา → 201 · insert status='draft' เสมอ + pass_pct ลง rules", async () => {
    const { calls } = mockClient({
      assessments: [{ data: assessmentRow() }, { data: assessmentRow() }],
      assessment_rules: [{ data: null }],
    });
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { status: string; createdBy: string | null } };
    expect(body.data.status).toBe("draft");
    expect(body.data.createdBy).toBe(USER_ID);
    const insert = calls.find((call) => call.table === "assessments" && call.method === "insert");
    expect((insert?.payload as Record<string, unknown>)?.["status"]).toBe("draft");
    const ruleInsert = calls.find((call) => call.table === "assessment_rules");
    expect((ruleInsert?.payload as Record<string, unknown>)?.["pass_pct"]).toBe(70);
    expect((ruleInsert?.payload as Record<string, unknown>)?.["time_limit_minutes"]).toBe(90);
    // exam_review_mode ลงทุกแถว rules ที่แทรก (0049 — default จาก schema เมื่อ body ไม่ส่ง)
    expect((ruleInsert?.payload as Record<string, unknown>)?.["exam_review_mode"]).toBe(
      "after_final_attempt",
    );
  });

  it("instructor สร้าง draft ของหลักสูตรตัวเอง (ไม่แนบ rules) → 201 และไม่แตะ assessment_rules", async () => {
    const { calls } = mockClient(
      { assessments: [{ data: assessmentRow() }, { data: assessmentRow() }] },
      ["instructor"],
    );
    const res = await POST(postRequest({ courseId: COURSE_ID, code: "QUIZ-01", title: "แบบทดสอบ" }));
    expect(res.status).toBe(201);
    expect(calls.some((call) => call.table === "assessment_rules")).toBe(false);
  });

  it("instructor แนบ rules → 403 ERR-RBAC-001 ก่อนเขียน DB (ar_write เฉพาะ staff:exam/sa)", async () => {
    const { calls } = mockClient({ assessments: [], assessment_rules: [] }, ["instructor"]);
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "assessments")).toBe(false);
  });

  it("instructor สร้างบนหลักสูตรคนอื่น → RLS 42501 → 403 ERR-RBAC-001", async () => {
    const { calls } = mockClient(
      { assessments: [{ error: { code: "42501", message: "new row violates row-level security policy" } }] },
      ["instructor"],
    );
    const res = await POST(postRequest({ courseId: COURSE_ID, code: "QUIZ-02", title: "แบบทดสอบ" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "assessment_rules")).toBe(false);
  });

  it("body ส่ง status มา → 400 ERR-VAL-001 (schema strict — ไม่รับ status จาก body)", async () => {
    const { calls } = mockClient({ assessments: [], assessment_rules: [] });
    const res = await POST(
      postRequest({ ...VALID_BODY, status: "published" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.table === "assessments")).toBe(false);
  });

  it("timeLimitMinutes 4 (นอก 5-480) → 400 ERR-VAL-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({ assessments: [], assessment_rules: [] });
    const res = await POST(
      postRequest({ courseId: COURSE_ID, code: "FIN-02", title: "สอบ", rules: { passPct: 70, timeLimitMinutes: 4 } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.table === "assessments")).toBe(false);
  });

  it("B4: สร้างสำเร็จแต่ reload drift (กติกาเพี้ยน) → 503 ERR-SYS-002 ไม่ตอบ 201 ที่ payload เพี้ยน", async () => {
    const drifted = assessmentRow({ assessment_rules: driftedRules() });
    mockClient({
      assessments: [{ data: assessmentRow() }, { data: drifted }],
      assessment_rules: [{ data: null }],
    });
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessment_row_drift"); // F5: ตายที่ขาเข้าก่อน map
  });

  it("r3-G3: INSERT คืนแถวที่ id หาย (created drift) → 503 ERR-SYS-002 ก่อนแตะ rules/reload ด้วย id ที่ไม่ผ่าน validation", async () => {
    const { calls } = mockClient({
      assessments: [{ data: assessmentRow({ id: null }) }],
      assessment_rules: [{ data: null }],
    });
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessment_row_drift");
    // ห้ามนำ id ที่ไม่ผ่าน validation ไปใช้ต่อ: ไม่มี rules insert · ไม่มี reload (select ครั้งที่สอง)
    expect(calls.some((call) => call.table === "assessment_rules")).toBe(false);
    expect(calls.filter((call) => call.table === "assessments")).toHaveLength(1);
  });

  it("r3-G4: INSERT คืน course ที่มีคีย์เกิน (nested strict) → 503 ERR-SYS-002 ไม่ strip เงียบแล้วตอบ 201", async () => {
    mockClient({
      assessments: [{ data: assessmentRow({ course: { id: COURSE_ID, created_by: USER_ID, email: "person@example.com" } }) }],
      assessment_rules: [{ data: null }],
    });
    const res = await POST(postRequest({ courseId: COURSE_ID, code: "QUIZ-03", title: "แบบทดสอบ" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessment_row_drift");
  });

  it("r3-G3: reload พัง (DB error) → 503 ERR-SYS-002 assessment_reload_failed ตาม invariant 5 (ไม่ใช่ 500)", async () => {
    mockClient({
      assessments: [{ data: assessmentRow() }, { error: { code: "PGRST116", message: "JSON object requested" } }],
      assessment_rules: [{ data: null }],
    });
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("assessment_reload_failed");
  });
});

/**
 * route.test — unit test ของ GET/POST /api/v1/admin/assessments (Wave D · D-3 · contract-first)
 *
 * mock client ตามแบบ src/app/api/v1/admin/courses/route.test.ts (vi.mock supabase/ssr;
 * auth.getUser + mfa aal2 + profiles.is_active + rpc my_roles) — result ต่อตารางผ่านคิว
 * (ทุก from(table) ใหม่ดึง result ถัดไปของตารางนั้น — จำลอง insert → insert rules → reload)
 * · rpc ที่ไม่ใช่ my_roles ดึงจากคิวต่อชื่อฟังก์ชัน (default = แถวว่าง) — กติกาล่าสุด
 * ของ GET/POST มาจาก **RPC admin_latest_assessment_rules (0051)** แล้ว merge ที่ BFF
 * ไม่ใช่ embed ตารางอีกต่อไป (gate GP3 r2 R2-M3)
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
const ASSESSMENT_ID = "d0000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-01T00:00:00+00:00";

/** result ต่อการ await builder 1 ครั้ง (data/error ตามรูป PostgrestError) */
interface StubResult {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

/** rpc call ที่ถูกจด — payload = พารามิเตอร์ที่ route ส่งเข้า RPC */
interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
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

/**
 * client stub — from(table) คืน builder ใหม่ที่ดึง result ถัดไปของคิวตารางนั้น + จดทุก call ·
 * rpc(my_roles) ตอบ roles · rpc อื่น (เช่น admin_latest_assessment_rules) ดึงจากคิวต่อ
 * ชื่อฟังก์ชัน — คิวไม่ระบุ = ตอบแถวว่าง (ไม่มีกติกา) ไม่ใช่ null (null = drift ตาม route)
 */
function mockClient(
  queues: Record<string, StubResult[]>,
  roles: readonly string[] = ["staff:exam"],
  rpcQueues: Record<string, StubResult[]> = {},
): { calls: RecordedCall[]; rpcCalls: RecordedRpc[] } {
  const calls: RecordedCall[] = [];
  const rpcCalls: RecordedRpc[] = [];
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
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      if (fn === "my_roles") {
        return { data: [...roles], error: null };
      }
      rpcCalls.push({ fn, args });
      const queue = rpcQueues[fn] ?? [];
      const next = queue.length > 0 ? (queue.shift() as StubResult) : { data: [], error: null };
      return { data: next.data ?? null, error: next.error ?? null };
    }),
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
  return { calls, rpcCalls };
}

/** แถว assessments + embed course ตาม select ของ route (0051 — ไม่มี assessment_rules embed) */
function assessmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ASSESSMENT_ID,
    code: "FIN-01",
    title: "สอบจบหลักสูตร",
    description: null,
    is_final: true,
    status: "draft",
    course_id: COURSE_ID,
    created_at: CREATED_AT,
    course: { id: COURSE_ID, created_by: USER_ID },
    ...overrides,
  };
}

/** แถว RPC admin_latest_assessment_rules (0051) — 14 คอลัมน์ + assessment_id นำหน้า */
function rulesRpcRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assessment_id: ASSESSMENT_ID,
    version: 1,
    pass_pct: 70,
    time_limit_minutes: 90,
    question_count: 30,
    max_attempts: 3,
    attempt_cooldown_minutes: 1440,
    shuffle_questions: true,
    shuffle_options: true,
    require_course_complete: true,
    selection: { bank_ids: ["b00000000-0000-4000-8000-000000000001"] },
    proctoring_mode: "basic",
    exam_review_mode: "after_final_attempt",
    effective_from: CREATED_AT,
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
  it("staff:exam → 200 { data, page } · createdBy จาก course owner + สรุปกติกาล่าสุดจาก RPC 0051", async () => {
    const { rpcCalls } = mockClient(
      { assessments: [{ data: [assessmentRow()] }] },
      ["staff:exam"],
      { admin_latest_assessment_rules: [{ data: [rulesRpcRow()] }] },
    );
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
    // RPC ถูกเรียกครั้งเดียวพร้อม id ทั้งหน้า (ไม่ใช่ per-row N+1)
    const rpc = rpcCalls.find((item) => item.fn === "admin_latest_assessment_rules");
    expect(rpc?.args["p_assessment_ids"]).toEqual([ASSESSMENT_ID]);
  });

  it("R2-M3: select ไร้ assessment_rules embed · กติการวม selection มาทาง RPC ที่คุมบทบาท (ไม่ใช่ column grant)", async () => {
    const other = "d0000000-0000-4000-8000-000000000002";
    const { calls, rpcCalls } = mockClient(
      { assessments: [{ data: [assessmentRow(), assessmentRow({ id: other })] }] },
      ["staff:exam"],
      {
        admin_latest_assessment_rules: [
          { data: [rulesRpcRow(), rulesRpcRow({ assessment_id: other })] },
        ],
      },
    );
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const call = calls.find((item) => item.table === "assessments");
    // embed ที่เหลือ = course owner เท่านั้น — ต้องไม่มี assessment_rules ใน select อีก
    expect(call?.select).toContain("course:courses!left");
    expect(call?.select?.includes("assessment_rules")).toBe(false);
    // เกณฑ์ "ล่าสุด" ย้ายเข้า RPC (distinct on version desc) — ไม่มี order/limit ของ embed อีก
    expect(call?.orders).not.toContainEqual({
      column: "version",
      options: { referencedTable: "assessment_rules", ascending: false },
    });
    expect(call?.limits).not.toContain(1);
    expect(call?.limits).toContain(21); // limit default 20 + 1 เพื่อคำนวณ hasMore
    const rpc = rpcCalls.find((item) => item.fn === "admin_latest_assessment_rules");
    expect(rpc?.args["p_assessment_ids"]).toEqual([ASSESSMENT_ID, other]);
    // คอลัมน์ RPC ถูก project เป็นรูป embed เดิม — selection (ขอบเขตคลัง) ตกถึง payload ขาออก
    const body = (await res.json()) as { data: Array<{ rules: { selection: Record<string, unknown> } | null }> };
    expect(body.data[0]?.rules?.selection).toEqual({ bank_ids: ["b00000000-0000-4000-8000-000000000001"] });
    expect(body.data[1]?.rules?.selection).toEqual({ bank_ids: ["b00000000-0000-4000-8000-000000000001"] });
  });

  it("staff:content ไม่มี assessment:view → 403 ERR-RBAC-001 ก่อนถึง DB", async () => {
    const { calls, rpcCalls } = mockClient({ assessments: [{ data: [] }] }, ["staff:content"]);
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(errorDefinition("ERR-RBAC-001").httpStatus).toBe(403);
    expect(calls.some((call) => call.table === "assessments")).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("staff:viewer มี assessment:view → 200 (ขอบเขตให้ RLS กรอง) · หน้าว่างไม่ยิง RPC เลย", async () => {
    const { rpcCalls } = mockClient({ assessments: [{ data: [] }] }, ["staff:viewer"]);
    const res = await GET(adminUrl("?status=draft"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
    expect(rpcCalls).toHaveLength(0); // ids เปล่า = skip RPC ตาม helper
  });

  it("B4: แถว RPC กติกา drift (pass_pct null) → 503 ERR-SYS-002 fail-closed ไม่รั่ง 200 เพี้ยน", async () => {
    mockClient(
      { assessments: [{ data: [assessmentRow()] }] },
      ["staff:exam"],
      { admin_latest_assessment_rules: [{ data: [rulesRpcRow({ pass_pct: null })] }] },
    );
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessment_row_drift"); // F5: ตายที่ขาเข้าก่อน map
  });

  it("R2-M3: RPC 0051 ล้ม → 503 admin_assessments_rules_rpc_failed (ไม่กลืนเป็น 'ไม่มีกติกา')", async () => {
    mockClient(
      { assessments: [{ data: [assessmentRow()] }] },
      ["staff:exam"],
      {
        admin_latest_assessment_rules: [
          { error: { code: "42501", message: "x (ERR-RBAC-001|rules_read_forbidden)" } },
        ],
      },
    );
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessments_rules_rpc_failed");
  });

  it("R2-M3: RPC คืนค่าไม่ใช่ array → 503 admin_assessments_rules_rpc_drift fail-closed", async () => {
    mockClient(
      { assessments: [{ data: [assessmentRow()] }] },
      ["staff:exam"],
      { admin_latest_assessment_rules: [{ data: null }] },
    );
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessments_rules_rpc_drift");
  });

  it("R2-M3: แถว RPC ไม่มี assessment_id → 503 admin_assessments_rules_rpc_drift (merge ไม่ได้ = ตาย)", async () => {
    const row = rulesRpcRow();
    delete row["assessment_id"];
    mockClient(
      { assessments: [{ data: [assessmentRow()] }] },
      ["staff:exam"],
      { admin_latest_assessment_rules: [{ data: [row] }] },
    );
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessments_rules_rpc_drift");
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
  it("staff:exam สร้างพร้อมกติกา → 201 · insert status='draft' เสมอ + pass_pct ลง rules + สรุปจาก RPC 0051", async () => {
    const { calls, rpcCalls } = mockClient(
      {
        assessments: [{ data: assessmentRow() }, { data: assessmentRow() }],
        assessment_rules: [{ data: null }],
      },
      ["staff:exam"],
      { admin_latest_assessment_rules: [{ data: [rulesRpcRow({ version: 1 })] }] },
    );
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { status: string; createdBy: string | null; rules: { version: number; passPct: number } | null };
    };
    expect(body.data.status).toBe("draft");
    expect(body.data.createdBy).toBe(USER_ID);
    // สรุปกติกาของ response มาจาก RPC merge หลัง reload — ไม่ใช่แถวที่ insert คืน
    expect(body.data.rules?.version).toBe(1);
    expect(body.data.rules?.passPct).toBe(70);
    const insert = calls.find((call) => call.table === "assessments" && call.method === "insert");
    expect((insert?.payload as Record<string, unknown>)?.["status"]).toBe("draft");
    const ruleInsert = calls.find((call) => call.table === "assessment_rules");
    expect((ruleInsert?.payload as Record<string, unknown>)?.["pass_pct"]).toBe(70);
    expect((ruleInsert?.payload as Record<string, unknown>)?.["time_limit_minutes"]).toBe(90);
    // exam_review_mode ลงทุกแถว rules ที่แทรก (0049 — default จาก schema เมื่อ body ไม่ส่ง)
    expect((ruleInsert?.payload as Record<string, unknown>)?.["exam_review_mode"]).toBe(
      "after_final_attempt",
    );
    // RPC ถูกเรียกครั้งเดียว (merge หลัง reload) ด้วย id ของแถวใหม่
    const rpc = rpcCalls.find((item) => item.fn === "admin_latest_assessment_rules");
    expect(rpc?.args["p_assessment_ids"]).toEqual([ASSESSMENT_ID]);
  });

  it("instructor สร้าง draft ของหลักสูตรตัวเอง (ไม่แนบ rules) → 201 rules=null และไม่แตะ assessment_rules", async () => {
    const { calls, rpcCalls } = mockClient(
      { assessments: [{ data: assessmentRow() }, { data: assessmentRow() }] },
      ["instructor"],
    );
    const res = await POST(postRequest({ courseId: COURSE_ID, code: "QUIZ-01", title: "แบบทดสอบ" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { rules: unknown } };
    expect(body.data.rules).toBeNull(); // ยังไม่มีกติกา — RPC ตอบแถวว่าง
    expect(calls.some((call) => call.table === "assessment_rules")).toBe(false);
    expect(rpcCalls).toHaveLength(1); // reload merge ยังเรียก RPC หนึ่งครั้ง
  });

  it("instructor แนบ rules → 403 ERR-RBAC-001 ก่อนเขียน DB (ar_write เฉพาะ staff:exam/sa)", async () => {
    const { calls, rpcCalls } = mockClient({ assessments: [], assessment_rules: [] }, ["instructor"]);
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "assessments")).toBe(false);
    expect(rpcCalls).toHaveLength(0);
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

  it("B4: reload ผ่านแต่กติกา RPC drift (pass_pct null) → 503 ERR-SYS-002 ไม่ตอบ 201 ที่ payload เพี้ยน", async () => {
    mockClient(
      {
        assessments: [{ data: assessmentRow() }, { data: assessmentRow() }],
        assessment_rules: [{ data: null }],
      },
      ["staff:exam"],
      { admin_latest_assessment_rules: [{ data: [rulesRpcRow({ pass_pct: null })] }] },
    );
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_assessment_row_drift"); // F5: ตายที่ขาเข้าก่อน map
  });

  it("r3-G3: INSERT คืนแถวที่ id หาย (created drift) → 503 ERR-SYS-002 ก่อนแตะ rules/reload ด้วย id ที่ไม่ผ่าน validation", async () => {
    const { calls, rpcCalls } = mockClient({
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
    expect(rpcCalls).toHaveLength(0);
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

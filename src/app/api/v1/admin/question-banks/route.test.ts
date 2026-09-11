/**
 * route.test — unit test ของ GET/POST /api/v1/admin/question-banks (Wave D · D-3)
 *
 * mock ตามแบบ admin/assessments/route.test.ts — result ต่อตารางผ่านคิว
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
import { QuestionBankCreateResult } from "@/lib/schemas/v1/admin-exam";
import { GET, POST } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const COURSE_ID = "c0000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-01T00:00:00+00:00";

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
}

function bankRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "b0000000-0000-4000-8000-000000000001",
    code: "BANK-01",
    name: "ธนาคารข้อสอบกฎหมายทั่วไป",
    description: null,
    course_id: null,
    category_id: null,
    is_active: true,
    created_at: CREATED_AT,
    questions: [{ count: 5 }],
    ...overrides,
  };
}

/** client stub — โครงเดียวกับ admin/assessments/route.test.ts (คิวต่อตาราง + จด call) */
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
      const entry: RecordedCall = { table, method: "select", filters: [] };
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
        order: () => builder,
        limit: () => builder,
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

function adminUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/question-banks" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d3-2" },
  });
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/admin/question-banks", {
    method: "POST",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d3-2", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BANK = {
  code: "BANK-01",
  name: "ธนาคารข้อสอบกฎหมายทั่วไป",
  courseId: COURSE_ID,
  questions: [
    {
      type: "single_choice",
      questionText: "กฎหมายใดครอบคลุมสัญญา?",
      options: [
        { optionText: "แพ่งและพาณิชย์", isCorrect: true, sortOrder: 0 },
        { optionText: "อาญา", isCorrect: false, sortOrder: 1 },
      ],
    },
  ],
};

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/question-banks — สิทธิ์ + จำนวนข้อต่อ bank", () => {
  it("staff:exam → 200 { data, page } + questionCount จาก embed count", async () => {
    mockClient({ question_banks: [{ data: [bankRow()] }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-d3-2");
    const body = (await res.json()) as { data: Array<{ questionCount: number }>; page: { hasMore: boolean } };
    expect(body.page.hasMore).toBe(false);
    expect(body.data[0]?.questionCount).toBe(5);
  });

  it("select รวม questions(count) แต่ไม่มี is_correct/options · resource ไม่มี is_correct", async () => {
    // r8-N1: คิว 2 รายการ — เดิมเรียก GET สองครั้งกับคิวเดียว ครั้งที่สองได้ data:null
    // ที่ `?? []` กลืนเป็น 200 หน้าว่าง (assert is_correct เป็นจริงเปล่า) — ตอนนี้ null = 503
    const { calls } = mockClient({ question_banks: [{ data: [bankRow()] }, { data: [bankRow()] }] });
    await GET(adminUrl());
    const call = calls.find((item) => item.table === "question_banks");
    expect(call?.select).toContain("questions(count)");
    expect(call?.select?.includes("is_correct")).toBe(false);
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(JSON.stringify(body.data).includes("is_correct")).toBe(false);
  });

  it("staff:content ไม่มี question_bank:view → 403 ERR-RBAC-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({ question_banks: [{ data: [] }] }, ["staff:content"]);
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "question_banks")).toBe(false);
  });

  it("instructor เห็นเฉพาะของตัวเอง (RLS จำลองที่ mock — รายการที่ DB ให้กลับมา)", async () => {
    mockClient({ question_banks: [{ data: [bankRow()] }] }, ["instructor"]);
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ code: string }> };
    expect(body.data[0]?.code).toBe("BANK-01");
  });
});

describe("POST /admin/question-banks — สร้าง bank + ข้อสอบเริ่มต้น", () => {
  it("instructor สร้าง bank + ข้อ (options พร้อม is_correct) → 201 · status='draft' + created_by ถูกต้อง", async () => {
    const { calls } = mockClient(
      {
        question_banks: [{ data: bankRow() }],
        questions: [{ data: { id: "d0000000-0000-4000-8000-000000000001", type: "single_choice", question_text: "โจทย์", points: 1 } }],
        question_options: [{ data: null }],
      },
      ["instructor"],
    );
    const res = await POST(postRequest(VALID_BANK));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { questionCount: number; questions: Array<{ id: string }> } };
    expect(body.data.questions).toHaveLength(1);
    // r11-Q1: นับจากข้อที่สร้างจริงรอบนี้ — mock embed ของ bankRow บอก 5 ต้องถูก override เป็น 1 (ไม่ใช่ค่า stale)
    expect(body.data.questionCount).toBe(1);
    expect(() => QuestionBankCreateResult.parse(body.data)).not.toThrow();
    const bankInsert = calls.find((call) => call.table === "question_banks" && call.method === "insert");
    expect((bankInsert?.payload as Record<string, unknown>)?.["created_by"]).toBe(USER_ID);
    const questionInsert = calls.find((call) => call.table === "questions" && call.method === "insert");
    expect((questionInsert?.payload as Record<string, unknown>)?.["status"]).toBe("draft");
    expect((questionInsert?.payload as Record<string, unknown>)?.["created_by"]).toBe(USER_ID);
    const optionInsert = calls.find((call) => call.table === "question_options" && call.method === "insert");
    const optionRows = optionInsert?.payload as Array<{ is_correct: boolean }>;
    expect(optionRows?.[0]?.is_correct).toBe(true);
  });

  it("staff:exam สร้าง bank ได้เช่นกัน (ไม่มีข้อเริ่มต้น) → 201 · questionCount 0 ตามจริง", async () => {
    mockClient({ question_banks: [{ data: bankRow() }] });
    const res = await POST(postRequest({ code: "BANK-02", name: "ธนาคารวิชาที่สอง" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { questionCount: number; questions: unknown[] } };
    // r11-Q1: bank เปล่า = 0 (ไม่ใช่ค่า stale จาก aggregate ตอน insert bank)
    expect(body.data.questionCount).toBe(0);
    expect(body.data.questions).toHaveLength(0);
  });

  it("instructor สร้างแทนคนอื่น (created_by ไม่ตรง) → RLS 42501 → 403 ERR-RBAC-001", async () => {
    const { calls } = mockClient(
      { question_banks: [{ error: { code: "42501", message: "new row violates row-level security policy" } }] },
      ["instructor"],
    );
    const res = await POST(postRequest(VALID_BANK));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("code ซ้ำ (unique uq_question_banks_code 23505) → 400 ERR-VAL-001", async () => {
    mockClient({ question_banks: [{ error: { code: "23505", message: "duplicate key value violates unique constraint" } }] });
    const res = await POST(postRequest(VALID_BANK));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("staff:content ไม่มี question_bank:create → 403 ERR-RBAC-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({ question_banks: [] }, ["staff:content"]);
    const res = await POST(postRequest(VALID_BANK));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "question_banks")).toBe(false);
  });

  it("body strict — ข้อสอบส่ง status มา → 400 ERR-VAL-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({ question_banks: [], question_options: [] });
    const res = await POST(
      postRequest({
        ...VALID_BANK,
        questions: [{ ...VALID_BANK.questions[0], status: "active" }],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.table === "question_banks")).toBe(false);
  });
});

describe("r4-H2a: แถว DB ขาเข้า drift → 503 ERR-SYS-002 fail-closed (ตรวจก่อน map)", () => {
  it("GET — ชนิดคอลัมน์เพี้ยน (name เป็นตัวเลข) → 503 question_bank_row_drift", async () => {
    mockClient({ question_banks: [{ data: [bankRow({ name: 42 })] }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("question_bank_row_drift");
  });

  it("r8-N1: GET — สำเร็จแต่ data null → 503 question_banks_rows_not_array ไม่ใช่ 200 หน้าว่าง", async () => {
    mockClient({ question_banks: [{ data: null }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("question_banks_rows_not_array");
  });

  it("GET — แถวมีคีย์เกิน (คอลัมน์รั่วจาก select/view) → 503 question_bank_row_drift ไม่ใช่ 200 แบบตัดเงียบ", async () => {
    mockClient({ question_banks: [{ data: [bankRow({ owner_email: "x@y.z" })] }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("question_bank_row_drift");
  });

  it("GET — embed นับข้อเพี้ยน (count เป็น string) → 503 question_bank_row_drift", async () => {
    mockClient({ question_banks: [{ data: [bankRow({ questions: [{ count: "5" }] })] }] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
  });

  it("POST — แถวข้อใหม่ drift (type นอก enum) → 503 question_created_row_drift + ไม่เอา id ไป insert options", async () => {
    const { calls } = mockClient(
      {
        question_banks: [{ data: bankRow() }],
        questions: [
          {
            data: {
              id: "d0000000-0000-4000-8000-000000000001",
              type: "essay",
              question_text: "โจทย์",
              points: 1,
            },
          },
        ],
        question_options: [{ data: null }],
      },
      ["instructor"],
    );
    const res = await POST(postRequest(VALID_BANK));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("question_created_row_drift");
    expect(calls.some((call) => call.table === "question_options")).toBe(false);
  });
});

/**
 * route.test — unit test ของ GET /api/v1/admin/question-banks/{id} (Wave G P2 · D73/D78 ·
 * API-SPECIFICATION §3.8 แถว 218)
 *
 * ครอบ: RBAC ต่อบทบาท (staff:exam/viewer ผ่าน · staff:content 403 ก่อนถึง DB) ·
 * UUID ผิดรูป 400 ก่อนแตะ DB · bank ไม่มี/RLS ซ่อน = 404 ต่างจากคลังว่าง ·
 * select เดียวกับ list (questions(count) — ไม่มี is_correct) · row drift → 503 fail-closed
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
import { QuestionBankResource } from "@/lib/schemas/v1/admin-exam";
import { GET } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const BANK_ID = "b0000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-01T00:00:00+00:00";
const URL_PATH = `http://localhost:3000/api/v1/admin/question-banks/${BANK_ID}`;

interface StubResult {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

interface RecordedCall {
  table: string;
  select?: string;
  filters: Array<{ column: string; value: unknown }>;
}

function bankRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BANK_ID,
    code: "BANK-01",
    name: "ธนาคารข้อสอบกฎหมายทั่วไป",
    description: null,
    course_id: null,
    category_id: null,
    is_active: true,
    created_at: CREATED_AT,
    questions: [{ count: 7 }],
    ...overrides,
  };
}

/** client stub — โครงเดียวกับ ../route.test.ts (คิวต่อตาราง + จด call) */
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
      const entry: RecordedCall = { table, filters: [] };
      const builder = {
        select: (s: string) => {
          entry.select = s;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          entry.filters.push({ column, value });
          return builder;
        },
        maybeSingle: () => builder,
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

function bankUrl(rawId = BANK_ID): Request {
  return new Request(`http://localhost:3000/api/v1/admin/question-banks/${rawId}`, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-gp2-1" },
  });
}

function detailContext(rawId = BANK_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: rawId }) };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/question-banks/{id} — RBAC + envelope", () => {
  it("staff:exam → 200 { data } + questionCount จาก embed + สะท้อน x-request-id", async () => {
    mockClient({ question_banks: [{ data: bankRow() }] });
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-gp2-1");
    const body = (await res.json()) as { data: { questionCount: number; code: string } };
    expect(body.data.code).toBe("BANK-01");
    expect(body.data.questionCount).toBe(7);
    expect(() => QuestionBankResource.parse(body.data)).not.toThrow();
  });

  it("staff:viewer มี question_bank:view → 200", async () => {
    mockClient({ question_banks: [{ data: bankRow() }] }, ["staff:viewer"]);
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(200);
  });

  it("staff:content ไม่มี question_bank:view → 403 ERR-RBAC-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({ question_banks: [] }, ["staff:content"]);
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "question_banks")).toBe(false);
  });
});

describe("GET /admin/question-banks/{id} — validation + 404 ต่างจากคลังว่าง", () => {
  it(":id ผิดรูป uuid → 400 ERR-VAL-001 fields:[\"id\"] ก่อนแตะ DB", async () => {
    const { calls } = mockClient({ question_banks: [] });
    const res = await GET(bankUrl("not-a-uuid"), detailContext("not-a-uuid"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toEqual(["id"]);
    expect(calls.some((call) => call.table === "question_banks")).toBe(false);
  });

  it("bank ไม่มี/RLS ซ่อน → 404 ERR-NF-001 question_bank_not_found (ไม่เปิดเผยการมีอยู่)", async () => {
    mockClient({ question_banks: [{ data: null }] });
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.details?.reason).toBe("question_bank_not_found");
  });

  it("query ล้ม → 503 ERR-SYS-002 (ไม่ leak ข้อความ SQL)", async () => {
    mockClient({ question_banks: [{ data: null, error: { code: "XX000", message: "connection reset" } }] });
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message.includes("connection reset")).toBe(false);
  });
});

describe("GET /admin/question-banks/{id} — select + row drift fail-closed", () => {
  it("select เดียวกับ list — มี questions(count) · ไม่มี is_correct", async () => {
    const { calls } = mockClient({ question_banks: [{ data: bankRow() }] });
    await GET(bankUrl(), detailContext());
    const call = calls.find((item) => item.table === "question_banks");
    expect(call?.select).toContain("questions(count)");
    expect(call?.select?.includes("is_correct")).toBe(false);
    expect(call?.filters).toEqual([{ column: "id", value: BANK_ID }]);
  });

  it("แถว drift (name เป็นตัวเลข) → 503 question_bank_row_drift", async () => {
    mockClient({ question_banks: [{ data: bankRow({ name: 42 }) }] });
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("question_bank_row_drift");
  });

  it("embed นับข้อหาย (questions []) → 503 ไม่ fabricate questionCount 0", async () => {
    mockClient({ question_banks: [{ data: bankRow({ questions: [] }) }] });
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("question_bank_row_drift");
  });

  it("แถวมีคีย์เกิน (คอลัมน์รั่ว) → 503 ไม่ตอบ 200 แบบตัดเงียบ", async () => {
    mockClient({ question_banks: [{ data: bankRow({ owner_email: "x@y.z" }) }] });
    const res = await GET(bankUrl(), detailContext());
    expect(res.status).toBe(503);
  });
});

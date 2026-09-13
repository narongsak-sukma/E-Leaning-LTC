/**
 * route.test — unit test ของ GET /api/v1/admin/question-banks/{id}/questions (Wave G P2 ·
 * D73/D78 · API-SPECIFICATION §3.8 แถว 219)
 *
 * ครอบ: RBAC ต่อบทบาท · UUID ผิดรูป · 404 ต่างจากคลังว่าง (200 data:[]) · cursor/limit
 * (PageQuery strict · limit+1 probe → hasMore) · แถวไม่มีเฉลย (DTO แยก — D74) ·
 * row drift → 503 fail-closed
 */
import { readFileSync } from "node:fs";
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
import { decodeCursor } from "@/lib/api/pagination";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { QuestionResource } from "@/lib/schemas/v1/admin-exam";
import { GET } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const BANK_ID = "b0000000-0000-4000-8000-000000000001";
const QUESTION_ID = "d0000000-0000-4000-8000-000000000001";
const OPTION_ID = "e0000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-01T00:00:00+00:00";
const URL_PATH = "http://localhost:3000/api/v1/admin/question-banks/" + BANK_ID + "/questions";

interface StubResult {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

interface RecordedCall {
  table: string;
  select?: string;
  filters: Array<{ column: string; value: unknown }>;
  order: Array<[string, { ascending: boolean }]>;
  limit: number | null;
  or: string | null;
}

function questionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: QUESTION_ID,
    bank_id: BANK_ID,
    type: "single_choice",
    difficulty: "medium",
    question_text: "โจทย์กฎหมาย ข้อที่ 1",
    explanation: null,
    points: 1,
    status: "draft",
    tags: [],
    version: 1,
    created_at: CREATED_AT,
    question_options: [
      { id: OPTION_ID, option_text: "ตัวเลือกก", sort_order: 0 },
      { id: "e0000000-0000-4000-8000-000000000002", option_text: "ตัวเลือกข", sort_order: 1 },
    ],
    ...overrides,
  };
}

function listUrl(query = ""): Request {
  return new Request(URL_PATH + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-gp2-list-1" },
  });
}

function listContext(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: BANK_ID }) };
}

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
      const entry: RecordedCall = { table, filters: [], order: [], limit: null, or: null };
      const builder = {
        select: (s: string) => {
          entry.select = s;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          entry.filters.push({ column, value });
          return builder;
        },
        or: (s: string) => {
          entry.or = s;
          return builder;
        },
        order: (column: string, opts: { ascending: boolean }) => {
          entry.order.push([column, opts]);
          return builder;
        },
        limit: (n: number) => {
          entry.limit = n;
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

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET .../questions — RBAC + envelope", () => {
  it("staff:exam → 200 {data,page} · x-request-id สะท้อนกลับ · แถว parse ผ่าน QuestionResource และไม่มีเฉลย", async () => {
    const { calls } = mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{ data: [questionRow()] }],
    });
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-gp2-list-1");
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; page: { hasMore: boolean; nextCursor: string | null } };
    expect(body.page.hasMore).toBe(false);
    expect(body.page.nextCursor).toBe(null);
    const json = JSON.stringify(body.data);
    expect(json.includes("is_correct")).toBe(false);
    expect(json.includes("isCorrect")).toBe(false);
    expect(() => QuestionResource.parse(body.data[0])).not.toThrow();
    const qCall = calls.find((item) => item.table === "questions");
    expect(qCall?.select?.includes("question_options(id,option_text,sort_order)")).toBe(true);
    expect(qCall?.select?.includes("is_correct")).toBe(false);
    expect(qCall?.filters).toEqual([{ column: "bank_id", value: BANK_ID }]);
    expect(qCall?.order).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(qCall?.limit).toBe(21); // limit default 20 + 1 probe (D78)
    expect(qCall?.or).toBe(null); // ไม่มี cursor → ไม่มี or-filter
  });

  it("staff:viewer มี question_bank:view → 200", async () => {
    mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{ data: [questionRow()] }],
    }, ["staff:viewer"]);
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(200);
  });

  it("staff:content ไม่มี question_bank:view → 403 ERR-RBAC-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({}, ["staff:content"]);
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "question_banks")).toBe(false);
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });
});

describe("GET .../questions — validation + 404 ต่างจากคลังว่าง", () => {
  it(":id ผิดรูป uuid → 400 ERR-VAL-001 fields:[\"id\"] ก่อนแตะ DB", async () => {
    const { calls } = mockClient({}, ["staff:exam"]);
    const badCtx: { params: Promise<{ id: string }> } = {
      params: Promise.resolve({ id: "not-a-uuid" }),
    };
    const res = await GET(listUrl(), badCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toEqual(["id"]);
    expect(calls.some((call) => call.table === "question_banks")).toBe(false);
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("bank ไม่มี/RLS ซ่อน → 404 ERR-NF-001 question_bank_not_found · ไม่ไป list ข้อ", async () => {
    const { calls } = mockClient({}, ["staff:exam"]);
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.details?.reason).toBe("question_bank_not_found");
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("คลังว่าง (bank มี ไม่มีข้อ) → 200 data:[] hasMore=false — ต่างจาก 404", async () => {
    mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{ data: [] }],
    });
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean } };
    expect(body.data).toEqual([]);
    expect(body.page.hasMore).toBe(false);
  });

  it("?limit=101 (> max 100) → 400 ERR-VAL-001 หลังเช็ค bank · ไม่ list ข้อ", async () => {
    const { calls } = mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [],
    });
    const res = await GET(listUrl("?limit=101"), listContext());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("query ล้ม → 503 ERR-SYS-002 admin_question_list_query_failed ไม่ leak ข้อความ SQL", async () => {
    mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{ data: null, error: { code: "XX000", message: "connection reset" } }],
    });
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_question_list_query_failed");
    expect(body.error.message.includes("connection reset")).toBe(false);
  });
});
describe("GET .../questions — cursor (created_at,id) DESC + limit+1 probe", () => {
  it("?limit=2 กับ 3 แถว → hasMore=true ตัดเหลือ 2 · cursor payload = (created_at,id) แถวสุดท้าย", async () => {
    const r1 = questionRow({ id: "d0000000-0000-4000-8000-0000000000a1", created_at: "2026-09-03T00:00:00+00:00" });
    const r2 = questionRow({ id: "d0000000-0000-4000-8000-0000000000a2", created_at: "2026-09-02T00:00:00+00:00" });
    const r3 = questionRow({ id: "d0000000-0000-4000-8000-0000000000a3", created_at: "2026-09-01T00:00:00+00:00" });
    mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{ data: [r1, r2, r3] }],
    });
    const res = await GET(listUrl("?limit=2"), listContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; page: { hasMore: boolean; nextCursor?: string } };
    expect(body.data.map((row) => row.id)).toEqual([
      "d0000000-0000-4000-8000-0000000000a1",
      "d0000000-0000-4000-8000-0000000000a2",
    ]);
    expect(body.page.hasMore).toBe(true);
    const payload = decodeCursor(body.page.nextCursor as string);
    expect(payload.sortKey).toBe("2026-09-02T00:00:00+00:00");
    expect(payload.id).toBe("d0000000-0000-4000-8000-0000000000a2");
  });

  it("เดิน cursor 2 หน้า → หน้าสองคืนแถวเก่ากว่า · or-filter row-wise ถูกใช้", async () => {
    const r1 = questionRow({ id: "d0000000-0000-4000-8000-0000000000a1", created_at: "2026-09-03T00:00:00+00:00" });
    const r2 = questionRow({ id: "d0000000-0000-4000-8000-0000000000a2", created_at: "2026-09-02T00:00:00+00:00" });
    const r3 = questionRow({ id: "d0000000-0000-4000-8000-0000000000a3", created_at: "2026-09-01T00:00:00+00:00" });
    const { calls } = mockClient({
      question_banks: [{ data: { id: BANK_ID } }, { data: { id: BANK_ID } }],
      questions: [{ data: [r1, r2, r3] }, { data: [r3] }],
    });
    const page1 = await GET(listUrl("?limit=2"), listContext());
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as { page: { nextCursor?: string } };
    const cursor = body1.page.nextCursor as string;
    const page2 = await GET(listUrl("?limit=2&cursor=" + encodeURIComponent(cursor)), listContext());
    expect(page2.status).toBe(200);
    const body2 = (await page2.json()) as { data: Array<{ id: string }>; page: { hasMore: boolean } };
    expect(body2.data.map((row) => row.id)).toEqual(["d0000000-0000-4000-8000-0000000000a3"]);
    expect(body2.page.hasMore).toBe(false);
    const qCall2 = calls.filter((item) => item.table === "questions")[1];
    expect(qCall2?.or).toBe(
      "created_at.lt.2026-09-02T00:00:00+00:00,and(created_at.eq.2026-09-02T00:00:00+00:00,id.lt.d0000000-0000-4000-8000-0000000000a2)",
    );
  });
});

describe("GET .../questions — drift fail-closed (r4-H2a/r8-N1)", () => {
  it("questions data null → 503 questions_rows_not_array ไม่ใช่ 200 หน้าว่าง", async () => {
    mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{ data: null }],
    });
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("questions_rows_not_array");
  });

  it("แถว drift (tags null) → 503 question_row_drift", async () => {
    mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{ data: [questionRow({ tags: null })] }],
    });
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("question_row_drift");
  });

  it("option embed รั่ว is_correct → 503 (D74 fail-closed — เฉลยห้ามเข้า DTO ที่ไม่ใช่ edit)", async () => {
    mockClient({
      question_banks: [{ data: { id: BANK_ID } }],
      questions: [{
        data: [questionRow({
          question_options: [{ id: OPTION_ID, option_text: "ตัวเลือกก", sort_order: 0, is_correct: true }],
        })],
      }],
    });
    const res = await GET(listUrl(), listContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("question_row_drift");
  });
});

describe("D74 — select ของ list ตัด is_correct ตั้งแต่ SELECT", () => {
  it("QUESTION_SELECT ใน source ไม่มี is_correct (grep-assert)", () => {
    const src = readFileSync("src/app/api/v1/admin/question-banks/[id]/questions/route.ts", "utf8");
    const m = /QUESTION_SELECT =\s*"([^"]+)"\s*\+\s*"([^"]+)";/.exec(src);
    expect(m).not.toBeNull();
    expect((String(m?.[1] ?? "") + String(m?.[2] ?? "")).includes("is_correct")).toBe(false);
  });
});

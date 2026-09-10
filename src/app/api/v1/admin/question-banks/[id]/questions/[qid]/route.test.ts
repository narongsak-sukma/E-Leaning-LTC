/**
 * route.test — unit test ของ PATCH /api/v1/admin/question-banks/{id}/questions/{qid}
 * (Wave D · D-3)
 *
 * ครอบ: happy (staff:exam แก้ข้อ active ที่ "ใช้แล้ว" → version ใหม่), denial
 * (staff:content ไม่มี perm · instructor แก้ข้อ active · instructor แก้นอก bank ตัวเอง),
 * strict schema (ห้ามส่ง status), ไม่เจอข้อ → 404, response ไม่มี is_correct
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
import { QuestionResource } from "@/lib/schemas/v1/admin-exam";
import { PATCH } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const BANK_ID = "b0000000-0000-4000-8000-000000000001";
const QUESTION_ID = "d0000000-0000-4000-8000-000000000001";
const OPTION_ID = "e0000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-01T00:00:00+00:00";
const URL_PATH = `http://localhost:3000/api/v1/admin/question-banks/${BANK_ID}/questions/${QUESTION_ID}`;

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

/** แถวข้อสอบตาม select ของ route (reload รวม options แบบไม่มี is_correct) */
function questionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: QUESTION_ID,
    bank_id: BANK_ID,
    type: "single_choice",
    difficulty: "medium",
    question_text: "โจทย์เดิม",
    explanation: null,
    points: 1,
    status: "draft",
    tags: [],
    version: 2,
    created_at: CREATED_AT,
    question_options: [
      { id: OPTION_ID, option_text: "ตัวเลือกก", sort_order: 0 },
      { id: "e0000000-0000-4000-8000-000000000002", option_text: "ตัวเลือกข", sort_order: 1 },
    ],
    ...overrides,
  };
}

function patchRequest(body: unknown): Request {
  return new Request(URL_PATH, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d3-3", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** client stub — คิวต่อตาราง (questions ต้องการ 3 result: อ่าน → update → reload) */
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

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("PATCH /admin/question-banks/{id}/questions/{qid} — happy path", () => {
  it("staff:exam แก้ข้อที่ใช้แล้ว (active, version 4) → 200 version ใหม่ = 5", async () => {
    const { calls } = mockClient({
      questions: [
        { data: questionRow({ status: "active", version: 4 }) },
        { data: null },
        { data: questionRow({ status: "active", version: 5, question_text: "โจทย์แก้ไข" }) },
      ],
    });
    const res = await PATCH(patchRequest({ questionText: "โจทย์แก้ไข" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version: number; status: string } };
    expect(body.data.version).toBe(5);
    expect(body.data.status).toBe("active");
    const update = calls.find((call) => call.table === "questions" && call.method === "update");
    expect((update?.payload as Record<string, unknown>)?.["version"]).toBe(5);
    expect((update?.payload as Record<string, unknown>)?.["question_text"]).toBe("โจทย์แก้ไข");
    expect((update?.payload as Record<string, unknown>)?.["status"]).toBeUndefined();
  });

  it("instructor แก้ข้อ draft ของตัวเอง → 200 · response ไม่มี is_correct ทุกตัวเลือก", async () => {
    mockClient(
      {
        questions: [
          { data: questionRow() },
          { data: null },
          { data: questionRow({ question_text: "โจทย์แก้ไข" }) },
        ],
      },
      ["instructor"],
    );
    const res = await PATCH(patchRequest({ questionText: "โจทย์แก้ไข" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(() => QuestionResource.parse(body.data)).not.toThrow();
    const json = JSON.stringify(body.data);
    expect(json.includes("is_correct")).toBe(false);
    expect(json.includes("isCorrect")).toBe(false);
  });

  it("แนบ options พร้อม is_correct → UPDATE แถวที่มี id / INSERT แถวที่ไม่มี (ไม่มี DELETE grant)", async () => {
    const { calls } = mockClient({
      questions: [{ data: questionRow() }, { data: null }, { data: questionRow() }],
      question_options: [{ data: null }, { data: null }],
    });
    const res = await PATCH(
      patchRequest({
        options: [
          { id: OPTION_ID, optionText: "ตัวเลือกกแก้ไข", isCorrect: true, sortOrder: 0 },
          { optionText: "ตัวเลือกใหม่", isCorrect: false, sortOrder: 2 },
        ],
      }),
      { params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }) },
    );
    expect(res.status).toBe(200);
    const optionUpdate = calls.find((call) => call.table === "question_options" && call.method === "update");
    expect((optionUpdate?.payload as Record<string, unknown>)?.["is_correct"]).toBe(true);
    const optionInsert = calls.find((call) => call.table === "question_options" && call.method === "insert");
    expect((optionInsert?.payload as Record<string, unknown>)?.["question_id"]).toBe(QUESTION_ID);
  });
});

describe("PATCH — denial + validation", () => {
  it("staff:content ไม่มี question_bank:update → 403 ERR-RBAC-001 ก่อนถึง DB", async () => {
    const { calls } = mockClient({ questions: [] }, ["staff:content"]);
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("instructor แก้ข้อ active (ใช้แล้ว — อ่านอย่างเดียวสำหรับผู้แต่ง) → 403 ERR-RBAC-001", async () => {
    const { calls } = mockClient(
      { questions: [{ data: questionRow({ status: "active" }) }] },
      ["instructor"],
    );
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "questions" && call.method === "update")).toBe(false);
  });

  it("instructor แก้นอก bank ตัวเอง → RLS 42501 → 403 ERR-RBAC-001", async () => {
    mockClient(
      { questions: [{ data: questionRow() }, { error: { code: "42501", message: "row-level security" } }] },
      ["instructor"],
    );
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("ไม่พบข้อ (bank/question ไม่ตรง หรือ RLS บัง) → 404 ERR-NF-001", async () => {
    mockClient({ questions: [{ data: null }] });
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
  });

  it("body ส่ง status มา → 400 ERR-VAL-001 (schema strict — ไม่เขียน DB)", async () => {
    const { calls } = mockClient({ questions: [] });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });
});

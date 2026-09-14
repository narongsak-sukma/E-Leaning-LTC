/**
 * route.test — unit test ของ PATCH /api/v1/admin/question-banks/{id}/questions/{qid}
 * (Wave D · D-3 · 0019-r1)
 *
 * 0019-r1 (gate r1 B6): route ยุบการเขียนทั้งหมดเป็น RPC `admin_update_question`
 * ครั้งเดียว (TX เดียว: สิทธิ์ + version bump + sort_order สองเฟส + options
 * update-or-insert) — mock จึงเหลือ rpc() จุดเขียนเดียว + reload ผ่าน from() ·
 * ครอบ: happy (staff:exam แก้ข้อ "ใช้แล้ว" → version ใหม่ · instructor แก้ draft),
 * options ส่งเป็น jsonb ทั้งก้อน, denial (staff:content · instructor แก้ active ·
 * instructor นอก bank ตัวเอง — ทั้งหมดเป็นป้ายจาก RPC), ไม่เจอ → 404, strict schema
 * (ห้าม status), response ไม่มี is_correct
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
import { resetRateLimitStore } from "@/lib/rate-limit";
import { EditQuestionResource, QuestionResource } from "@/lib/schemas/v1/admin-exam";
import { GET, PATCH } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const BANK_ID = "b0000000-0000-4000-8000-000000000001";
const QUESTION_ID = "d0000000-0000-4000-8000-000000000001";
const OPTION_ID = "e0000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-01T00:00:00+00:00";
const URL_PATH = `http://localhost:3000/api/v1/admin/question-banks/${BANK_ID}/questions/${QUESTION_ID}`;

interface StubResult {
  data?: unknown;
  error?: { code?: string; message?: string | null } | null;
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

/**
 * client stub — rpc() เป็นจุดเขียนเดียว (my_roles + admin_update_question) ·
 * from() เหลือใช้ตอน reload (คิวต่อตาราง — questions ต้องการผล reload 1 อัน)
 */
function mockClient(
  queues: Record<string, StubResult[]>,
  roles: readonly string[] = ["staff:exam"],
  questionRpc: StubResult = { data: { question_id: QUESTION_ID, version: 5 }, error: null },
): { calls: RecordedCall[]; rpcCalls: Array<[string, Record<string, unknown>]> } {
  const calls: RecordedCall[] = [];
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
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
      rpcCalls.push([fn, args]);
      if (fn === "my_roles") {
        return { data: [...roles], error: null };
      }
      if (fn === "admin_update_question") {
        return { data: questionRpc.data ?? null, error: questionRpc.error ?? null };
      }
      return { data: null, error: null };
    }),
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
  return { calls, rpcCalls };
}

/** เรียก admin_update_question จริง (แยกจาก my_roles ที่ requirePermission ใช้) */
function adminRpcCalls(rpcCalls: Array<[string, Record<string, unknown>]>): Array<Record<string, unknown>> {
  return rpcCalls.filter(([fn]) => fn === "admin_update_question").map(([, args]) => args);
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("PATCH /admin/question-banks/{id}/questions/{qid} — happy path (RPC TX เดียว)", () => {
  it("staff:exam แก้ข้อที่ใช้แล้ว (active, version 4) → 200 version ใหม่ = 5 · เขียนผ่าน RPC ครั้งเดียว", async () => {
    const { calls, rpcCalls } = mockClient({
      questions: [{ data: questionRow({ status: "active", version: 5, question_text: "โจทย์แก้ไข" }) }],
    });
    const res = await PATCH(patchRequest({ questionText: "โจทย์แก้ไข" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version: number; status: string } };
    expect(body.data.version).toBe(5);
    expect(body.data.status).toBe("active");
    // เขียนทั้งหมดผ่าน RPC เดียว — p_patch ไม่มี version (RPC เป็นคน bump) ไม่มี status
    const adminCalls = adminRpcCalls(rpcCalls);
    expect(adminCalls.length).toBe(1);
    expect(adminCalls[0]).toEqual({
      p_question_id: QUESTION_ID,
      p_bank_id: BANK_ID,
      p_patch: { question_text: "โจทย์แก้ไข" },
      p_options: null,
    });
    // from() เหลือแค่ reload (select) — ไม่มี update/insert ที่ route อีกต่อไป (B6)
    expect(calls.filter((call) => call.table === "questions").length).toBe(1);
    expect(calls.some((call) => call.method === "update" || call.method === "insert")).toBe(false);
  });

  it("instructor แก้ข้อ draft ของตัวเอง → 200 · response ไม่มี is_correct ทุกตัวเลือก", async () => {
    mockClient(
      { questions: [{ data: questionRow({ question_text: "โจทย์แก้ไข" }) }] },
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

  it("แนบ options → ส่งทั้งก้อนเป็น p_options (id = update · ไม่มี id = insert) ไม่แตะตาราง option", async () => {
    const { calls, rpcCalls } = mockClient({ questions: [{ data: questionRow() }] });
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
    expect(adminRpcCalls(rpcCalls)[0]?.["p_options"]).toEqual([
      { id: OPTION_ID, option_text: "ตัวเลือกกแก้ไข", is_correct: true, sort_order: 0 },
      { option_text: "ตัวเลือกใหม่", is_correct: false, sort_order: 2 },
    ]);
    // B6: route เขียน option ทั้งหมดใน RPC — ไม่มีเขียนตรง question_options เป็นรายแถว
    expect(calls.some((call) => call.table === "question_options")).toBe(false);
  });

  it("explanation: null → p_patch มีคีย์ explanation เป็น null (เคลียร์ค่า ไม่ใช่ไม่แตะ)", async () => {
    const { rpcCalls } = mockClient({ questions: [{ data: questionRow() }] });
    const res = await PATCH(patchRequest({ explanation: null }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(200);
    expect(adminRpcCalls(rpcCalls)[0]?.["p_patch"]).toEqual({ explanation: null });
  });
});

describe("PATCH — denial + validation", () => {
  it("staff:content ไม่มี question_bank:update → 403 ERR-RBAC-001 ก่อนถึง RPC/DB", async () => {
    const { calls, rpcCalls } = mockClient({ questions: [] }, ["staff:content"]);
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(adminRpcCalls(rpcCalls).length).toBe(0);
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("instructor แก้ข้อ active (ใช้แล้ว) → ป้าย RPC question_active_readonly_for_instructor → 403 ERR-RBAC-001 ไม่ reload", async () => {
    const { calls, rpcCalls } = mockClient(
      { questions: [] },
      ["instructor"],
      {
        data: null,
        error: {
          message:
            "คุณไม่มีสิทธิ์ดำเนินการนี้: ข้อที่เปิดใช้แล้วแก้ไม่ได้ (ERR-RBAC-001|question_active_readonly_for_instructor)",
        },
      },
    );
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details?.reason).toBe("question_active_readonly_for_instructor");
    expect(adminRpcCalls(rpcCalls).length).toBe(1);
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("instructor แก้นอก bank ตัวเอง → ป้าย RPC not_question_owner → 403 ERR-RBAC-001", async () => {
    mockClient(
      { questions: [] },
      ["instructor"],
      { data: null, error: { message: "คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|not_question_owner)" } },
    );
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details?.reason).toBe("not_question_owner");
  });

  it("ไม่พบข้อ (bank/question ไม่ตรง) → ป้าย RPC question_not_found → 404 ERR-NF-001", async () => {
    mockClient(
      { questions: [] },
      ["staff:exam"],
      { data: null, error: { message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|question_not_found)" } },
    );
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.details?.reason).toBe("question_not_found");
  });

  it("body ส่ง status มา → 400 ERR-VAL-001 (schema strict — ไม่เรียก RPC)", async () => {
    const { calls, rpcCalls } = mockClient({ questions: [] });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(adminRpcCalls(rpcCalls).length).toBe(0);
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });
});

describe("PATCH — RPC infra path", () => {
  it("RPC error ไม่มีป้ายทะเบียน (SQL ดิบ) → 503 ERR-SYS-002 opaque ไม่ leak ข้อความ", async () => {
    mockClient(
      { questions: [] },
      ["staff:exam"],
      { data: null, error: { code: "XX000", message: 'SQLSTATE 42703: column "boom" does not exist' } },
    );
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("admin_question_rpc_failed");
    expect(body.error.message.includes("SQLSTATE")).toBe(false);
  });

  it("RPC สำเร็จแต่ reload ไม่เจอแถว → 503 ERR-SYS-002 question_reload_failed (r4-H2b: ไม่ใช่ ERR-SYS-001 500)", async () => {
    mockClient({ questions: [{ data: null }] });
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("question_reload_failed");
  });

  it("r4-H2b: reload ได้แถว drift (tags เป็น null) → 503 ERR-SYS-002 question_row_drift ไม่ใช่ TypeError → 500", async () => {
    mockClient({ questions: [{ data: questionRow({ tags: null }) }] });
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("question_row_drift");
  });

  it("reload query ล้ม → 503 ERR-SYS-002", async () => {
    mockClient({
      questions: [{ data: null, error: { code: "XX000", message: "connection reset" } }],
    });
    const res = await PATCH(patchRequest({ questionText: "x" }), {
      params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("B6 (grep-assert): route เขียน questions/question_options ผ่าน RPC เท่านั้น — ไม่มี .update/.insert ตรง", () => {
    const src = readFileSync(
      "src/app/api/v1/admin/question-banks/[id]/questions/[qid]/route.ts",
      "utf8",
    );
    expect(src.includes('.from("question_options")')).toBe(false);
    expect(src.includes('supabase\n      .from("questions")\n      .update')).toBe(false);
    expect(src.includes('rpc("admin_update_question"')).toBe(true);
  });
});

describe("GET (edit) — ข้อเดี่ยวสำหรับฟอร์มแก้ (D74)", () => {
  function editRow(): Record<string, unknown> {
    return questionRow({
      question_options: [
        { id: OPTION_ID, option_text: "ตัวเลือกก", sort_order: 0, is_correct: true },
        { id: "e0000000-0000-4000-8000-000000000002", option_text: "ตัวเลือกข", sort_order: 1, is_correct: false },
      ],
    });
  }
  function editContext(): { params: Promise<{ id: string; qid: string }> } {
    return { params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }) };
  }
  function editUrl(): Request {
    return new Request(URL_PATH, {
      headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-gp2-edit-1" },
    });
  }

  it("staff:exam → 200 EditQuestionResource (options มี isCorrect) · Cache-Control private, no-store", async () => {
    mockClient({ questions: [{ data: editRow() }] });
    const res = await GET(editUrl(), editContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { data: { options: Array<{ isCorrect: boolean }>; version: number } };
    expect(body.data.options).toEqual([
      { id: OPTION_ID, optionText: "ตัวเลือกก", sortOrder: 0, isCorrect: true },
      { id: "e0000000-0000-4000-8000-000000000002", optionText: "ตัวเลือกข", sortOrder: 1, isCorrect: false },
    ]);
  });

  it("staff:content → 403 ก่อนถึง DB (ไม่มี question_bank:update)", async () => {
    const { calls } = mockClient({ questions: [] }, ["staff:content"]);
    const res = await GET(editUrl(), editContext());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("staff:viewer → 403 (มี view แต่ไม่มี question_bank:update — D74 ให้เฉลยเฉพาะผู้แต่ง)", async () => {
    const { calls } = mockClient({ questions: [] }, ["staff:viewer"]);
    const res = await GET(editUrl(), editContext());
    expect(res.status).toBe(403);
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("qid ไม่อยู่ใน bank (data null) → 404 ERR-NF-001 question_not_found", async () => {
    mockClient({ questions: [] }, ["staff:exam"]);
    const res = await GET(editUrl(), editContext());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.details?.reason).toBe("question_not_found");
  });

  it("qid ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB", async () => {
    const { calls } = mockClient({ questions: [] }, ["staff:exam"]);
    const badCtx: { params: Promise<{ id: string; qid: string }> } = {
      params: Promise.resolve({ id: BANK_ID, qid: "not-a-uuid" }),
    };
    const res = await GET(editUrl(), badCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details?: { fields?: string[] } } };
    expect(body.error.details?.fields).toEqual(["questionId"]);
    expect(calls.some((call) => call.table === "questions")).toBe(false);
  });

  it("row drift (tags null) → 503 edit_question_row_drift · error path ก็ no-store", async () => {
    mockClient({ questions: [{ data: questionRow({ tags: null }) }] });
    const res = await GET(editUrl(), editContext());
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("edit_question_row_drift");
  });

  it("Cache-Control private, no-store ครบทุกทางออก error — 400/403/404/503", async () => {
    // 400 (uuid ผิด)
    mockClient({ questions: [] }, ["staff:exam"]);
    const badCtx: { params: Promise<{ id: string; qid: string }> } = {
      params: Promise.resolve({ id: "oops", qid: QUESTION_ID }),
    };
    const r400 = await GET(editUrl(), badCtx);
    expect(r400.status).toBe(400);
    expect(r400.headers.get("cache-control")).toBe("private, no-store");
    // 403 (staff:content)
    mockClient({ questions: [] }, ["staff:content"]);
    const r403 = await GET(editUrl(), editContext());
    expect(r403.status).toBe(403);
    expect(r403.headers.get("cache-control")).toBe("private, no-store");
    // 404 (ไม่พบ)
    mockClient({ questions: [] }, ["staff:exam"]);
    const r404 = await GET(editUrl(), editContext());
    expect(r404.status).toBe(404);
    expect(r404.headers.get("cache-control")).toBe("private, no-store");
    // 503 (drift)
    mockClient({ questions: [{ data: questionRow({ tags: null }) }] });
    const r503 = await GET(editUrl(), editContext());
    expect(r503.status).toBe(503);
    expect(r503.headers.get("cache-control")).toBe("private, no-store");
  });

  it("select ของ edit GET รวม is_correct ใน embed · กรองทั้ง id+bank_id", async () => {
    const { calls } = mockClient({ questions: [{ data: editRow() }] });
    await GET(editUrl(), editContext());
    const call = calls.find((item) => item.table === "questions");
    expect(call?.select?.includes("question_options(id,option_text,sort_order,is_correct)")).toBe(true);
    expect(call?.filters).toEqual([
      { column: "id", value: QUESTION_ID },
      { column: "bank_id", value: BANK_ID },
    ]);
  });

  it("DTO แยก — response ผ่าน EditQuestionResource (options มี isCorrect)", async () => {
    mockClient({ questions: [{ data: editRow() }] });
    const res = await GET(editUrl(), editContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(() => EditQuestionResource.parse(body.data)).not.toThrow();
    expect(JSON.stringify(body.data).includes("isCorrect")).toBe(true);
  });
});

describe("D74 — select แยกชุดระหว่าง edit GET กับเส้นอื่น (grep-assert)", () => {
  it("EDIT_QUESTION_SELECT รวม is_correct · QUESTION_SELECT (list/PATCH) ไม่มี", () => {
    const editSrc = readFileSync("src/app/api/v1/admin/question-banks/[id]/questions/[qid]/route.ts", "utf8");
    const listSrc = readFileSync("src/app/api/v1/admin/question-banks/[id]/questions/route.ts", "utf8");
    const editM = /EDIT_QUESTION_SELECT =\s*"([^"]+)"\s*\+\s*"([^"]+)";/.exec(editSrc);
    const listM = /QUESTION_SELECT =\s*"([^"]+)"\s*\+\s*"([^"]+)";/ .exec(listSrc);
    expect(editM).not.toBeNull();
    expect(listM).not.toBeNull();
    expect((String(editM?.[1] ?? "") + String(editM?.[2] ?? "")).includes("is_correct")).toBe(true);
    expect((String(listM?.[1] ?? "") + String(listM?.[2] ?? "")).includes("is_correct")).toBe(false);
  });
});

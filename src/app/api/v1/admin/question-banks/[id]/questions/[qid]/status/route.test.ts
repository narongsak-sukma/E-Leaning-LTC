/**
 * route.test — unit test ของ PATCH /api/v1/admin/question-banks/{id}/questions/{qid}/status
 * (Wave G P2 · D75 · API-SPECIFICATION §3.8 แถว 222)
 *
 * ครอบ: RBAC (staff:exam ผ่าน · instructor ตายที่ RPC · viewer/content 403 ก่อน RPC) ·
 * body strict + JSON เสีย · UUID params · error mapping ตามป้าย RPC
 * (transition/needs_options → 400 · not_found → 404 · AUTH-004/RBAC-001 → 403 ·
 * ไม่มีป้าย → 503 opaque) · p_request_id (header / ไม่มี header) · PostgREST wrap · drift
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
import { QuestionStatusResult } from "@/lib/schemas/v1/admin-exam";
import { PATCH } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const BANK_ID = "b0000000-0000-4000-8000-000000000001";
const QUESTION_ID = "d0000000-0000-4000-8000-000000000001";
const URL_PATH = "http://localhost:3000/api/v1/admin/question-banks/" + BANK_ID + "/questions/" + QUESTION_ID + "/status";

interface StubResult {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function statusRequest(body: unknown, requestId = "req-gp2-status-1"): Request {
  return new Request(URL_PATH, {
    method: "PATCH",
    headers: {
      "x-forwarded-for": "10.5.0.1",
      "x-request-id": requestId,
      "content-type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(): { params: Promise<{ id: string; qid: string }> } {
  return { params: Promise.resolve({ id: BANK_ID, qid: QUESTION_ID }) };
}

function mockClient(
  roles: readonly string[] = ["staff:exam"],
  rpcResult: StubResult = {
    data: { question_id: QUESTION_ID, status: "active", version: 3 },
    error: null,
  },
): { rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];
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
      rpcCalls.push({ fn, args });
      if (fn === "my_roles") {
        return { data: [...roles], error: null };
      }
      return { data: rpcResult.data ?? null, error: rpcResult.error ?? null };
    }),
    from: (table: string) => {
      if (table === "profiles") {
        return profilesBuilder;
      }
      throw new Error("unexpected table: " + table);
      const builder = {
        then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return builder;
    },
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { rpcCalls };
}

function statusRpcCalls(rpcCalls: RpcCall[]): Array<Record<string, unknown>> {
  return rpcCalls.filter((call) => call.fn === "admin_set_question_status").map((call) => call.args);
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("PATCH .../status — happy path + p_request_id", () => {
  it("staff:exam draft→active → 200 {questionId,status,version} · p_request_id จาก header", async () => {
    const { rpcCalls } = mockClient(["staff:exam"], {
      data: { question_id: QUESTION_ID, status: "active", version: 3 },
      error: null,
    });
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { questionId: string; status: string; version: number } };
    expect(body.data.questionId).toBe(QUESTION_ID);
    expect(body.data.status).toBe("active");
    expect(body.data.version).toBe(3);
    expect(() => QuestionStatusResult.parse(body.data)).not.toThrow();
    const calls = statusRpcCalls(rpcCalls);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      p_question_id: QUESTION_ID,
      p_bank_id: BANK_ID,
      p_status: "active",
      p_request_id: "req-gp2-status-1",
    });
  });

  it("ไม่มี header x-request-id → p_request_id = null", async () => {
    const { rpcCalls } = mockClient();
    const bare = new Request(URL_PATH, {
      method: "PATCH",
      headers: { "x-forwarded-for": "10.5.0.1", "content-type": "application/json" },
      body: JSON.stringify({ status: "retired" }),
    });
    const res = await PATCH(bare, ctx());
    expect(res.status).toBe(200);
    expect(statusRpcCalls(rpcCalls)[0]?.["p_request_id"]).toBe(null);
  });

  it("PostgREST wrap scalar เป็น array หลักเดียว (r8-N2) → unwrap ได้แถวเดียว", async () => {
    mockClient(["staff:exam"], {
      data: [{ question_id: QUESTION_ID, status: "retired", version: 4 }],
      error: null,
    });
    const res = await PATCH(statusRequest({ status: "retired" }), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; version: number } };
    expect(body.data.status).toBe("retired");
    expect(body.data.version).toBe(4);
  });
});

describe("PATCH .../status — RBAC", () => {
  it("instructor ผ่าน BFF (question_bank:update) แต่ RPC ปฏิเสธ ERR-RBAC-001|question_status_forbidden → 403", async () => {
    mockClient(["instructor"], {
      data: null,
      error: { message: "คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|question_status_forbidden)" },
    });
    const res = await PATCH(statusRequest({ status: "retired" }), ctx());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details?.reason).toBe("question_status_forbidden");
  });

  it("staff:viewer ไม่มี question_bank:update → 403 ก่อนเรียก RPC", async () => {
    const { rpcCalls } = mockClient(["staff:viewer"]);
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(statusRpcCalls(rpcCalls).length).toBe(0);
  });

  it("staff:content → 403 ก่อนเรียก RPC", async () => {
    const { rpcCalls } = mockClient(["staff:content"]);
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(403);
    expect(statusRpcCalls(rpcCalls).length).toBe(0);
  });

  it("RPC คืน ERR-AUTH-004 (ป้ายไม่มี reason) → 403 ตามทะเบียน", async () => {
    mockClient(["staff:exam"], {
      data: null,
      error: { message: "กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004)" },
    });
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });
});

describe("PATCH .../status — body strict + validation", () => {
  it("body มีคีย์แปลกปลอม → 400 ERR-VAL-001 ก่อนเรียก RPC", async () => {
    const { rpcCalls } = mockClient();
    const res = await PATCH(statusRequest({ status: "active", version: 9 }), ctx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(statusRpcCalls(rpcCalls).length).toBe(0);
  });

  it("status นอก enum (published) → 400", async () => {
    const { rpcCalls } = mockClient();
    const res = await PATCH(statusRequest({ status: "published" }), ctx());
    expect(res.status).toBe(400);
    expect(statusRpcCalls(rpcCalls).length).toBe(0);
  });

  it("JSON เสีย → 400 ERR-VAL-001 fields:[\"body\"]", async () => {
    const { rpcCalls } = mockClient();
    const res = await PATCH(statusRequest("{bad json"), ctx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details?: { fields?: string[] } } };
    expect(body.error.details?.fields).toEqual(["body"]);
    expect(statusRpcCalls(rpcCalls).length).toBe(0);
  });

  it("bankId ผิดรูป uuid → 400 ก่อนเรียก RPC", async () => {
    const { rpcCalls } = mockClient();
    const badCtx: { params: Promise<{ id: string; qid: string }> } = {
      params: Promise.resolve({ id: "oops", qid: QUESTION_ID }),
    };
    const res = await PATCH(statusRequest({ status: "active" }), badCtx);
    expect(res.status).toBe(400);
    expect(statusRpcCalls(rpcCalls).length).toBe(0);
  });
});

describe("PATCH .../status — error mapping ตามป้าย RPC (0047)", () => {
  it("same-status → ERR-VAL-001|question_status_transition → 400", async () => {
    mockClient(["staff:exam"], {
      data: null,
      error: { message: "เปลี่ยนสถานะไม่ได้ (ERR-VAL-001|question_status_transition)" },
    });
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.reason).toBe("question_status_transition");
  });

  it("draft ไม่มีตัวเลือก → ERR-VAL-001|question_needs_options → 400", async () => {
    mockClient(["staff:exam"], {
      data: null,
      error: { message: "ข้อสอบต้องมีตัวเลือกก่อน (ERR-VAL-001|question_needs_options)" },
    });
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.reason).toBe("question_needs_options");
  });

  it("qid ผิด bank → ERR-NF-001|question_not_found → 404", async () => {
    mockClient(["staff:exam"], {
      data: null,
      error: { message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|question_not_found)" },
    });
    const res = await PATCH(statusRequest({ status: "retired" }), ctx());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.details?.reason).toBe("question_not_found");
  });

  it("SQL ดิบไม่มีป้าย → 503 ERR-SYS-002 opaque ไม่ leak ข้อความ", async () => {
    mockClient(["staff:exam"], {
      data: null,
      error: { code: "XX000", message: "SQLSTATE 42703: column boom does not exist" },
    });
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("question_status_update_failed");
    expect(body.error.message.includes("SQLSTATE")).toBe(false);
  });

  it("RPC สำเร็จแต่แถว drift (status draft นอก enum) → 503 question_status_rpc_row_drift", async () => {
    mockClient(["staff:exam"], {
      data: { question_id: QUESTION_ID, status: "draft", version: 9 },
      error: null,
    });
    const res = await PATCH(statusRequest({ status: "active" }), ctx());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("question_status_rpc_row_drift");
  });

  it("RPC สำเร็จแต่ data null → 503 question_status_rpc_drift", async () => {
    mockClient(["staff:exam"], { data: null, error: null });
    const res = await PATCH(statusRequest({ status: "retired" }), ctx());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("question_status_rpc_drift");
  });
});

describe("D75 — route ผูก RPC ถูกต้อง (grep-assert)", () => {
  it("source เรียก admin_set_question_status + ส่ง p_request_id จาก options", () => {
    const src = readFileSync("src/app/api/v1/admin/question-banks/[id]/questions/[qid]/status/route.ts", "utf8");
    expect(src.includes('rpc("admin_set_question_status"')).toBe(true);
    expect(src.includes("p_request_id: options.requestId ?? null")).toBe(true);
  });
});

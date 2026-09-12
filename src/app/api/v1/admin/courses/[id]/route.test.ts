/**
 * route.test — PATCH /api/v1/admin/courses/{id} (Wave E Phase 5 · [#90])
 *
 * - course:publish (SC/SA) · aal1 → 403 · :id ผิดรูป → 400 · body strict { action, comment? }
 * - return บังคับ comment 10-500 → 400 ก่อนแตะ RPC (RPC ตรวจซ้ำชั้นที่สอง)
 * - RPC admin_decide_course — transition + audit atomic · tag → AppError ·
 *   drift → 503 admin_decide_course_row_drift
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
    clearAuthCookies: () => () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { PATCH } from "./route";

const SC = "staff:content";
const SA = "super_admin";
const SE = "staff:exam";
const CALLER_ID = "a0000000-0000-4000-8000-000000000001";
const COURSE_ID = "c0000000-0000-4000-8000-000000000001";

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const rpcResults: Record<string, { data?: unknown; error?: unknown }> = {};

function mockClient(options: { roles: readonly string[]; aal?: "aal1" | "aal2" }) {
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: CALLER_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: options.aal ?? "aal2" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      if (fn === "my_roles") {
        return { data: options.roles, error: null };
      }
      const result = rpcResults[fn];
      return { data: result?.data ?? null, error: result?.error ?? null };
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : {})),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/admin/courses/" + COURSE_ID, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-6" },
    body: JSON.stringify(body),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
  rpcCalls = [];
  for (const key of Object.keys(rpcResults)) {
    delete rpcResults[key];
  }
});

describe("PATCH /admin/courses/{id} — ตัดสินสถานะคอร์ส", () => {
  it("SC publish → 200 + args ครบ (p_comment null เมื่อ publish)", async () => {
    mockClient({ roles: [SC] });
    rpcResults["admin_decide_course"] = { data: { courseId: COURSE_ID, status: "published" } };
    const res = await PATCH(patchRequest({ action: "publish" }), ctx(COURSE_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { courseId: string; status: string } };
    expect(body.data.courseId).toBe(COURSE_ID);
    expect(body.data.status).toBe("published");
    const call = rpcCalls.find((c) => c.fn === "admin_decide_course");
    expect(call?.args["p_course_id"]).toBe(COURSE_ID);
    expect(call?.args["p_action"]).toBe("publish");
    expect(call?.args["p_comment"]).toBeNull();
    expect(call?.args["p_request_id"]).toBe("req-e11-6");
  });

  it("SA return พร้อม comment → 200 + p_comment ถูกส่ง", async () => {
    mockClient({ roles: [SA] });
    rpcResults["admin_decide_course"] = { data: { courseId: COURSE_ID, status: "returned" } };
    const res = await PATCH(patchRequest({ action: "return", comment: "โครงสร้างเนื้อหาไม่ครบตามหลักสูตร กรุณาแก้" }), ctx(COURSE_ID));
    expect(res.status).toBe(200);
    const call = rpcCalls.find((c) => c.fn === "admin_decide_course");
    expect(call?.args["p_action"]).toBe("return");
    expect(call?.args["p_comment"]).toBe("โครงสร้างเนื้อหาไม่ครบตามหลักสูตร กรุณาแก้");
  });

  it("SE → 403 (ไม่ถือ course:publish) + ไม่เรียก RPC", async () => {
    mockClient({ roles: [SE] });
    const res = await PATCH(patchRequest({ action: "publish" }), ctx(COURSE_ID));
    expect(res.status).toBe(403);
    expect(rpcCalls.filter((c) => c.fn === "admin_decide_course")).toHaveLength(0);
  });

  it("return ไม่กรอก comment → 400 fields [comment] ก่อนแตะ RPC", async () => {
    mockClient({ roles: [SC] });
    const res = await PATCH(patchRequest({ action: "return" }), ctx(COURSE_ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields: string[] } } };
    expect(body.error.details.fields).toContain("comment");
    expect(rpcCalls.filter((c) => c.fn === "admin_decide_course")).toHaveLength(0);
  });

  it("return comment สั้นเกิน → 400 ก่อนแตะ RPC", async () => {
    mockClient({ roles: [SC] });
    const res = await PATCH(patchRequest({ action: "return", comment: "สั้น" }), ctx(COURSE_ID));
    expect(res.status).toBe(400);
    expect(rpcCalls.filter((c) => c.fn === "admin_decide_course")).toHaveLength(0);
  });

  it("body มีคีย์แปลกปลอม → 400 (strict)", async () => {
    mockClient({ roles: [SC] });
    const res = await PATCH(patchRequest({ action: "publish", extra: 1 }), ctx(COURSE_ID));
    expect(res.status).toBe(400);
  });

  it(":id ผิดรูป → 400 ก่อนแตะ RPC", async () => {
    mockClient({ roles: [SC] });
    const res = await PATCH(patchRequest({ action: "publish" }), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(rpcCalls.filter((c) => c.fn === "admin_decide_course")).toHaveLength(0);
  });

  it("aal1 → 403 ERR-AUTH-004", async () => {
    mockClient({ roles: [SC], aal: "aal1" });
    const res = await PATCH(patchRequest({ action: "publish" }), ctx(COURSE_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it.each([
    ["invalid_transition", "(ERR-VAL-001|invalid_transition)", 400],
    ["comment_required", "(ERR-VAL-001|comment_required)", 400],
    ["course_not_found", "(ERR-NF-001|course_not_found)", 404],
  ])("RPC tag %s → %d (ไม่ leak SQL)", async (_label, message, expected) => {
    mockClient({ roles: [SC] });
    rpcResults["admin_decide_course"] = { error: { message } };
    const res = await PATCH(patchRequest({ action: "publish" }), ctx(COURSE_ID));
    expect(res.status).toBe(expected);
    expect(JSON.stringify(await res.json())).not.toContain("SQLSTATE");
  });

  it("RPC error ไม่มีป้าย → 503 admin_decide_course_failed", async () => {
    mockClient({ roles: [SC] });
    rpcResults["admin_decide_course"] = { error: { message: "SQLSTATE XX000 net fail" } };
    const res = await PATCH(patchRequest({ action: "publish" }), ctx(COURSE_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("admin_decide_course_failed");
  });

  it("drift (status นอก enum) → 503 course_decision_drift", async () => {
    mockClient({ roles: [SC] });
    rpcResults["admin_decide_course"] = { data: { courseId: COURSE_ID, status: "bogus" } };
    const res = await PATCH(patchRequest({ action: "publish" }), ctx(COURSE_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("course_decision_drift");
  });

  it("unpublish → 200 + p_action 'unpublish'", async () => {
    mockClient({ roles: [SC] });
    rpcResults["admin_decide_course"] = { data: { courseId: COURSE_ID, status: "pending_review" } };
    const res = await PATCH(patchRequest({ action: "unpublish" }), ctx(COURSE_ID));
    expect(res.status).toBe(200);
    const call = rpcCalls.find((c) => c.fn === "admin_decide_course");
    expect(call?.args["p_action"]).toBe("unpublish");
    expect(call?.args["p_comment"]).toBeNull();
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    mockClient({ roles: [SC] });
    rpcResults["admin_decide_course"] = { data: { courseId: COURSE_ID, status: "published" } };
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await PATCH(patchRequest({ action: "publish" }), ctx(COURSE_ID));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { details: { group: string } } };
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

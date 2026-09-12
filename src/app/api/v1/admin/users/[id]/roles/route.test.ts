/**
 * route.test — POST/DELETE /api/v1/admin/users/{id}/roles (Wave E Phase 5 · [#90])
 *
 * POST — SR มอบได้เฉพาะ lawyer (D-p5-5 resource-scope ที่ BFF ก่อน RPC) · SA มอบ
 *   instructor/staff:* ได้ · super_admin เป็น role → 400 ที่ zod (ตรงป้าย
 *   ERR-VAL-001|role_not_grantable) · reason 10-500 บังคับ
 * DELETE — body {role, reason} บังคับ (RPC บังคับเหตุผลเสมอ) · 204 เมื่อสำเร็จ ·
 *   แท็ก role_not_manageable/self_revoke/last_role → 400 · role_not_found → 404
 *
 * mock ตามแบบ credit-rules/route.test.ts — audit ROLE_GRANT/ROLE_REVOKE อยู่ใน TX ของ RPC
 * แล้ว จึงไม่มี service-client audit ใน route นี้
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
import { DELETE, POST } from "./route";

const SA = "super_admin";
const SR = "staff:registrar";
const CALLER_ID = "a0000000-0000-4000-8000-000000000001";
const TARGET_ID = "b0000000-0000-4000-8000-000000000001";

/** ตัวติดตามเรียก rpc — ตรวจ args ของ grant/revoke */
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

/** ผล rpc ที่ตั้งได้ราย function */
const rpcResults: Record<string, { data?: unknown; error?: unknown }> = {};

/** client ครบชั้น RBAC — my_roles + admin_grant_role/admin_revoke_role */
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

/** POST request ไปยัง :id พร้อม body */
function postRequest(body: unknown, targetId: string = TARGET_ID): Request {
  return new Request("http://localhost:3000/api/v1/admin/users/" + targetId + "/roles", {
    method: "POST",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-3" },
    body: JSON.stringify(body),
  });
}

/** DELETE request ไปยัง :id — body {role, reason} บังคับตาม RPC */
function deleteRequest(body: unknown, targetId: string = TARGET_ID): Request {
  return new Request("http://localhost:3000/api/v1/admin/users/" + targetId + "/roles", {
    method: "DELETE",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-3" },
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

describe("POST /admin/users/{id}/roles — มอบบทบาท", () => {
  it("reason สั้นเกิน → 400 + ไม่เรียก RPC", async () => {
    mockClient({ roles: [SR] });
    const res = await POST(postRequest({ role: "lawyer", reason: "สั้น" }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    expect(rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(0);
  });

  it("SR มอบ lawyer → 201 + args ครบ", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_grant_role"] = { data: { userId: TARGET_ID, role: "lawyer", granted: true } };
    const res = await POST(postRequest({ role: "lawyer", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["userId"]).toBe(TARGET_ID);
    expect(body.data["role"]).toBe("lawyer");
    expect(body.data["granted"]).toBe(true);
    const grantCall = rpcCalls.find((c) => c.fn === "admin_grant_role");
    expect(grantCall?.args["p_user_id"]).toBe(TARGET_ID);
    expect(grantCall?.args["p_role"]).toBe("lawyer");
    expect(grantCall?.args["p_reason"]).toBe("ยืนยันใบอนุญาตทนายความ เรียบร้อย");
    expect(grantCall?.args["p_request_id"]).toBe("req-e11-3");
  });

  it("SR มอบ instructor → 403 ที่ BFF ก่อนถึง RPC (D-p5-5 resource-scope)", async () => {
    mockClient({ roles: [SR] });
    const res = await POST(postRequest({ role: "instructor", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { permission: string } } };
    expect(body.error.details.permission).toBe("role:grant");
    expect(rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(0);
  });

  it("SA มอบ instructor → 201 (SA ไม่ถูกจำกัด scope lawyer)", async () => {
    mockClient({ roles: [SA] });
    rpcResults["admin_grant_role"] = { data: { userId: TARGET_ID, role: "instructor", granted: true } };
    const res = await POST(postRequest({ role: "instructor", reason: "แต่งตั้งผู้สอนหลักสูตร ภาคี" }), ctx(TARGET_ID));
    expect(res.status).toBe(201);
    const grantCall = rpcCalls.find((c) => c.fn === "admin_grant_role");
    expect(grantCall?.args["p_role"]).toBe("instructor");
  });

  it("role เป็น super_admin → 400 ERR-VAL-001 ที่ zod + ไม่เรียก RPC (ตรงป้าย role_not_grantable)", async () => {
    mockClient({ roles: [SA] });
    const res = await POST(postRequest({ role: "super_admin", reason: "แต่งตั้งผู้ดูแลระบบ สูงสุด" }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(0);
  });

  it("role นอก scope (staff:exam โดย SR — zod ผ่าน แต่ resource-scope 403) + ไม่เรียก RPC", async () => {
    mockClient({ roles: [SR] });
    const res = await POST(postRequest({ role: "staff:exam", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { permission: string } } };
    expect(body.error.details.permission).toBe("role:grant");
    expect(rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(0);
  });

  it("role นอกชุดจริง (ไม่มีใน enum) → 400 + ไม่เรียก RPC", async () => {
    mockClient({ roles: [SR] });
    const res = await POST(postRequest({ role: "citizen", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    expect(rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(0);
  });

  it("RPC ป้าย (ERR-VAL-001|no_verified_license) → 400 (ไม่ leak SQL)", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_grant_role"] = {
      error: { message: "...(ERR-VAL-001|no_verified_license)" },
    };
    const res = await POST(postRequest({ role: "lawyer", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("no_verified_license");
  });

  it("RPC ป้าย (ERR-NF-001|user_not_found) → 404", async () => {
    mockClient({ roles: [SA] });
    rpcResults["admin_grant_role"] = {
      error: { message: "...(ERR-NF-001|user_not_found)" },
    };
    const res = await POST(postRequest({ role: "lawyer", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(404);
  });

  it("RPC error ไม่มีป้าย → 503 ERR-SYS-002 (ไม่ leak SQL)", async () => {
    mockClient({ roles: [SA] });
    rpcResults["admin_grant_role"] = {
      error: { message: "SQLSTATE 23514 check constraint detail xyz" },
    };
    const res = await POST(postRequest({ role: "lawyer", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("admin_grant_role_failed");
    expect(JSON.stringify(body)).not.toContain("SQLSTATE");
  });

  it("drift (userId ไม่ใช่ uuid) → 503 admin_grant_role_row_drift", async () => {
    mockClient({ roles: [SA] });
    rpcResults["admin_grant_role"] = { data: { userId: "nope", role: "lawyer", granted: true } };
    const res = await POST(postRequest({ role: "lawyer", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("admin_grant_role_row_drift");
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    mockClient({ roles: [SA] });
    rpcResults["admin_grant_role"] = { data: { userId: TARGET_ID, role: "lawyer", granted: true } };
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await POST(postRequest({ role: "lawyer", reason: "ยืนยันใบอนุญาตทนายความ เรียบร้อย" }), ctx(TARGET_ID));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { details: { group: string } } };
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

describe("DELETE /admin/users/{id}/roles — ถอนบทบาท", () => {
  it("SR ถอน lawyer → 204", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_revoke_role"] = { data: { userId: TARGET_ID, role: "lawyer", revoked: true } };
    const res = await DELETE(deleteRequest({ role: "lawyer", reason: "พ้นสภาพความเป็นทนาย แล้ว" }), ctx(TARGET_ID));
    expect(res.status).toBe(204);
    const revokeCall = rpcCalls.find((c) => c.fn === "admin_revoke_role");
    expect(revokeCall?.args["p_role"]).toBe("lawyer");
    expect(revokeCall?.args["p_reason"]).toBe("พ้นสภาพความเป็นทนาย แล้ว");
  });

  it("SR ถอน instructor → 403 ที่ BFF ก่อนถึง RPC", async () => {
    mockClient({ roles: [SR] });
    const res = await DELETE(deleteRequest({ role: "instructor", reason: "พ้นสภาพความเป็นทนาย แล้ว" }), ctx(TARGET_ID));
    expect(res.status).toBe(403);
    expect(rpcCalls.filter((c) => c.fn === "admin_revoke_role")).toHaveLength(0);
  });

  it("DELETE ไม่ส่ง body → 400 (RPC บังคับ role+reason เสมอ — ไม่รับ ?role= ไม่มีเหตุผล)", async () => {
    mockClient({ roles: [SA] });
    const res = await DELETE(new Request("http://localhost:3000/api/v1/admin/users/" + TARGET_ID + "/roles", {
      method: "DELETE",
      headers: { "x-request-id": "req-e11-3" },
    }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    expect(rpcCalls.filter((c) => c.fn === "admin_revoke_role")).toHaveLength(0);
  });

  it.each([
    ["role_not_manageable (super_admin)", "(ERR-VAL-001|role_not_manageable)", 400],
    ["self_revoke (ถอนตัวเอง)", "(ERR-VAL-001|self_revoke)", 400],
    ["last_role (บทบาทสุดท้าย)", "(ERR-VAL-001|last_role)", 400],
    ["role_not_found", "(ERR-NF-001|role_not_found)", 404],
  ])("RPC ป้าย %s → %d", async (_label, message, expected) => {
    mockClient({ roles: [SA] });
    rpcResults["admin_revoke_role"] = { error: { message } };
    const res = await DELETE(deleteRequest({ role: "lawyer", reason: "พ้นสภาพความเป็นทนาย แล้ว" }), ctx(TARGET_ID));
    expect(res.status).toBe(expected);
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001 (DELETE)", async () => {
    mockClient({ roles: [SA] });
    rpcResults["admin_revoke_role"] = { data: { userId: "b0000000-0000-4000-8000-000000000003", role: "lawyer", revoked: true } };
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await DELETE(deleteRequest({ role: "lawyer", reason: "พ้นสภาพความเป็นทนาย แล้ว" }), ctx(TARGET_ID));
    }
    expect(last?.status).toBe(429);
  });
});
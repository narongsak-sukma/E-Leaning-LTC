/**
 * route.test — PATCH /api/v1/admin/credit-rules/{id} (Wave E Phase 3 · Credit Bank)
 *
 * RBAC credit_rule:update (sr/sa) · body strict { status: active|retired } เท่านั้น ·
 * :id uuid ตรวจก่อนแตะ DB · เขียนผ่าน RPC atomic admin_update_credit_rule_status (0032)
 * ด้วย user-JWT client เท่านั้น (guard + transition + audit อยู่ใน TX เดียวของ RPC) ·
 * error มีป้าย "(ERR-XXX-NNN|tag)" → map ตามทะเบียน · ไม่มีป้าย = 503 opaque ·
 * แถว jsonb ขาเข้า drift → 503 fail-closed · rate STAFF_WRITE
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
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { PATCH } from "./route";

const SV = "staff:viewer";
const SR = "staff:registrar";
const SA = "super_admin";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const RULE_ID = "c1000000-0000-4000-8000-000000000001";

/** แถว jsonb ที่ RPC คืน — snake_case 15 คอลัมน์ (0006 ผ่าน RPC 0032) */
function ruleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RULE_ID,
    code: "CR-LTC-001",
    name: "สอบผ่านหลักสูตรทั่วไป",
    course_id: null,
    credit_type: "general",
    credits: 3,
    valid_days: null,
    carry_over: false,
    required_credits_per_cycle: 12,
    priority: 100,
    renewal_cycle: null,
    effective_from: "2026-09-01T00:00:00+00:00",
    effective_to: null,
    status: "active",
    created_at: "2026-08-01T00:00:00+00:00",
    ...overrides,
  };
}

interface RpcCallRecord {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

/**
 * mock PATCH — route ไม่แตะ from() ใด ๆ นอกจาก profiles (requirePermission) ·
 * rpc แยกตามชื่อ: my_roles (RBAC) / admin_update_credit_rule_status (mutation)
 */
function mockPatch(options: {
  roles?: readonly string[] | undefined;
  rpcResult?: { data?: unknown; error?: unknown } | null;
  aal?: "aal1" | "aal2";
}): { readonly rpcCalls: readonly RpcCallRecord[] } {
  const roles = options.roles ?? [SR];
  const rpcCalls: RpcCallRecord[] = [];
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: STAFF_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: options.aal ?? "aal2" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ fn, args: args ?? {} });
      if (fn === "my_roles") {
        return { data: roles, error: null };
      }
      if (fn === "admin_update_credit_rule_status") {
        if (options.rpcResult == null) {
          return { data: ruleRow(), error: null };
        }
        return {
          data: options.rpcResult.data ?? null,
          error: options.rpcResult.error ?? null,
        };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : {})),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { rpcCalls };
}

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost:3000/api/v1/admin/credit-rules/${RULE_ID}`, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.5.0.2", "x-request-id": "req-e11-2" },
    body: JSON.stringify(body),
  });
}

/** เรียก PATCH กับ :id ที่ต่างจากของ patchRequest (เช่น uuid ผิดรูป) */
async function patchWithId(id: string, body: unknown): Promise<Response> {
  return PATCH(new Request(`http://localhost:3000/api/v1/admin/credit-rules/${id}`, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.5.0.2", "x-request-id": "req-e11-2" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) } as never);
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("PATCH /admin/credit-rules/{id} — สิทธิ์ + รูปแบบ", () => {
  it("registrar active → 200 + resource + RPC args ครบ 3 (ไม่มีฟิลด์อื่น) + ไม่ใช้ service_role", async () => {
    const { rpcCalls } = mockPatch({ roles: [SR] });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["id"]).toBe(RULE_ID);
    expect(body.data["status"]).toBe("active");
    expect(body.data["credits"]).toBe(3);
    expect(body.data["code"]).toBe("CR-LTC-001");
    const updateCall = rpcCalls.find((call) => call.fn === "admin_update_credit_rule_status");
    expect(updateCall).toBeDefined();
    expect(updateCall?.args["p_rule_id"]).toBe(RULE_ID);
    expect(updateCall?.args["p_status"]).toBe("active");
    expect(updateCall?.args["p_request_id"]).toBe("req-e11-2");
    expect(Object.keys(updateCall?.args ?? {}).sort()).toEqual([
      "p_request_id",
      "p_rule_id",
      "p_status",
    ]);
    // RPC เดินด้วย user-JWT เท่านั้น — service client ห้ามถูกแตะ (audit อยู่ใน TX ของ RPC)
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("super_admin → 200", async () => {
    mockPatch({ roles: [SA] });
    const res = await PATCH(patchRequest({ status: "retired" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(200);
  });

  it("viewer ไม่ถือ credit_rule:update → 403 ERR-RBAC-001 + ไม่เรียก RPC mutation", async () => {
    const { rpcCalls } = mockPatch({ roles: [SV] });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(rpcCalls.some((call) => call.fn === "admin_update_credit_rule_status")).toBe(false);
  });

  it("registrar MFA aal1 → 403 ERR-AUTH-004 + ไม่เรียก RPC mutation", async () => {
    const { rpcCalls } = mockPatch({ roles: [SR], aal: "aal1" });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(rpcCalls.some((call) => call.fn === "admin_update_credit_rule_status")).toBe(false);
  });

  it(":id ผิดรูป uuid → 400 ERR-VAL-001 field id + ไม่เรียก RPC mutation", async () => {
    const { rpcCalls } = mockPatch({ roles: [SR] });
    const res = await patchWithId("not-a-uuid", { status: "active" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { field: string } } };
    expect(body.error.details.field).toBe("id");
    expect(rpcCalls.some((call) => call.fn === "admin_update_credit_rule_status")).toBe(false);
  });

  it.each([
    ["ว่าง ({})", {}],
    ["มี key แปลกปลอม", { status: "active", name: "แก้ชื่อห้าม" }],
    ["status 'draft' (PATCH lifecycle ยอม active|retired เท่านั้น)", { status: "draft" }],
    ["status ไม่ใช่ string", { status: 1 }],
  ])("body ผิด (%s) → 400 ERR-VAL-001 + ไม่เรียก RPC mutation", async (_label, body) => {
    const { rpcCalls } = mockPatch({ roles: [SR] });
    const res = await PATCH(patchRequest(body), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("ERR-VAL-001");
    expect(rpcCalls.some((call) => call.fn === "admin_update_credit_rule_status")).toBe(false);
  });
});

describe("PATCH /admin/credit-rules/{id} — RPC error mapping + drift", () => {
  it("RPC ป้าย (ERR-NF-001|rule_not_found) → 404", async () => {
    mockPatch({
      roles: [SR],
      rpcResult: { data: null, error: { code: "P0001", message: "ไม่พบกฎ (ERR-NF-001|rule_not_found)" } },
    });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.details.reason).toBe("rule_not_found");
  });

  it.each([
    [
      "invalid_transition",
      "draft→retired ห้าม (ERR-VAL-001|invalid_transition)",
      "invalid_transition",
    ],
    [
      "status_value",
      "สถานะไม่ถูกต้อง (ERR-VAL-001|status_value)",
      "status_value",
    ],
  ])("RPC ป้าย %s → 400 ERR-VAL-001 reason ตรง tag", async (_label, message, reason) => {
    mockPatch({ roles: [SR], rpcResult: { data: null, error: { code: "P0001", message } } });
    const res = await PATCH(patchRequest({ status: "retired" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.reason).toBe(reason);
  });

  it("RPC ป้าย (ERR-AUTH-004|mfa_required) → 403 ERR-AUTH-004", async () => {
    mockPatch({
      roles: [SR],
      rpcResult: { data: null, error: { code: "P0001", message: "ต้องยืนยัน aal2 (ERR-AUTH-004|mfa_required)" } },
    });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(body.error.details.reason).toBe("mfa_required");
  });

  it("RPC ป้าย (ERR-RBAC-001|credit_rule_forbidden) → 403", async () => {
    mockPatch({
      roles: [SR],
      rpcResult: { data: null, error: { code: "P0001", message: "ห้าม (ERR-RBAC-001|credit_rule_forbidden)" } },
    });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details.reason).toBe("credit_rule_forbidden");
  });

  it("RPC error ไม่มีป้าย (SQL ดิบ) → 503 ERR-SYS-002 opaque credit_rule_update_failed", async () => {
    mockPatch({
      roles: [SR],
      rpcResult: {
        data: null,
        error: { code: "XX000", message: "SQLSTATE XX000 internal detail ห้ามออก client" },
      },
    });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string }; message: string };
    };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_rule_update_failed");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("RPC ป้ายแต่ code นอกทะเบียน (ERR-FOO-999) → 503 fallback", async () => {
    mockPatch({
      roles: [SR],
      rpcResult: { data: null, error: { code: "P0001", message: "ล้ม (ERR-FOO-999|weird)" } },
    });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_rule_update_failed");
  });

  it("แถว jsonb drift (credits ผิดชนิด) → 503 credit_rule_updated_drift", async () => {
    mockPatch({
      roles: [SR],
      rpcResult: { data: ruleRow({ credits: "3" }), error: null },
    });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("credit_rule_updated_drift");
  });

  it("RPC คืน data null (ไม่มีแถว) → 503 credit_rule_updated_drift", async () => {
    mockPatch({ roles: [SR], rpcResult: { data: null, error: null } });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("credit_rule_updated_drift");
  });

  it("PostgREST wrap array [row] หลักเดียว → 200 ปกติ", async () => {
    mockPatch({ roles: [SR], rpcResult: { data: [ruleRow()], error: null } });
    const res = await PATCH(patchRequest({ status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(RULE_ID);
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001 group STAFF_WRITE", async () => {
    mockPatch({});
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await PATCH(patchRequest({ status: "active" }), {
        params: Promise.resolve({ id: RULE_ID }),
      } as never);
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

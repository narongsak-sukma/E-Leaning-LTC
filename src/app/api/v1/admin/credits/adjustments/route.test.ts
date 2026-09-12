/**
 * route.test — POST /api/v1/admin/credits/adjustments (Wave E Phase 3 · Credit Bank)
 *
 * RBAC credit_adjustment:create (sr/sa) · body strict (amount ≠0 · ±9999.99 · ทศนิยม ≤2 ·
 * reason 10-500) · เรียก RPC admin_credit_adjust ด้วย user-JWT client เท่านั้น (D68 C-9 —
 * ห้าม service_role · RPC ตรวจสิทธิ์ + audit CREDIT_ADJUST ใน TX เดียวเอง) ·
 * error มีป้าย "(ERR-XXX-NNN|reason)" → map ตามทะเบียน · ไม่มีป้าย → 503 opaque ·
 * แถว jsonb ขาเข้า strict (drift → 503) · ขาออก parse ก่อน 201
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
import { POST } from "./route";

const SV = "staff:viewer";
const SR = "staff:registrar";
const SA = "super_admin";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const USER_ID = "b0000000-0000-4000-8000-000000000002";
const CYCLE_ID = "e0000000-0000-4000-8000-000000000003";
const ADJ_ID = "d0000000-0000-4000-8000-000000000004";

/** body ที่ถูกต้อง (ผ่าน zod ขาเข้า BFF) */
function adjustBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: USER_ID,
    cycleId: CYCLE_ID,
    creditType: "general",
    amount: 2.5,
    reason: "ปรับเพิ่มเครดิตค้างจากระบบเดิม",
    ...overrides,
  };
}

/** แถว jsonb ที่ RPC คืน — snake_case 7 คีย์ (0031 §6) */
function adjustmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ADJ_ID,
    user_id: USER_ID,
    renewal_cycle_id: CYCLE_ID,
    credit_type: "general",
    amount: 2.5,
    reason: "ปรับเพิ่มเครดิตค้างจากระบบเดิม",
    created_at: "2026-09-01T10:00:00+00:00",
    ...overrides,
  };
}

interface RpcCallRecord {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

/**
 * mock POST adjustments — route ไม่แตะ from() ใด ๆ (profiles ของ requirePermission ต้องมี)
 * · rpc แยกตามชื่อฟังก์ชัน: my_roles (RBAC) / admin_credit_adjust (mutation)
 */
function mockAdjust(options: {
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
      if (fn === "admin_credit_adjust") {
        return options.rpcResult ?? { data: adjustmentRow(), error: null };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : {})),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { rpcCalls };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/admin/credits/adjustments", {
    method: "POST",
    headers: { "x-forwarded-for": "10.6.0.1", "x-request-id": "req-e11-3" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("POST /admin/credits/adjustments — สิทธิ์ + รูปแบบ", () => {
  it("registrar ปรับ credit → 201 + resource camelCase + RPC args ครบ 6 + ไม่ใช้ service_role (D68 C-9)", async () => {
    const { rpcCalls } = mockAdjust({});
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["id"]).toBe(ADJ_ID);
    expect(body.data["userId"]).toBe(USER_ID);
    expect(body.data["renewalCycleId"]).toBe(CYCLE_ID);
    expect(body.data["amount"]).toBe(2.5);
    const adjustCall = rpcCalls.find((call) => call.fn === "admin_credit_adjust");
    expect(adjustCall).toBeDefined();
    expect(adjustCall?.args["p_user_id"]).toBe(USER_ID);
    expect(adjustCall?.args["p_cycle_id"]).toBe(CYCLE_ID);
    expect(adjustCall?.args["p_credit_type"]).toBe("general");
    expect(adjustCall?.args["p_amount"]).toBe(2.5);
    expect(adjustCall?.args["p_reason"]).toBe("ปรับเพิ่มเครดิตค้างจากระบบเดิม");
    expect(adjustCall?.args["p_request_id"]).toBe("req-e11-3");
    // D68 C-9 — RPC ต้องเดินด้วย user-JWT เท่านั้น service client ห้ามถูกแตะ
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("super_admin → 201", async () => {
    mockAdjust({ roles: [SA] });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(201);
  });

  it("viewer ไม่ถือ credit_adjustment:create → 403 ERR-RBAC-001 + ไม่เรียก RPC mutation", async () => {
    const { rpcCalls } = mockAdjust({ roles: [SV] });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(rpcCalls.some((call) => call.fn === "admin_credit_adjust")).toBe(false);
  });

  it("registrar MFA aal1 → 403 ERR-AUTH-004 + ไม่เรียก RPC mutation", async () => {
    const { rpcCalls } = mockAdjust({ roles: [SR], aal: "aal1" });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(rpcCalls.some((call) => call.fn === "admin_credit_adjust")).toBe(false);
  });

  it.each([
    ["amount เป็น 0", adjustBody({ amount: 0 })],
    ["amount เกินเพดาน ±9999.99", adjustBody({ amount: 10000 })],
    ["amount ทศนิยมเกิน 2 ตำแหน่ง", adjustBody({ amount: 1.234 })],
    ["reason สั้นเกิน 10", adjustBody({ reason: "สั้น" })],
    ["creditType ตัวใหญ่", adjustBody({ creditType: "General" })],
    ["userId ไม่ใช่ uuid", adjustBody({ userId: "abc" })],
    ["มีคีย์แปลกปลอม", { ...adjustBody(), status: "active" }],
  ])("body ผิด (%s) → 400 ERR-VAL-001 + ไม่เรียก RPC mutation", async (_label, body) => {
    const { rpcCalls } = mockAdjust({ roles: [SR] });
    const res = await POST(postRequest(body));
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("ERR-VAL-001");
    expect(rpcCalls.some((call) => call.fn === "admin_credit_adjust")).toBe(false);
  });
});

describe("POST /admin/credits/adjustments — RPC error mapping + drift", () => {
  it("RPC error มีป้าย (ERR-CRD-002|reason_required) → 422 + ข้อความไทยจากทะเบียน", async () => {
    mockAdjust({
      roles: [SR],
      rpcResult: {
        data: null,
        error: { code: "P0001", message: "เหตุผลบังคับ (ERR-CRD-002|reason_required)" },
      },
    });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-CRD-002");
    expect(body.error.details.reason).toBe("reason_required");
  });

  it("RPC error ไม่มีป้าย (SQL ดิบ) → 503 ERR-SYS-002 opaque admin_credit_adjust_failed", async () => {
    mockAdjust({
      roles: [SR],
      rpcResult: {
        data: null,
        error: { code: "XX000", message: "SQLSTATE XX000 internal detail ห้ามออก client" },
      },
    });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string }; message: string };
    };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("admin_credit_adjust_failed");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("RPC error มีป้ายแต่ code นอกทะเบียน → 503 ERR-SYS-002 (fallback)", async () => {
    mockAdjust({
      roles: [SR],
      rpcResult: {
        data: null,
        error: { code: "P0001", message: "ล้ม (ERR-FOO-999|weird)" },
      },
    });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("admin_credit_adjust_failed");
  });

  it("แถว jsonb drift (amount ผิดชนิด) → 503 adjustment_row_drift", async () => {
    mockAdjust({
      roles: [SR],
      rpcResult: { data: adjustmentRow({ amount: "2.5" }), error: null },
    });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("adjustment_row_drift");
  });

  it("PostgREST wrap array [row] หลักเดียว → 201 ปกติ", async () => {
    mockAdjust({
      roles: [SR],
      rpcResult: { data: [adjustmentRow()], error: null },
    });
    const res = await POST(postRequest(adjustBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(ADJ_ID);
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001 group STAFF_WRITE", async () => {
    mockAdjust({});
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await POST(postRequest(adjustBody()));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

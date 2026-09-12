/**
 * route.test — GET /api/v1/admin/dashboard (Wave E Phase 5 · [#90])
 *
 * - report:view (sv/se/sr/sa — staff:content ไม่ถือ report:view จึงโดนตัดที่ BFF ตรง
 *   ชุด has_any_role ของ RPC 0036 §7) · aal1 → 403 · rate STAFF_WRITE
 * - query strict (from/to ISO date optional) · from > to → 400 ก่อนแตะ RPC
 * - RPC admin_dashboard_stats → jsonb camelCase · drift → 503 admin_dashboard_stats_drift
 *   · PostgREST wrap [obj] → unwrap · tag date_range → 400
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
import { GET } from "./route";

const SV = "staff:viewer";
const SE = "staff:exam";
const SR = "staff:registrar";
const SA = "super_admin";
const SC = "staff:content";
const CALLER_ID = "a0000000-0000-4000-8000-000000000001";

/** jsonb ตรง contract ของ admin_dashboard_stats (0036 §7) */
function statsJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    range: { from: "2026-08-14", to: "2026-09-12" },
    users: { new: 12, total: 345 },
    enrollments: { new: 40 },
    exams: { attempts: 25, passed: 19, passRatePct: 76.0 },
    certificates: { issued: 8 },
    credits: { issued: 30.5 },
    ...overrides,
  };
}

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const rpcResults: Record<string, { data?: unknown; error?: unknown }> = {};

/** client ครบชั้น RBAC — my_roles + admin_dashboard_stats */
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

function adminUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/dashboard" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-4" },
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
  rpcCalls = [];
  for (const key of Object.keys(rpcResults)) {
    delete rpcResults[key];
  }
});

describe("GET /admin/dashboard — สิทธิ์ + query + RPC", () => {
  it.each([[[SV]], [[SE]], [[SR]], [[SA]]])("บทบาท %j ถือ report:view → 200", async (roles) => {
    mockClient({ roles });
    rpcResults["admin_dashboard_stats"] = { data: statsJson() };
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { range: { from: string } } };
    expect(body.data.range.from).toBe("2026-08-14");
  });

  it("staff:content → 403 (ไม่ถือ report:view — ตรงชุด RPC ที่ไม่รวม staff:content)", async () => {
    mockClient({ roles: [SC] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("aal1 → 403 ERR-AUTH-004", async () => {
    mockClient({ roles: [SV], aal: "aal1" });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("ไม่ส่ง from/to → RPC รับ null ทั้งคู่ (RPC ใช้ default 30 วันเอง)", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_dashboard_stats"] = { data: statsJson() };
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const call = rpcCalls.find((c) => c.fn === "admin_dashboard_stats");
    expect(call?.args["p_from"]).toBeNull();
    expect(call?.args["p_to"]).toBeNull();
  });

  it("ส่ง from/to → ผ่านไปให้ RPC ตรงตัว", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_dashboard_stats"] = { data: statsJson() };
    const res = await GET(adminUrl("?from=2026-08-01&to=2026-08-31"));
    expect(res.status).toBe(200);
    const call = rpcCalls.find((c) => c.fn === "admin_dashboard_stats");
    expect(call?.args["p_from"]).toBe("2026-08-01");
    expect(call?.args["p_to"]).toBe("2026-08-31");
  });

  it("from > to → 400 ERR-VAL-001 ก่อนแตะ RPC", async () => {
    mockClient({ roles: [SR] });
    const res = await GET(adminUrl("?from=2026-09-01&to=2026-08-01"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(rpcCalls.filter((c) => c.fn === "admin_dashboard_stats")).toHaveLength(0);
  });

  it.each([
    "?from=01-09-2026",
    "?to=not-a-date",
    "?foo=bar",
  ])("query %s ผิดรูป → 400 ERR-VAL-001", async (query) => {
    mockClient({ roles: [SR] });
    const res = await GET(adminUrl(query));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("RPC tag date_range → 400", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_dashboard_stats"] = {
      error: { message: "...(ERR-VAL-001|date_range)" },
    };
    // ช่วงวันผ่าน BFF (from ≤ to) — ป้ายจำลองมาจากชั้น RPC เป็นชั้นที่สอง
    const res = await GET(adminUrl("?from=2026-08-01&to=2026-09-01"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("date_range");
  });

  it("RPC error ไม่มีป้าย → 503 (ไม่ leak SQL)", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_dashboard_stats"] = { error: { message: "SQLSTATE XX000 connection lost" } };
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("admin_dashboard_stats_failed");
    expect(JSON.stringify(body)).not.toContain("SQLSTATE");
  });

  it("drift (passRatePct ผิดชนิด) → 503 admin_dashboard_stats_drift", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_dashboard_stats"] = {
      data: statsJson({ exams: { attempts: 25, passed: "19", passRatePct: 76 } }),
    };
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("admin_dashboard_stats_drift");
  });

  it("PostgREST wrap scalar jsonb เป็น [obj เดียว] → unwrap แล้ว 200", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_dashboard_stats"] = { data: [statsJson()] };
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { users: { total: number } } };
    expect(body.data.users.total).toBe(345);
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    mockClient({ roles: [SR] });
    rpcResults["admin_dashboard_stats"] = { data: statsJson() };
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await GET(adminUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { details: { group: string } } };
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});
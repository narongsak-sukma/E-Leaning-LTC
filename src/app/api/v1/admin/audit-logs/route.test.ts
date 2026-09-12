/**
 * route.test — GET /api/v1/admin/audit-logs (Wave E Phase 5 · [#90])
 *
 * - BFF role-scope ก่อน RPC: staff:viewer + super_admin เท่านั้น (audit_log:view ถือกว้าง —
 *   citizen/lawyer/SE/SR/SC ผ่าน requirePermission ได้ แต่โดนตัดที่ BFF ตรง guard RPC 0036 §8)
 * - query strict camelCase (action/actor/entityType/entityId/from/to/cursor/limit) ·
 *   keyset (occurred_at,id) · audit AUDIT_READ fail-closed หลังอ่าน (ล้ม 2 ครั้ง → 503)
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
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { GET } from "./route";

const SV = "staff:viewer";
const SA = "super_admin";
const LAWYER = "lawyer";
const SR = "staff:registrar";
const CALLER_ID = "a0000000-0000-4000-8000-000000000001";
const ROW_ID = "d0000000-0000-4000-8000-000000000001";
const T1 = "2026-08-01T00:00:00+00:00";
const T2 = "2026-09-01T00:00:00+00:00";

/** แถว audit จาก RPC (snake_case ตรง 0036 §8) */
function auditRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    occurred_at: T1,
    actor_user_id: CALLER_ID,
    actor_roles: ["staff:viewer"],
    action: "ROLE_GRANT",
    entity_type: "user",
    entity_id: "b0000000-0000-4000-8000-000000000002",
    context: { filters: {}, row_count: 3 },
    request_id: "req-xyz",
    ...overrides,
  };
}

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const rpcResults: Record<string, { data?: unknown; error?: unknown }> = {};

/** client ครบชั้น — my_roles + admin_list_audit_logs + append_audit_event (user-JWT) */
function mockClient(options: {
  roles: readonly string[];
  aal?: "aal1" | "aal2";
  auditReadError?: unknown;
}) {
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
      if (fn === "append_audit_event") {
        return { error: options.auditReadError ?? null };
      }
      const result = rpcResults[fn];
      return { data: result?.data ?? null, error: result?.error ?? null };
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : {})),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
}

function adminUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/audit-logs" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-5" },
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

describe("GET /admin/audit-logs — role-scope + query + AUDIT_READ", () => {
  it.each([[[SV]], [[SA]]])("บทบาท %j → 200 (staff:viewer/super_admin เท่านั้น)", async (roles) => {
    mockClient({ roles });
    rpcResults["admin_list_audit_logs"] = {
      data: { data: [auditRow()], nextCursor: null },
    };
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean } };
    expect(body.data).toHaveLength(1);
    expect(body.page.hasMore).toBe(false);
    // audit AUDIT_READ เขียนผ่าน user-JWT client หลังอ่านสำเร็จ
    const auditCall = rpcCalls.find((c) => c.fn === "append_audit_event");
    expect(auditCall?.args["p_action"]).toBe("AUDIT_READ");
    expect(auditCall?.args["p_entity_type"]).toBe("audit_log");
  });

  it("filters → context ของ AUDIT_READ เก็บเฉพาะคีย์ที่มีจริง (snake allowlist) + row_count", async () => {
    mockClient({ roles: [SV] });
    rpcResults["admin_list_audit_logs"] = {
      data: { data: [auditRow()], nextCursor: null },
    };
    const res = await GET(adminUrl("?action=ROLE_&from=" + encodeURIComponent(T1)));
    expect(res.status).toBe(200);
    const auditCall = rpcCalls.find((c) => c.fn === "append_audit_event");
    const context = auditCall?.args["p_context"] as Record<string, unknown>;
    expect(context["filters"]).toEqual({ action: "ROLE_", occurred_from: T1 });
    expect(context["row_count"]).toBe(1);
  });

  it("citizen/lawyer ผ่าน requirePermission ได้ แต่โดน role-scope 403 ที่ BFF ก่อน RPC", async () => {
    mockClient({ roles: [LAWYER] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { permission: string } } };
    expect(body.error.details.permission).toBe("audit_log:view");
    expect(rpcCalls.filter((c) => c.fn === "admin_list_audit_logs")).toHaveLength(0);
  });

  it("SR → 403 ที่ BFF (guard RPC รับเฉพาะ sv/sa — BFF ตัดก่อน)", async () => {
    mockClient({ roles: [SR] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    expect(rpcCalls.filter((c) => c.fn === "admin_list_audit_logs")).toHaveLength(0);
  });

  it("aal1 → 403 ERR-AUTH-004", async () => {
    mockClient({ roles: [SV], aal: "aal1" });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("filters ขาออกไป RPC ครบ p_* (action/actor/entityType/entityId/from/to)", async () => {
    mockClient({ roles: [SV] });
    rpcResults["admin_list_audit_logs"] = {
      data: { data: [], nextCursor: null },
    };
    const q =
      "?action=ROLE_" +
      "&actor=" + CALLER_ID +
      "&entityType=user" +
      "&entityId=" + "b0000000-0000-4000-8000-000000000002" +
      "&from=" + encodeURIComponent(T1) +
      "&to=" + encodeURIComponent(T2);
    const res = await GET(adminUrl(q));
    expect(res.status).toBe(200);
    const call = rpcCalls.find((c) => c.fn === "admin_list_audit_logs");
    expect(call?.args["p_action"]).toBe("ROLE_");
    expect(call?.args["p_actor"]).toBe(CALLER_ID);
    expect(call?.args["p_entity_type"]).toBe("user");
    expect(call?.args["p_entity_id"]).toBe("b0000000-0000-4000-8000-000000000002");
    expect(call?.args["p_from"]).toBe(T1);
    expect(call?.args["p_to"]).toBe(T2);
  });

  it("cursor ขาเข้า → p_cursor_occurred_at/p_cursor_id · nextCursor ขาออก → เซ็น (occurredAt,id)", async () => {
    mockClient({ roles: [SV] });
    rpcResults["admin_list_audit_logs"] = {
      data: {
        data: [auditRow()],
        nextCursor: { occurredAt: T2, id: "d0000000-0000-4000-8000-000000000002" },
      },
    };
    const cursor = encodeCursor({ sortKey: T1, id: ROW_ID });
    const res = await GET(adminUrl("?cursor=" + encodeURIComponent(cursor)));
    expect(res.status).toBe(200);
    const call = rpcCalls.find((c) => c.fn === "admin_list_audit_logs");
    expect(call?.args["p_cursor_occurred_at"]).toBe(T1);
    expect(call?.args["p_cursor_id"]).toBe(ROW_ID);
    const body = (await res.json()) as { page: { nextCursor: string | null } };
    expect(decodeCursor(String(body.page.nextCursor))).toEqual({
      sortKey: T2,
      id: "d0000000-0000-4000-8000-000000000002",
    });
  });

  it.each([
    "?action=ROLE!BAD",
    "?actor=not-a-uuid",
    "?entityType=user!x",
    "?entityId=zzz",
    "?from=yesterday",
    "?limit=0",
    "?foo=bar",
  ])("query %s ผิดรูป → 400 ERR-VAL-001", async (query) => {
    mockClient({ roles: [SV] });
    const res = await GET(adminUrl(query));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("แถว drift (occurredAt ผิดชนิด) → 503 audit_log_row_drift", async () => {
    mockClient({ roles: [SV] });
    rpcResults["admin_list_audit_logs"] = {
      data: { data: [auditRow({ occurred_at: 12345 })], nextCursor: null },
    };
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("audit_log_row_drift");
  });

  it("RPC error ไม่มีป้าย → 503 (ไม่ leak SQL)", async () => {
    mockClient({ roles: [SV] });
    rpcResults["admin_list_audit_logs"] = { error: { message: "SQLSTATE XX000 boom" } };
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
  });

  it("AUDIT_READ ล้ม 2 ครั้ง → 503 audit_read_unavailable (fail-closed)", async () => {
    mockClient({ roles: [SV], auditReadError: { message: "42501" } });
    rpcResults["admin_list_audit_logs"] = {
      data: { data: [auditRow()], nextCursor: null },
    };
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("audit_read_unavailable");
    // พยายามเขียน 2 ครั้งตามแบบแผน retry-once
    const attempts = rpcCalls.filter((c) => c.fn === "append_audit_event");
    expect(attempts).toHaveLength(2);
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    mockClient({ roles: [SV] });
    rpcResults["admin_list_audit_logs"] = {
      data: { data: [], nextCursor: null },
    };
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await GET(adminUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { details: { group: string } } };
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});
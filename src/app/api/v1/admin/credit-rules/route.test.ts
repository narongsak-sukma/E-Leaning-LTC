/**
 * route.test — /api/v1/admin/credit-rules (Wave E Phase 3 · Credit Bank)
 *
 * GET — RBAC credit_rule:view (sv/sr/sa) · query strict · keyset (created_at,id) ·
 *       drift → 503 · rate STAFF_WRITE
 * POST — RBAC credit_rule:create (sr/sa) · body strict · INSERT ไม่รับ status ·
 *       23505/23503 mapping · audit best-effort (deny ไม่ล้ม mutation)
 *
 * mock ตามแบบ src/app/api/v1/admin/courses/route.test.ts (vi.mock supabase/ssr ·
 * auth.getUser + mfa + profiles active + rpc my_roles · thenable builder)
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
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { GET, POST } from "./route";

const SV = "staff:viewer";
const SC = "staff:content";
const SR = "staff:registrar";
const SA = "super_admin";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const RULE_ID = "c1000000-0000-4000-8000-000000000001";
const CAT_ID = "b0000000-0000-4000-8000-000000000001";
const T1 = "2026-08-01T00:00:00+00:00";
const T2 = "2026-09-01T00:00:00+00:00";

/** thenable builder — คืน builder เดียว chainable + ติดตาม call ทุก method */
function makeBuilder() {
  const calls: {
    select: unknown[];
    eq: Array<{ column: string; value: unknown }>;
    or: string[];
    order: Array<[string, { ascending: boolean }]>;
    limit: unknown[];
    insert: unknown[];
  } = { select: [], eq: [], or: [], order: [], limit: [], insert: [] };
  const builder = {
    select: vi.fn((s: unknown) => {
      calls.select.push(s);
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      calls.eq.push({ column, value });
      return builder;
    }),
    or: vi.fn((filter: string) => {
      calls.or.push(filter);
      return builder;
    }),
    order: vi.fn((column: string, opts: { ascending: boolean }) => {
      calls.order.push([column, opts]);
      return builder;
    }),
    limit: vi.fn((n: unknown) => {
      calls.limit.push(n);
      return builder;
    }),
    insert: vi.fn((payload: unknown) => {
      calls.insert.push(payload);
      return builder;
    }),
    single: vi.fn(async () => ({ data: null, error: null })),
    // default no-op — mockClient/เทส DB-error จะ override ทับ (คง type ของ property ไว้)
    then: (res: (v: { data: unknown; error: null }) => unknown): unknown => res({ data: [], error: null }),
  };
  return { builder, calls };
}

type BuilderControl = ReturnType<typeof makeBuilder>;

/**
 * client ครบชั้น RBAC — from("profiles") active · from("credit_rules") → builder หลัก ·
 * then คืน `rows` (GET) · single() คืน createdRow/insertError (POST)
 */
function mockClient(options: {
  rows?: unknown[];
  createdRow?: unknown;
  insertError?: { code?: string | null; message?: string } | null;
  roles: readonly string[];
  aal?: "aal1" | "aal2";
}): BuilderControl {
  const { builder, calls } = makeBuilder();
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
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles" ? { data: options.roles, error: null } : { data: null, error: null }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : builder)),
  };
  builder.then = (res: (v: { data: unknown; error: null }) => unknown) =>
    res({ data: options.rows ?? [], error: null });
  builder.single = vi.fn(async () => ({
    data: options.insertError != null ? null : (options.createdRow ?? null),
    error: options.insertError ?? null,
  }));
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { builder, calls };
}

/** service client (audit best-effort) — ควบคุมผล rpc ได้ */
function mockServiceClient(
  rpcResult: { data: null; error: unknown } = { data: null, error: null },
) {
  const auditCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const serviceRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    auditCalls.push({ fn, args });
    return rpcResult;
  });
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ rpc: serviceRpc } as never);
  return { serviceRpc, auditCalls };
}

function adminUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/credit-rules" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-1" },
  });
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/admin/credit-rules", {
    method: "POST",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-1" },
    body: JSON.stringify(body),
  });
}

function ruleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "CR-LTC-001",
    name: "สอบผ่านหลักสูตรทั่วไป",
    credits: 3,
    ...overrides,
  };
}

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
    status: "draft",
    created_at: T1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/credit-rules — สิทธิ์ + envelope §1.2", () => {
  it.each([[[SR]], [[SV]], [[SA]]])("บทบาท %j ถือ credit_rule:view → 200", async (roles) => {
    mockClient({ rows: [ruleRow()], roles });
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      page: { nextCursor: null; hasMore: boolean };
    };
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(body.data).toHaveLength(1);
  });

  it("staff:content ไม่ถือ credit_rule:view → 403 ERR-RBAC-001", async () => {
    mockClient({ rows: [], roles: [SC] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("credit_rule:view");
  });

  it("staff ที่ยัง aal1 → 403 ERR-AUTH-004 ก่อนถึง query", async () => {
    mockClient({ rows: [], roles: [SV], aal: "aal1" });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });
});

describe("GET — query strict + keyset", () => {
  it("status/course_id → .eq ครบ · ไม่มี cursor ไม่เรียก .or", async () => {
    const control = mockClient({ rows: [], roles: [SR] });
    const res = await GET(adminUrl("?status=active&course_id=" + CAT_ID));
    expect(res.status).toBe(200);
    expect(control.calls.eq).toEqual([
      { column: "status", value: "active" },
      { column: "course_id", value: CAT_ID },
    ]);
    expect(control.calls.or).toEqual([]);
  });

  it("limit+1 → hasMore=true + nextCursor signed ชี้ (created_at,id) แถวสุดท้าย", async () => {
    const rows = [
      ruleRow({ id: RULE_ID, created_at: T2 }),
      ruleRow({ id: "c1000000-0000-4000-8000-000000000002", created_at: T1 }),
      ruleRow({ id: "c1000000-0000-4000-8000-000000000003", created_at: "2026-07-01T00:00:00+00:00" }),
    ];
    const control = mockClient({ rows, roles: [SR] });
    const res = await GET(adminUrl("?limit=2"));
    const body = (await res.json()) as {
      data: unknown[];
      page: { nextCursor: string | null; hasMore: boolean };
    };
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.page.hasMore).toBe(true);
    expect(control.calls.limit).toEqual([3]);
    expect(control.calls.order).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(decodeCursor(String(body.page.nextCursor))).toEqual({
      sortKey: T1,
      id: "c1000000-0000-4000-8000-000000000002",
    });
  });

  it("cursor มาพร้อม request → or-filter row-wise DESC", async () => {
    const control = mockClient({ rows: [], roles: [SR] });
    const cursor = encodeCursor({ sortKey: T1, id: RULE_ID });
    const res = await GET(adminUrl("?cursor=" + encodeURIComponent(cursor)));
    expect(res.status).toBe(200);
    expect(control.calls.or).toEqual([
      "created_at.lt." + T1 + ",and(created_at.eq." + T1 + ",id.lt." + RULE_ID + ")",
    ]);
  });

  it.each(["?limit=abc", "?status=deleted", "?course_id=not-a-uuid", "?foo=bar"])(
    "query %s ผิดรูป → 400 ERR-VAL-001 fields",
    async (query) => {
      mockClient({ rows: [], roles: [SR] });
      const res = await GET(adminUrl(query));
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details: { fields: string[] } };
      };
      expect(body.error.code).toBe("ERR-VAL-001");
      expect(Array.isArray(body.error.details.fields)).toBe(true);
    },
  );

  it("RLS คืนแถวว่าง → data: [] + hasMore false", async () => {
    mockClient({ rows: [], roles: [SR] });
    const res = await GET(adminUrl());
    const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean } };
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("แถว drift (credits ผิดชนิด — mapper ตัดคีย์แปลกปลอมก่อน schema จึงต้อง drift ที่ค่า) → 503 credit_rule_row_drift", async () => {
    mockClient({ rows: [{ ...ruleRow(), credits: "3" }], roles: [SR] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_rule_row_drift");
  });

  it("error ฝั่ง DB → 503 ERR-SYS-002 credit_rules_query_failed", async () => {
    const control = mockClient({ rows: [], roles: [SR] });
    control.builder.then = ((
      res: (v: { data: null; error: { message: string } }) => unknown,
    ) => res({ data: null, error: { message: "SQLSTATE XX000" } })) as never;
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_rules_query_failed");
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    mockClient({ rows: [], roles: [SR] });
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await GET(adminUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as {
      error: { code: string; details: { group: string } };
    };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

describe("POST /admin/credit-rules — สร้างกฎ (draft)", () => {
  it("registrar สร้างสำเร็จ → 201 + resource + INSERT ไม่ส่ง status + audit CREDIT_RULE_CREATE", async () => {
    const control = mockClient({ rows: [], createdRow: ruleRow(), roles: [SR] });
    const { auditCalls } = mockServiceClient();
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["code"]).toBe("CR-LTC-001");
    expect(body.data["status"]).toBe("draft");
    const inserted = control.calls.insert[0] as Record<string, unknown>;
    expect(inserted).not.toHaveProperty("status");
    expect(auditCalls.length).toBeGreaterThan(0);
    expect(auditCalls[0]?.fn).toBe("append_audit_event");
    const args = auditCalls[0]?.args ?? {};
    expect(args["p_action"]).toBe("CREDIT_RULE_CREATE");
    expect(args["p_entity_type"]).toBe("credit_rule");
  });

  it("viewer ไม่ถือ credit_rule:create → 403 + ไม่แตะ DB", async () => {
    const control = mockClient({ rows: [], roles: [SV] });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(403);
    expect(control.calls.insert).toHaveLength(0);
  });

  it.each([
    ["credits เป็น 0", { credits: 0 }],
    ["creditType พิมพ์ใหญ่", { creditType: "General" }],
    ["code ผิดรูป", { code: "RULE-1" }],
    ["priority ติดลบ", { priority: -1 }],
    ["effective_to ≤ effective_from", { effectiveFrom: "2026-09-02", effectiveTo: "2026-09-01" }],
  ])("body %s → 400 ERR-VAL-001 fields", async (_label, overrides) => {
    mockClient({ roles: [SR] });
    const res = await POST(postRequest(ruleBody(overrides)));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { fields: string[] } };
    };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.fields.length).toBeGreaterThan(0);
  });

  it("23505 (code ซ้ำ) → 400 ERR-VAL-001 field code duplicate", async () => {
    mockClient({ roles: [SR], insertError: { code: "23505", message: "dup" } });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details: { field: string; reason: string } };
    };
    expect(body.error.details.field).toBe("code");
    expect(body.error.details.reason).toBe("duplicate");
  });

  it("23503 (course_id ไม่มีจริง) → 400 field courseId", async () => {
    mockClient({ roles: [SR], insertError: { code: "23503", message: "fk" } });
    const body = ruleBody({ courseId: CAT_ID });
    const res = await POST(postRequest(body));
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { details: { field: string } } };
    expect(parsed.error.details.field).toBe("courseId");
  });

  it("audit rpc deny → ยัง 201 (best-effort — WARN tripwire ไม่ล้ม mutation)", async () => {
    mockClient({ rows: [], createdRow: ruleRow(), roles: [SR] });
    mockServiceClient({ data: null, error: { code: "42501", message: "denied" } });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(201);
  });
});

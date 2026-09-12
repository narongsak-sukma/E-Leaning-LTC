/**
 * route.test — /api/v1/admin/credit-rules (Wave E Phase 3 · Credit Bank)
 *
 * GET — RBAC credit_rule:view (sv/sr/sa) · query strict · keyset (created_at,id) ·
 *       drift → 503 · rate STAFF_WRITE
 * POST — RBAC credit_rule:create (sr/sa) · body strict · atomic RPC
 *       admin_create_credit_rule (0032 — validate + INSERT + audit CREDIT_RULE_CREATE ใน TX
 *       เดียว · status 'draft' ตั้งใน RPC ไม่รับจาก client) · error tags
 *       "(ERR-XXX-NNN|tag)" แกะผ่าน lib/api/rpc-errors → AppError · ไม่มีป้าย = ERR-SYS-002
 *       opaque (ห้าม leak ข้อความ SQL)
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
 * client ครบชั้น RBAC — from("profiles") active · from("credit_rules") → builder หลัก (GET) ·
 * then คืน `rows` · rpc("admin_create_credit_rule") คืน `createResult` (POST — atomic RPC 0032)
 */
function mockClient(options: {
  rows?: unknown[];
  /** ผลของ rpc admin_create_credit_rule — data = แถว jsonb (หรือ [แถว]) · error มีป้าย/ไม่มีป้าย */
  createResult?: { data?: unknown; error?: unknown } | null;
  roles: readonly string[];
  aal?: "aal1" | "aal2";
}): BuilderControl & {
  readonly rpcCalls: ReadonlyArray<{ fn: string; args: Record<string, unknown> }>;
} {
  const { builder, calls } = makeBuilder();
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
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
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      if (fn === "my_roles") {
        return { data: options.roles, error: null };
      }
      if (fn === "admin_create_credit_rule") {
        return {
          data: options.createResult?.data ?? null,
          error: options.createResult?.error ?? null,
        };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : builder)),
  };
  builder.then = (res: (v: { data: unknown; error: null }) => unknown) =>
    res({ data: options.rows ?? [], error: null });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { builder, calls, rpcCalls };
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
    // gate r3 MINOR-1 — required ที่ BFF แล้ว: fixture ต้องส่งเสมอ ไม่งั้น happy-path
    // เทสเองก็ 400 (ช่องว่างเดิมที่ทำให้ bug นี้มองไม่เห็นเพราะ RPC ถูก mock)
    effectiveFrom: "2026-09-01",
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

describe("POST /admin/credit-rules — สร้างกฎ (draft) ผ่าน RPC atomic 0032", () => {
  it("registrar สร้างสำเร็จ → 201 + resource + rpc args ครบ 13 พารามิเตอร์ (ไม่มี p_status) + ไม่แตะ service client", async () => {
    const control = mockClient({ rows: [], createResult: { data: ruleRow() }, roles: [SR] });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["code"]).toBe("CR-LTC-001");
    expect(body.data["status"]).toBe("draft");
    const createCalls = control.rpcCalls.filter((c) => c.fn === "admin_create_credit_rule");
    expect(createCalls).toHaveLength(1);
    const args = createCalls[0]?.args ?? {};
    expect(Object.keys(args).sort()).toEqual([
      "p_carry_over",
      "p_code",
      "p_course_id",
      "p_credit_type",
      "p_credits",
      "p_effective_from",
      "p_effective_to",
      "p_name",
      "p_priority",
      "p_renewal_cycle",
      "p_request_id",
      "p_required_credits_per_cycle",
      "p_valid_days",
    ]);
    expect(args["p_code"]).toBe("CR-LTC-001");
    expect(args["p_name"]).toBe("สอบผ่านหลักสูตรทั่วไป");
    expect(args["p_credits"]).toBe(3);
    expect(args["p_request_id"]).toBe("req-e11-1");
    // status ไม่รับจาก client — RPC ตั้ง 'draft' เอง
    expect(args).not.toHaveProperty("p_status");
    // audit CREDIT_RULE_CREATE อยู่ใน TX ของ RPC แล้ว — service client ต้องไม่ถูกแตะ
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
    expect(control.calls.insert).toHaveLength(0);
  });

  it("viewer ไม่ถือ credit_rule:create → 403 + ไม่เรียก rpc mutation", async () => {
    const control = mockClient({ rows: [], roles: [SV] });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(403);
    expect(control.rpcCalls.filter((c) => c.fn === "admin_create_credit_rule")).toHaveLength(0);
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

  it("ไม่กรอก effectiveFrom → 400 ERR-VAL-001 fields มี effectiveFrom และไม่ถึง RPC (gate r3 MINOR-1)", async () => {
    const control = mockClient({ roles: [SR] });
    const rest = ruleBody();
    delete rest.effectiveFrom;
    const res = await POST(postRequest(rest));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { fields: string[] } };
    };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.fields).toContain("effectiveFrom");
    // กันที่ประตู BFF จริง — RPC ต้องไม่ถูกเรียกเลย (เดิม optional→null แล้วพังที่ชั้น 0032)
    expect(control.rpcCalls.filter((c) => c.fn === "admin_create_credit_rule")).toHaveLength(0);
  });

  it.each([
    [
      "code ซ้ำ (23505)",
      'duplicate key value violates unique constraint "credit_rules_code_key" (ERR-VAL-001|code_duplicate)',
      "code_duplicate",
    ],
    [
      "course_id ไม่มีจริง (23503)",
      'insert or update on table "credit_rules" violates foreign key constraint (ERR-VAL-001|course_not_found)',
      "course_not_found",
    ],
  ])("RPC ป้าย error %s → 400 ERR-VAL-001 reason ตรง tag (ไม่ leak SQL)", async (_label, message, reason) => {
    mockClient({ rows: [], createResult: { error: { message } }, roles: [SR] });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.reason).toBe(reason);
    // ข้อความ SQL ดิบห้ามหลุดออก client (SDS §6.1)
    expect(JSON.stringify(body)).not.toContain("credit_rules_code_key");
    expect(JSON.stringify(body)).not.toContain("violates foreign key");
  });

  it("RPC ป้าย (ERR-AUTH-004|mfa_required) → 403 ERR-AUTH-004 reason mfa_required", async () => {
    mockClient({
      rows: [],
      createResult: {
        error: { message: "ต้องยืนยันตัวตนระดับ aal2 (ERR-AUTH-004|mfa_required)" },
      },
      roles: [SR],
    });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(body.error.details.reason).toBe("mfa_required");
  });

  it("RPC ป้าย (ERR-RBAC-001|credit_rule_forbidden) → 403 ERR-RBAC-001", async () => {
    mockClient({
      rows: [],
      createResult: {
        error: { message: "บทบาทไม่ได้รับอนุญาต (ERR-RBAC-001|credit_rule_forbidden)" },
      },
      roles: [SR],
    });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details.reason).toBe("credit_rule_forbidden");
  });

  it("RPC error ไม่มีป้าย → 503 ERR-SYS-002 reason credit_rule_create_failed ไม่ leak SQL", async () => {
    mockClient({
      rows: [],
      createResult: {
        error: { message: 'new row violates check constraint "credit_rules_check" (SQLSTATE 23514)' },
      },
      roles: [SR],
    });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_rule_create_failed");
    expect(JSON.stringify(body)).not.toContain("SQLSTATE");
    expect(JSON.stringify(body)).not.toContain("credit_rules_check");
  });

  it("แถวที่ RPC คืน drift (credits ผิดชนิด) → 503 credit_rule_created_drift", async () => {
    mockClient({ rows: [], createResult: { data: ruleRow({ credits: "3" }) }, roles: [SR] });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_rule_created_drift");
  });

  it("PostgREST wrap scalar jsonb เป็น [แถวเดียว] → unwrap แล้ว 201", async () => {
    mockClient({ rows: [], createResult: { data: [ruleRow()] }, roles: [SR] });
    const res = await POST(postRequest(ruleBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["code"]).toBe("CR-LTC-001");
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001 (POST)", async () => {
    mockClient({ rows: [], createResult: { data: ruleRow() }, roles: [SR] });
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await POST(postRequest(ruleBody()));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as {
      error: { code: string; details: { group: string } };
    };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

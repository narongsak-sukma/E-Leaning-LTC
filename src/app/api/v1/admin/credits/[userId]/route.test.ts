/**
 * route.test — GET /api/v1/admin/credits/{userId} (Wave E Phase 3 · Credit Bank)
 *
 * RBAC สองชั้น: credit_ledger:view + role-scope ซ้ำ (staff เท่านั้น — lawyer/instructor
 * ถือ permission แต่ดูได้เฉพาะ owner-view ของตน ไม่ผ่าน endpoint admin) · :userId uuid ·
 * query strict (key แปลกปลอม/limit เกิน/after_* ครึ่งเดี่ยว → 400) · keyset (created_at,id)
 * DESC + or-filter row-wise · join renewal_cycles เอา cycle_no (embed null → cycleNo 0 →
 * ล้ม schema → 503 fail-closed) · drift ค่าผิดชนิด → 503 · audit PII_ACCESS fail-closed —
 * ล้มซ้ำ 2 ครั้ง → 503 ERR-SYS-002 ไม่มี disclosure โดยไม่มี audit (gate BLOCKER-7)
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
import { decodeCursor } from "@/lib/api/pagination";
import { ipHashOf } from "@/lib/auth/password-reset";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { userAgentHashOf } from "@/lib/security/hash";
import { GET } from "./route";

const SV = "staff:viewer";
const SR = "staff:registrar";
const SA = "super_admin";
const LAWYER = "lawyer";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const USER_ID = "b0000000-0000-4000-8000-000000000002";
const CYCLE_ID = "e0000000-0000-4000-8000-000000000003";
const T1 = "2026-09-01T09:00:00+00:00";
const T2 = "2026-08-01T09:00:00+00:00";

/** แถว ledger ครบคอลัมน์ (ตรง LEDGER_SELECT) — embed renewal_cycles เป็น object ลูก */
function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID === "b0000000-0000-4000-8000-000000000002"
      ? "c2000000-0000-4000-8000-00000000000a"
      : "c2000000-0000-4000-8000-00000000000b",
    renewal_cycle_id: CYCLE_ID,
    entry_type: "adjustment",
    credit_type: "general",
    amount: 2.5,
    source_type: "admin_adjustment",
    reason: "ปรับเพิ่มเครดิตค้างจากระบบเดิม",
    created_by: STAFF_ID,
    created_at: T2,
    renewal_cycles: { cycle_no: 3 },
    ...overrides,
  };
}

interface BuilderCalls {
  readonly select: unknown[];
  readonly eq: unknown[];
  readonly order: unknown[];
  readonly limit: unknown[];
  readonly or: unknown[];
}

/**
 * mock GET ledger — from("credit_ledger_entries") ครั้งเดียวต่อคำขอ · thenable builder
 * จับ select/eq/order/limit/or เพื่อ assert โครง query ฝั่ง DB
 */
function mockLedger(options: {
  roles: readonly string[];
  rows?: readonly Record<string, unknown>[];
  dbError?: { message: string } | null;
  aal?: "aal1" | "aal2";
  /** ผล error ของ rpc audit ตามลำดับครั้ง — เกินความยาว array = สำเร็จ (error null) */
  auditRpcErrors?: readonly unknown[];
}): BuilderCalls & {
  readonly auditCalls: ReadonlyArray<{ fn: string; args: Record<string, unknown> }>;
} {
  const selectCalls: unknown[] = [];
  const eqCalls: unknown[] = [];
  const orderCalls: unknown[] = [];
  const limitCalls: unknown[] = [];
  const orCalls: unknown[] = [];
  const auditCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const serviceRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    auditCalls.push({ fn, args });
    // push ก่อนคืนค่า — index ปัจจุบัน = auditCalls.length - 1
    return { data: null, error: options.auditRpcErrors?.[auditCalls.length - 1] ?? null };
  });
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ rpc: serviceRpc } as never);
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const ledgerBuilder: Record<string, unknown> = {};
  Object.assign(ledgerBuilder, {
    select: vi.fn((s: unknown) => {
      selectCalls.push(s);
      return ledgerBuilder;
    }),
    eq: vi.fn((col: unknown, val: unknown) => {
      eqCalls.push([col, val]);
      return ledgerBuilder;
    }),
    order: vi.fn((col: unknown, opts: unknown) => {
      orderCalls.push([col, opts]);
      return ledgerBuilder;
    }),
    limit: vi.fn((n: unknown) => {
      limitCalls.push(n);
      return ledgerBuilder;
    }),
    or: vi.fn((filter: unknown) => {
      orCalls.push(filter);
      return ledgerBuilder;
    }),
    then: (onFulfilled?: (value: { data: unknown; error: unknown }) => unknown) => {
      const result = {
        data: options.dbError != null ? null : (options.rows ?? []),
        error: options.dbError ?? null,
      };
      return Promise.resolve(result).then((value) =>
        onFulfilled != null ? onFulfilled(value) : value,
      );
    },
  });
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
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return profilesBuilder;
      }
      return ledgerBuilder;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return {
    select: selectCalls,
    eq: eqCalls,
    order: orderCalls,
    limit: limitCalls,
    or: orCalls,
    auditCalls,
  };
}

function ledgerUrl(userId = USER_ID, search = "", extraHeaders: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000/api/v1/admin/credits/${userId}${search}`, {
    method: "GET",
    headers: { "x-forwarded-for": "10.7.0.1", "x-request-id": "req-e11-4", ...extraHeaders },
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/credits/{userId} — สิทธิ์ (สองชั้น) + รูปแบบ", () => {
  it.each([[[SV]], [[SR]], [[SA]]])(
    "บทบาท %j ถือ credit_ledger:view + เป็น staff → 200 + page envelope",
    async (roles) => {
      mockLedger({ roles, rows: [ledgerRow()] });
      const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean; nextCursor: string | null } };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.page.hasMore).toBe(false);
      expect(body.page.nextCursor).toBeNull();
    },
  );

  it("lawyer ถือ permission แต่ไม่ใช่ staff → 403 ERR-RBAC-001 (role-scope ชั้นที่สอง) + ไม่แตะ ledger", async () => {
    const calls = mockLedger({ roles: [LAWYER], rows: [ledgerRow()] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: { permission: string } } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details.permission).toBe("credit_ledger:view");
    expect(calls.select).toHaveLength(0);
    expect(calls.auditCalls).toHaveLength(0);
  });

  it("registrar MFA aal1 → 403 ERR-AUTH-004 + ไม่แตะ ledger", async () => {
    const calls = mockLedger({ roles: [SR], aal: "aal1", rows: [ledgerRow()] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(calls.select).toHaveLength(0);
  });

  it(":userId ผิดรูป uuid → 400 ERR-VAL-001 field userId + ไม่แตะ DB", async () => {
    const calls = mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const res = await GET(ledgerUrl("not-a-uuid"), {
      params: Promise.resolve({ userId: "not-a-uuid" }),
    } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { field: string } } };
    expect(body.error.details.field).toBe("userId");
    expect(calls.select).toHaveLength(0);
  });

  it.each([
    ["limit ไม่ใช่ตัวเลข", "?limit=abc"],
    ["key แปลกปลอม", "?foo=bar"],
    ["limit เกินเพดาน 100", "?limit=101"],
  ])("query %s → 400 ERR-VAL-001", async (_label, search) => {
    mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const res = await GET(ledgerUrl(USER_ID, search), {
      params: Promise.resolve({ userId: USER_ID }),
    } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("after_created_at ครึ่งเดี่ยว (ไม่มี after_id) → 400 ระบุ fields ครบคู่", async () => {
    mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const res = await GET(
      ledgerUrl(USER_ID, `?after_created_at=${encodeURIComponent(T1)}`),
      { params: Promise.resolve({ userId: USER_ID }) } as never,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields: string[] } } };
    expect(body.error.details.fields).toEqual(["after_created_at", "after_id"]);
  });
});

describe("GET /admin/credits/{userId} — โครง query + keyset", () => {
  it("eq user_id + select มี join renewal_cycles + order สองคอลัมน์ DESC + limit = limit+1", async () => {
    const calls = mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const res = await GET(ledgerUrl(USER_ID, "?limit=5"), {
      params: Promise.resolve({ userId: USER_ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(calls.eq[0]).toEqual(["user_id", USER_ID]);
    const selectStr = String(calls.select[0]);
    expect(selectStr).toContain("renewal_cycles(cycle_no)");
    expect(calls.order[0]).toEqual(["created_at", { ascending: false }]);
    expect(calls.order[1]).toEqual(["id", { ascending: false }]);
    expect(calls.limit[0]).toBe(6);
  });

  it("คู่ after_* → or-filter row-wise ตรงสัญญา (created_at,id) DESC", async () => {
    const calls = mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const afterId = "c2000000-0000-4000-8000-000000000099";
    const res = await GET(
      ledgerUrl(USER_ID, `?after_created_at=${encodeURIComponent(T1)}&after_id=${afterId}`),
      { params: Promise.resolve({ userId: USER_ID }) } as never,
    );
    expect(res.status).toBe(200);
    expect(calls.or[0]).toBe(
      `created_at.lt.${T1},and(created_at.eq.${T1},id.lt.${afterId})`,
    );
  });

  it("limit+1 ครบ 21 แถว → hasMore true + nextCursor decode ตรง (sortKey, id) ของแถวที่ 20", async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      ledgerRow({
        id: `c2000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
        created_at: i === 0 ? T1 : T2,
      }),
    );
    mockLedger({ roles: [SV], rows });
    const res = await GET(ledgerUrl(USER_ID, "?limit=20"), {
      params: Promise.resolve({ userId: USER_ID }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      page: { hasMore: boolean; nextCursor: string | null };
    };
    expect(body.data).toHaveLength(20);
    expect(body.page.hasMore).toBe(true);
    expect(body.page.nextCursor).not.toBeNull();
    const payload = decodeCursor(body.page.nextCursor as string);
    expect(payload.sortKey).toBe(T2);
    expect(payload.id).toBe(`c2000000-0000-4000-8000-${String(119).padStart(12, "0")}`);
  });

  it("รายการว่าง → 200 data [] + hasMore false", async () => {
    mockLedger({ roles: [SR], rows: [] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean } };
    expect(body.data).toHaveLength(0);
    expect(body.page.hasMore).toBe(false);
  });
});

describe("GET /admin/credits/{userId} — audit PII_ACCESS (fail-closed)", () => {
  it("อ่านสำเร็จ → append_audit_event 1 ครั้ง: PII_ACCESS/user/{userId} + context ครบ 4 คีย์", async () => {
    const calls = mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(200);
    expect(calls.auditCalls).toHaveLength(1);
    const call = calls.auditCalls[0] ?? { fn: "", args: {} };
    expect(call.fn).toBe("append_audit_event");
    expect(call.args["p_action"]).toBe("PII_ACCESS");
    expect(call.args["p_entity_type"]).toBe("user");
    expect(call.args["p_entity_id"]).toBe(USER_ID);
    const context = call.args["p_context"] as Record<string, unknown>;
    expect(context["endpoint"]).toBe("/api/v1/admin/credits/{userId}");
    expect(context["target_user_id"]).toBe(USER_ID);
    expect(context["purpose"]).toBe("credit_ledger_view");
    expect(context["user_id"]).toBe(STAFF_ID);
    expect(call.args["p_request_id"]).toBe("req-e11-4");
  });

  it("audit rpc ล้มซ้ำ 2 ครั้ง (42501 ทั้งคู่) → 503 ERR-SYS-002 fail-closed ไม่มี disclosure", async () => {
    const calls = mockLedger({
      roles: [SV],
      rows: [ledgerRow()],
      auditRpcErrors: [
        { code: "42501", message: "permission denied" },
        { code: "42501", message: "permission denied" },
      ],
    });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(503);
    expect(calls.auditCalls).toHaveLength(2);
    const body = (await res.json()) as {
      data?: unknown;
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_ledger_pii_audit_unavailable");
    // ไม่มี disclosure — ตอบ 503 (ล้ม) จึงไม่มี data หลุดออกไปโดยไม่มี audit
    expect("data" in body).toBe(false);
    // ข้อความ error ไม่ leak รายละเอียด DB (SDS §6.1)
    expect(JSON.stringify(body.error)).not.toContain("42501");
  });

  it("audit ล้มครั้งแรก สำเร็จครั้งที่สอง (retry) → 200 + เขียน audit ครบ 2 ครั้ง", async () => {
    const calls = mockLedger({
      roles: [SV],
      rows: [ledgerRow()],
      auditRpcErrors: [{ code: "42501", message: "permission denied" }],
    });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
    expect(calls.auditCalls).toHaveLength(2);
  });

  it("drift 503 (ตอบไม่สำเร็จ) → ไม่เขียน audit", async () => {
    const calls = mockLedger({ roles: [SV], rows: [ledgerRow({ amount: "2.5" })] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(503);
    expect(calls.auditCalls).toHaveLength(0);
  });

  it("D76: audit รับ p_ip_hash/p_user_agent จาก request จริง (10.7.0.1 + UA ของ header) — ไม่ใช่ null", async () => {
    const calls = mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const ua = "Mozilla/5.0 (d76-credits-route)";
    const res = await GET(ledgerUrl(USER_ID, "", { "user-agent": ua }), {
      params: Promise.resolve({ userId: USER_ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(calls.auditCalls).toHaveLength(1);
    const call = calls.auditCalls[0] ?? { fn: "", args: {} };
    expect(call.fn).toBe("append_audit_event");
    expect(call.args["p_ip_hash"]).toBe(ipHashOf("10.7.0.1"));
    expect(call.args["p_ip_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(call.args["p_user_agent"]).toBe(
      userAgentHashOf(new Request("http://localhost/", { headers: { "user-agent": ua } })),
    );
    expect(call.args["p_user_agent"]).toMatch(/^[0-9a-f]{64}$/);
    // D76 สองทิศ: UA ต่างกัน → hash ต่างกัน (ค่ามาจาก header จริง ไม่ใช่ค่าคงที่)
    const calls2 = mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const res2 = await GET(ledgerUrl(USER_ID, "", { "user-agent": ua + "-variant-2" }), {
      params: Promise.resolve({ userId: USER_ID }),
    } as never);
    expect(res2.status).toBe(200);
    const call2 = calls2.auditCalls[0] ?? { fn: "", args: {} };
    expect(call2.args["p_user_agent"]).not.toBe(call.args["p_user_agent"]);
  });

  it("D76: request ไม่มี header user-agent → p_user_agent เป็น null (ตาม helper — ไม่ hash ค่าว่าง)", async () => {
    const calls = mockLedger({ roles: [SV], rows: [ledgerRow()] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(200);
    const call = calls.auditCalls[0] ?? { fn: "", args: {} };
    expect(call.args["p_user_agent"]).toBeNull();
    expect(call.args["p_ip_hash"]).toBe(ipHashOf("10.7.0.1"));
  });
});

describe("GET /admin/credits/{userId} — drift fail-closed + rate", () => {
  it("embed renewal_cycles เป็น null → cycleNo 0 ล้ม schema (min 1) → 503 ledger_row_drift", async () => {
    mockLedger({ roles: [SV], rows: [ledgerRow({ renewal_cycles: null })] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("ledger_row_drift");
  });

  it("แถว drift ค่าผิดชนิด (amount เป็น string) → 503 ledger_row_drift", async () => {
    mockLedger({ roles: [SV], rows: [ledgerRow({ amount: "2.5" })] });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("ledger_row_drift");
  });

  it("DB error → 503 ERR-SYS-002 ledger_query_failed", async () => {
    mockLedger({ roles: [SV], dbError: { message: "SQLSTATE XX000" } });
    const res = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("ledger_query_failed");
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001 group STAFF_WRITE", async () => {
    mockLedger({ roles: [SV], rows: [ledgerRow()] });
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await GET(ledgerUrl(), { params: Promise.resolve({ userId: USER_ID }) } as never);
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

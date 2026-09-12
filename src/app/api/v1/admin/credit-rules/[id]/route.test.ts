/**
 * route.test — PATCH /api/v1/admin/credit-rules/{id} (Wave E Phase 3 · Credit Bank)
 *
 * RBAC credit_rule:update (sr/sa) · :id uuid · body strict { status } เท่านั้น ·
 * transition ตรวจซ้ำฝั่ง BFF (draft→active / active→retired เท่านั้น — ข้อความไทยเจาะจง) ·
 * 404 เมื่อไม่พบ · P0001 (trigger race) → ข้อความไทยเดียวกัน · audit best-effort
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

/** แถวเต็ม (ใช้เป็น current + updated) — คอลัมน์เดียวกับ COLUMNS ของ route */
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
    created_at: "2026-08-01T00:00:00+00:00",
    ...overrides,
  };
}

interface PatchMocks {
  readonly calls: {
    readonly update: unknown[];
    readonly select: unknown[];
  };
}

/**
 * mock PATCH flow — from("credit_rules") เรียก 2 ครั้ง: ครั้งแรก = อ่าน current
 * (select().eq().maybeSingle()) · ครั้งที่สอง = UPDATE (update().eq().select().single())
 */
function mockPatch(options: {
  roles: readonly string[];
  currentRow?: unknown;
  currentError?: { message: string } | null;
  updatedRow?: unknown;
  updateError?: { code?: string | null; message: string } | null;
  aal?: "aal1" | "aal2";
}): PatchMocks {
  const updateCalls: unknown[] = [];
  const selectCalls: unknown[] = [];
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const currentBuilder = {
    select: vi.fn((s: unknown) => {
      selectCalls.push(s);
      return currentBuilder;
    }),
    eq: vi.fn(() => currentBuilder),
    maybeSingle: vi.fn(async () => ({
      data: options.currentError != null ? null : (options.currentRow ?? null),
      error: options.currentError ?? null,
    })),
  };
  const updateBuilder = {
    update: vi.fn((payload: unknown) => {
      updateCalls.push(payload);
      return updateBuilder;
    }),
    eq: vi.fn(() => updateBuilder),
    select: vi.fn((s: unknown) => {
      selectCalls.push(s);
      return updateBuilder;
    }),
    single: vi.fn(async () => ({
      data: options.updateError != null ? null : (options.updatedRow ?? null),
      error: options.updateError ?? null,
    })),
  };
  let creditRulesCalls = 0;
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
      creditRulesCalls += 1;
      return creditRulesCalls === 1 ? currentBuilder : updateBuilder;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { calls: { update: updateCalls, select: selectCalls } };
}

/** service client (audit best-effort) */
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

function patchUrl(ruleId = RULE_ID): Request {
  return new Request(`http://localhost:3000/api/v1/admin/credit-rules/${ruleId}`, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-2" },
    body: JSON.stringify({ status: "active" }),
  });
}

function patchRequest(ruleId: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/v1/admin/credit-rules/${ruleId}`, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-2" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("PATCH /admin/credit-rules/{id} — สิทธิ์ + รูปแบบ", () => {
  it("registrar เผยแพร่ draft→active → 200 + resource + audit CREDIT_RULE_UPDATE แนบ status_from/to", async () => {
    mockPatch({
      roles: [SR],
      currentRow: ruleRow({ status: "draft" }),
      updatedRow: ruleRow({ status: "active" }),
    });
    const { auditCalls } = mockServiceClient();
    const res = await PATCH(patchUrl(), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["status"]).toBe("active");
    expect(body.data["id"]).toBe(RULE_ID);
    expect(auditCalls[0]?.fn).toBe("append_audit_event");
    const args = auditCalls[0]?.args ?? {};
    expect(args["p_action"]).toBe("CREDIT_RULE_UPDATE");
    const context = args["p_context"] as Record<string, unknown>;
    expect(context["status_from"]).toBe("draft");
    expect(context["status_to"]).toBe("active");
  });

  it("super_admin ถือ credit_rule:update → 200 (เผยแพร่ draft→active)", async () => {
    mockPatch({
      roles: [SA],
      currentRow: ruleRow({ status: "draft" }),
      updatedRow: ruleRow({ status: "active" }),
    });
    mockServiceClient();
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("active");
  });

  it("viewer ไม่ถือ credit_rule:update → 403 ERR-RBAC-001 + ไม่แตะ credit_rules", async () => {
    const mocks = mockPatch({ roles: [SV] });
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(mocks.calls.update).toHaveLength(0);
  });

  it("registrar MFA aal1 → 403 ERR-AUTH-004 + ไม่แตะ credit_rules", async () => {
    const mocks = mockPatch({ roles: [SR], aal: "aal1", currentRow: ruleRow() });
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(mocks.calls.update).toHaveLength(0);
  });

  it(":id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB", async () => {
    const mocks = mockPatch({ roles: [SR], currentRow: ruleRow() });
    const res = await PATCH(patchUrl("not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { field: string } } };
    expect(body.error.details.field).toBe("id");
    expect(mocks.calls.update).toHaveLength(0);
  });

  it.each([
    ["ไม่มี status", {}],
    ["มีคีย์แปลกปลอม", { status: "active", name: "แก้ชื่อ" }],
    ["status นอกค่าที่ยอม", { status: "draft" }],
    ["status ผิดชนิด", { status: 1 }],
  ])("body %s → 400 ERR-VAL-001 (strict)", async (_label, body) => {
    const mocks = mockPatch({ roles: [SR], currentRow: ruleRow() });
    const res = await PATCH(patchRequest(RULE_ID, body), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("ERR-VAL-001");
    expect(mocks.calls.update).toHaveLength(0);
  });

  it("current read error ฝั่ง DB → 503 ERR-SYS-002 credit_rule_query_failed", async () => {
    mockPatch({ roles: [SR], currentError: { message: "SQLSTATE XX000" } });
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("credit_rule_query_failed");
  });

  it("ไม่พบกฎ → 404 ERR-NF-001 + ไม่ UPDATE", async () => {
    const mocks = mockPatch({ roles: [SR], currentRow: null });
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(mocks.calls.update).toHaveLength(0);
  });
});

describe("PATCH — lifecycle transition (trigger 0010 mirror)", () => {
  const EXPECTED_INVALID =
    "เปลี่ยนสถานะกฎเครดิตไม่ได้: ทำได้เฉพาะเผยแพร่จากฉบับร่าง (ร่าง→ใช้งาน) หรือปลดระวัง (ใช้งาน→ปลดระวัง)";

  it("draft→retired ผิดกติกา → 400 + ข้อความไทยเจาะจง + ไม่ UPDATE", async () => {
    const mocks = mockPatch({ roles: [SR], currentRow: ruleRow({ status: "draft" }) });
    const res = await PATCH(patchRequest(RULE_ID, { status: "retired" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.message).toBe(EXPECTED_INVALID);
    expect(mocks.calls.update).toHaveLength(0);
  });

  it("retired→active ผิดกติกา → 400 + ข้อความไทยเดียวกัน", async () => {
    const mocks = mockPatch({ roles: [SR], currentRow: ruleRow({ status: "retired" }) });
    const res = await PATCH(patchRequest(RULE_ID, { status: "active" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(EXPECTED_INVALID);
    expect(mocks.calls.update).toHaveLength(0);
  });

  it("active→retired ถูกกติกา → 200 + สถานะใหม่ + audit สรุป transition", async () => {
    mockPatch({
      roles: [SR],
      currentRow: ruleRow({ status: "active" }),
      updatedRow: ruleRow({ status: "retired" }),
    });
    const { auditCalls } = mockServiceClient();
    const res = await PATCH(patchRequest(RULE_ID, { status: "retired" }), {
      params: Promise.resolve({ id: RULE_ID }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("retired");
    const args = auditCalls[0]?.args ?? {};
    const context = args["p_context"] as Record<string, unknown>;
    expect(context["status_from"]).toBe("active");
    expect(context["status_to"]).toBe("retired");
  });

  it("P0001 (trigger ปฏิเสธ — race กับผู้ใช้อื่น) → 400 + ข้อความไทยเดียวกัน ไม่ leak SQL", async () => {
    mockPatch({
      roles: [SR],
      currentRow: ruleRow({ status: "draft" }),
      updateError: { code: "P0001", message: "ข้อความ SQL ภายใน — ห้ามออก client" },
    });
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.message).toBe(EXPECTED_INVALID);
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("UPDATE error อื่น → 503 ERR-SYS-002 credit_rule_update_failed", async () => {
    mockPatch({
      roles: [SR],
      currentRow: ruleRow({ status: "draft" }),
      updateError: { code: "XX000", message: "boom" },
    });
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("credit_rule_update_failed");
  });

  it("updated row หายระหว่าง read/update → 404", async () => {
    mockPatch({
      roles: [SR],
      currentRow: ruleRow({ status: "draft" }),
      updatedRow: null,
    });
    const res = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    mockPatch({
      roles: [SR],
      currentRow: ruleRow({ status: "draft" }),
      updatedRow: ruleRow({ status: "active" }),
    });
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await PATCH(patchUrl(), { params: Promise.resolve({ id: RULE_ID }) } as never);
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

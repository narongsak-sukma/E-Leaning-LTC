/**
 * route.test — /api/v1/admin/users (Wave E Phase 5 · [#90])
 *
 * GET — RBAC user:view + aal2 · query strict · RPC admin_list_users (0035 §7) ·
 *       audit PII_ACCESS fail-closed ก่อนคืนแถว (ล้ม 2 ครั้ง → 503) · drift → 503 ·
 *       keyset nextCursor เซ็น · rate STAFF_WRITE
 * POST — RBAC user:create (super_admin เท่านั้น) · body strict (+reason 10-500) ·
 *       GoTrue invite + RPC admin_grant_role + durable audit USER_CREATE ผ่าน RPC
 *       admin_audit_user_created (0038 — retry จำกัด · ค้าง = 503 fail-closed) ·
 *       error tag → AppError · drift → 503 · PostgREST wrap [แถวเดียว] → unwrap
 *
 * mock ตามแบบ credit-rules/route.test.ts (vi.mock supabase/ssr + server · auth.getUser +
 * mfa + rpc my_roles · thenable builder · service client rpc/auth.admin)
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

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { ipHashOf } from "@/lib/auth/password-reset";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { userAgentHashOf } from "@/lib/security/hash";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { GET, POST } from "./route";

const SA = "super_admin";
const SR = "staff:registrar";
const SV = "staff:viewer";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const USER_ID = "b0000000-0000-4000-8000-000000000001";
const T1 = "2026-08-01T00:00:00+00:00";
const T2 = "2026-09-01T00:00:00+00:00";

/** แถวผู้ใช้จาก admin_list_users (snake_case ตรง 0035 §7 + is_banned/banned_until ของ RPC v2 0041) */
function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    display_name: "สมชาย ใจดี",
    email: "somchai@example.com",
    deleted_at: null,
    created_at: T1,
    roles: ["citizen"],
    has_verified_license: false,
    is_banned: false,
    banned_until: null,
    ...overrides,
  };
}

/** body ของ POST — reason 10-500 บังคับ (RPC บังคับเช่นเดียวกัน) */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "new.staff@example.com",
    displayName: "มานี รักเรียน",
    role: "staff:viewer",
    reason: "แต่งตั้งให้ดูแลรายงานประจำวัน",
    ...overrides,
  };
}

/** service client mock — rpc append_audit_event + auth.admin (invite/update) */
function makeServiceClient(options: {
  auditError?: unknown;
  inviteResult?: { data: unknown; error: unknown } | null;
  updateError?: unknown;
}): {
  client: Record<string, unknown>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  inviteCalls: Array<{ email: string; options: unknown }>;
  updateCalls: Array<{ userId: string; attrs: unknown }>;
} {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inviteCalls: Array<{ email: string; options: unknown }> = [];
  const updateCalls: Array<{ userId: string; attrs: unknown }> = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      return { error: options.auditError ?? null };
    }),
    auth: {
      admin: {
        inviteUserByEmail: vi.fn(async (email: string, opts: unknown) => {
          inviteCalls.push({ email, options: opts });
          const r = options.inviteResult ?? {
            data: { user: { id: "b0000000-0000-4000-8000-000000000009", invited_at: T1 } },
            error: null,
          };
          return r;
        }),
        updateUserById: vi.fn(async (userId: string, attrs: unknown) => {
          updateCalls.push({ userId, attrs });
          return { error: options.updateError ?? null };
        }),
      },
    },
  };
  return { client, rpcCalls, inviteCalls, updateCalls };
}

/**
 * client ครบชั้น RBAC — rpc my_roles + admin_list_users/admin_grant_role +
 * append_audit_event (user-JWT · AUDIT_READ ไม่ใช้ใน route นี้) · from("profiles") active
 */
function mockClient(options: {
  listResult?: { data?: unknown; error?: unknown } | null;
  grantResult?: { data?: unknown; error?: unknown } | null;
  /** transient error กี่ครั้งแรกของ admin_audit_user_created ก่อนคืนสำเร็จ (0 = สำเร็จทันที) */
  auditCreateErrors?: number;
  /** error ถาวรของ admin_audit_user_created (มีป้าย ERR-… = ไม่ retry) */
  auditCreateError?: unknown;
  roles: readonly string[];
  aal?: "aal1" | "aal2";
}): {
  readonly rpcCalls: ReadonlyArray<{ fn: string; args: Record<string, unknown> }>;
} {
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let auditCreateAttempts = 0;
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
      if (fn === "admin_list_users") {
        return {
          data: options.listResult?.data ?? null,
          error: options.listResult?.error ?? null,
        };
      }
      if (fn === "admin_grant_role") {
        return {
          data: options.grantResult?.data ?? null,
          error: options.grantResult?.error ?? null,
        };
      }
      if (fn === "admin_audit_user_created") {
        auditCreateAttempts += 1;
        if (options.auditCreateError !== undefined) {
          return { data: null, error: options.auditCreateError };
        }
        if (auditCreateAttempts <= (options.auditCreateErrors ?? 0)) {
          return { data: null, error: { message: "network timeout (transient)" } };
        }
        return {
          data: { userId: "b0000000-0000-4000-8000-000000000009", role: "staff:viewer", audited: true },
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : {})),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { rpcCalls };
}

function adminUrl(query = "", extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/v1/admin/users" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-1", ...extraHeaders },
  });
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/admin/users", {
    method: "POST",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-1" },
    body: JSON.stringify(body),
  });
}

let service: ReturnType<typeof makeServiceClient>;

/** เตรียม client คู่ (user-JWT + service) — เรียกในทุก test ก่อน handler */
function setup(options: Parameters<typeof mockClient>[0] & Parameters<typeof makeServiceClient>[0]): ReturnType<typeof mockClient> {
  service = makeServiceClient(options);
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service.client as never);
  return mockClient(options);
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/users — สิทธิ์ + keyset + PII audit", () => {
  it.each([[[SV]], [[SR]], [[SA]]])("บทบาท %j ถือ user:view → 200", async (roles) => {
    setup({ listResult: { data: { data: [userRow()], nextCursor: null } }, roles });
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean } };
    expect(body.page.hasMore).toBe(false);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: USER_ID, displayName: "สมชาย ใจดี", roles: ["citizen"] });
  });

  it("nextCursor จาก RPC → เซ็น (createdAt,id) · hasMore=true", async () => {
    setup({
      listResult: {
        data: {
          data: [userRow()],
          nextCursor: { createdAt: T2, id: "b0000000-0000-4000-8000-000000000002" },
        },
      },
      roles: [SR],
    });
    const res = await GET(adminUrl("?limit=20"));
    const body = (await res.json()) as { page: { nextCursor: string | null; hasMore: boolean } };
    expect(res.status).toBe(200);
    expect(body.page.hasMore).toBe(true);
    expect(decodeCursor(String(body.page.nextCursor))).toEqual({
      sortKey: T2,
      id: "b0000000-0000-4000-8000-000000000002",
    });
  });

  it("cursor ขาเข้า → แกะส่ง p_cursor_created_at/p_cursor_id ให้ RPC", async () => {
    const control = setup({ listResult: { data: { data: [], nextCursor: null } }, roles: [SR] });
    const cursor = encodeCursor({ sortKey: T1, id: USER_ID });
    const res = await GET(adminUrl("?cursor=" + encodeURIComponent(cursor)));
    expect(res.status).toBe(200);
    const listCall = control.rpcCalls.find((c) => c.fn === "admin_list_users");
    expect(listCall?.args["p_cursor_created_at"]).toBe(T1);
    expect(listCall?.args["p_cursor_id"]).toBe(USER_ID);
  });

  it("aal1 → 403 ERR-AUTH-004 ก่อนถึง RPC", async () => {
    setup({ roles: [SV], aal: "aal1" });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
  });

  it.each(["?status=deleted-forever", "?limit=0", "?foo=bar"])(
    "query %s ผิดรูป → 400 ERR-VAL-001 fields",
    async (query) => {
      setup({ roles: [SR] });
      const res = await GET(adminUrl(query));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: { fields: string[] } } };
      // ค่าว่าง = ไม่ระบุ — 400 ต้องมาจาก status/limit/คีย์แปลกปลอม ไม่ใช่ค่าว่าง
      expect(body.error.code).toBe("ERR-VAL-001");
    },
  );

  it("แถว drift (hasVerifiedLicense ผิดชนิด) → 503 admin_user_row_drift", async () => {
    setup({
      listResult: { data: { data: [userRow({ has_verified_license: "yes" })], nextCursor: null } },
      roles: [SR],
    });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("admin_user_row_drift");
  });

  it("RPC error มีป้าย (ERR-RBAC-001|role_scope) → 403 (ไม่ leak SQL)", async () => {
    setup({
      listResult: { error: { message: "...(ERR-RBAC-001|role_scope)" } },
      roles: [SR],
    });
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("PII audit ล้ม 2 ครั้ง → 503 (fail-closed — ไม่คืนแถวโดยไม่มี audit)", async () => {
    setup({
      listResult: { data: { data: [userRow()], nextCursor: null } },
      roles: [SR],
      auditError: { message: "42501 allowlist" },
    });
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("admin_users_pii_audit_unavailable");
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    setup({ listResult: { data: { data: [], nextCursor: null } }, roles: [SR] });
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await GET(adminUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { details: { group: string } } };
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });

  it("D76: audit PII_ACCESS รับ p_ip_hash/p_user_agent จาก request จริง (10.5.0.1 + UA ของ header) — ไม่ใช่ null · UA ต่างกัน = hash ต่างกัน", async () => {
    setup({ listResult: { data: { data: [userRow()], nextCursor: null } }, roles: [SR] });
    const ua = "Mozilla/5.0 (d76-users-route)";
    const res = await GET(adminUrl("", { "user-agent": ua }));
    expect(res.status).toBe(200);
    const auditCalls = service.rpcCalls.filter((c) => c.fn === "append_audit_event");
    expect(auditCalls).toHaveLength(1);
    const args = auditCalls[0]?.args ?? {};
    expect(args["p_ip_hash"]).toBe(ipHashOf("10.5.0.1"));
    expect(args["p_ip_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(args["p_user_agent"]).toBe(
      userAgentHashOf(new Request("http://localhost/", { headers: { "user-agent": ua } })),
    );
    expect(args["p_user_agent"]).toMatch(/^[0-9a-f]{64}$/);
    expect(args["p_request_id"]).toBe("req-e11-1");
    // D76 สองทิศ: UA ต่างกัน → hash ต่างกัน (ค่ามาจาก header จริง ไม่ใช่ค่าคงที่)
    setup({ listResult: { data: { data: [userRow()], nextCursor: null } }, roles: [SR] });
    const res2 = await GET(adminUrl("", { "user-agent": ua + "-variant-2" }));
    expect(res2.status).toBe(200);
    const auditCalls2 = service.rpcCalls.filter((c) => c.fn === "append_audit_event");
    const args2 = auditCalls2[0]?.args ?? {};
    expect(args2["p_user_agent"]).not.toBe(args["p_user_agent"]);
  });

  it("D76: request ไม่มี header user-agent → p_user_agent เป็น null (ตาม helper — ไม่ hash ค่าว่าง)", async () => {
    setup({ listResult: { data: { data: [userRow()], nextCursor: null } }, roles: [SR] });
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    const auditCalls = service.rpcCalls.filter((c) => c.fn === "append_audit_event");
    expect(auditCalls).toHaveLength(1);
    const args = auditCalls[0]?.args ?? {};
    expect(args["p_user_agent"]).toBeNull();
    expect(args["p_ip_hash"]).toBe(ipHashOf("10.5.0.1"));
  });
});

describe("POST /admin/users — สร้างบัญชีเจ้าหน้าที่ (super_admin เท่านั้น)", () => {
  it("super_admin สร้างสำเร็จ → 201 + invite พร้อม display_name + RPC grant + durable audit USER_CREATE (0038)", async () => {
    const control = setup({
      grantResult: { data: { userId: USER_ID, role: "staff:viewer", granted: true } },
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["userId"]).toBe("b0000000-0000-4000-8000-000000000009");
    expect(body.data["role"]).toBe("staff:viewer");
    expect(body.data["granted"]).toBe(true);
    // GoTrue invite — ส่ง display_name เข้า meta_data ให้ trigger สร้าง profiles
    expect(service.inviteCalls).toHaveLength(1);
    expect(service.inviteCalls[0]?.options).toEqual({ data: { display_name: "มานี รักเรียน" } });
    // RPC grant — user-JWT + reason ครบ
    const grantCall = control.rpcCalls.find((c) => c.fn === "admin_grant_role");
    expect(grantCall?.args["p_role"]).toBe("staff:viewer");
    expect(grantCall?.args["p_reason"]).toBe("แต่งตั้งให้ดูแลรายงานประจำวัน");
    expect(grantCall?.args["p_request_id"]).toBe("req-e11-1");
    // durable audit USER_CREATE — RPC user-JWT admin_audit_user_created (0038 §1)
    // พร้อม actor+reason ใน context (ไม่ใช่ service append_audit_event ที่ allowlist
    // ปฏิเสธ USER_* ทุกครั้งอีกแล้ว — gate p5-r1 B4)
    const auditCall = control.rpcCalls.find((c) => c.fn === "admin_audit_user_created");
    expect(auditCall?.args["p_target_user_id"]).toBe("b0000000-0000-4000-8000-000000000009");
    expect(auditCall?.args["p_role"]).toBe("staff:viewer");
    expect(auditCall?.args["p_reason"]).toBe("แต่งตั้งให้ดูแลรายงานประจำวัน");
    expect(service.rpcCalls.filter((c) => c.fn === "append_audit_event")).toHaveLength(0);
  });

  it("audit RPC transient 2 ครั้ง → retry ครั้งที่ 3 สำเร็จ → 201 (เยียวยาได้)", async () => {
    const control = setup({
      grantResult: { data: { userId: USER_ID, role: "staff:viewer", granted: true } },
      auditCreateErrors: 2,
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(201);
    expect(control.rpcCalls.filter((c) => c.fn === "admin_audit_user_created")).toHaveLength(3);
  });

  it("audit RPC transient 3 ครั้ง → 503 user_create_audit_failed (fail-closed — บัญชีถูกสร้างแล้ว ให้ตรวจซ้ำ ไม่ใช่ WARN เงียบ)", async () => {
    const control = setup({
      grantResult: { data: { userId: USER_ID, role: "staff:viewer", granted: true } },
      auditCreateErrors: 3,
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("user_create_audit_failed");
    // invite+grant เกิดแล้ว (ระบบภายนอก) — audit ค้างจึงต้องบอกให้ตรวจซ้ำ ไม่อ้างว่าสำเร็จ
    expect(service.inviteCalls).toHaveLength(1);
    expect(control.rpcCalls.filter((c) => c.fn === "admin_audit_user_created")).toHaveLength(3);
  }, 10_000);

  it("audit RPC ป้าย (ERR-AUTH-004) → 403 ทันที ไม่ retry (1 call)", async () => {
    const control = setup({
      grantResult: { data: { userId: USER_ID, role: "staff:viewer", granted: true } },
      auditCreateError: { message: "...(ERR-AUTH-004|mfa_required)" },
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(control.rpcCalls.filter((c) => c.fn === "admin_audit_user_created")).toHaveLength(1);
  });

  it("registrar เรียก → 403 (user:create = super_admin เท่านั้น) + ไม่แตะ GoTrue/RPC", async () => {
    const control = setup({ roles: [SR] });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(403);
    expect(service.inviteCalls).toHaveLength(0);
    expect(control.rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(0);
  });

  it.each([
    ["role เป็น super_admin", { role: "super_admin" }],
    ["reason สั้นเกิน", { reason: "สั้น" }],
    ["displayName ว่าง", { displayName: "" }],
    ["email ผิดรูป", { email: "not-an-email" }],
  ])("body %s → 400 ERR-VAL-001 ก่อนแตะ GoTrue/RPC", async (_label, overrides) => {
    const control = setup({ roles: [SA] });
    const res = await POST(postRequest(createBody(overrides)));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(service.inviteCalls).toHaveLength(0);
    expect(control.rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(0);
  });

  it("GoTrue 422 (อีเมลซ้ำ) → 400 ERR-VAL-001 email_already_registered", async () => {
    setup({
      inviteResult: { data: {}, error: { status: 422, message: "already registered" } },
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("email_already_registered");
  });

  it("GoTrue error อื่น → 503 ERR-SYS-002 (ไม่ leak ข้อความ GoTrue)", async () => {
    setup({
      inviteResult: { data: {}, error: { status: 500, message: "internal GoTrue failure xyz" } },
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details.reason).toBe("staff_user_invite_failed");
    expect(JSON.stringify(body)).not.toContain("internal GoTrue failure");
  });

  it("RPC grant ป้าย (ERR-VAL-001|no_verified_license) → 400 (ไม่ leak SQL)", async () => {
    const control = setup({
      grantResult: { error: { message: "...(ERR-VAL-001|no_verified_license)" } },
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("no_verified_license");
    expect(control.rpcCalls.filter((c) => c.fn === "admin_grant_role")).toHaveLength(1);
  });

  it("แถวที่ RPC คืน drift → 503 (lib จับ envelope ก่อน — admin_grant_role_row_drift)", async () => {
    setup({
      grantResult: { data: { userId: "not-a-uuid", role: "staff:viewer", granted: true } },
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("admin_grant_role_row_drift");
  });

  it("PostgREST wrap scalar jsonb เป็น [แถวเดียว] → unwrap แล้ว 201", async () => {
    setup({
      grantResult: { data: [{ userId: USER_ID, role: "staff:viewer", granted: false }] },
      roles: [SA],
    });
    const res = await POST(postRequest(createBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["granted"]).toBe(false);
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001 (POST)", async () => {
    setup({
      grantResult: { data: { userId: USER_ID, role: "staff:viewer", granted: true } },
      roles: [SA],
    });
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await POST(postRequest(createBody()));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { details: { group: string } } };
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});
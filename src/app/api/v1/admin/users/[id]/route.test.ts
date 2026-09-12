/**
 * route.test — PATCH /api/v1/admin/users/{id} (Wave E Phase 5 · [#90])
 *
 * - RBAC user:disable (super_admin เท่านั้น) · aal1 → 403 · :id ผิดรูป → 400
 * - body strict: is_active=false บังคับ reason 10-500 → 400 ก่อนแตะ DB/GoTrue
 * - guard: เป้าหมาย super_admin เมื่อผู้เรียกไม่ใช่ → 403 ก่อนแตะ GoTrue
 * - GoTrue ban/unban = ตัวบังคับจริง · profiles.is_active ตามหลัง · ล้มหลัง ban = 503
 * - audit USER_* best-effort (allowlist ยังไม่รับ — ล้มไม่กระทบ response)
 * - 200 { data: { userId, isActive } } · rate STAFF_WRITE
 *
 * mock ตามแบบ credit-rules/route.test.ts + ctx(id) แบบ certificates/[id]/revoke
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
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered }
  ;
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { PATCH } from "./route";

const SA = "super_admin";
const SR = "staff:registrar";
const CALLER_ID = "a0000000-0000-4000-8000-000000000001";
const TARGET_ID = "b0000000-0000-4000-8000-000000000001";
const OTHER_SA_ID = "b0000000-0000-4000-8000-000000000002";

/** เป้าหมายเป็น super_admin หรือไม่ — ตั้งใน test ก่อน setup() */
let raRow: { role: string } | null = null;

/** builders — role_assignments (guard) + profiles (update) พร้อม call ที่ตามจับ */
function makeBuilders(profilesError: unknown) {
  const raCalls: Array<{ column: string; value: unknown }> = [];
  const profilesUpdateCalls: Array<Record<string, unknown>> = [];
  const raBuilder = {
    select: vi.fn(() => raBuilder),
    eq: vi.fn((column: string, value: unknown) => {
      raCalls.push({ column, value });
      return raBuilder;
    }),
    is: vi.fn(() => raBuilder),
    limit: vi.fn(() => raBuilder),
    maybeSingle: vi.fn(async () => ({ data: raRow === null ? null : { role: raRow.role }, error: null })),
  };
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
    update: vi.fn((payload: Record<string, unknown>) => {
      profilesUpdateCalls.push(payload);
      return profilesBuilder;
    }),
    then: (res: (v: { data: null; error: unknown }) => unknown): unknown =>
      res({ data: null, error: profilesError ?? null }),
  };
  return { raCalls, profilesUpdateCalls, raBuilder, profilesBuilder };
}

/** user-JWT client (RBAC + role_assignments) + service client (GoTrue + profiles + rpc) */
function mockClient(options: {
  roles: readonly string[];
  aal?: "aal1" | "aal2";
  banError?: unknown;
  profilesError?: unknown;
  auditError?: unknown;
}) {
  const { raCalls, profilesUpdateCalls, raBuilder, profilesBuilder } = makeBuilders(options.profilesError);
  const banCalls: Array<{ userId: string; attrs: unknown }> = [];
  const svcRpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const userClient = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: CALLER_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: options.aal ?? "aal2" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) => {
      if (fn === "my_roles") {
        return { data: options.roles, error: null };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) =>
      table === "role_assignments" ? raBuilder : profilesBuilder,
    ),
  };
  const service = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      svcRpcCalls.push({ fn, args });
      return { error: options.auditError ?? null };
    }),
    auth: {
      admin: {
        updateUserById: vi.fn(async (userId: string, attrs: unknown) => {
          banCalls.push({ userId, attrs });
          return { error: options.banError ?? null };
        }),
      },
    },
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : {})),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(userClient as never);
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);
  return { raCalls, banCalls, profilesUpdateCalls, svcRpcCalls };
}

function patchRequest(body: unknown, targetId: string = TARGET_ID): Request {
  return new Request("http://localhost:3000/api/v1/admin/users/" + targetId, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e11-2" },
    body: JSON.stringify(body),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
  raRow = null;
});

describe("PATCH /admin/users/{id} — ปิด/เปิดใช้งานบัญชี", () => {
  it("SA ปิดบัญชี → 200 isActive=false + ban '876000h' + profiles.is_active=false", async () => {
    const control = mockClient({ roles: [SA] });
    const res = await PATCH(patchRequest({ is_active: false, reason: "ละเมิดข้อบังคับ ซ้ำ" }), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string; isActive: boolean } };
    expect(body.data.userId).toBe(TARGET_ID);
    expect(body.data.isActive).toBe(false);
    expect(control.banCalls).toEqual([{ userId: TARGET_ID, attrs: { ban_duration: "876000h" } }]);
    expect(control.profilesUpdateCalls).toEqual([{ is_active: false }]);
    const audit = control.svcRpcCalls.find((c) => c.fn === "append_audit_event");
    expect(audit?.args["p_action"]).toBe("USER_DISABLE");
  });

  it("SA เปิดบัญชี → 200 isActive=true + unban 'none' + is_active=true (ไม่บังคับ reason)", async () => {
    const control = mockClient({ roles: [SA] });
    const res = await PATCH(patchRequest({ is_active: true }), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { isActive: boolean } };
    expect(body.data.isActive).toBe(true);
    expect(control.banCalls).toEqual([{ userId: TARGET_ID, attrs: { ban_duration: "none" } }]);
    expect(control.profilesUpdateCalls).toEqual([{ is_active: true }]);
    const audit = control.svcRpcCalls.find((c) => c.fn === "append_audit_event");
    expect(audit?.args["p_action"]).toBe("USER_UPDATE");
  });

  it("เป้าหมาย super_admin เมื่อผู้เรียกไม่ใช่ → 403 ก่อนแตะ GoTrue (BFF guard)", async () => {
    raRow = { role: "super_admin" };
    const control = mockClient({ roles: [SR] });
    const res = await PATCH(patchRequest({ is_active: false, reason: "ละเมิดข้อบังคับ ซ้ำ" }), ctx(OTHER_SA_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details: { permission: string } } };
    expect(body.error.details.permission).toBe("user:disable");
    expect(control.banCalls).toHaveLength(0);
  });

  it("aal1 → 403 ERR-AUTH-004 ก่อนแตะ GoTrue", async () => {
    const control = mockClient({ roles: [SA], aal: "aal1" });
    const res = await PATCH(patchRequest({ is_active: false, reason: "ละเมิดข้อบังคับ ซ้ำ" }), ctx(TARGET_ID));
    expect(res.status).toBe(403);
    expect(control.banCalls).toHaveLength(0);
  });

  it(":id ผิดรูป → 400 ก่อนแตะ GoTrue", async () => {
    const control = mockClient({ roles: [SA] });
    const res = await PATCH(patchRequest({ is_active: false, reason: "ละเมิดข้อบังคับ ซ้ำ" }), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(control.banCalls).toHaveLength(0);
  });

  it("body ผิดรูป (is_active หาย) → 400 ก่อนแตะ GoTrue", async () => {
    const control = mockClient({ roles: [SA] });
    const res = await PATCH(patchRequest({}), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    expect(control.banCalls).toHaveLength(0);
  });

  it("is_active=false ไม่กรอก reason → 400 fields [reason] ก่อนแตะ GoTrue", async () => {
    const control = mockClient({ roles: [SA] });
    const res = await PATCH(patchRequest({ is_active: false }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields: string[] } } };
    expect(body.error.details.fields).toContain("reason");
    expect(control.banCalls).toHaveLength(0);
  });

  it("reason สั้นเกิน 10 → 400 ก่อนแตะ GoTrue", async () => {
    const control = mockClient({ roles: [SA] });
    const res = await PATCH(patchRequest({ is_active: false, reason: "สั้น" }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    expect(control.banCalls).toHaveLength(0);
  });

  it("GoTrue ban ล้ม → 503 gotrue_ban_failed ก่อนแตะ profiles (ไม่เกิดสถานะคลาดเคลื่อน)", async () => {
    const control = mockClient({ roles: [SA], banError: { message: "GoTrue down" } });
    const res = await PATCH(patchRequest({ is_active: false, reason: "ละเมิดข้อบังคับ ซ้ำ" }), ctx(TARGET_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("gotrue_ban_failed");
    expect(control.profilesUpdateCalls).toHaveLength(0);
  });

  it("profiles.is_active ล้มหลัง ban → 503 (บัญชีค้างถูกแบน fail-closed) + ยัง WARN audit", async () => {
    const control = mockClient({ roles: [SA], profilesError: { message: "update blocked" } });
    const res = await PATCH(patchRequest({ is_active: false, reason: "ละเมิดข้อบังคับ ซ้ำ" }), ctx(TARGET_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("profile_is_active_update_failed");
    // ban เกิดขึ้นแล้ว — คงสถานะ fail-closed
    expect(control.banCalls).toHaveLength(1);
    expect(control.profilesUpdateCalls).toHaveLength(1);
  });

  it("audit best-effort ล้ม → ยัง 200 (allowlist ยังไม่รับ USER_* — WARN เท่านั้น)", async () => {
    const control = mockClient({ roles: [SA], auditError: { message: "42501" } });
    const res = await PATCH(patchRequest({ is_active: false, reason: "ละเมิดข้อบังคับ ซ้ำ" }), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    expect(control.svcRpcCalls.filter((c) => c.fn === "append_audit_event")).toHaveLength(1);
  });

  it("rate STAFF_WRITE เกิน 60/min → 429 ERR-RATE-001", async () => {
    mockClient({ roles: [SA] });
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await PATCH(patchRequest({ is_active: true }), ctx(TARGET_ID));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { details: { group: string } } };
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});
/**
 * route.test — /api/v1/admin/license-applications (Wave E Phase 5 · API-SPEC §3.8 แถว 228)
 *
 * GET — RBAC license:verify (registrar/super_admin · aal2) · query strict · keyset
 * (submitted_at,id) DESC · แถวตรงสัญญา lane F ครบ 9 key · evidenceUrl signed 5 นาที ·
 * audit PII_ACCESS fail-closed · drift → 503
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
import { encodeCursor } from "@/lib/api/pagination";
import { GET } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const APP_ID = "b0000000-0000-4000-8000-000000000001";
const T1 = "2026-08-01T00:00:00+00:00";
const T2 = "2026-09-01T00:00:00+00:00";
const SIGNED_URL = "https://stub.supabase.co/storage/v1/object/sign/license-evidence/x?token=t";

/** แถวดิบ (select + embed profiles/media_assets) */
function appRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APP_ID,
    user_id: "u0000000-0000-4000-8000-000000000001",
    license_no: "1234567",
    status: "pending",
    submitted_at: T2,
    decided_at: null,
    rejected_reason: null,
    profiles: { display_name: "สมศรี ใจดี", email: "somsri@example.com" },
    media_assets: null,
    ...overrides,
  };
}

/**
 * staff client ครบชั้น requirePermission — auth/mfa/profiles/my_roles ·
 * from("license_applications") → thenable builder ติดตาม chain · storage.createSignedUrl
 */
function mockStaffClient(options: {
  readonly roles?: readonly string[];
  readonly aal?: "aal1" | "aal2";
  readonly rows?: unknown[];
  readonly queryError?: unknown;
  readonly signedUrl?: string | null;
  readonly signedError?: unknown;
  readonly auditError?: unknown;
} = {}): {
  readonly calls: {
    readonly select: unknown[];
    readonly eq: Array<{ column: string; value: unknown }>;
    readonly or: string[];
    readonly order: Array<[string, { ascending: boolean }]>;
    readonly limit: unknown[];
    readonly signedCalls: Array<{ path: unknown; ttl: unknown }>;
  };
  readonly auditCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} {
  const calls = {
    select: [] as unknown[],
    eq: [] as Array<{ column: string; value: unknown }>,
    or: [] as string[],
    order: [] as Array<[string, { ascending: boolean }]>,
    limit: [] as unknown[],
    signedCalls: [] as Array<{ path: unknown; ttl: unknown }>,
  };
  const auditCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const queryResult: { data: unknown; error: unknown } =
    options.queryError !== undefined
      ? { data: null, error: options.queryError }
      : { data: options.rows ?? [], error: null };
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
    then: (res: (v: { data: unknown; error: unknown }) => unknown): unknown => res(queryResult),
  };
  const storage = {
    from: vi.fn(() => storage),
    createSignedUrl: vi.fn(async (path: unknown, ttl: unknown) => {
      calls.signedCalls.push({ path, ttl });
      if (options.signedError !== undefined) {
        return { data: null, error: options.signedError };
      }
      return { data: { signedUrl: options.signedUrl ?? SIGNED_URL }, error: null };
    }),
  };
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const auditRpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    auditCalls.push({ fn, args });
    return { data: null, error: options.auditError ?? null };
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
    rpc: vi.fn(async (fn: string) => {
      if (fn === "my_roles") {
        return { data: options.roles ?? ["staff:registrar"], error: null };
      }
      return { data: null, error: null };
    }),
    storage,
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : builder)),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ rpc: auditRpc } as never);
  return { calls, auditCalls };
}

function listUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/license-applications" + query, {
    headers: { "x-forwarded-for": "10.9.0.1", "x-request-id": "req-admin-lic-1" },
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  resetRateLimitStore();
});

describe("GET /api/v1/admin/license-applications", () => {
  it("registrar — 200 · แถวตรงสัญญา lane F ครบ 9 key · keyset + audit PII_ACCESS", async () => {
    const { calls, auditCalls } = mockStaffClient({ rows: [appRow(), appRow({ id: "b0000000-0000-4000-8000-000000000002", submitted_at: T1 })] });
    const res = await GET(listUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      page?: { nextCursor?: string | null };
    };
    expect(body.data).toHaveLength(2);
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual(
      ["decidedAt", "displayName", "email", "evidenceUrl", "id", "licenseNo", "reason", "status", "submittedAt"],
    );
    expect(body.data[0]).toEqual({
      id: APP_ID,
      displayName: "สมศรี ใจดี",
      email: "somsri@example.com",
      licenseNo: "1234567",
      status: "pending",
      submittedAt: T2,
      decidedAt: null,
      reason: null,
      evidenceUrl: null,
    });
    expect(calls.select[0]).toContain(
      "profiles!license_applications_user_id_fkey(display_name,email)",
    );
    expect(calls.select[0]).toContain(
      "media_assets!license_applications_evidence_media_id_fkey(storage_path)",
    );
    expect(calls.limit[0]).toBe(21);
    expect(calls.order).toEqual([
      ["submitted_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(calls.eq).toEqual([]);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.fn).toBe("append_audit_event");
    expect(auditCalls[0]?.args["p_action"]).toBe("PII_ACCESS");
    expect(auditCalls[0]?.args["p_entity_type"]).toBe("license_application");
  });

  it("super_admin ได้ด้วย · staff:content โดนปฏิเสธ 403 · aal1 โดนปฏิเสธ 403", async () => {
    mockStaffClient({ roles: ["super_admin"] });
    expect((await GET(listUrl())).status).toBe(200);
    mockStaffClient({ roles: ["staff:content"] });
    expect((await GET(listUrl())).status).toBe(403);
    mockStaffClient({ roles: ["staff:registrar"], aal: "aal1" });
    expect((await GET(listUrl())).status).toBe(403);
  });

  it("filter status → eq + limit ตาม ?limit · 3 แถวกับ limit=2 → nextCursor", async () => {
    const { calls } = mockStaffClient({
      rows: [appRow(), appRow({ id: "b0000000-0000-4000-8000-000000000002", submitted_at: T1 }), appRow({ id: "b0000000-0000-4000-8000-000000000003", submitted_at: T1 })],
    });
    const res = await GET(listUrl("?status=pending&limit=2"));
    expect(res.status).toBe(200);
    expect(calls.eq).toEqual([{ column: "status", value: "pending" }]);
    expect(calls.limit[0]).toBe(3);
    const body = (await res.json()) as { data: unknown[]; page: { nextCursor?: string | null } };
    expect(body.data).toHaveLength(2);
    expect(typeof body.page.nextCursor).toBe("string");
  });

  it("cursor → or-filter row-wise (submitted_at,id) DESC", async () => {
    const { calls } = mockStaffClient({ rows: [] });
    const cursor = encodeCursor({ sortKey: T1, id: "b0000000-0000-4000-8000-000000000002" });
    const res = await GET(listUrl(`?cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(200);
    expect(calls.or).toEqual([
      `submitted_at.lt.${T1},and(submitted_at.eq.${T1},id.lt.b0000000-0000-4000-8000-000000000002)`,
    ]);
  });

  it("media_assets มี path → evidenceUrl signed 300s · storage ล้ม = null (graceful)", async () => {
    const withMedia = mockStaffClient({
      rows: [appRow({ media_assets: { storage_path: "license-evidence/u1/abc.png" } })],
    });
    const res1 = await GET(listUrl());
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { data: Array<{ evidenceUrl: string | null }> };
    expect(body1.data[0]?.evidenceUrl).toBe(SIGNED_URL);
    expect(withMedia.calls.signedCalls).toEqual([
      { path: "license-evidence/u1/abc.png", ttl: 300 },
    ]);
    mockStaffClient({
      rows: [appRow({ media_assets: { storage_path: "license-evidence/u1/abc.png" } })],
      signedError: { message: "storage down" },
    });
    const res2 = await GET(listUrl());
    const body2 = (await res2.json()) as { data: Array<{ evidenceUrl: string | null }> };
    expect(body2.data[0]?.evidenceUrl).toBeNull();
  });

  it("query strict — status=weird → 400 · limit=0 → 400 · key แปลกปลอม → 400", async () => {
    mockStaffClient({ rows: [] });
    for (const query of ["?status=weird", "?limit=0", "?limit=101", "?bogus=1"]) {
      expect((await GET(listUrl(query))).status).toBe(400);
    }
  });

  it("DB query ล้ม → 503 license_applications_query_failed", async () => {
    mockStaffClient({ queryError: { message: "db down" } });
    const res = await GET(listUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason?: string } } };
    expect(body.error.details.reason).toBe("license_applications_query_failed");
  });

  it("แถว drift (สถานะนอก enum) → 503 license_application_row_drift", async () => {
    mockStaffClient({ rows: [appRow({ status: "processing" })] });
    const res = await GET(listUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason?: string } } };
    expect(body.error.details.reason).toBe("license_application_row_drift");
  });

  it("audit ล้ม 2 ครั้ง → 503 fail-closed license_applications_pii_audit_unavailable", async () => {
    mockStaffClient({ rows: [appRow()], auditError: { message: "rpc denied" } });
    const res = await GET(listUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason?: string } } };
    expect(body.error.details.reason).toBe("license_applications_pii_audit_unavailable");
  });

  it("ไม่มี session → 401", async () => {
    mockStaffClient({ aal: "aal2" });
    vi.mocked(createSupabaseSsrClient).mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "no" } })) },
    } as never);
    const res = await GET(listUrl());
    expect(res.status).toBe(401);
  });
});

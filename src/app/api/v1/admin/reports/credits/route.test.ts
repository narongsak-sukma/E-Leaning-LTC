/**
 * route.test — GET /api/v1/admin/reports/credits (Wave E · D55-6)
 * ตรวจ: RBAC 2 ชั้น (sr/sv/sa) · query strict · x-ltc-truncated · drift → 503
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
vi.mock("@/lib/reports/views", () => ({
  listEnrollmentProgress: vi.fn(),
  listAssessmentStatistics: vi.fn(),
  listCreditBalances: vi.fn(),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { listCreditBalances } from "@/lib/reports/views";
import { GET } from "./route";

const SV = "staff:viewer";
const SE = "staff:exam";
const SR = "staff:registrar";
const SA = "super_admin";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";

function mockAuth(roles: readonly string[], aal: "aal1" | "aal2" = "aal2") {
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: STAFF_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: aal }, error: null })),
      },
    },
    rpc: vi.fn(async (fn: string) => (fn === "my_roles" ? { data: roles, error: null } : { data: null, error: null })),
    from: vi.fn(() => profilesBuilder),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
}

function getUrl(query = "") {
  return new Request("http://localhost:3000/api/v1/admin/reports/credits" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e5-2" },
  });
}

const ROW = { userId: "f1000000-0000-4000-8000-000000000001", renewalCycleId: "d1000000-0000-4000-8000-000000000001", creditType: "CPD", balance: 12.5, lastEntryAt: "2026-01-31T00:00:00+00:00" };

beforeEach(() => {
  vi.mocked(listCreditBalances).mockReset();
  resetRateLimitStore();
});

describe("RBAC ของ credits", () => {
  it.each([[[SR]], [[SV]], [[SA]]])("บทบาท %j → 200", async (roles) => {
    mockAuth(roles);
    vi.mocked(listCreditBalances).mockResolvedValue({ rows: [ROW], truncated: false } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
  });
  it.each([[[SE]]])("บทบาท %j → 403 ERR-RBAC-001 + ไม่เรียก lib", async (roles) => {
    mockAuth(roles);
    const res = await GET(getUrl());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("report:view");
    expect(listCreditBalances).not.toHaveBeenCalled();
  });
});

describe("query + response ของ credits", () => {
  it("query ผิดรูป (limit=abc) → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth([SR]);
    const res = await GET(getUrl("?limit=abc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(listCreditBalances).not.toHaveBeenCalled();
  });
  it("คีย์แปลกปลอมใน query → 400 ERR-VAL-001", async () => {
    mockAuth([SR]);
    const res = await GET(getUrl("?foo=bar"));
    expect(res.status).toBe(400);
  });
  it("truncated → header x-ltc-truncated: true · ไม่ truncated → ไม่มี header", async () => {
    mockAuth([SR]);
    vi.mocked(listCreditBalances).mockResolvedValue({ rows: [], truncated: true } as never);
    const res = await GET(getUrl());
    expect(res.headers.get("x-ltc-truncated")).toBe("true");
    vi.mocked(listCreditBalances).mockResolvedValue({ rows: [ROW], truncated: false } as never);
    resetRateLimitStore();
    const res2 = await GET(getUrl());
    expect(res2.headers.get("x-ltc-truncated")).toBeNull();
  });
  it("แถว drift (คีย์แปลกปลอม) → 503 ERR-SYS-002 credit_balance_drift", async () => {
    mockAuth([SR]);
    vi.mocked(listCreditBalances).mockResolvedValue({
      rows: [{ ...ROW, leak_col: "x" }],
      truncated: false,
    } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("credit_balance_drift");
  });
});

describe("GET credits — ตัวกรอง from/to", () => {
  it("from/to ถูกต้อง → lib รับค่าครบ", async () => {
    mockAuth([SR]);
    vi.mocked(listCreditBalances).mockResolvedValue({ rows: [], truncated: false } as never);
    const res = await GET(getUrl("?from=2026-01-01T00:00:00%2B00:00&to=2026-02-01T00:00:00-06:00"));
    expect(res.status).toBe(200);
    expect(vi.mocked(listCreditBalances).mock.calls[0]?.[0]).toEqual({
      limit: 100,
      from: "2026-01-01T00:00:00+00:00",
      to: "2026-02-01T00:00:00-06:00",
    });
  });
});

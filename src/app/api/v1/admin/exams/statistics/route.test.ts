/**
 * route.test — GET /api/v1/admin/reports/exams/statistics (Wave E · D55-6)
 * ตรวจ: RBAC 2 ชั้น (se/sv/sa — sr โดน 403 (D12-23)) · query strict · x-ltc-truncated · drift → 503
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
vi.mock("@/lib/reports/monitoring", () => ({
  getExamMonitoring: vi.fn(),
  getExamStatistics: vi.fn(),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { getExamStatistics } from "@/lib/reports/monitoring";
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
  return new Request("http://localhost:3000/api/v1/admin/reports/exams/statistics" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e5-2" },
  });
}

const ROW = { assessmentId: "a1000000-0000-4000-8000-000000000001", attemptTotal: 8, attemptPassed: 6, passRatePct: 75, avgScorePct: 82.5 };

beforeEach(() => {
  vi.mocked(getExamStatistics).mockReset();
  resetRateLimitStore();
});

describe("RBAC ของ exams/statistics", () => {
  it.each([[[SE]], [[SV]], [[SA]]])("บทบาท %j → 200", async (roles) => {
    mockAuth(roles);
    vi.mocked(getExamStatistics).mockResolvedValue({ rows: [ROW], truncated: false } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
  });
  it.each([[[SR]]])("บทบาท %j → 403 ERR-RBAC-001 + ไม่เรียก lib", async (roles) => {
    mockAuth(roles);
    const res = await GET(getUrl());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("report:view");
    expect(getExamStatistics).not.toHaveBeenCalled();
  });
});

describe("query + response ของ exams/statistics", () => {
  it("query ผิดรูป (limit=abc) → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth([SE]);
    const res = await GET(getUrl("?limit=abc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(getExamStatistics).not.toHaveBeenCalled();
  });
  it("คีย์แปลกปลอมใน query → 400 ERR-VAL-001", async () => {
    mockAuth([SE]);
    const res = await GET(getUrl("?foo=bar"));
    expect(res.status).toBe(400);
  });
  it("truncated → header x-ltc-truncated: true · ไม่ truncated → ไม่มี header", async () => {
    mockAuth([SE]);
    vi.mocked(getExamStatistics).mockResolvedValue({ rows: [], truncated: true } as never);
    const res = await GET(getUrl());
    expect(res.headers.get("x-ltc-truncated")).toBe("true");
    vi.mocked(getExamStatistics).mockResolvedValue({ rows: [ROW], truncated: false } as never);
    resetRateLimitStore();
    const res2 = await GET(getUrl());
    expect(res2.headers.get("x-ltc-truncated")).toBeNull();
  });
  it("แถว drift (คีย์แปลกปลอม) → 503 ERR-SYS-002 exam_statistics_drift", async () => {
    mockAuth([SE]);
    vi.mocked(getExamStatistics).mockResolvedValue({
      rows: [{ ...ROW, leak_col: "x" }],
      truncated: false,
    } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("exam_statistics_drift");
  });
});

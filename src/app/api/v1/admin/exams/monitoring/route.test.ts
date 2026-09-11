/**
 * route.test — GET /api/v1/admin/exams/monitoring (Wave E · D55-6)
 * ตรวจ: RBAC 2 ชั้น (se/sa · sv/sr 403) · ไม่มี user_id รายคน · drift → 503
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
import { getExamMonitoring } from "@/lib/reports/monitoring";
import { GET } from "./route";

const SE = "staff:exam";
const SA = "super_admin";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const A1 = "a1000000-0000-4000-8000-000000000001";
const C1 = "c1000000-0000-4000-8000-000000000001";

const PAYLOAD = {
  generatedAt: "2026-09-12T00:00:00+00:00",
  summary: { inProgressCount: 3, overdueCount: 2 },
  byAssessment: [{ assessmentId: A1, inProgress: 3, overdue: 2 }],
  byCourse: [{ courseId: C1, inProgress: 3, overdue: 2 }],
};

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

function getUrl() {
  return new Request("http://localhost:3000/api/v1/admin/exams/monitoring", {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e5-3" },
  });
}

beforeEach(() => {
  vi.mocked(getExamMonitoring).mockReset();
  resetRateLimitStore();
});

describe("RBAC ของ exams/monitoring", () => {
  it.each([[[SE]], [[SA]]])("บทบาท %j → 200 (payload ไม่มี user_id รายคน)", async (roles) => {
    mockAuth(roles);
    vi.mocked(getExamMonitoring).mockResolvedValue(PAYLOAD as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(PAYLOAD);
    expect(JSON.stringify(body)).not.toContain("userId");
  });
  it.each([[["staff:viewer"]], [["staff:registrar"]]])("บทบาท %j → 403 + ไม่เรียก lib", async (roles) => {
    mockAuth(roles);
    const res = await GET(getUrl());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("attempt:view");
    expect(getExamMonitoring).not.toHaveBeenCalled();
  });
});

describe("payload ของ monitoring", () => {
  it("drift (คีย์แปลกปลอมใน summary) → 503 ERR-SYS-002 exam_monitoring_drift", async () => {
    mockAuth([SE]);
    vi.mocked(getExamMonitoring).mockResolvedValue({
      ...PAYLOAD,
      summary: { inProgressCount: 3, overdueCount: 2, leak: 1 },
    } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("exam_monitoring_drift");
  });
  it("byAssessment แถวมี user_id (แนวคิด PII รายคน) → 503 เพราะ schema strict", async () => {
    mockAuth([SE]);
    vi.mocked(getExamMonitoring).mockResolvedValue({
      ...PAYLOAD,
      byAssessment: [{ assessmentId: A1, inProgress: 3, overdue: 2, userId: "x" }],
    } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
  });
});

/**
 * route.test — GET /api/v1/admin/reports/enrollments (Wave E · D55-6)
 * ตรวจ: RBAC 2 ชั้น (sv/sa · se/sr 403) · rate · query strict · x-ltc-truncated ·
 * drift → 503 · ไม่เรียก lib เมื่อ gate ตี
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
import { listEnrollmentProgress } from "@/lib/reports/views";
import { GET } from "./route";

const SV = "staff:viewer";
const SE = "staff:exam";
const SR = "staff:registrar";
const SA = "super_admin";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";

/** client จำลองสำหรับ requirePermission (auth + my_roles + profiles) */
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

function getUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/reports/enrollments" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e5-1" },
  });
}

const ROW = {
  enrollmentId: "e0000000-0000-4000-8000-000000000001",
  userId: "f0000000-0000-4000-8000-000000000001",
  courseId: COURSE_ID,
  lessonTotal: 10,
  lessonCompleted: 4,
  progressPct: 40,
};

beforeEach(() => {
  vi.mocked(listEnrollmentProgress).mockReset();
  resetRateLimitStore();
});

describe("RBAC — กรอบบทบาทของ GET /admin/reports/enrollments", () => {
  it.each([[[SV]], [[SA]], [[SV, SA]]])("บทบาท %j → 200", async (roles) => {
    mockAuth(roles);
    vi.mocked(listEnrollmentProgress).mockResolvedValue({ rows: [ROW], truncated: false } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
  });
  it.each([[[SE]], [[SR]]])("บทบาท %j → 403 ERR-RBAC-001 + ไม่เรียก lib", async (roles) => {
    mockAuth(roles);
    const res = await GET(getUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("report:view");
    expect(listEnrollmentProgress).not.toHaveBeenCalled();
  });
  it("aal1 (ยังไม่ยืนยัน MFA) → 403 ERR-AUTH-004", async () => {
    mockAuth([SV], "aal1");
    const res = await GET(getUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });
  it("ไม่ล็อกอิน (getUser ไม่สำเร็จ) → 401 ERR-AUTH-001", async () => {
    const client = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "no session" } })),
        mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: "aal2" }, error: null })) },
      },
      rpc: vi.fn(async () => ({ data: null, error: null })),
      from: vi.fn(() => {
        const b = {
          select: vi.fn(() => b),
          eq: vi.fn(() => b),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        };
        return b;
      }),
    };
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-001");
  });
});

describe("GET enrollments — query + response", () => {
  it("sv + limit/courseId → 200 { data } + lib รับค่าถูก", async () => {
    mockAuth([SV]);
    vi.mocked(listEnrollmentProgress).mockResolvedValue({ rows: [ROW], truncated: false } as never);
    const res = await GET(getUrl(`?limit=5&courseId=${COURSE_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toEqual(ROW);
    expect(vi.mocked(listEnrollmentProgress).mock.calls[0]?.[0]).toEqual({
      limit: 5,
      courseId: COURSE_ID,
    });
  });
  it("limit ไม่ได้ส่ง → default 100 (lib)", async () => {
    mockAuth([SV]);
    vi.mocked(listEnrollmentProgress).mockResolvedValue({ rows: [], truncated: false } as never);
    await GET(getUrl());
    expect(vi.mocked(listEnrollmentProgress).mock.calls[0]?.[0]).toEqual({ limit: 100, courseId: undefined });
  });
  it("limit=abc / limit=501 / คีย์แปลกปลอม → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth([SV]);
    for (const q of ["?limit=abc", "?limit=501", "?foo=bar"]) {
      resetRateLimitStore();
      const res = await GET(getUrl(q));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("ERR-VAL-001");
    }
    expect(listEnrollmentProgress).not.toHaveBeenCalled();
  });
  it("truncated → header x-ltc-truncated: true", async () => {
    mockAuth([SA]);
    vi.mocked(listEnrollmentProgress).mockResolvedValue({ rows: [], truncated: true } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ltc-truncated")).toBe("true");
  });
  it("ไม่ truncated → ไม่มี header x-ltc-truncated", async () => {
    mockAuth([SA]);
    vi.mocked(listEnrollmentProgress).mockResolvedValue({ rows: [ROW], truncated: false } as never);
    const res = await GET(getUrl());
    expect(res.headers.get("x-ltc-truncated")).toBeNull();
  });
  it("แถว drift (คีย์แปลกปลอม) → 503 ERR-SYS-002 enrollment_progress_drift", async () => {
    mockAuth([SV]);
    vi.mocked(listEnrollmentProgress).mockResolvedValue({
      rows: [{ ...ROW, holder_email: "x" }],
      truncated: false,
    } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("enrollment_progress_drift");
  });
});

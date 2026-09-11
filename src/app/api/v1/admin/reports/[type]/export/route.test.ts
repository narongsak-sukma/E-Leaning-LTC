/**
 * route.test — GET /api/v1/admin/reports/:type/export (Wave E · D55-6)
 * ตรวจ: RBAC 2 ชั้นต่อประเภท (D12-23) · type ไม่รู้จัก → 404 · header ไฟล์
 * (content-type/content-disposition/x-ltc-truncated) · runExport ได้รับตัวกรองครบ
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
vi.mock("@/lib/reports/export", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reports/export")>("@/lib/reports/export");
  return {
    ...actual,
    runExport: vi.fn(),
  };
});

import { AppError } from "@/lib/errors";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { runExport } from "@/lib/reports/export";
import { GET } from "./route";

const SV = "staff:viewer";
const SE = "staff:exam";
const SR = "staff:registrar";
const SA = "super_admin";
const STAFF_ID = "a0000000-0000-4000-8000-000000000001";

const RESULT = {
  exportId: "exp-1",
  contentType: "text/csv; charset=utf-8",
  filename: "ltc-report-enrollments-20260912.csv",
  body: "body",
  rowCount: 2,
  truncated: false,
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

function getUrl(path: string, query = "") {
  return new Request(
    "http://localhost:3000/api/v1/admin/reports/" + path + "/export" + query,
    { headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e5-4" } },
  );
}

beforeEach(() => {
  vi.mocked(runExport).mockReset();
  resetRateLimitStore();
});

describe("RBAC ของ export (D12-23)", () => {
  it.each([
    ["enrollments", [SV], 200],
    ["enrollments", [SA], 200],
    ["enrollments", [SE], 403],
    ["enrollments", [SR], 403],
    ["assessments", [SE], 200],
    ["assessments", [SV], 200],
    ["assessments", [SR], 403],
    ["credits", [SR], 200],
    ["credits", [SV], 200],
    ["credits", [SE], 403],
  ])("type %s + %j → %i", async (type, roles, status) => {
    mockAuth(roles);
    vi.mocked(runExport).mockReset();
    vi.mocked(runExport).mockResolvedValue(RESULT as never);
    const res = await GET(getUrl(type), { params: Promise.resolve({ type }) });
    expect(res.status).toBe(status);
    if (status === 200) {
      expect(runExport).toHaveBeenCalledTimes(1);
    } else {
      expect(runExport).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.error.code).toBe("ERR-RBAC-001");
    }
  });
});

describe("contract ของ export route", () => {
  it("type ไม่รู้จัก → 404 ERR-NF-001 (ไม่เรียก runExport)", async () => {
    mockAuth([SA]);
    const res = await GET(getUrl("unknown"), { params: Promise.resolve({ type: "unknown" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-NF-001");
    expect(runExport).not.toHaveBeenCalled();
  });
  it("200 CSV — content-type/content-disposition ถูกต้อง · runExport รับ type/format/requestedBy", async () => {
    mockAuth([SV]);
    vi.mocked(runExport).mockResolvedValue(RESULT as never);
    const res = await GET(getUrl("enrollments"), { params: Promise.resolve({ type: "enrollments" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="ltc-report-enrollments-20260912.csv"',
    );
    expect(vi.mocked(runExport).mock.calls[0]?.[0]).toMatchObject({
      type: "enrollments",
      format: "csv",
      requestedBy: STAFF_ID,
      requestId: "req-e5-4",
    });
  });
  it("format=json → content-type json", async () => {
    mockAuth([SR]);
    vi.mocked(runExport).mockResolvedValue({ ...RESULT, contentType: "application/json; charset=utf-8", filename: "ltc-report-credits-20260912.json" } as never);
    const res = await GET(getUrl("credits", "?format=json"), { params: Promise.resolve({ type: "credits" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="ltc-report-credits-20260912.json"',
    );
  });
  it("truncated → header x-ltc-truncated: true · ไม่ truncated → ไม่มี header", async () => {
    mockAuth([SV]);
    vi.mocked(runExport).mockResolvedValue({ ...RESULT, truncated: true } as never);
    const res = await GET(getUrl("enrollments"), { params: Promise.resolve({ type: "enrollments" }) });
    expect(res.headers.get("x-ltc-truncated")).toBe("true");
    vi.mocked(runExport).mockResolvedValue(RESULT as never);
    resetRateLimitStore();
    const res2 = await GET(getUrl("enrollments"), { params: Promise.resolve({ type: "enrollments" }) });
        expect(res2.headers.get("x-ltc-truncated")).toBeNull();
  });
  it("query ผิดรูป (format=xml) → 400 ERR-VAL-001 (ไม่เรียก runExport)", async ()  => {
    mockAuth([SV]);
    const res = await GET(getUrl("enrollments", "?format=xml"), { params: Promise.resolve({ type: "enrollments" }) });
    expect(res.status).toBe(400);
    expect(runExport).not.toHaveBeenCalled();
  });
  it("runExport fail-closed (report_exports เขียนไม่ได้) → 503 ERR-SYS-002", async () => {
    mockAuth([SV]);
    vi.mocked(runExport).mockRejectedValue(
      new AppError("ERR-SYS-002", { details: { reason: "report_exports_write_failed" } }),
    );
    const res = await GET(getUrl("enrollments"), { params: Promise.resolve({ type: "enrollments" }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("report_exports_write_failed");
  });
});

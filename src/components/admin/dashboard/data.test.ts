/**
 * unit tests — dashboard/data (Wave E Phase 5 · lane F · ADM-001)
 * ครอบ: parseDashboardStats · defaultDashboardRange · isIsoDate · dashboardRangeValid
 * · getAdminDashboard (200 → ok · 401/403 → forbidden · 500/network/ผิดรูป → server)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:53227";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  DASHBOARD_DEFAULT_DAYS,
  dashboardRangeValid,
  defaultDashboardRange,
  getAdminDashboard,
  isIsoDate,
  parseDashboardStats,
} from "./data";

/** view model flat ที่การ์ด KPI ใช้ (ผลลัพธ์หลัง map) */
const EXPECTED = {
  usersNew: 5,
  usersTotal: 120,
  enrollmentsNew: 42,
  examAttempts: 30,
  examPassed: 21,
  examPassRatePct: 66.67,
  certificatesIssued: 18,
  creditsIssued: 180.5,
};

/**
 * รูปร่างบน wire จริง = jsonb ซ้อนของ RPC admin_dashboard_stats (API-SPEC 1.2.1 —
 * passRatePct/credits.issued เป็น numeric ได้เศษ) · เดิม fixture เขียน flat
 * ตรง ๆ ทำ parser ผ่านเท็จกับรูปที่ BFF ไม่เคยส่ง (e2e-16 t5 จับ drift นี้)
 */
const WIRE = {
  range: { from: "2026-08-14", to: "2026-09-12" },
  users: { new: 5, total: 120 },
  enrollments: { new: 42 },
  exams: { attempts: 30, passed: 21, passRatePct: 66.67 },
  certificates: { issued: 18 },
  credits: { issued: 180.5 },
};

const STATS = EXPECTED;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stubBff(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> => jsonResponse(status, body)),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.headers.mockReset();
  mocks.headers.mockResolvedValue({ get: () => "sb-auth=token123" });
});

describe("parseDashboardStats", () => {
  it("jsonb ซ้อนของ RPC ครบทุกกลุ่ม → map เป็น view flat ได้ครบ (ทศนิยมคงเดิม)", () => {
    expect(parseDashboardStats({ data: WIRE })).toEqual(EXPECTED);
  });

  it("passRatePct null (ไม่มีคนสอบ) → ยอมและคง null", () => {
    expect(
      parseDashboardStats({
        data: { ...WIRE, exams: { ...WIRE.exams, passRatePct: null } },
      }),
    ).toEqual({ ...EXPECTED, examPassRatePct: null });
  });

  it("คีย์ใดผิด type → null (fail-closed)", () => {
    expect(parseDashboardStats({ data: { ...WIRE, users: { new: "5", total: 120 } } })).toBeNull();
    expect(
      parseDashboardStats({ data: { ...WIRE, exams: { ...WIRE.exams, passRatePct: -1 } } }),
    ).toBeNull();
  });

  it("กลุ่มใดขาดหาย / ไม่ใช่ object / ไม่มี data → null", () => {
    expect(parseDashboardStats({ data: { ...WIRE, credits: null } })).toBeNull();
    expect(parseDashboardStats(null)).toBeNull();
    expect(parseDashboardStats({ nope: 1 })).toBeNull();
  });

  it("รูป flat เดิม (BFF ไม่เคยส่ง) → null — กัน regression กลับไปหา contract เดิม", () => {
    expect(parseDashboardStats({ data: STATS })).toBeNull();
  });
});

describe("isIsoDate / dashboardRangeValid", () => {
  it("YYYY-MM-DD จริง → true · รูปแบบ/วันที่เพี้ยน → false", () => {
    expect(isIsoDate("2026-09-12")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("12/09/2026")).toBe(false);
    expect(isIsoDate(20260912)).toBe(false);
  });

  it("from ≤ to → true · from > to → false", () => {
    expect(dashboardRangeValid({ from: "2026-08-14", to: "2026-09-12" })).toBe(true);
    expect(dashboardRangeValid({ from: "2026-09-12", to: "2026-08-14" })).toBe(false);
  });
});

describe("defaultDashboardRange", () => {
  it("to = วันนี้ (เขตไทย) และ from = to − 29 วัน (default 30 วัน)", () => {
    const now = new Date("2026-09-12T04:00:00Z");
    const range = defaultDashboardRange(now);
    expect(range.to).toBe("2026-09-12");
    expect(range.from).toBe("2026-08-14");
    expect(DASHBOARD_DEFAULT_DAYS).toBe(30);
  });
});

describe("getAdminDashboard", () => {
  const RANGE = { from: "2026-08-14", to: "2026-09-12" };

  it("200 ครบรูป (jsonb ซ้อน) → ok + map เป็น view flat", async () => {
    stubBff(200, { data: WIRE });
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: true, data: EXPECTED });
  });

  it("ส่ง from/to + cookie ของ request เดิมให้ BFF ครบ", async () => {
    let capturedUrl = "";
    let capturedCookie = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedCookie = new Headers(init?.headers).get("cookie") ?? "";
        return jsonResponse(200, { data: WIRE });
      }),
    );
    await getAdminDashboard(RANGE);
    expect(capturedUrl).toContain("from=2026-08-14");
    expect(capturedUrl).toContain("to=2026-09-12");
    expect(capturedCookie).toBe("sb-auth=token123");
  });

  it("401/403 → forbidden", async () => {
    stubBff(401, { error: { code: "ERR-AUTH-001", message: "x" } });
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: false, kind: "forbidden" });
    stubBff(403, { error: { code: "ERR-RBAC-001", message: "x" } });
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: false, kind: "forbidden" });
  });

  it("500 / network ล่ม / body ผิดรูป → server (fail-closed)", async () => {
    stubBff(500, { error: { code: "HTTP_500", message: "x" } });
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: false, kind: "server" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: false, kind: "server" });
    stubBff(200, { data: { ...WIRE, users: { new: "5", total: 120 } } });
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: false, kind: "server" });
  });
});

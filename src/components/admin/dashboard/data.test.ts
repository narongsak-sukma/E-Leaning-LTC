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

const STATS = {
  usersNew: 5,
  usersTotal: 120,
  enrollmentsNew: 42,
  examAttempts: 30,
  examPassed: 21,
  examPassRatePct: 70,
  certificatesIssued: 18,
  creditsIssued: 180,
};

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
  it("envelope { data } ครบทุกคีย์ → parse ได้ครบ", () => {
    expect(parseDashboardStats({ data: STATS })).toEqual(STATS);
  });

  it("ค่า null (บทบาทไม่เห็น KPI นั้น) → ยอมและคง null", () => {
    expect(
      parseDashboardStats({
        data: { ...STATS, certificatesIssued: null, creditsIssued: null },
      }),
    ).toEqual({ ...STATS, certificatesIssued: null, creditsIssued: null });
  });

  it("คีย์ใดผิด type → null (fail-closed)", () => {
    expect(parseDashboardStats({ data: { ...STATS, usersNew: "5" } })).toBeNull();
    expect(parseDashboardStats({ data: { ...STATS, examPassRatePct: -1 } })).toBeNull();
  });

  it("ไม่ใช่ object / ไม่มี data → null", () => {
    expect(parseDashboardStats(null)).toBeNull();
    expect(parseDashboardStats({ nope: 1 })).toBeNull();
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

  it("200 ครบรูป → ok", async () => {
    stubBff(200, { data: STATS });
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: true, data: STATS });
  });

  it("ส่ง from/to + cookie ของ request เดิมให้ BFF ครบ", async () => {
    let capturedUrl = "";
    let capturedCookie = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedCookie = new Headers(init?.headers).get("cookie") ?? "";
        return jsonResponse(200, { data: STATS });
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
    stubBff(200, { data: { ...STATS, usersNew: "5" } });
    expect(await getAdminDashboard(RANGE)).toEqual({ ok: false, kind: "server" });
  });
});

/**
 * unit tests — reports/exams (Wave E Phase 5 · lane F · ADM-004)
 * strict parsers ของ monitoring/statistics — ผิดรูป = null
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
process.env.SUPABASE_ANON_KEY = "anonic";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svcic";

import {
  EXAM_STATISTICS_LIMIT,
  getExamMonitoringData,
  getExamStatisticsData,
  nullableCount,
  nullablePercent,
  parseExamMonitoring,
  parseExamStatistics,
} from "./exams";

const MONITORING = {
  generatedAt: "2026-09-01T03:00:00Z",
  summary: { inProgressCount: 3, overdueCount: 1 },
  byAssessment: [{ assessmentId: "a-1", inProgress: 2, extra: true, overdue: 1 }],
  byCourse: [{ courseId: "c-1", inProgress: 2, overdue: 1, titleTh: null }],
};

const STATS_ROW = {
  assessmentId: "a-1",
  attemptTotal: 10,
  attemptPassed: 8,
  passRatePct: 80,
  avgScorePct: 75.5,
  extraIgnored: true,
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

describe("nullableCount", () => {
  it("int >= 0 or null only", () => {
    expect(nullableCount(0)).toBe(0);
    expect(nullableCount(5)).toBe(5);
    expect(nullableCount(null)).toBeNull();
    expect(nullableCount(-1)).toBeUndefined();
    expect(nullableCount(1.5)).toBeUndefined();
    expect(nullableCount("3")).toBeUndefined();
  });
});

describe("parseExamMonitoring", () => {
  it("ok shape (extra keys ignored)", () => {
    const parsed = parseExamMonitoring({ data: MONITORING });
    expect(parsed).toEqual({
      generatedAt: MONITORING.generatedAt,
      summary: MONITORING.summary,
      byAssessment: [{ assessmentId: "a-1", inProgress: 2, overdue: 1 }],
      byCourse: [{ courseId: "c-1", inProgress: 2, overdue: 1, titleTh: null }],
    });
  });
  it("drift -> null", () => {
    expect(parseExamMonitoring(null)).toBeNull();
    expect(parseExamMonitoring({ data: { ...MONITORING, generatedAt: "" } })).toBeNull();
    expect(parseExamMonitoring({ data: { ...MONITORING, summary: {} } })).toBeNull();
    expect(parseExamMonitoring({ data: { ...MONITORING, byAssessment: [{ assessmentId: "a", inProgress: "2", overdue: 0 }] } })).toBeNull();
    expect(parseExamMonitoring({ data: { ...MONITORING, byCourse: [{ courseId: "c", inProgress: 1, overdue: 0 }] } })).toBeNull();
  });
});

describe("parseExamStatistics", () => {
  it("ok shape (extra keys ignored)", () => {
    expect(parseExamStatistics({ data: [STATS_ROW] })).toEqual([
      { assessmentId: "a-1", attemptTotal: 10, attemptPassed: 8, passRatePct: 80, avgScorePct: 75.5 },
    ]);
  });
  it("drift -> null", () => {
    expect(parseExamStatistics(null)).toBeNull();
    expect(parseExamStatistics({ data: [{ ...STATS_ROW, assessmentId: "" }] })).toBeNull();
    expect(parseExamStatistics({ data: [{ ...STATS_ROW, passRatePct: -2 }] })).toBeNull();
  });
});

describe("loaders", () => {
  it("monitoring 200 ok", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        capturedUrl = String(input);
        return jsonResponse(200, { data: MONITORING });
      }),
    );
    const result = await getExamMonitoringData();
    expect(result).toEqual({ ok: true, data: {
      generatedAt: MONITORING.generatedAt,
      summary: MONITORING.summary,
      byAssessment: [{ assessmentId: "a-1", inProgress: 2, overdue: 1 }],
      byCourse: [{ courseId: "c-1", inProgress: 2, overdue: 1, titleTh: null }],
    } });
    expect(capturedUrl).toContain("/api/v1/admin/exams/monitoring");
  });

  it("statistics 200 ok + limit param", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        capturedUrl = String(input);
        return jsonResponse(200, { data: [STATS_ROW] });
      }),
    );
    const result = await getExamStatisticsData();
    expect(result).toEqual({ ok: true, data: [
      { assessmentId: "a-1", attemptTotal: 10, attemptPassed: 8, passRatePct: 80, avgScorePct: 75.5 },
    ] });
    expect(capturedUrl).toContain(`limit=${EXAM_STATISTICS_LIMIT}`);
  });

  it("401/403 -> forbidden, else server", async () => {
    stubBff(401, { error: { code: "ERR-AUTH-001", message: "x" } });
    expect(await getExamMonitoringData()).toEqual({ ok: false, kind: "forbidden" });
    stubBff(403, { error: { code: "ERR-RBAC-001", message: "x" } });
    expect(await getExamMonitoringData()).toEqual({ ok: false, kind: "forbidden" });
    stubBff(500, { error: { code: "HTTP_500", message: "x" } });
    expect(await getExamMonitoringData()).toEqual({ ok: false, kind: "server" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await getExamMonitoringData()).toEqual({ ok: false, kind: "server" });
    stubBff(200, { data: { ...MONITORING, generatedAt: 5 } });
    expect(await getExamMonitoringData()).toEqual({ ok: false, kind: "server" });
  });
});

describe("nullablePercent", () => {
  it("finite >= 0 or null only (decimals allowed)", () => {
    expect(nullablePercent(75.5)).toBe(75.5);
    expect(nullablePercent(-1)).toBeUndefined();
    expect(nullablePercent("80")).toBeUndefined();
    expect(nullablePercent(null)).toBeNull();
  });
});

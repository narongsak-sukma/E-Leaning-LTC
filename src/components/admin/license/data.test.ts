/**
 * unit tests — license/data (Wave E Phase 5 · lane F · ADM-003)
 * parse fail-closed + isLicenseStatus + loader error mapping
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
  getAdminLicenseApplications,
  isLicenseStatus,
  LICENSE_PAGE_SIZE,
  parseAdminLicenseApplicationRow,
  parseAdminLicenseApplicationsPage,
  LICENSE_STATUS_FILTER_OPTIONS,
} from "./data";

const ROW = {
  id: "00000000-0000-4000-8000-0000000000aa",
  displayName: "Somrai M.",
  email: "som@inbox.co.th",
  licenseNo: "T-12345",
  status: "pending",
  submittedAt: "2026-08-20T04:00:00Z",
  decidedAt: null,
  reason: null,
  evidenceUrl: null,
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

describe("parseAdminLicenseApplicationRow", () => {
  it("row ok -> same shape", () => {
    expect(parseAdminLicenseApplicationRow(ROW)).toEqual(ROW);
  });

  it("row drift -> null", () => {
    expect(parseAdminLicenseApplicationRow(null)).toBeNull();
    expect(parseAdminLicenseApplicationRow({ ...ROW, id: "" })).toBeNull();
    expect(parseAdminLicenseApplicationRow({ ...ROW, licenseNo: 3 })).toBeNull();
    expect(parseAdminLicenseApplicationRow({ ...ROW, submittedAt: undefined })).toBeNull();
    expect(parseAdminLicenseApplicationRow({ ...ROW, status: "frozen" })).toBeNull();
  });

  it("nullable wrong type -> null", () => {
    expect(parseAdminLicenseApplicationRow({ ...ROW, email: 9 })).toBeNull();
    expect(parseAdminLicenseApplicationRow({ ...ROW, reason: true })).toBeNull();
    expect(parseAdminLicenseApplicationRow({ ...ROW, evidenceUrl: {} })).toBeNull();
  });
});

describe("parseAdminLicenseApplicationsPage", () => {
  it("page ok -> same shape · drift -> null", () => {
    const page = { data: [ROW], page: { nextCursor: "c1", hasMore: true } };
    expect(parseAdminLicenseApplicationsPage(page)).toEqual(page);
    expect(
      parseAdminLicenseApplicationsPage({ data: [], page: { nextCursor: null, hasMore: false } }),
    ).toEqual({ data: [], page: { nextCursor: null, hasMore: false } });
    expect(parseAdminLicenseApplicationsPage(null)).toBeNull();
    expect(parseAdminLicenseApplicationsPage({ data: "x", page: { nextCursor: null, hasMore: false } })).toBeNull();
    expect(
      parseAdminLicenseApplicationsPage({
        data: [{ ...ROW, status: "frozen" }],
        page: { nextCursor: null, hasMore: false },
      }),
    ).toBeNull();
    expect(
      parseAdminLicenseApplicationsPage({
        data: [ROW],
        page: { nextCursor: "c1", hasMore: "yes" },
      }),
    ).toBeNull();
  });
});

describe("isLicenseStatus / filter options", () => {
  it("enum in/out", () => {
    expect(isLicenseStatus("pending")).toBe(true);
    expect(isLicenseStatus("approved")).toBe(true);
    expect(isLicenseStatus("rejected")).toBe(true);
    expect(isLicenseStatus("frozen")).toBe(false);
    expect(isLicenseStatus(undefined)).toBe(false);
  });

  it("thai filter options complete", () => {
    expect(LICENSE_STATUS_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      "all",
      "pending",
      "approved",
      "rejected",
    ]);
    expect(LICENSE_STATUS_FILTER_OPTIONS[0]?.label).toBe("ทั้งหมด");
  });
});

describe("getAdminLicenseApplications", () => {
  it("200 ok + query params", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        capturedUrl = String(input);
        return jsonResponse(200, { data: [ROW], page: { nextCursor: null, hasMore: false } });
      }),
    );
    const result = await getAdminLicenseApplications({ status: "pending" });
    expect(result).toEqual({
      ok: true,
      data: { data: [ROW], page: { nextCursor: null, hasMore: false } },
    });
    expect(capturedUrl).toContain("/api/v1/admin/license-applications?");
    expect(capturedUrl).toContain("status=pending");
    expect(capturedUrl).toContain(`limit=${LICENSE_PAGE_SIZE}`);
  });

  it("401/403 -> forbidden, else server", async () => {
    stubBff(401, { error: { code: "ERR-AUTH-001", message: "x" } });
    expect(await getAdminLicenseApplications({})).toEqual({ ok: false, kind: "forbidden" });
    stubBff(403, { error: { code: "ERR-RBAC-001", message: "x" } });
    expect(await getAdminLicenseApplications({})).toEqual({ ok: false, kind: "forbidden" });
    stubBff(500, { error: { code: "HTTP_500", message: "x" } });
    expect(await getAdminLicenseApplications({})).toEqual({ ok: false, kind: "server" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await getAdminLicenseApplications({})).toEqual({ ok: false, kind: "server" });
    stubBff(200, { data: [{ ...ROW, submittedAt: 5 }], page: { nextCursor: null, hasMore: false } });
    expect(await getAdminLicenseApplications({})).toEqual({ ok: false, kind: "server" });
  });
});

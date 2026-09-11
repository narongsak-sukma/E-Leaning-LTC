/**
 * certificates.server.test — unit test loader หน้า "ประกาศนียบัตรของฉัน" (Wave D-6)
 *
 * - 200 มีรายการ → ready · 200 ว่าง → empty
 * - 401 → unauthenticated · 503/500/network → error (fail-closed ภาษาไทย)
 * - forward cookie ของ request ปัจจุบันให้ BFF เสมอ (แบบ learning.server.ts)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:53227";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { loadMyCertificatesPageData } from "./certificates.server";

const UUID_CERT = "00000000-0000-4000-8000-0000000000c1";
const ISO = "2026-09-10T03:00:00+07:00";

const ROW = {
  id: UUID_CERT,
  cert_no: "LTC-2026-123456",
  course_title: "หลักสูตรจริยธรรมทนายความ",
  issued_at: ISO,
  status: "valid",
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
  mocks.cookies.mockReset();
  mocks.cookies.mockResolvedValue({ getAll: () => [] });
});

describe("loadMyCertificatesPageData", () => {
  it("200 มีรายการ → ready", async () => {
    stubBff(200, { data: [ROW], page: { hasMore: true } });
    const result = await loadMyCertificatesPageData();
    expect(result).toEqual({
      kind: "ready",
      certificates: [ROW],
      hasMore: true,
    });
  });

  it("200 ว่าง → empty", async () => {
    stubBff(200, { data: [], page: { hasMore: false } });
    const result = await loadMyCertificatesPageData();
    expect(result).toEqual({ kind: "empty" });
  });

  it("401 → unauthenticated", async () => {
    stubBff(401, { error: { code: "ERR-AUTH-001", message: "unauthenticated" } });
    const result = await loadMyCertificatesPageData();
    expect(result).toEqual({ kind: "unauthenticated" });
  });

  it("503 → error (fail-closed)", async () => {
    stubBff(503, { error: { code: "ERR-SYS-002", message: "unavailable" } });
    const result = await loadMyCertificatesPageData();
    expect(result).toEqual({ kind: "error" });
  });

  it("500 → error (fail-closed)", async () => {
    stubBff(500, { error: { code: "HTTP_500", message: "x" } });
    const result = await loadMyCertificatesPageData();
    expect(result).toEqual({ kind: "error" });
  });

  it("network ล่ม → error (fail-closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await loadMyCertificatesPageData();
    expect(result).toEqual({ kind: "error" });
  });

  it("แถว drift → error (fail-closed ไม่แสดงข้อมูลที่ไม่ผ่าน schema)", async () => {
    stubBff(200, {
      data: [{ ...ROW, revoked_at: "2026-09-11T00:00:00Z" }],
      page: { hasMore: false },
    });
    const result = await loadMyCertificatesPageData();
    expect(result).toEqual({ kind: "error" });
  });

  it("forward cookie ของ request ให้ BFF", async () => {
    mocks.cookies.mockResolvedValue({
      getAll: () => [{ name: "sb-auth", value: "token123" }],
    });
    let captured: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Headers(init?.headers).get("cookie");
        return jsonResponse(200, { data: [], page: { hasMore: false } });
      }),
    );
    await loadMyCertificatesPageData();
    expect(captured).toBe("sb-auth=token123");
  });
});

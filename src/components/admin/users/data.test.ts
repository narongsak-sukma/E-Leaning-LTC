/**
 * unit tests — users/data (Wave E Phase 5 · lane F · ADM-002)
 * ครอบ: parseAdminUserRow / parseAdminUsersPage (แถวผิดรูป = fail-closed ทั้งหน้า)
 * · isUserStatus · getAdminUsers (200 → ok · 401/403 → forbidden · 500/network → server)
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
  ADMIN_USERS_PAGE_SIZE,
  getAdminUsers,
  isUserStatus,
  parseAdminUserRow,
  parseAdminUsersPage,
  USER_STATUS_FILTER_OPTIONS,
} from "./data";

const ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "staff@lawcouncil.go.th",
  displayName: "สมชาย ใจดี",
  status: "active",
  roles: ["staff:viewer"],
  createdAt: "2026-08-01T03:00:00Z",
  disabledReason: null,
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

describe("parseAdminUserRow / parseAdminUsersPage", () => {
  it("แถวครบรูป → parse ได้ · roles ขาด → []", () => {
    expect(parseAdminUserRow(ROW)).toEqual(ROW);
    const withoutRoles = parseAdminUserRow({ ...ROW, roles: undefined });
    expect(withoutRoles).toEqual({ ...ROW, roles: [] });
  });

  it("แถวผิดรูป (id/email/displayName/status/createdAt ว่างหรือ type ผิด) → null", () => {
    expect(parseAdminUserRow(null)).toBeNull();
    expect(parseAdminUserRow({ ...ROW, id: "" })).toBeNull();
    expect(parseAdminUserRow({ ...ROW, email: 5 })).toBeNull();
    expect(parseAdminUserRow({ ...ROW, displayName: null })).toBeNull();
    expect(parseAdminUserRow({ ...ROW, status: "" })).toBeNull();
    expect(parseAdminUserRow({ ...ROW, createdAt: undefined })).toBeNull();
  });

  it("disabledReason ผิด type → null (contract ผิดรูป)", () => {
    expect(parseAdminUserRow({ ...ROW, disabledReason: 7 })).toBeNull();
  });

  it("หน้าครบรูป → { data, page } · แถวเดียวผิดรูป → null ทั้งหน้า (fail-closed)", () => {
    const page = { nextCursor: "c2", hasMore: true };
    expect(parseAdminUsersPage({ data: [ROW], page })).toEqual({ data: [ROW], page });
    expect(parseAdminUsersPage({ data: [ROW, { ...ROW, id: "" }], page })).toBeNull();
    expect(parseAdminUsersPage({ data: [ROW] })).toBeNull();
    expect(parseAdminUsersPage({ data: [ROW], page: { hasMore: "yes" } })).toBeNull();
  });
});

describe("isUserStatus / ตัวเลือกกรอง", () => {
  it("สถานะใน enum → true · ค่าแปลกปลอม → false", () => {
    expect(isUserStatus("active")).toBe(true);
    expect(isUserStatus("disabled")).toBe(true);
    expect(isUserStatus("banned")).toBe(false);
    expect(isUserStatus(undefined)).toBe(false);
  });

  it("ตัวเลือกกรองไทยครบ 3 ค่า และ default เป็น all", () => {
    expect(USER_STATUS_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      "all",
      "active",
      "disabled",
    ]);
    expect(USER_STATUS_FILTER_OPTIONS[0]?.label).toBe("ทั้งหมด");
  });
});

describe("getAdminUsers", () => {
  it("200 ครบรูป → ok + ส่ง q/status/cursor/limit ครบ", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        capturedUrl = String(input);
        return jsonResponse(200, { data: [ROW], page: { nextCursor: null, hasMore: false } });
      }),
    );
    const result = await getAdminUsers({ q: "สมชาย", status: "active", cursor: "c1" });
    expect(result).toEqual({
      ok: true,
      data: { data: [ROW], page: { nextCursor: null, hasMore: false } },
    });
    expect(capturedUrl).toContain("/api/v1/admin/users?");
    expect(capturedUrl).toContain("q=");
    expect(capturedUrl).toContain("status=active");
    expect(capturedUrl).toContain("cursor=c1");
    expect(capturedUrl).toContain(`limit=${ADMIN_USERS_PAGE_SIZE}`);
  });

  it("401/403 → forbidden · 500/network/ผิดรูป → server", async () => {
    stubBff(401, { error: { code: "ERR-AUTH-001", message: "x" } });
    expect(await getAdminUsers({})).toEqual({ ok: false, kind: "forbidden" });
    stubBff(403, { error: { code: "ERR-RBAC-001", message: "x" } });
    expect(await getAdminUsers({})).toEqual({ ok: false, kind: "forbidden" });
    stubBff(500, { error: { code: "HTTP_500", message: "x" } });
    expect(await getAdminUsers({})).toEqual({ ok: false, kind: "server" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await getAdminUsers({})).toEqual({ ok: false, kind: "server" });
    stubBff(200, { data: [{ ...ROW, email: 1 }], page: { nextCursor: null, hasMore: false } });
    expect(await getAdminUsers({})).toEqual({ ok: false, kind: "server" });
  });
});

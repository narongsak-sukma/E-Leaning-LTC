/**
 * unit tests — users/api-client (Wave E Phase 5 · lane F)
 * ครอบ: patchAdminJson/postAdminJson/deleteAdminJson — same-origin + method ถูกต้อง ·
 * error envelope → AdminApiError (code/status/fields) · JSON พัง · network ล่ม ·
 * ไม่มี window (SSR) → ปฏิเสธทำงานทันที (แบบ exam-admin.client.test)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError } from "@/lib/exam-admin.client";
import { deleteAdminJson, patchAdminJson, postAdminJson } from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** จำลอง browser context — transport อนุญาตเฉพาะ browser (window ต้องมี) */
function stubBrowser(fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal("window", { location: { origin: "http://app.test" } });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("patchAdminJson / postAdminJson / deleteAdminJson", () => {
  it("PATCH ส่ง method/body/content-type ครบ และคืน status+body เมื่อ 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: { id: "u-1" } }));
    stubBrowser(fetchMock);
    const { status, body } = await patchAdminJson("/api/v1/admin/users/u-1", {
      action: "disable",
      reason: "ตรวจพบการใช้ในทางมิชอบ",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ data: { id: "u-1" } });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("PATCH");
    expect(String(init?.body)).toContain("disable");
  });

  it("POST/DELETE ส่ง method ถูกต้อง (DELETE ไม่มี body)", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    stubBrowser(fetchMock);
    const posted = await postAdminJson("/api/v1/admin/users/u-1/roles", { role: "lawyer" });
    expect(posted.status).toBe(204);
    const deleted = await deleteAdminJson("/api/v1/admin/users/u-1/roles?role=lawyer");
    expect(deleted.status).toBe(204);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("DELETE");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBeUndefined();
  });

  it("error envelope → AdminApiError พร้อม code/status/fields จาก details.fields", async () => {
    stubBrowser(async () =>
      jsonResponse(403, {
        error: {
          code: "ERR-RBAC-001",
          message: "ไม่มีสิทธิ์มอบบทบาทนี้",
          details: { fields: ["role"] },
        },
      }),
    );
    const error = await patchAdminJson("/api/v1/admin/users/u-1", { action: "enable" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AdminApiError);
    if (error instanceof AdminApiError) {
      expect(error.code).toBe("ERR-RBAC-001");
      expect(error.status).toBe(403);
      expect(error.fields).toEqual(["role"]);
    }
  });

  it("ไม่มี envelope → code HTTP_<status> · JSON พังบน 2xx → body null", async () => {
    stubBrowser(async () => new Response("boom", { status: 500 }));
    const error = await patchAdminJson("/api/v1/admin/users/u-1", {}).catch(
      (caught: unknown) => caught,
    );
    if (error instanceof AdminApiError) {
      expect(error.code).toBe("HTTP_500");
    } else {
      expect.unreachable("ต้อง throw AdminApiError");
    }
    stubBrowser(async () => new Response("{not-json", { status: 200 }));
    const ok = await patchAdminJson("/api/v1/admin/users/u-1", {});
    expect(ok.status).toBe(200);
    expect(ok.body).toBeNull();
  });

  it("network ล่ม / ไม่มี window (SSR) → AdminApiError ERR-SYS-001", async () => {
    stubBrowser(async () => {
      throw new Error("offline");
    });
    const offline = await patchAdminJson("/api/v1/admin/users/u-1", {}).catch(
      (caught: unknown) => caught,
    );
    expect(offline).toBeInstanceOf(AdminApiError);
    vi.unstubAllGlobals();
    const ssr = await patchAdminJson("/api/v1/admin/users/u-1", {}).catch(
      (caught: unknown) => caught,
    );
    if (ssr instanceof AdminApiError) {
      expect(ssr.code).toBe("ERR-SYS-001");
      expect(ssr.status).toBe(0);
    } else {
      expect.unreachable("ต้อง throw AdminApiError");
    }
  });
});

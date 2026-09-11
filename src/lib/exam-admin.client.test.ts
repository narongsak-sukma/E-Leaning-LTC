/**
 * unit tests — exam-admin.client (D-7)
 * ครอบ: postAdminJson — same-origin POST · error envelope → AdminApiError (code/status/fields) ·
 * JSON พัง · network ล่ม · unwrapDataEnvelope fail-closed
 * วิธี: stub window/fetch ที่ขอบเขต (node env — ไม่มี DOM)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminApiError,
  postAdminJson,
  TRANSPORT_FALLBACK_MESSAGE,
  unwrapDataEnvelope,
} from "./exam-admin.client";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** จำลอง browser context — postAdminJson อนุญาตเฉพาะ browser (window ต้องมี) */
function stubBrowser(fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal("window", { location: { origin: "http://app.test" } });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
}

/** ตอบ JSON พร้อม content-type ครบ */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("postAdminJson", () => {
  it("POST same-origin พร้อม headers/credentials ครบ และคืน status+body เมื่อ 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { data: { id: "as-1" } }));
    vi.stubGlobal("window", { location: { origin: "http://app.test" } });
    vi.stubGlobal("fetch", fetchMock);
    const { status, body } = await postAdminJson("/api/v1/admin/assessments", { code: "A" });
    expect(status).toBe(201);
    expect(body).toEqual({ data: { id: "as-1" } });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("http://app.test/api/v1/admin/assessments");
  });

  it("error envelope → AdminApiError พร้อม code/status/message/fields จาก details.fields", async () => {
    stubBrowser(async () =>
      jsonResponse(422, {
        error: {
          code: "ERR-VAL-001",
          message: "ข้อมูลไม่ถูกต้อง",
          details: { fields: ["code", "rules.passPct"] },
        },
      }),
    );
    const error = await postAdminJson("/api/v1/admin/assessments", { code: "" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AdminApiError);
    if (error instanceof AdminApiError) {
      expect(error.code).toBe("ERR-VAL-001");
      expect(error.status).toBe(422);
      expect(error.fields).toEqual(["code", "rules.passPct"]);
    }
  });

  it("details.field (ตัวเดียว) → fields เป็น array หนึ่งค่า", async () => {
    stubBrowser(async () =>
      jsonResponse(422, {
        error: {
          code: "ERR-VAL-001",
          message: "ข้อมูลไม่ถูกต้อง",
          details: { field: "enrollmentId" },
        },
      }),
    );
    const error = await postAdminJson("/api/v1/admin/certificates", {}).catch(
      (caught: unknown) => caught,
    );
    if (error instanceof AdminApiError) {
      expect(error.fields).toEqual(["enrollmentId"]);
    } else {
      expect.unreachable("ต้อง throw AdminApiError");
    }
  });

  it("ไม่มี envelope → code เป็น HTTP_<status> และ fallback message ภาษาไทย", async () => {
    stubBrowser(async () => new Response("boom", { status: 500 }));
    const error = await postAdminJson("/api/v1/admin/assessments", {}).catch(
      (caught: unknown) => caught,
    );
    if (error instanceof AdminApiError) {
      expect(error.code).toBe("HTTP_500");
      expect(error.message).toBe(TRANSPORT_FALLBACK_MESSAGE);
    } else {
      expect.unreachable("ต้อง throw AdminApiError");
    }
  });

  it("network ล่ม → AdminApiError ERR-SYS-001", async () => {
    stubBrowser(async () => {
      throw new Error("offline");
    });
    const error = await postAdminJson("/api/v1/admin/assessments", {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AdminApiError);
    if (error instanceof AdminApiError) {
      expect(error.code).toBe("ERR-SYS-001");
      expect(error.status).toBe(0);
    }
  });

  it("ไม่มี window (SSR) → ปฏิเสธทำงานทันทีด้วย ERR-SYS-001", async () => {
    const error = await postAdminJson("/api/v1/admin/assessments", {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AdminApiError);
    if (error instanceof AdminApiError) {
      expect(error.code).toBe("ERR-SYS-001");
    }
  });
});

describe("unwrapDataEnvelope", () => {
  it("แตก { data } ได้ถูกต้อง", () => {
    expect(unwrapDataEnvelope({ data: { id: "qb-1" } })).toEqual({ id: "qb-1" });
  });

  it("ไม่มี data / ไม่ใช่ object → null (fail-closed)", () => {
    expect(unwrapDataEnvelope(null)).toBeNull();
    expect(unwrapDataEnvelope({ nope: 1 })).toBeNull();
    expect(unwrapDataEnvelope([1, 2])).toBeNull();
  });
});

/**
 * transport.test — unit test ของชั้นขนส่งกลาง BFF (PB-19 · src/lib/api/transport.ts)
 *
 * - URL absolute จาก origin option · ไม่มี origin บน server → throw (fail-closed)
 * - headers: accept · content-type เฉพาะ POST · cookie forward (ยาว > 1) ·
 *   x-ltc-bff-internal เฉพาะฝั่ง server (guard typeof window) · headers เสริม merge ทับท้าย
 * - GET/POST body JSON · keepalive · credentials/cache · 204 → body null (ไม่อ่าน body)
 * - error envelope §1.3: code/message จาก envelope · fallback `HTTP_<status>` ·
 *   network fail → ERR-SYS-001 status 0 (ApiError เสมอ)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchJson } from "./transport";

const ORIGIN = "https://learn.example.com";
const PATH = "/api/v1/things";

/** call ของ fetch ที่ถูกจับ — (input, init) ครบ */
interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: RecordedCall[] = [];

function stubFetch(handler: (callIndex: number) => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input instanceof URL ? input.href : String(input), init: init ?? {} });
      return handler(calls.length - 1);
    }),
  );
}

/** Response ปลอมแบบย่อ — ครอบสัญญาที่ transport อ่าน (ok/status/json) */
function fakeResponse(
  status: number,
  body: unknown,
  options?: { readonly jsonThrows?: boolean },
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (options?.jsonThrows === true) {
        throw new SyntaxError("Unexpected end of JSON input");
      }
      return body;
    },
  } as unknown as Response;
}

/** 204 ที่ถ้า "อ่าน body" จะได้ค่า — พิสูจน์ว่า transport ไม่อ่าน body ของ 204 */
function fake204WithBody(): Response {
  return {
    ok: true,
    status: 204,
    json: async () => ({ leaked: true }),
  } as unknown as Response;
}

function headersOf(callIndex: number): Record<string, string> {
  const call = calls[callIndex];
  if (call === undefined) {
    throw new Error(`ไม่พบการเรียก fetch ลำดับที่ ${callIndex}`);
  }
  return (call.init.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ——— URL + origin ———
describe("URL + origin", () => {
  it("ระบุ origin → เรียก absolute URL = origin + path", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    const result = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN });
    expect(result.status).toBe(200);
    expect(calls[0]?.url).toBe(`${ORIGIN}${PATH}`);
  });

  it("ไม่มี origin และไม่มี window (server ลืมส่ง) → throw programming error ไม่ใช่ ApiError", async () => {
    stubFetch(() => fakeResponse(200, {}));
    const error = await fetchJson(PATH, { method: "GET" }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ต้องระบุ origin");
  });
});

// ——— headers ———
describe("headers", () => {
  it("GET: accept + x-ltc-bff-internal (ฝั่ง server) · ไม่มี content-type", async () => {
    stubFetch(() => fakeResponse(200, {}));
    await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN });
    const headers = headersOf(0);
    expect(headers["accept"]).toBe("application/json");
    expect(headers["x-ltc-bff-internal"]).toBe("1");
    expect(headers["content-type"]).toBeUndefined();
  });

  it("POST: เพิ่ม content-type application/json; charset=utf-8", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    await fetchJson(PATH, { method: "POST", body: { a: 1 } }, { origin: ORIGIN });
    expect(headersOf(0)["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("cookieHeader ยาว > 1 → forward เป็น header cookie", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN, cookieHeader: "sb-session=abc123" });
    expect(headersOf(0)["cookie"]).toBe("sb-session=abc123");
  });

  it("cookieHeader สั้น (<= 1 ตัวอักษร) → ไม่ส่ง header cookie (พฤติกรรมเดิม)", async () => {
    stubFetch(() => fakeResponse(200, {}));
    await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN, cookieHeader: "a" });
    expect(headersOf(0)["cookie"]).toBeUndefined();
  });

  it("ฝั่ง browser (มี window) → ไม่ส่ง x-ltc-bff-internal · ใช้ window.location.origin เอง", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    vi.stubGlobal("window", { location: { origin: "https://browser.example.com" } });
    await fetchJson(PATH, { method: "GET" });
    const headers = headersOf(0);
    expect(headers["x-ltc-bff-internal"]).toBeUndefined();
    expect(calls[0]?.url).toBe("https://browser.example.com/api/v1/things");
  });

  it("headers เสริมราย call เข้าไปครบ (เช่น Idempotency-Key)", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    await fetchJson(
      PATH,
      { method: "POST", headers: { "idempotency-key": "99000000-0000-4000-8000-000000000009" } },
      { origin: ORIGIN },
    );
    expect(headersOf(0)["idempotency-key"]).toBe("99000000-0000-4000-8000-000000000009");
  });

  it("headers เสริม merge ทับท้าย — ทับ default ได้ (Object.assign ลำดับสุดท้าย ตาม examRequest เดิม)", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    await fetchJson(
      PATH,
      { method: "POST", headers: { accept: "application/x-special" } },
      { origin: ORIGIN },
    );
    expect(headersOf(0)["accept"]).toBe("application/x-special");
  });
});

// ——— body + keepalive + fetch options ———
describe("body + keepalive + fetch options", () => {
  it("POST มี body → JSON.stringify ก่อนส่ง", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    await fetchJson(PATH, { method: "POST", body: { answers: [{ questionId: "q1" }] } }, { origin: ORIGIN });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ answers: [{ questionId: "q1" }] }));
  });

  it("POST ไม่มี body (เช่น enroll) → init.body ไม่ถูกตั้ง", async () => {
    stubFetch(() => fakeResponse(201, { data: 1 }));
    await fetchJson(PATH, { method: "POST" }, { origin: ORIGIN });
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("keepalive: true → ส่งต่อให้ fetch", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    await fetchJson(PATH, { method: "POST", body: { positionSeconds: 120 }, keepalive: true }, { origin: ORIGIN });
    expect(calls[0]?.init.keepalive).toBe(true);
  });

  it("default ไม่ตั้ง keepalive", async () => {
    stubFetch(() => fakeResponse(200, { data: 1 }));
    await fetchJson(PATH, { method: "POST", body: { a: 1 } }, { origin: ORIGIN });
    expect(calls[0]?.init.keepalive).toBeUndefined();
  });

  it("credentials same-origin + cache no-store เสมอ", async () => {
    stubFetch(() => fakeResponse(200, {}));
    await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN });
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(calls[0]?.init.cache).toBe("no-store");
  });
});

// ——— ตอบสนองสำเร็จ ———
describe("ตอบสนองสำเร็จ", () => {
  it("200 → { status, body } ดิบ", async () => {
    stubFetch(() => fakeResponse(200, { data: { id: "x" } }));
    const result = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: { id: "x" } });
  });

  it("201 (สร้างทรัพยากร) → ผ่านเป็นสำเร็จ", async () => {
    stubFetch(() => fakeResponse(201, { data: { id: "y" } }));
    const result = await fetchJson(PATH, { method: "POST" }, { origin: ORIGIN });
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ data: { id: "y" } });
  });

  it("204 → { status: 204, body: null } — ไม่อ่าน body (json มีค่าก็ตาม)", async () => {
    stubFetch(() => fake204WithBody());
    const result = await fetchJson(PATH, { method: "POST" }, { origin: ORIGIN });
    expect(result).toEqual({ status: 204, body: null });
  });
});

// ——— error envelope §1.3 ———
describe("error envelope 1.3", () => {
  it("401 มี envelope ครบ → ApiError code/message/status จาก envelope", async () => {
    stubFetch(() => fakeResponse(401, { error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบ" } }));
    const error = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).name).toBe("ApiError");
    expect((error as ApiError).code).toBe("ERR-AUTH-001");
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("กรุณาเข้าสู่ระบบ");
  });

  it("429 envelope ไม่มี message → ข้อความกลางไทย (fallback ของ transport)", async () => {
    stubFetch(() => fakeResponse(429, { error: { code: "ERR-RATE-001" } }));
    const error = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("ERR-RATE-001");
    expect((error as ApiError).message).toBe("ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง");
  });

  it("error ไม่ใช่ record (error: string) → code fallback HTTP_<status>", async () => {
    stubFetch(() => fakeResponse(502, { error: "oops" }));
    const error = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("HTTP_502");
    expect((error as ApiError).message).toBe("ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง");
  });

  it("code ใน envelope ว่าง → fallback HTTP_<status>", async () => {
    stubFetch(() => fakeResponse(503, { error: { code: "", message: "x" } }));
    const error = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("HTTP_503");
  });

  it("body parse ไม่ได้ (JSON เสีย) → code HTTP_<status> + ข้อความกลาง", async () => {
    stubFetch(() => fakeResponse(500, null, { jsonThrows: true }));
    const error = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("HTTP_500");
    expect((error as ApiError).message).toBe("ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง");
  });

  it("network fail → ERR-SYS-001 status 0 (fail-closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const error = await fetchJson(PATH, { method: "GET" }, { origin: ORIGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ERR-SYS-001");
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toBe("ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง");
  });
});

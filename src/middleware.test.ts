/**
 * middleware.test — unit test ของ src/middleware.ts (SDS §5.4 + §5.1 + codex-gate-c01 รอบแก้)
 *
 * - request-id: สร้างใหม่ทุก request + สะท้อนกลับ response
 * - CSRF fail-closed: ทุก non-safe method (ไม่ใช่ GET/HEAD/OPTIONS) ต้องพิสูจน์ origin ได้ —
 *   ไม่มีทั้ง Origin และ Sec-Fetch-Site → 403
 * - session refresh: เขียน cookie หมุน token ทั้ง request + response ด้วย flags บังคับ
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("./lib/config", () => ({
  getConfig: () => ({
    supabaseUrl: "https://auth.test.supabase.co",
    supabaseAnonKey: "anon-key-unit-test",
  }),
}));

import { createServerClient } from "@supabase/ssr";
import { middleware, isCsrfAllowed, config } from "./middleware";

const createServerClientMock = vi.mocked(createServerClient);

function makeRequest(method: string, path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000" + path, { method, headers });
}

/** stub client ของ @supabase/ssr — เก็บ cookies adapter ไว้ให้ test เรียก setAll แทน library */
function stubRefreshClient() {
  let captured: {
    getAll: () => { name: string; value: string }[];
    setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => void;
  } | undefined;
  createServerClientMock.mockImplementation(((_url: string, _key: string, opts: unknown) => {
    captured = (opts as { cookies: typeof captured }).cookies;
    return {
      auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    };
  }) as never);
  return () => captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubRefreshClient();
});

describe("request-id", () => {
  it("ทุก response มี x-request-id และไม่ซ้ำกันข้าม request", async () => {
    const r1 = await middleware(makeRequest("GET", "/api/v1/courses"));
    const r2 = await middleware(makeRequest("GET", "/api/v1/courses"));
    const id1 = r1.headers.get("x-request-id");
    const id2 = r2.headers.get("x-request-id");
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("GET ข้าม origin ผ่าน (CSRF คุมเฉพาะ mutation)", async () => {
    const res = await middleware(makeRequest("GET", "/api/v1/courses", { origin: "https://evil.example" }));
    expect(res.status).toBe(200);
  });
});

describe("CSRF — fail-closed ทุก non-safe method (SDS §5.4)", () => {
  it("POST Origin ตรง host ตัวเอง → ผ่าน", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/auth/login", { origin: "http://localhost:3000" }));
    expect(res.status).toBe(200);
  });

  it("POST Origin คนละ host → 403 ERR-RBAC-001 + reason csrf_origin_mismatch + มี x-request-id", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/auth/login", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, string> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["reason"]).toBe("csrf_origin_mismatch");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("POST ไม่มี Origin + Sec-Fetch-Site: cross-site → 403", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/courses", { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  it("POST Sec-Fetch-Site same-origin / same-site / none → ผ่านทั้งหมด", async () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      const res = await middleware(makeRequest("POST", "/api/v1/courses", { "sec-fetch-site": site }));
      expect(res.status).toBe(200);
    }
  });

  it("POST ไม่มีทั้ง Origin และ Sec-Fetch-Site → 403 (fail-closed — พิสูจน์ origin ไม่ได้)", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/courses"));
    expect(res.status).toBe(403);
  });

  it("method ที่ไม่ใช่ safe ทุกตัวถูกคุม (PUT/PATCH/DELETE) — ใช้ allowlist ไม่ใช่ enumerate 4 ตัว", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await middleware(makeRequest(method, "/api/v1/courses"));
      expect(res.status, method).toBe(403);
    }
  });

  it("safe methods (GET/HEAD/OPTIONS) ผ่านโดยไม่ต้องมี Origin", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await middleware(makeRequest(method, "/api/v1/courses"));
      expect(res.status, method).toBe(200);
    }
  });

  it("Origin ผิดรูปแบบ → 403 (fail-closed)", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/courses", { origin: "::not a url::" }));
    expect(res.status).toBe(403);
  });
});

describe("session refresh (SDS §5.1) — cookie หมุน token เขียนสองทิศทาง", () => {
  it("setAll เขียน response cookie ด้วย flags บังคับ (httpOnly ทับ default ของ library)", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/auth/login", { origin: "http://localhost:3000" }));
    const cookies = createServerClientMock.mock.calls[0]?.[2] as unknown as {
      cookies: {
        setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => void;
      };
    };
    cookies.cookies.setAll([{ name: "sb-auth-token", value: "rotated", options: { httpOnly: false } }]);
    const written = res.cookies.getAll().find((c) => c.name === "sb-auth-token");
    expect(written?.value).toBe("rotated");
    expect(written).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("Auth server ล้ม (getConfig/createServerClient โยน) → ยังตอบ 200 ปกติ (authorization เป็นของ handler)", async () => {
    createServerClientMock.mockImplementation((() => {
      throw new Error("auth server unreachable");
    }) as never);
    const res = await middleware(makeRequest("GET", "/api/v1/courses"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("isCsrfAllowed + config", () => {
  it("isCsrfAllowed ตรงกับ middleware decision", () => {
    expect(isCsrfAllowed(makeRequest("POST", "/api/v1/x", { origin: "http://localhost:3000" }))).toBe(true);
    expect(isCsrfAllowed(makeRequest("POST", "/api/v1/x", { origin: "https://evil.example" }))).toBe(false);
    expect(isCsrfAllowed(makeRequest("POST", "/api/v1/x"))).toBe(false);
  });

  it("config.matcher ครอบคลุม /api/v1/* เท่านั้น", () => {
    expect(config.matcher).toEqual(["/api/v1/:path*"]);
  });
});

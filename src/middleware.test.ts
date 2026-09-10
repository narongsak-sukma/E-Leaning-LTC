/**
 * middleware.test — unit test ของ src/middleware.ts (SDS §5.4 + request-id)
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware, isCsrfAllowed, config } from "./middleware";

function makeRequest(method: string, path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000" + path, { method, headers });
}

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

describe("CSRF — mutating methods (SDS §5.4)", () => {
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

  it("POST ไม่มีทั้ง Origin และ Sec-Fetch-Site → ผ่าน (non-browser client)", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/courses"));
    expect(res.status).toBe(200);
  });

  it("Origin ผิดรูปแบบ → 403 (fail-closed)", async () => {
    const res = await middleware(makeRequest("POST", "/api/v1/courses", { origin: "::not a url::" }));
    expect(res.status).toBe(403);
  });
});

describe("isCsrfAllowed + config", () => {
  it("isCsrfAllowed ตรงกับ middleware decision", () => {
    expect(isCsrfAllowed(makeRequest("POST", "/api/v1/x", { origin: "http://localhost:3000" }))).toBe(true);
    expect(isCsrfAllowed(makeRequest("POST", "/api/v1/x", { origin: "https://evil.example" }))).toBe(false);
  });

  it("config.matcher ครอบคลุม /api/v1/* เท่านั้น", () => {
    expect(config.matcher).toEqual(["/api/v1/:path*"]);
  });
});

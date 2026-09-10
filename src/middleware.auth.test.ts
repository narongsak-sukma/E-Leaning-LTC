/**
 * middleware.auth.test — gate r11 M1: refresh ใน middleware ต้องไม่ล้าง credential
 * ของ session ที่ไม่ได้ยืนยันว่าตาย (ใช้ @supabase/ssr จริง — mock เฉพาะ transport)
 *
 * จุดรั่วที่ codex พิสูจน์: หน้าเว็บ (เช่น GET /courses) + access token หมดอายุ →
 * SDK refresh ภายใน getUser โดนปฏิเสธแบบ non-retryable (รวม 401 จากชั้น key-auth
 * ของ gateway ที่ไม่มี code — ไม่ได้แตะ session ฝั่ง server เลย) → SDK
 * _removeSession → middleware เดิม propagate การลบ (maxAge=0) กลับ browser และ
 * เข้า render → logout ถัดมาเจอ cookie ว่าง → 204 โดยไม่เคย revoke
 *
 * fix: middleware buffer การเขียนทั้งหมด — "การลบ" เผยแพร่เฉพาะเมื่อผล auth ยืนยัน
 * ตายจริงตาม allowlist เดียวกับ logout route (lib/supabase/auth-errors) · "การเขียน"
 * (rotation) เผยแพร่เสมอ
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("./lib/config", () => ({
  getConfig: () => ({
    supabaseUrl: "http://supabase.test.local",
    supabaseAnonKey: "test-anon-key",
  }),
}));

import { middleware } from "./middleware";

/** session ที่ SDK อ่านได้และ access หมดอายุแล้ว — บังคับ refresh ภายใน getUser */
const EXPIRED_SESSION_JSON = JSON.stringify({
  access_token: "access-token-old",
  refresh_token: "refresh-token-test",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) - 600,
  user: {
    id: "11111111-1111-4111-8111-000000000099",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  },
});

/** ชื่อ base cookie ตามที่ @supabase/ssr คำนวณจาก hostname (คู่กับ route.test ของ logout) */
const AUTH_COOKIE = "sb-supabase-auth-token";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** สร้าง request หน้าเว็บ/API ที่แนบ session cookie หมดอายุมา */
function requestWithExpiredSession(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "GET",
    headers: { cookie: `${AUTH_COOKIE}=${encodeURIComponent(EXPIRED_SESSION_JSON)}` },
  });
}

/** การลบ cookie auth ที่หลุดออกไป browser (ค่าว่าง/maxAge 0) — ต้องไม่มีเมื่อไม่ยืนยันตาย */
function leakedDeletions(res: {
  cookies: { getAll: () => Array<{ name: string; value: string; maxAge?: number | undefined }> };
}) {
  return res.cookies
    .getAll()
    .filter((c) => c.name.startsWith("sb-"))
    .filter((c) => c.value === "" || c.maxAge === 0);
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

describe("middleware refresh กับ SDK จริง — ไม่ยืนยันตาย = รักษา credential (gate r11 M1)", () => {
  it("GET /courses + refresh โดน 401 จากชั้น key-auth ของ gateway (ไม่มี code) → ไม่ลบ cookie, render ยังเห็น credential เดิม", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      // probe จริงของ Kong: 401 ไม่มี error_code ใด ๆ
      if (url.includes("/auth/v1/token")) {
        return jsonResponse(401, { message: "Invalid authentication credentials" });
      }
      return jsonResponse(401, { message: "Invalid authentication credentials" });
    });
    const res = await middleware(requestWithExpiredSession("/courses"));
    expect(res.status).toBe(200);
    // ห้ามมีการลบ cookie auth หลุดออกไป browser — credential ยังมีชีวิต
    expect(leakedDeletions(res)).toEqual([]);
    // render ที่อยู่ใต้ middleware ยังเห็น session เดิม (ไม่ถูกลบทิ้งกลางทาง)
    expect(res.headers.get("x-middleware-request-cookie")).toContain("sb-supabase-auth-token=");
  });

  it("เส้น API (GET /api/v1/courses) ก็เช่นกัน — การข้ามลบไม่ได้มีเฉพาะหน้าเว็บ", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(401, { message: "Invalid authentication credentials" }),
    );
    const res = await middleware(requestWithExpiredSession("/api/v1/courses"));
    expect(res.status).toBe(200);
    expect(leakedDeletions(res)).toEqual([]);
    expect(res.headers.get("x-middleware-request-cookie")).toContain("sb-supabase-auth-token=");
  });

  it("refresh โดน 429 (rate-limit) → ไม่ลบ cookie (transient — ลองใหม่ได้)", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(429, { code: 429, msg: "rate_limit" }));
    const res = await middleware(requestWithExpiredSession("/courses"));
    expect(res.status).toBe(200);
    expect(leakedDeletions(res)).toEqual([]);
  });

  it("refresh ตอบ user_banned (บัญชีถูกระงับ ≠ session สิ้นสภาพ) → ไม่ลบ cookie — logout ยัง revoke ได้ภายหลัง", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(400, { code: 400, error_code: "user_banned", msg: "Invalid Refresh Token: User Banned" }),
    );
    const res = await middleware(requestWithExpiredSession("/courses"));
    expect(res.status).toBe(200);
    expect(leakedDeletions(res)).toEqual([]);
    expect(res.headers.get("x-middleware-request-cookie")).toContain("sb-supabase-auth-token=");
  });

  it("positive control: refresh ตอบ refresh_token_already_used (live probe จริง) = ตายจริง → ลบ cookie ถึง browser + หายจาก render", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(400, {
        code: 400,
        error_code: "refresh_token_already_used",
        msg: "Invalid Refresh Token: Already Used",
      }),
    );
    const res = await middleware(requestWithExpiredSession("/courses"));
    expect(res.status).toBe(200);
    const deletions = res.cookies.getAll().filter((c) => c.name === AUTH_COOKIE);
    expect(deletions.length).toBe(1); // การลบถูกเผยแพร่ — session ตายจริง
    expect(deletions[0]?.value === "" || deletions[0]?.maxAge === 0).toBe(true);
    // และ render ไม่เห็น session อีก (cookie ถูกลบออกจาก request ที่ forward)
    expect(res.headers.get("x-middleware-request-cookie") ?? "").not.toContain(AUTH_COOKIE);
  });
});

/**
 * gate r12 M2 — การลบ cookie auth มีสองความหมาย: "ล้าง session" (เผยแพร่เฉพาะเมื่อ
 * ยืนยันตาย) กับ "เก็บกวาด chunk เก่าระหว่าง rotation" (dist/main/cookies.js setItem
 * ลบชื่อ base/.N ที่ไม่อยู่ในชุดใหม่ **ใน setAll เดียวกับการเขียนชุดใหม่** — ต้องเผยแพร่
 * พร้อม rotation เสมอ ไม่งั้น base เก่าค้างทั้ง browser และ render แล้ว combineChunks
 * (อ่าน base ก่อน) ยังใช้ token เก่า)
 */
describe("middleware rotation cleanup ของ chunk (gate r12 M2) — ใช้ SDK จริง", () => {
  /** สร้าง session JSON ขนาดพอให้เข้ารหัสแล้วเกิน MAX_CHUNK_SIZE (3180) ของ ssr */
  function sessionJson(pad: number, tokenPrefix: string): string {
    return JSON.stringify({
      access_token: `${tokenPrefix}-${"x".repeat(pad)}`,
      refresh_token: `refresh-${tokenPrefix}`,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3500,
      user: {
        id: "11111111-1111-4111-8111-000000000099",
        aud: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    });
  }

  /** แยก session เป็นชุด chunk ตามที่ @supabase/ssr เขียนจริง: base64url + ทุก 3180 ตัวอักษร */
  function chunkedCookies(json: string): Array<{ name: string; value: string }> {
    const encoded = `base64-${Buffer.from(json, "utf8").toString("base64url")}`;
    const chunks: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < encoded.length; i += 3180) {
      chunks.push({ name: `${AUTH_COOKIE}.${i / 3180}`, value: encoded.slice(i, i + 3180) });
    }
    return chunks;
  }

  /** /auth/v1/token ตอบ session ใหม่ (rotation สำเร็จ) — ส่วนอื่น 401 ไร้ code ก็ได้ */
  function mockTokenReturns(json: string): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        return jsonResponse(200, JSON.parse(json));
      }
      return jsonResponse(401, { message: "Invalid authentication credentials" });
    });
  }

  it("rotation base เดี่ยว → หลาย chunk: ลบ base เก่าออกพร้อมเขียน chunk ใหม่ (cleanup ห้ามถูกทิ้ง)", async () => {
    // request มาแบบ base เดี่ยวหมดอายุ
    const expired = JSON.stringify({
      access_token: "access-token-old",
      refresh_token: "refresh-token-test",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 600,
      user: {
        id: "11111111-1111-4111-8111-000000000099",
        aud: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    });
    mockTokenReturns(sessionJson(12000, "fresh-a"));
    const req = new NextRequest("http://localhost:3000/courses", {
      method: "GET",
      headers: { cookie: `${AUTH_COOKIE}=${encodeURIComponent(expired)}` },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const all = res.cookies.getAll();
    // chunk ใหม่ถูกเขียนออกไป (อย่างน้อย .0)
    expect(all.some((c) => c.name === `${AUTH_COOKIE}.0` && c.value !== "")).toBe(true);
    // base เก่าถูกลบออกด้วย (cleanup ของ rotation — ไม่ใช่การล้าง session)
    const baseDel = all.filter((c) => c.name === AUTH_COOKIE);
    expect(baseDel.length).toBe(1);
    expect(baseDel[0]?.value === "" || baseDel[0]?.maxAge === 0).toBe(true);
    // render เห็น chunk ใหม่ ไม่เห็น base เก่า
    const forwarded = res.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).toContain(`${AUTH_COOKIE}.0=`);
    expect(forwarded).not.toContain(`${AUTH_COOKIE}=`);
  });

  it("จำนวน chunk ลดลง (เดิมหลาย chunk → ใหม่ base เดี่ยว): ลบ chunk .N เก่าครบชุด", async () => {
    // request มาแบบ chunked หมดอายุ (สร้างตามรูปที่ ssr เขียนจริง)
    const expiredBig = JSON.stringify({
      access_token: `old-${"x".repeat(12000)}`,
      refresh_token: "refresh-token-test",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 600,
      user: {
        id: "11111111-1111-4111-8111-000000000099",
        aud: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    });
    const chunks = chunkedCookies(expiredBig);
    mockTokenReturns(sessionJson(200, "fresh-small"));
    const req = new NextRequest("http://localhost:3000/courses", {
      method: "GET",
      headers: { cookie: chunks.map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const all = res.cookies.getAll();
    // base เดี่ยวใหม่ถูกเขียน
    expect(all.some((c) => c.name === AUTH_COOKIE && c.value !== "")).toBe(true);
    // ทุก chunk เก่าถูกลบออก (ไม่ตกหล่นแม้จะไม่มีการล้าง session)
    for (const { name } of chunks) {
      const del = all.filter((c) => c.name === name);
      expect(del.length).toBe(1);
      expect(del[0]?.value === "" || del[0]?.maxAge === 0).toBe(true);
    }
    const forwarded = res.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).toContain(`${AUTH_COOKIE}=`);
    for (const { name } of chunks) {
      expect(forwarded).not.toContain(`${name}=`);
    }
  });

  it("rotation ต่อเนื่องสองรอบ: cookie ที่ browser เก็บกลับมาใช้ได้ทันที (ไม่ต้องหมุนซ้ำ/ไม่หลงชื่อเก่า)", async () => {
    // รอบแรก: base เดี่ยวหมดอายุ → หมุนเป็น chunk ใหญ่
    const expired = JSON.stringify({
      access_token: "access-token-old",
      refresh_token: "refresh-token-test",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 600,
      user: {
        id: "11111111-1111-4111-8111-000000000099",
        aud: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    });
    mockTokenReturns(sessionJson(12000, "fresh-a"));
    const first = await middleware(
      new NextRequest("http://localhost:3000/courses", {
        method: "GET",
        headers: { cookie: `${AUTH_COOKIE}=${encodeURIComponent(expired)}` },
      }),
    );
    expect(first.cookies.getAll().some((c) => c.name === `${AUTH_COOKIE}.0` && c.value !== "")).toBe(true);

    // รอบสอง: browser ส่ง chunk จากรอบแรกกลับมา (ยังไม่หมดอายุ) → ไม่ต้องยิง refresh เลย
    let tokenCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        tokenCalls += 1;
        return jsonResponse(400, { code: 400, error_code: "session_expired", msg: "should not refresh" });
      }
      return jsonResponse(401, { message: "Invalid authentication credentials" });
    });
    const cookieBack = first.cookies
      .getAll()
      .filter((c) => c.value !== "" && c.maxAge !== 0)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const second = await middleware(
      new NextRequest("http://localhost:3000/courses", {
        method: "GET",
        headers: { cookie: cookieBack },
      }),
    );
    expect(tokenCalls).toBe(0); // SDK อ่าน session ใหม่จาก chunk ได้ — ไม่ refresh
    expect(second.cookies.getAll().filter((c) => c.name.startsWith(AUTH_COOKIE) && (c.value === "" || c.maxAge === 0))).toEqual([]);
  });
});

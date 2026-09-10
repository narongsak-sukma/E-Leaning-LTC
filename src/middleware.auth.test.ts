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

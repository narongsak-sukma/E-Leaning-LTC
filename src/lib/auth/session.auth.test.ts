/**
 * session.auth.test — gate r12 M1: handler ต้องไม่ล้าง credential ที่ยังมีชีวิต
 * (ใช้ @supabase/ssr + auth-js จริงผ่าน createSupabaseSsrClientBuffered — mock
 * เฉพาะ transport (global fetch) + next/headers + config)
 *
 * จุดรั่วที่ codex พิสูจน์: middleware รักษา cookie ไว้แล้ว (r11) แต่ handler
 * เรียก SDK ซ้ำ (requireUser → getUser) ผ่าน client ที่เขียน cookie ตรง ๆ —
 * refresh โดนปฏิเสธ non-retryable รอบที่สอง (gateway 401 ไร้ code ไม่ได้แตะ
 * session ฝั่ง server) → SDK _removeSession → การลบหลุดไป response ทันที →
 * browser โดนล้างทีหลัง middleware → logout ถัดมา 204 โดยไม่เคย revoke
 *
 * fix: getUser() ใช้ buffered client + commitAuthWrites(deathConfirmed) —
 * นโยบายเดียวกับ middleware (selectPublishableAuthCookies): rotation เผยแพร่
 * เสมอ / การลบเฉพาะเมื่อยืนยันตายจริง หรือเป็น cleanup ที่มาพร้อม rotation
 *
 * ห่วงโซ่เต็ม (แต่ละข้อมีหลักฐานใน suite ของตัวเอง):
 * middleware ไม่ลบ (middleware.auth.test r11) → handler ไม่ลบ (ไฟล์นี้) →
 * logout เจอ credential จริงจึงยิง revoke (logout route.test r9: rotate→403→
 * gateway-401 → 503 + เก็บ token; กดซ้ำหลังล้าง = idempotent)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => {
  // cookie store จำลอง — เก็บสิ่งที่ handler เขียนกลับ (สิ่งที่ browser จะได้รับ)
  const jar = new Map<string, { value: string; options?: unknown }>();
  return {
    cookies: async () => ({
      getAll: () =>
        [...jar.entries()].map(([name, { value }]) => ({ name, value })),
      set: (name: string, value: string, options?: unknown) => {
        jar.set(name, { value, options });
      },
      delete: (name: string) => {
        jar.delete(name);
      },
      __jar: jar,
    }),
  };
});

vi.mock("../config", () => ({
  getConfig: () => ({
    supabaseUrl: "http://supabase.test.local",
    supabaseAnonKey: "test-anon-key",
  }),
}));

import { cookies } from "next/headers";
import { getUser } from "./session";

const AUTH_COOKIE = "sb-supabase-auth-token";

/** session หมดอายุ — บังคับ refresh ภายใน getUser ของ SDK จริง */
const EXPIRED_SESSION_JSON = JSON.stringify({
  access_token: "access-token-old",
  refresh_token: "refresh-token-test",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) - 600,
  user: {
    id: "11111111-1111-4111-8111-000000000099",
    aud: "authenticated",
    email: "probe@example.com",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  },
});

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** สถานะ cookie ที่ browser ถืออยู่ (jar ของ next/headers mock) */
async function jarSnapshot(): Promise<Map<string, string>> {
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  return new Map([...jar.entries()].map(([name, { value }]) => [name, value]));
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  jar.clear();
  jar.set(AUTH_COOKIE, { value: EXPIRED_SESSION_JSON });
});

describe("getUser กับ SDK จริง — commitAuthWrites ตามนโยบายเดียวกับ middleware (gate r12 M1)", () => {
  it("refresh โดน 401 จากชั้น key-auth ของ gateway (ไม่มี code) → คืน null แต่ **ห้ามลบ cookie** — logout ถัดมายังเจอ credential จึง revoke ได้", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(401, { message: "Invalid authentication credentials" }),
    );
    await expect(getUser()).resolves.toBeNull();
    const jar = await jarSnapshot();
    // credential ยังอยู่ครบ (browser ไม่โดนล้างจาก handler)
    expect(jar.get(AUTH_COOKIE)).toBe(EXPIRED_SESSION_JSON);
  });

  it("refresh โดน 429 (transient) → คืน null โดยไม่ลบ cookie", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(429, { code: 429, msg: "rate_limit" }));
    await expect(getUser()).resolves.toBeNull();
    const jar = await jarSnapshot();
    expect(jar.get(AUTH_COOKIE)).toBe(EXPIRED_SESSION_JSON);
  });

  it("refresh ตอบ user_banned (บัญชีระงับ ≠ session สิ้นสภาพ) → คืน null โดยไม่ลบ cookie", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(400, { code: 400, error_code: "user_banned", msg: "Invalid Refresh Token: User Banned" }),
    );
    await expect(getUser()).resolves.toBeNull();
    const jar = await jarSnapshot();
    expect(jar.get(AUTH_COOKIE)).toBe(EXPIRED_SESSION_JSON);
  });

  it("positive control: refresh_token_already_used (ตายจริงตาม live probe) → คืน null และลบ cookie ถึง browser", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(400, {
        code: 400,
        error_code: "refresh_token_already_used",
        msg: "Invalid Refresh Token: Already Used",
      }),
    );
    await expect(getUser()).resolves.toBeNull();
    const jar = await jarSnapshot();
    const entry = jar.get(AUTH_COOKIE) ?? "";
    expect(entry === "" || jar.has(AUTH_COOKIE) === false || entry.length === 0).toBe(true);
  });

  it("rotation สำเร็จ: refresh ตอบ session ใหม่ → commit เขียน token ใหม่ถึง browser (แม้ getUser ต่อจะไม่สำเร็จ)", async () => {
    const freshSession = JSON.stringify({
      access_token: "access-token-new",
      refresh_token: "refresh-token-new",
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
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        return jsonResponse(200, JSON.parse(freshSession));
      }
      // /auth/v1/user ล้ม (เช่น gateway ตอบ 401 ไร้ code) — rotation ยังต้องถึง browser
      return jsonResponse(401, { message: "Invalid authentication credentials" });
    });
    await expect(getUser()).resolves.toBeNull();
    const jar = await jarSnapshot();
    const stored = jar.get(AUTH_COOKIE) ?? "";
    // token ใหม่ถูกเขียนกลับ (ไม่ทิ้ง rotation กลางอากาศ — วิถีเดียวกับ r8 ของ logout)
    // ค่าที่ @supabase/ssr เขียนเข้ารหัส base64url นำหน้าด้วย "base64-"
    expect(stored.startsWith("base64-")).toBe(true);
    const decoded = Buffer.from(stored.slice("base64-".length), "base64url").toString("utf8");
    expect(decoded).toContain("access-token-new");
    expect(decoded).toContain("refresh-token-new");
  });

  it("rotation + cleanup ของ chunk: session ใหม่ใหญ่เกิน chunk เดียว → เขียน .0/.1 และ**ลบ base เก่า**พร้อมกัน (cleanup ไม่ถูกทิ้ง — r12 M2 ฝั่ง handler)", async () => {
    const freshBig = JSON.stringify({
      access_token: `access-token-new-${"x".repeat(12000)}`,
      refresh_token: "refresh-token-new",
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
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        return jsonResponse(200, JSON.parse(freshBig));
      }
      return jsonResponse(401, { message: "Invalid authentication credentials" });
    });
    await expect(getUser()).resolves.toBeNull();
    const jar = await jarSnapshot();
    // chunk ใหม่เขียนถึง browser
    expect(jar.has(`${AUTH_COOKIE}.0`)).toBe(true);
    expect(jar.get(`${AUTH_COOKIE}.0`) ?? "").not.toBe("");
    // base เก่าถูกเก็บกวาด (ค่าว่าง) ไม่ค้างให้ combineChunks อ่าน token เก่า
    expect(jar.get(AUTH_COOKIE) ?? "").toBe("");
  });
});

/**
 * route.auth.test — gate r13 M1 regression ผ่าน **public handler จริง**
 * (GET /api/v1/categories) ตามที่ codex สั่ง: "พร้อม regression ผ่าน public
 * handler จริง" — ใช้ @supabase/ssr + supabase-js จริงทั้งเส้น mock เฉพาะ
 * transport (global fetch) + next/headers + ตัวแปรสภาพแวดล้อมของ config
 *
 * ห่วงโซ่ที่ codex พิสูจน์ (และถูกปิดทีละข้อ):
 * middleware ไม่ลบ (middleware.auth.test r11) → getUser ไม่ลบ
 * (session.auth.test r12) → **query ภายใน handler ไม่ลบ (ไฟล์นี้ r13)** →
 * logout เจอ credential จริงจึงยิง revoke (logout route.test r9–r10)
 *
 * จุดรั่ว: handler นี้ไม่ได้เรียก .auth ตรง ๆ เลย แต่ `.from()` ของ
 * supabase-js เรียก `_getSessionToken()` → `auth.getSession()` ภายใน SDK →
 * refresh โดน 401 ไร้ code ของ gateway → `_removeSession()` → setAll(deletions)
 * ลบ cookie ทันที แม้ middleware เพิ่งรักษาไว้ — logout ถัดมา 204 ไม่ revoke
 */
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://supabase.test.local";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

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

import { cookies } from "next/headers";
import { GET } from "./route";

const AUTH_COOKIE = "sb-supabase-auth-token";

/** session หมดอายุ — บังคับ refresh ภายใน _getSessionToken ของ query จริง */
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

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** สถานะ cookie ที่ browser ถืออยู่หลัง response ของ handler */
async function jarMap(): Promise<Map<string, string>> {
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  return new Map([...jar.entries()].map(([name, { value }]) => [name, value]));
}

function categoriesRequest(): Request {
  return new Request("http://localhost:3000/api/v1/categories", {
    method: "GET",
    headers: { "x-request-id": "req-auth-test" },
  });
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  jar.clear();
  jar.set(AUTH_COOKIE, { value: EXPIRED_SESSION_JSON });
});

describe("GET /api/v1/categories กับ SDK จริง — query path ไม่ล้าง credential (gate r13 M1)", () => {
  it("refresh ระหว่าง query โดน 401 จากชั้น key-auth ของ gateway (ไม่มี code) → cookie ของ browser ไม่ถูกลบ — logout ถัดมายัง revoke ได้", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(401, { message: "Invalid authentication credentials" }),
    );
    const res = await GET(categoriesRequest());
    // handler ตอบ error ตามปกติ (query ล้ม — เรื่องของ ERR-SYS-002) แต่สิ่งที่
    // สำคัญคือ cookie ของ browser: ต้องเห็น credential เดิมครบ
    expect(res.status).toBeGreaterThanOrEqual(400);
    const jar = await jarMap();
    expect(jar.get(AUTH_COOKIE)).toBe(EXPIRED_SESSION_JSON);
  });

  it("rotation ระหว่าง query สำเร็จ (gateway ฟื้นแล้ว) → token ใหม่ถึง browser — แก้แบบกั๊กไม่ได้: กันการลบแล้วทิ้ง rotation คือคนละเรื่อง", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        return jsonResponse(200, {
          access_token: "handler-fresh-token",
          refresh_token: "handler-fresh-refresh",
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
      // /rest/v1/* — หมวดว่างก็พอ (เราดูที่ jar ไม่ใช่ผล query)
      return jsonResponse(200, []);
    });
    await GET(categoriesRequest());
    const jar = await jarMap();
    const stored = jar.get(AUTH_COOKIE) ?? "";
    expect(stored.startsWith("base64-")).toBe(true);
    const decoded = Buffer.from(stored.slice("base64-".length), "base64url").toString("utf8");
    expect(decoded).toContain("handler-fresh-token");
    expect(decoded).toContain("handler-fresh-refresh");
  });
});

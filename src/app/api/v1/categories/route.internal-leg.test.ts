/**
 * route.internal-leg.test — gate cleanup r2 M1 regression ผ่าน **public handler จริง**
 * (GET /api/v1/categories + @supabase/ssr + supabase-js จริง) — mock เฉพาะ transport
 * (global fetch) + next/headers + ตัวแปรสภาพแวดล้อมของ config
 *
 * r1 M1 (cb68382) ปิด middleware แล้ว แต่ codex r2 ชี้ว่า handler เองยังหมุน token
 * ได้: SDK (_useSession) สั่ง refresh เมื่อ token เหลือ < EXPIRY_MARGIN_MS (90 วิ)
 * ไม่ว่า autoRefreshToken จะเปิดหรือไม่ → rotation กลางขาในสำเร็จ server-side แต่
 * Set-Cookie โดน RSC loader ทิ้ง = browser คา parent เก่า (race PB-1)
 *
 * แก้ที่ src/lib/supabase/ssr.ts: client ของขาใน (header x-ltc-bff-internal: 1)
 * ได้ global.fetch ที่บล็อก POST /auth/v1/token ด้วย 400 non-retryable · error_code
 * `bff_internal_leg` อยู่นอก allowlist ตายจริงของ auth-errors → SDK preserve session
 * ที่ยังไม่หมดอายุจริง (handler ทำงานต่อด้วย token เดิม) และการลบ credential ตอน
 * token ตายจริงโดนนโยบาย setAll กลืนตาม doctrine r13 เหมือนเดิม
 */
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://supabase.test.local";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// header ของ request ปัจจุบัน — เปลี่ยนได้รายเคส (hoisted เพราะ vi.mock factory)
const h = vi.hoisted(() => ({ requestHeaders: {} as Record<string, string> }));

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
    // headers() ของ route handler — อ่าน x-ltc-bff-internal ที่ fixture ฝั่ง server ติ้ง
    headers: async () => new Headers(h.requestHeaders),
  };
});

import { cookies } from "next/headers";
import { GET } from "./route";

const AUTH_COOKIE = "sb-supabase-auth-token";

/** session เหลืออายุ 45 วิ — ใน margin 90 วิของ SDK (จุดชนของ race PB-1) */
const NEAR_EXPIRY_SESSION_JSON = JSON.stringify({
  access_token: "access-token-old",
  refresh_token: "refresh-token-near",
  token_type: "bearer",
  expires_in: 45,
  expires_at: Math.floor(Date.now() / 1000) + 45,
  user: {
    id: "11111111-1111-4111-8111-000000000099",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  },
});

/** session ตายจริง — หมุนไม่ได้และ preserve ไม่ได้ */
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

/** การหมุน token ที่ gateway ตอบสำเร็จ (ใช้กับ positive control เท่านั้น) */
function freshTokenResponse(): Response {
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

async function jarMap(): Promise<Map<string, string>> {
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  return new Map([...jar.entries()].map(([name, { value }]) => [name, value]));
}

function categoriesRequest(): Request {
  return new Request("http://localhost:3000/api/v1/categories", {
    method: "GET",
    headers: { "x-request-id": "req-internal-leg-test" },
  });
}

/** URL ทุกเส้นที่วิ่งออกนอกโปรแกรมจริง (interceptor กลืน /token ของขาในก่อนถึงตรงนี้) */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  h.requestHeaders = {};
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  jar.clear();
});

describe("GET /api/v1/categories กับ SDK จริง — ขาใน x-ltc-bff-internal ไม่หมุน token (gate r2 M1)", () => {
  it("token เหลือ 45 วิ (ใน margin 90 ของ SDK) + ขาใน → SDK พยายาม refresh ถูก interceptor บล็อก → handler 200 ด้วย token เดิม · browser เก็บ credential เดิมเป๊ะ · ไม่มี POST /auth/v1/token ออกนอกเครื่อง", async () => {
    h.requestHeaders = { "x-ltc-bff-internal": "1" };
    const jar = (await cookies()) as unknown as { __jar: Map<string, { value: string }> };
    jar.__jar.set(AUTH_COOKIE, { value: NEAR_EXPIRY_SESSION_JSON });
    // ทุกเส้น (รวม /token ถ้ามีรอดออกไป) ตอบสำเร็จแบบ fresh — ถ้า interceptor รั่ย
    // jar จะมี handler-fresh-token และ fetchedUrls จะมี /auth/v1/token
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) return freshTokenResponse();
      return jsonResponse(200, []);
    });

    const res = await GET(categoriesRequest());

    expect(res.status).toBe(200);
    expect(fetchedUrls().some((u) => u.includes("/auth/v1/token"))).toBe(false);
    // query วิ่งต่อด้วย access token เดิม (preserve path ของ auth-js)
    const restCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/rest/v1/"),
    );
    expect(restCall).toBeDefined();
    const initHeaders = (restCall?.[1] as RequestInit | undefined)?.headers;
    const authz =
      initHeaders instanceof Headers
        ? (initHeaders.get("authorization") ?? "")
        : String(
            (initHeaders as Record<string, string> | undefined)?.Authorization ??
              (initHeaders as Record<string, string> | undefined)?.authorization ??
              "",
          );
    expect(authz).toContain("access-token-old");

    const stored = (await jarMap()).get(AUTH_COOKIE);
    expect(stored).toBe(NEAR_EXPIRY_SESSION_JSON);
  });

  it("positive control: request เดียวกันแต่ไม่มี header ขาใน → rotation วิ่งจริงถึง transport และเผยแพร่ถึง browser — พิสูจน์ว่า interceptor คือสิ่งที่บล็อก ไม่ใช่ความบังเอิญอื่น", async () => {
    const jar = (await cookies()) as unknown as { __jar: Map<string, { value: string }> };
    jar.__jar.set(AUTH_COOKIE, { value: NEAR_EXPIRY_SESSION_JSON });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) return freshTokenResponse();
      return jsonResponse(200, []);
    });

    await GET(categoriesRequest());

    const tokenCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input).includes("/auth/v1/token"),
    );
    expect(tokenCalls.length).toBeGreaterThanOrEqual(1);
    const stored = (await jarMap()).get(AUTH_COOKIE) ?? "";
    expect(stored.startsWith("base64-")).toBe(true);
    const decoded = Buffer.from(
      stored.slice("base64-".length),
      "base64url",
    ).toString("utf8");
    expect(decoded).toContain("handler-fresh-token");
  });

  it("ขาใน + token ตายจริง → refresh ถูกบล็อกเหมือนกัน (session null) แต่การลบ credential โดนนโยบาย setAll กลืน (deathConfirmed=false) — browser ยังถือ credential เดิมไว้ให้รอบถัดไปตัดสินตาม allowlist", async () => {
    h.requestHeaders = { "x-ltc-bff-internal": "1" };
    const jar = (await cookies()) as unknown as { __jar: Map<string, { value: string }> };
    jar.__jar.set(AUTH_COOKIE, { value: EXPIRED_SESSION_JSON });
    fetchMock.mockImplementation(async () => jsonResponse(200, []));

    await GET(categoriesRequest());

    expect(fetchedUrls().some((u) => u.includes("/auth/v1/token"))).toBe(false);
    const stored = (await jarMap()).get(AUTH_COOKIE);
    expect(stored).toBe(EXPIRED_SESSION_JSON);
  });
});

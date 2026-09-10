/**
 * ssr.query.auth.test — gate r13 M1: เส้น query/RPC ของ client ธรรมดา
 * (createSupabaseSsrClient) ต้องไม่ล้าง credential ที่ยังมีชีวิต
 * (ใช้ @supabase/ssr + auth-js + postgrest-js จริง — mock เฉพาะ transport
 * (global fetch) + next/headers + config)
 *
 * จุดรั่วที่ codex พิสูจน์ (r13): handler ไม่ได้เรียก .auth ตรง ๆ ก็รั่ว —
 * `.from()`/`.rpc()` ของ supabase-js เรียก `_getSessionToken()` →
 * `auth.getSession()` ภายใน SDK เพื่อหา JWT → access หมดอายุ → refresh →
 * โดนปฏิเสธ non-retryable (gateway 401 ไร้ code) → `_removeSession()` →
 * setAll(deletions) — ทะลุถึง cookie ของ response แม้ middleware เพิ่งรักษา
 * ไว้ (r11) และ getUser แก้แล้ว (r12): logout ถัดมาเจอ cookie ว่าง → 204
 * โดยไม่เคย revoke
 *
 * fix: setAll ของ client นี้ผ่านนโยบายกลาง selectPublishableAuthCookies —
 * client นี้ไม่เคยเห็น error ของ refresh จึงใช้ deathConfirmed=false:
 * rotation เผยแพร่เสมอ / การลบตระกูล auth ที่ไม่มี rotation ร่วมชุด = ทิ้ง
 * (การเก็บกวาดตอนตายจริงเป็นของ middleware/getUser/logout ที่เห็น error)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => {
  // cookie store จำลอง — เก็บสิ่งที่ client เขียนกลับ (สิ่งที่ browser จะได้รับ)
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
import { createSupabaseSsrClient } from "./ssr";

const AUTH_COOKIE = "sb-supabase-auth-token";

/** session หมดอายุ (base เดี่ยว) — บังคับ refresh ภายใน _getSessionToken ของ query */
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

/** แยก session เป็นชุด chunk ตามที่ @supabase/ssr เขียนจริง (base64url ทุก 3180) */
function chunkedValues(json: string): Array<{ name: string; value: string }> {
  const encoded = `base64-${Buffer.from(json, "utf8").toString("base64url")}`;
  const chunks: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < encoded.length; i += 3180) {
    chunks.push({ name: `${AUTH_COOKIE}.${i / 3180}`, value: encoded.slice(i, i + 3180) });
  }
  return chunks;
}

/** สถานะ cookie ที่ browser ถืออยู่ */
async function jarMap(): Promise<Map<string, string>> {
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  return new Map([...jar.entries()].map(([name, { value }]) => [name, value]));
}

/** รัน query จริงผ่าน client ธรรมดา (trigger _getSessionToken ของ supabase-js) */
async function runQuery(): Promise<void> {
  const supabase = await createSupabaseSsrClient();
  await supabase.from("course_categories").select("id").limit(1);
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  const store = await cookies();
  const jar = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
  jar.clear();
  jar.set(AUTH_COOKIE, { value: EXPIRED_SESSION_JSON });
});

describe("query/RPC บน createSupabaseSsrClient กับ SDK จริง — นโยบายเดียวกับ middleware/getUser (gate r13 M1)", () => {
  it("refresh ระหว่าง query โดน 401 จากชั้น key-auth ของ gateway (ไม่มี code) → **ห้ามลบ cookie** — logout ถัดมายังเจอ credential จึง revoke/เก็บ token ได้", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(401, { message: "Invalid authentication credentials" }),
    );
    await runQuery();
    const jar = await jarMap();
    // credential ยังอยู่เป๊ะ — ทั้ง middleware (r11) / getUser (r12) / query (r13)
    // สามชั้นไม่มีชั้นไหนล้าง credential ที่ยังมีชีวิตอีก
    expect(jar.get(AUTH_COOKIE)).toBe(EXPIRED_SESSION_JSON);
  });

  it("rotation ระหว่าง query สำเร็จ → token ใหม่ถึง browser (ห้ามทิ้ง rotation กลางอากาศ)", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        return jsonResponse(200, JSON.parse(sessionJson(200, "query-fresh")));
      }
      return jsonResponse(200, []); // /rest/v1/* ตอบ empty ก็พอ — ดูที่ jar
    });
    await runQuery();
    const jar = await jarMap();
    const stored = jar.get(AUTH_COOKIE) ?? "";
    expect(stored.startsWith("base64-")).toBe(true);
    const decoded = Buffer.from(stored.slice("base64-".length), "base64url").toString("utf8");
    expect(decoded).toContain("query-fresh");
  });

  it("rotation ระหว่าง query + cleanup ของ chunk (หลาย chunk → base เดี่ยว) → ลบ .N เก่าครบชุดพร้อมเขียน base ใหม่", async () => {
    // เริ่มจาก session chunked หมดอายุ
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
    const store = await cookies();
    const jarRaw = (store as unknown as { __jar: Map<string, { value: string }> }).__jar;
    jarRaw.clear();
    const chunks = chunkedValues(expiredBig);
    for (const { name, value } of chunks) {
      jarRaw.set(name, { value });
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        return jsonResponse(200, JSON.parse(sessionJson(200, "query-fresh")));
      }
      return jsonResponse(200, []);
    });
    await runQuery();
    const jar = await jarMap();
    // base เดี่ยวใหม่ถูกเขียน (rotation เผยแพร่เสมอ)
    expect((jar.get(AUTH_COOKIE) ?? "").startsWith("base64-")).toBe(true);
    // ทุก chunk เก่าถูกเก็บกวาด (deletion ของ rotation ขี่มากับการเขียน — ไม่ทิ้ง)
    for (const { name } of chunks) {
      const value = jar.get(name);
      expect(value === undefined || value === "").toBe(true);
    }
  });

  it("positive boundary: refresh_token_already_used ระหว่าง query (ตายจริง) → client นี้ก็ไม่ลบ — การเก็บกวาดเป็นของ middleware/getUser/logout ที่เห็น error (รอบถัดไป)", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(400, {
        code: 400,
        error_code: "refresh_token_already_used",
        msg: "Invalid Refresh Token: Already Used",
      }),
    );
    await runQuery();
    const jar = await jarMap();
    // conservative รอบเดียว: credential ตายค้างไว้ถึง request ถัดไปที่เห็น error
    // (middleware ทุก request / requireUser ของ protected route / logout) —
    // ยอมช้าหนึ่งรอบเพื่อไม่ผิดทาง "ล้างของที่ยังมีชีวิต" ซึ่งแพงกว่า
    expect(jar.get(AUTH_COOKIE)).toBe(EXPIRED_SESSION_JSON);
  });
});

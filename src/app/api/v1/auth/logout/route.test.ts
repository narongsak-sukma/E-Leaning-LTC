/**
 * unit tests — POST /api/v1/auth/logout (gate r4+r5) — ใช้ SDK จริงทั้งเส้น
 * (createServerClient ของ @supabase/ssr ผ่าน createSupabaseSsrClientBuffered)
 * mock เฉพาะ transport (global fetch) และ cookieStore (next/headers) — แนวเดียวกับ
 * ที่ codex ใช้พิสูจน์จุดรั่ว: r4 (upstream ล้ม→401 โดยไม่ signOut) และ r5
 * (SDK เคลียร์ cookie แม้ revoke ล้ม → กดซ้ำได้ 204 ทั้งที่ token ยังไม่ถูก revoke)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    supabaseUrl: "http://supabase.test.local",
    supabaseAnonKey: "test-anon-key",
  }),
}));

const { cookieSet, jar } = vi.hoisted(() => {
  const cookieSet = vi.fn();
  const jar: { name: string; value: string }[] = [];
  return { cookieSet, jar };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => jar.slice(),
    set: cookieSet,
  })),
}));

import { POST } from "./route";

/** session จำลองที่ SDK อ่านได้ (expires ยังไม่ถึง — ไม่ trigger refresh) */
const SESSION_COOKIE = {
  name: "sb-supabase-auth-token", // sb-<hostname.split(".")[0]>-auth-token
  value: JSON.stringify({
    access_token: "access-token-test",
    refresh_token: "refresh-token-test",
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
  }),
};

/** session ที่ access token หมดอายุแล้ว (ASCII ล้วน — encodeURIComponent ไม่ยืดความยาว) */
function expiredSessionJson(padBytes: number): string {
  return JSON.stringify({
    access_token: "access-token-old",
    refresh_token: "refresh-token-test",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 600,
    user: {
      id: "11111111-1111-4111-8111-000000000099",
      aud: "authenticated",
      app_metadata: {},
      user_metadata: padBytes > 0 ? { pad: "x".repeat(padBytes) } : {},
      created_at: "2026-01-01T00:00:00Z",
    },
  });
}

/** session ใหม่ที่ refresh endpoint คืน (เล็ก — พอ chunk เดียว) */
const FRESH_SESSION = {
  access_token: "access-token-fresh-2",
  refresh_token: "refresh-token-2",
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
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  cookieSet.mockClear();
  jar.length = 0;
});

describe("POST /api/v1/auth/logout (SDK จริง + mock transport)", () => {
  it("revoke สำเร็จ → 204 + commit การลบ cookie", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toContain("http://supabase.test.local/auth/v1/logout");
    expect(String(url)).toContain("scope=local");
    expect(init.method).toBe("POST");
    expect(cookieSet).toHaveBeenCalled(); // commit ลบ session cookie
  });

  it("upstream 503 → 503 ERR-SYS-002 และไม่ commit ลบ cookie (ยัง retry ได้)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    const res = await POST();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(cookieSet).not.toHaveBeenCalled(); // cookie session ยังอยู่บนเครื่อง
  });

  it("503 → ผู้ใช้กดซ้ำ (upstream กลับมา) → ครั้งที่สอง revoke จริง + 204 + commit (จุดรั่ว r5)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const first = await POST();
    expect(first.status).toBe(503);
    expect(cookieSet).not.toHaveBeenCalled(); // ครั้งแรกห้ามเคลียร์ cookie
    const second = await POST();
    expect(second.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2); // revoke ถูกเรียกซ้ำจริง ไม่ข้ามเป็น 204
    expect(cookieSet).toHaveBeenCalled(); // commit หลัง revoke สำเร็จ
  });

  it("ไม่มี session cookie → 204 โดยไม่ยิง logout เลย (idempotent)", async () => {
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("auth server ตอบ 401 (refresh token ตายแล้ว) → 204 + commit ล้าง cookie เก่า", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Invalid refresh token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST();
    expect(res.status).toBe(204);
    expect(cookieSet).toHaveBeenCalled();
  });

  // ---- gate r6: access token หมดอายุ → refresh ก่อน revoke (SDK กลืน bad_jwt) ----

  it("access หมดอายุ + refresh ถูกปฏิเสธด้วย 400 invalid_grant (GoTrue) → 204 + commit (session ตายจริง)", async () => {
    jar.push({ name: SESSION_COOKIE.name, value: expiredSessionJson(0) });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ไม่ signOut — ไม่มี session ที่ใช้ได้เหลืออยู่
    const [url] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toContain("/auth/v1/token");
    expect(String(url)).toContain("grant_type=refresh_token");
    expect(cookieSet).toHaveBeenCalled(); // ล้าง cookie เก่าทิ้ง
  });

  it("access หมดอายุ + refresh ถูกปฏิเสธ (401) → 204 + commit (session ตายจริง)", async () => {
    jar.push({ name: SESSION_COOKIE.name, value: expiredSessionJson(0) });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token is expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ไม่ signOut — ไม่มี session ที่ใช้ได้เหลืออยู่
    expect(cookieSet).toHaveBeenCalled(); // ล้าง cookie เก่าทิ้ง
  });

  it("access หมดอายุ (session ใหญ่ chunk .0/.1) + refresh ได้ session ใหม่ + revoke สำเร็จ → 204, ไม่มี token หลงเหลือใน cookie ที่เขียนกลับ (จุดรั่ว r6 merged getAll)", async () => {
    // จำลอง chunked jar ตาม @supabase/ssr จริง: ASCII ล้วน → encodeURIComponent ไม่ยืด
    // ความยาว → ตัดที่ 3180 (MAX_CHUNK_SIZE) ได้ชื่อ .0/.1 ตรงตาม chunker.js
    const big = expiredSessionJson(3600);
    expect(big.length).toBeGreaterThan(3180); // ต้องแตกเป็นหลาย chunk จริง
    jar.push({ name: `${SESSION_COOKIE.name}.0`, value: big.slice(0, 3180) });
    jar.push({ name: `${SESSION_COOKIE.name}.1`, value: big.slice(3180) });

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        expect(String(init.body)).toContain("refresh-token-test"); // ใช้ refresh token เดิมจาก chunked jar
        return new Response(JSON.stringify(FRESH_SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/auth/v1/logout")) {
        // revoke ต้องใช้ access token ใหม่ ไม่ใช่ token หมดอายุตัวเก่า
        expect(JSON.stringify(init.headers)).toContain("access-token-fresh-2");
        return new Response(null, { status: 204 });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });

    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2); // refresh แล้ว logout — ไม่กลืน bad_jwt

    // คุณสมบัติปลายทางของ merged getAll: ทุก cookie sb-* ที่ commit ลงเครื่อง
    // ต้องเป็นการ "ลบ" เท่านั้น — ห้ามมี session token (เก่า/ใหม่) ถูกเขียนกลับ
    const sbWrites = cookieSet.mock.calls as unknown as Array<[string, string, { maxAge?: number }]>;
    const sbCookieWrites = sbWrites.filter(([name]) => String(name).startsWith("sb-"));
    expect(sbCookieWrites.length).toBeGreaterThan(0);
    for (const [name, value, options] of sbCookieWrites) {
      const isDeletion = value === "" || options?.maxAge === 0;
      expect(isDeletion, `cookie ${name} ต้องเป็นการลบ ไม่ใช่เขียน token กลับ (value=${value.slice(0, 40)}…)`).toBe(true);
    }
  });
});

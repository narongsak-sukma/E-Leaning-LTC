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
});

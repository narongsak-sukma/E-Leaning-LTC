/**
 * unit tests — POST /api/v1/auth/logout (gate r4→r8) — ใช้ SDK จริงทั้งเส้น
 * (createServerClient ของ @supabase/ssr ผ่าน createSupabaseSsrClientBuffered)
 * mock เฉพาะ transport (global fetch) และ cookieStore (next/headers) — แนวเดียวกับ
 * ที่ codex ใช้พิสูจน์จุดรั่ว: r4 (upstream ล้ม→401 โดยไม่ signOut) · r5 (SDK เคลียร์
 * cookie แม้ revoke ล้ม → กดซ้ำได้ 204) · r6 (SDK กลืน bad_jwt) · r7 (getSession คืน
 * error จาก refresh 429 แต่ route กลืน → 204 เท็จ · bad_jwt 403 โดยไม่พยายาม refresh)
 * · r8 (ปฏิเสธซ้ำหลัง refresh สำเร็จ ≠ ตายจริง · rotation ภายใน getSession ถูกทิ้ง ·
 * base→chunks ล้างไม่ครบชื่อที่เกิดใหม่ใน buffer) · r9 (401 จากชั้น key-auth ของ
 * gateway ไม่มี error code ≠ session ตาย — ยึด code เฉพาะ refresh_token_not_found /
 * invalid_grant เท่านั้น รูป body ตาม live probe ของ cluster จริง)
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
const FRESH_SESSION = freshSessionJson(0);

/** session ใหม่พร้อมขยายขนาด (pad ASCII — บังคับให้แตกเป็นหลาย chunk ตาม chunker จริง) */
function freshSessionJson(padBytes: number) {
  return {
    access_token: "access-token-fresh-2",
    refresh_token: "refresh-token-2",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3500,
    user: {
      id: "11111111-1111-4111-8111-000000000099",
      aud: "authenticated",
      app_metadata: {},
      user_metadata: padBytes > 0 ? { pad: "x".repeat(padBytes) } : {},
      created_at: "2026-01-01T00:00:00Z",
    },
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  cookieSet.mockClear();
  jar.length = 0;
});

/** cookie sb-* ที่ถูก commit ลงเครื่อง (คู่ [name, value, options]) */
function sbCookieWrites(): Array<[string, string, { maxAge?: number }]> {
  const writes = cookieSet.mock.calls as unknown as Array<[string, string, { maxAge?: number }]>;
  return writes.filter(([name]) => String(name).startsWith("sb-"));
}

/** ถอดรหัสค่า cookie ที่ SDK เขียน (ค่าเริ่มต้น cookieEncoding=base64url → นำหน้า base64-) */
function decodedWriteValue(value: string): string {
  return value.startsWith("base64-")
    ? Buffer.from(value.slice("base64-".length), "base64url").toString("utf8")
    : value;
}

/** ทุก cookie sb-* ที่ commit ลงเครื่องต้องเป็น "การลบ" เท่านั้น */
function expectOnlySbDeletions(): void {
  const sbWrites = sbCookieWrites();
  expect(sbWrites.length).toBeGreaterThan(0);
  for (const [name, value, options] of sbWrites) {
    const isDeletion = value === "" || options?.maxAge === 0;
    expect(isDeletion, `cookie ${name} ต้องเป็นการลบ ไม่ใช่เขียน token กลับ (value=${value.slice(0, 40)}…)`).toBe(true);
  }
}

describe("POST /api/v1/auth/logout (SDK จริง + mock transport)", () => {
  it("revoke สำเร็จ → 204 + commit การลบ cookie (fetch ตรงมี apikey+Bearer)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toContain("http://supabase.test.local/auth/v1/logout");
    expect(String(url)).toContain("scope=local");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["apikey"]).toBe("test-anon-key");
    expect(headers["authorization"]).toBe("Bearer access-token-test");
    expect(cookieSet).toHaveBeenCalled(); // commit ลบ session cookie
    expectOnlySbDeletions();
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

  it("ไม่มี session cookie → 204 โดยไม่ยิง logout เลย (idempotent — เก็บกวาด cookie เสียด้วย)", async () => {
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
    // v4: ไม่มี session ที่ใช้ได้ = จบแล้ว — clearAuthCookies เก็บกวาดชื่อ base ให้เรียบร้อย
    expectOnlySbDeletions();
  });

  it("revoke โดน 401 แต่ refresh ได้ token ใหม่ → revoke ซ้ำด้วยตัวใหม่ + 204 (จุดรั่ว r6/r7)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 401, msg: "bad jwt" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FRESH_SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(3); // revoke → refresh → revoke ใหม่
    const secondRefresh = fetchMock.mock.calls[1] as [URL | string, RequestInit];
    expect(String(secondRefresh[0])).toContain("/auth/v1/token");
    const retryRevoke = fetchMock.mock.calls[2] as [URL | string, RequestInit];
    expect(String(retryRevoke[0])).toContain("/auth/v1/logout");
    expect((retryRevoke[1].headers as Record<string, string>)["authorization"]).toBe(
      "Bearer access-token-fresh-2",
    );
    expect(cookieSet).toHaveBeenCalled();
    expectOnlySbDeletions();
  });

  it("revoke โดน 401 + refresh ตอบ refresh_token_not_found → session ตายจริง → 204 + commit ล้าง cookie เก่า", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 401, msg: "bad jwt" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cookieSet).toHaveBeenCalled();
    expectOnlySbDeletions();
  });

  // ---- gate r7 M1: getSession คืน error จาก refresh ภายใน (429) — ห้าม 204 เท็จ ----

  it("access หมดอายุ + refresh โดน 429 (rate-limit) → 503 ERR-SYS-002 ไม่ commit (จุดรั่ว r7 M1)", async () => {
    jar.push({ name: SESSION_COOKIE.name, value: expiredSessionJson(0) });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 429, msg: "rate_limit" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(fetchMock).toHaveBeenCalledTimes(1); // แค่ refresh ภายในของ getSession — ไม่มีการล้าง/204
    expect(cookieSet).not.toHaveBeenCalled(); // SDK queue การลบไว้ใน buffer แต่เราทิ้งมัน
  });

  // ---- gate r6/r7: access token หมดอายุ → SDK refresh ภายใน getSession ----

  it("access หมดอายุ + refresh ตอบ refresh_token_not_found (GoTrue จริง — live probe) → 204 + commit (session ตายจริง)", async () => {
    jar.push({ name: SESSION_COOKIE.name, value: expiredSessionJson(0) });
    // รูป body ตามที่ GoTrue ใน cluster ตอบจริง (probe ในเครื่อง): code เป็นตัวเลข
    // → SDK หยิบ error_code เป็น AuthApiError.code = "refresh_token_not_found"
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ไม่ revoke — ไม่มี session ที่ใช้ได้เหลืออยู่
    const [url] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toContain("/auth/v1/token");
    expect(String(url)).toContain("grant_type=refresh_token");
    expect(cookieSet).toHaveBeenCalled(); // ล้าง cookie เก่าทิ้ง
    expectOnlySbDeletions();
  });

  // ---- gate r9 M1: 401 จาก gateway (ไม่มี error code) ≠ session ตาย — ห้าม 204 ----

  it("access หมดอายุ + refresh โดน 401 จากชั้น key-auth ของ gateway (ไม่มี code) → 503 ไม่ commit ไม่ revoke (จุดรั่ว r9 M1)", async () => {
    jar.push({ name: SESSION_COOKIE.name, value: expiredSessionJson(0) });
    // Kong key-auth ตอบจริง (probe ในเครื่อง): 401 ไม่มี error_code ใด ๆ —
    // ไม่ได้แตะ session ฝั่ง server เลย จึงห้ามถือว่าตายจริง
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Invalid authentication credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(fetchMock).toHaveBeenCalledTimes(1); // แค่ refresh ภายใน — ไม่มีทางถึง revoke
    expect(cookieSet).not.toHaveBeenCalled(); // SDK queue การลบไว้ แต่เราทิ้งมัน — session ยังอยู่
  });

  it("getSession หมุนสำเร็จ → revoke โดน 403 → refresh รอบถัดไปโดน 401 gateway → 503 + commit เก็บ token ใหม่ (จุดรั่ว r9 M1 เส้นที่สอง)", async () => {
    // jar เป็น base เดี่ยวหมดอายุ → getSession refresh ภายในสำเร็จ (rotation เกิดก่อน
    // revoke) → revoke โดน 403 bad_jwt → refreshSession โดน 401 จาก gateway (ไม่มี
    // code) — เดิม isDefinitiveAuthError ยึด status → dead() ล้าง cookie + 204 ทิ้ง
    // token ใหม่ที่เพิ่งออก ทั้งที่ session ฝั่ง server ยังมีชีวิต
    jar.push({ name: SESSION_COOKIE.name, value: expiredSessionJson(0) });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FRESH_SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 403, msg: "bad_jwt" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Invalid authentication credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );
    const res = await POST();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(fetchMock).toHaveBeenCalledTimes(3); // refresh ภายใน → revoke → refresh รอบสอง
    // commit เก็บ session ที่เพิ่งหมุนไว้ — ห้ามล้างทิ้ง (session ยังมีชีวิตฝั่ง server)
    const writes = sbCookieWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some(([, value]) => decodedWriteValue(value).includes("access-token-fresh-2"))).toBe(true);
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

    // คุณสมบัติปลายทางของ merged getAll + clearAuthCookies: ทุก cookie sb-* ที่ commit
    // ลงเครื่องต้องเป็นการ "ลบ" เท่านั้น — ห้ามมี session token (เก่า/ใหม่) ถูกเขียนกลับ
    expectOnlySbDeletions();
  });

  // ---- gate r7 M2: bad_jwt 403 กับ token ที่ยังไม่หมดอายุ — refresh แล้ว revoke ซ้ำ ----

  it("revoke โดน 403 bad_jwt (token ยังไม่หมดอายุตามเครื่อง) → refresh + revoke ใหม่ (จุดรั่ว r7 M2)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 403, msg: "bad_jwt" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FRESH_SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await POST();
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryRevoke = fetchMock.mock.calls[2] as [URL | string, RequestInit];
    expect(String(retryRevoke[0])).toContain("/auth/v1/logout");
    expect((retryRevoke[1].headers as Record<string, string>)["authorization"]).toBe(
      "Bearer access-token-fresh-2",
    );
    expect(cookieSet).toHaveBeenCalled();
    expectOnlySbDeletions();
  });

  it("revoke โดน 403 bad_jwt ซ้ำกับ token ที่เพิ่งออกใหม่ → ไม่ใช่ตายจริง → 503 + commit เก็บ session ใหม่ (จุดรั่ว r8 M1)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 403, msg: "bad_jwt" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FRESH_SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 403, msg: "bad_jwt" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
    const res = await POST();
    // refresh เพิ่งสำเร็จ = session ยังมีชีวิตแน่นอน — bad_jwt กับ token ใหม่คือปัญหา
    // ฝั่งตรวจ JWT (เช่น signing key ไม่ตรงกัน) ไม่ใช่หลักฐานว่า session สิ้นสภาพ
    // ห้ามตอบ 204 + ล้าง cookie แกล้งว่า logout สำเร็จ
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(fetchMock).toHaveBeenCalledTimes(3); // จบที่ retry เดียว — ไม่วนไม่รู้จบ
    // commit เก็บ session ที่หมุนแล้วไว้ (เขียนกลับ ไม่ใช่การลบ) — ลองใหม่ภายหลังได้
    const writes = sbCookieWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some(([, value]) => decodedWriteValue(value).includes("access-token-fresh-2"))).toBe(true);
    expect(writes.some(([, value]) => decodedWriteValue(value).includes("access-token-test"))).toBe(false); // token เก่าไม่ถูกเขียนกลับ
  });

  // ---- gate r8 m1: rotation ภายใน getSession — transient ถัดไปห้ามทิ้ง token ใหม่ ----

  it("getSession หมุน token ภายในเอง + revoke โดน network ล้ม → 503 + commit เก็บ session ใหม่ (จุดรั่ว r8 m1)", async () => {
    // base เดี่ยว access หมดอายุ → SDK refresh ภายใน getSession เอง (ไม่มี rotation
    // ที่ route มองเห็นก่อน r8) แล้ว revoke ตัวแรกโดน network ล้ม
    jar.push({ name: SESSION_COOKIE.name, value: expiredSessionJson(0) });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FRESH_SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new TypeError("network down"));
    const res = await POST();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(fetchMock).toHaveBeenCalledTimes(2); // refresh ภายใน + revoke ที่ล้ม
    // ต้อง commit เก็บ refresh token ใหม่ไว้ — ไม่ใช่ทิ้งการเขียนทิ้งทั้งหมด
    const writes = sbCookieWrites();
    expect(writes.some(([, value]) => decodedWriteValue(value).includes("access-token-fresh-2"))).toBe(true);
  });

  // ---- gate r8 M2: refresh เปลี่ยน base เดี่ยว → หลาย chunk ต้องล้างครบทุกชื่อ ----

  it("base เดี่ยว + refresh โตเป็น 3 chunks + revoke สำเร็จ → commit ลบครบทั้ง base/.0/.1/.2 ไม่มี token หลุดกลับ (จุดรั่ว r8 M2)", async () => {
    // jar เริ่มจาก base เดี่ยว (session เล็ก หมดอายุ) — refresh คืน session ใหญ่
    // จน @supabase/ssr แตกเป็น chunk .0/.1/.2 ใหม่ใน buffer เท่านั้น (jar ไม่มีชื่อเหล่านี้)
    const small = expiredSessionJson(0);
    expect(small.length).toBeLessThanOrEqual(3180);
    jar.push({ name: SESSION_COOKIE.name, value: small });
    const bigFresh = freshSessionJson(6400);
    expect(JSON.stringify(bigFresh).length).toBeGreaterThan(2 * 3180); // 3 chunks จริง

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) {
        return new Response(JSON.stringify(bigFresh), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/auth/v1/logout")) {
        return new Response(null, { status: 204 });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });

    const res = await POST();
    expect(res.status).toBe(204);

    // ปลายทางของ clearAuthCookies แบบ union (jar+pending): ทุกชื่อ sb-* ที่ commit
    // เป็นการลบ และครอบคลุม chunk ใหม่ทุกชื่อที่เพิ่งเกิดใน buffer ระหว่าง request
    expectOnlySbDeletions();
    const deletedNames = new Set(sbCookieWrites().map(([name]) => String(name)));
    expect(deletedNames).toContain(SESSION_COOKIE.name);
    expect(deletedNames).toContain(`${SESSION_COOKIE.name}.0`);
    expect(deletedNames).toContain(`${SESSION_COOKIE.name}.1`);
    expect(deletedNames).toContain(`${SESSION_COOKIE.name}.2`);
  });
});

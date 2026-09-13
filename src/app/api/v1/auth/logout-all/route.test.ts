/**
 * unit tests — POST /api/v1/auth/logout-all (AUTH-010 · Wave G P1)
 *
 * แนวเดียวกับ logout route.test เดิม: ใช้ SDK จริงทั้งเส้น (createServerClient ผ่าน
 * createSupabaseSsrClientBuffered) mock เฉพาะ transport (global fetch — ครอบทั้ง
 * GoTrue logout และ PostgREST RPC ของ audit) และ cookieStore (next/headers) —
 * พิสูจน์: fail-closed (ไม่มีทาง 204 เหมือนสำเร็จโดยไม่ยืนยัน revoke), audit
 * AUTH_SESSION_REVOKE ถูกเรียกด้วย context ตรง allowlist 0008:474, rate limit
 * group AUTH ทำงานก่อนแตะ GoTrue
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetRateLimitStore } from "@/lib/rate-limit";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ authPerMin: 10 }));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    supabaseUrl: "http://supabase.test.local",
    supabaseAnonKey: "test-anon-key",
    supabaseServiceRoleKey: "test-service-key",
    rateLimit: { authPerMin: state.authPerMin },
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

const USER_ID = "11111111-1111-4111-8111-000000000099";
const SESSION_ID = "22222222-2222-4222-8222-000000000001";
const SESSION_ID_FRESH = "22222222-2222-4222-8222-000000000002";

/** access token จำลอง (JWT รูปถูกต้อง — claim session_id ตรงที่ route อ่าน) */
function jwtWithSessionId(sid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: USER_ID, session_id: sid })).toString(
    "base64url",
  );
  return `${header}.${payload}.sig`;
}

/** session จำลองที่ SDK อ่านได้ (expires ยังไม่ถึง — ไม่ trigger refresh) */
const SESSION_COOKIE = {
  name: "sb-supabase-auth-token", // sb-<hostname.split(".")[0]>-auth-token
  value: JSON.stringify({
    access_token: jwtWithSessionId(SESSION_ID),
    refresh_token: "refresh-token-test",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3500,
    user: {
      id: USER_ID,
      aud: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    },
  }),
};

/** session ใหม่ที่ refresh endpoint คืน (rotation คง session_id เดิมตาม GoTrue จริง) */
const FRESH_SESSION = {
  access_token: jwtWithSessionId(SESSION_ID_FRESH),
  refresh_token: "refresh-token-2",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3500,
  user: {
    id: USER_ID,
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2020-01-01T00:00:00Z",
  },
};

const fetchMock = vi.fn();

/** Request จำลอง (url + header x-request-id ตาม middleware จริง) */
function newRequest(): Request {
  return new Request("http://app.test/api/v1/auth/logout-all", {
    method: "POST",
    headers: { "x-forwarded-for": "10.0.0.1", "x-request-id": "req-0001" },
  });
}

/** dispatch fetch จำลอง — GoTrue logout + PostgREST RPC ตอบสำเร็จ */
function mockHappyFetch(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/logout")) {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/rest/v1/rpc/append_audit_event")) {
      return new Response(JSON.stringify("00000000-0000-4000-8000-0000000000aa"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`unexpected ${url}`, { status: 500 });
  });
}

/** คำขอ RPC ของ audit ทั้งหมด (จาก fetch mock) */
function rpcCalls(): Array<[URL | string, RequestInit]> {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes("/rest/v1/rpc/append_audit_event"),
  ) as Array<[URL | string, RequestInit]>;
}

beforeEach(() => {
  state.authPerMin = 10;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  cookieSet.mockClear();
  jar.length = 0;
  resetRateLimitStore();
});

describe("POST /api/v1/auth/logout-all (SDK จริง + mock transport)", () => {
  it("revoke สำเร็จ (scope=global) + audit RPC สำเร็จ → 204 + ลบ cookie + context ตรง allowlist", async () => {
    jar.push(SESSION_COOKIE);
    mockHappyFetch();
    const res = await POST(newRequest());
    expect(res.status).toBe(204);
    // revoke ด้วย fetch ตรง scope=global ด้วย Bearer ของ session เดิม
    const [revokeUrl, revokeInit] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(revokeUrl)).toContain("http://supabase.test.local/auth/v1/logout");
    expect(String(revokeUrl)).toContain("scope=global");
    expect(revokeInit.method).toBe("POST");
    expect((revokeInit.headers as Record<string, string>)["apikey"]).toBe("test-anon-key");
    expect((revokeInit.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer " + (JSON.parse(SESSION_COOKIE.value) as { access_token: string }).access_token,
    );
    // audit AUTH_SESSION_REVOKE ผ่าน service-role RPC — context ตรง allowlist 0008:474
    const rpcs = rpcCalls();
    expect(rpcs.length).toBe(1);
    const body = JSON.parse(String(rpcs[0]?.[1].body)) as Record<string, unknown>;
    expect(body["p_action"]).toBe("AUTH_SESSION_REVOKE");
    expect(body["p_entity_type"]).toBe("user");
    expect(body["p_entity_id"]).toBe(USER_ID);
    expect(body["p_actor_roles"]).toBeNull();
    expect(body["p_ip_hash"]).toBeNull();
    expect(body["p_user_agent"]).toBeNull();
    expect(body["p_request_id"]).toBe("req-0001");
    expect(body["p_context"]).toEqual({
      user_id: USER_ID,
      session_id: SESSION_ID,
      reason: "logout_all",
    });
    // service-role key ใช้กับ RPC เท่านั้น (SDK ส่ง headers เป็น Headers instance)
    expect(new Headers(rpcs[0]?.[1].headers).get("apikey")).toBe("test-service-key");
    // ล้าง cookie เฉพาะหลัง audit ผ่าน — เฉพาะการลบ ไม่มีการเขียน token กลับ
    expect(cookieSet).toHaveBeenCalled();
    const writes = cookieSet.mock.calls as unknown as Array<[string, string, { maxAge?: number }]>;
    for (const [name, value, options] of writes.filter(([n]) => String(n).startsWith("sb-"))) {
      expect(value === "" || options?.maxAge === 0, `cookie ${String(name)} ต้องเป็นการลบ`).toBe(
        true,
      );
    }
  });

  it("audit RPC ล้มซ้ำ 2 ครั้ง → 503 ERR-SYS-002 + ไม่ล้าง cookie (fail-closed audit)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/logout")) {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/rest/v1/rpc/append_audit_event")) {
        return new Response(JSON.stringify({ message: "permission denied", code: "42501" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    const res = await POST(newRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("logout_all_audit_unavailable");
    expect(rpcCalls().length).toBe(2); // retry อีกครั้งเดียว — แบบแผน B7
    expect(cookieSet).not.toHaveBeenCalled(); // cookie session ยังอยู่ (กดซ้ำได้)
  });

  it("revoke โดน 503 → 503 ERR-SYS-002 + ไม่เรียก audit + ไม่ล้าง cookie (fail-closed revoke)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    const res = await POST(newRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(rpcCalls().length).toBe(0); // ยังไม่ยืนยัน revoke — ห้าม audit
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("ไม่มี session → 204 โดยไม่ยิง fetch เลย (idempotent เหมือน logout เดิม)", async () => {
    const res = await POST(newRequest());
    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revoke โดน 401 + refresh ตอบ refresh_token_not_found (ยืนยันตายจริง) → 204 + ล้าง cookie โดยไม่ audit (ไม่มีอะไรถูก revoke สด)", async () => {
    jar.push(SESSION_COOKIE);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/logout")) {
        return new Response(JSON.stringify({ code: 401, msg: "bad jwt" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/auth/v1/token")) {
        return new Response(
          JSON.stringify({
            code: 400,
            error_code: "refresh_token_not_found",
            msg: "Invalid Refresh Token: Refresh Token Not Found",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    const res = await POST(newRequest());
    expect(res.status).toBe(204);
    expect(rpcCalls().length).toBe(0);
    expect(cookieSet).toHaveBeenCalled();
    const writes = cookieSet.mock.calls as unknown as Array<[string, string, { maxAge?: number }]>;
    for (const [name, value, options] of writes.filter(([n]) => String(n).startsWith("sb-"))) {
      expect(value === "" || options?.maxAge === 0, `cookie ${String(name)} ต้องเป็นการลบ`).toBe(
        true,
      );
    }
  });

  it("revoke โดน 403 bad_jwt → refresh สำเร็จ → revoke ซ้ำด้วย token ใหม่ + audit → 204", async () => {
    jar.push(SESSION_COOKIE);
    let logoutCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/logout")) {
        logoutCalls += 1;
        // ครั้งแรกถูกปฏิเสธ (bad_jwt) — ครั้งที่สอง (หลังหมุน token) สำเร็จ
        const status = logoutCalls === 1 ? 403 : 204;
        return new Response(
          status === 403 ? JSON.stringify({ code: 403, msg: "bad_jwt" }) : null,
          { status, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/auth/v1/token")) {
        return new Response(JSON.stringify(FRESH_SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/rest/v1/rpc/append_audit_event")) {
        return new Response(JSON.stringify("00000000-0000-4000-8000-0000000000aa"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    const res = await POST(newRequest());
    expect(res.status).toBe(204);
    // revoke ลำดับที่สอง (หลังหมุน token) ใช้ access token ใหม่
    const calls = fetchMock.mock.calls as Array<[URL | string, RequestInit]>;
    expect(calls.length).toBe(4); // revoke → refresh → revoke ใหม่ → audit RPC
    const retryRevoke = calls[2] as [URL | string, RequestInit];
    expect(String(retryRevoke[0])).toContain("scope=global");
    expect((retryRevoke[1].headers as Record<string, string>)["authorization"]).toBe(
      "Bearer " + FRESH_SESSION.access_token,
    );
    // audit ครั้งเดียว — ด้วย session_id ของ token ที่ revoke สำเร็จจริง
    const rpcs = rpcCalls();
    expect(rpcs.length).toBe(1);
    const body = JSON.parse(String(rpcs[0]?.[1].body)) as { p_context: Record<string, string> };
    expect(body.p_context["session_id"]).toBe(SESSION_ID_FRESH);
    expect(body.p_context["reason"]).toBe("logout_all");
    expect(cookieSet).toHaveBeenCalled();
  });

  // ---- rate limit group AUTH — ก่อนแตะ GoTrue (route ต้องโดนตัดที่ 429 ไม่ใช่ GoTrue) ----

  it("ยิงเกิน limit AUTH (10/นาที) → ครั้งที่ 11 = 429 ERR-RATE-001 โดยไม่แตะ fetch ทั้งหมด", async () => {
    jar.push(SESSION_COOKIE);
    mockHappyFetch();
    for (let i = 0; i < 10; i += 1) {
      const res = await POST(newRequest());
      expect(res.status).toBe(204);
    }
    fetchMock.mockClear(); // ตัดสินครั้งที่ 11 — ต้องไม่มี fetch ใด ๆ
    const limited = await POST(newRequest());
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as {
      error: { code: string; details: { retry_after_sec: number; group: string } };
    };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details["group"]).toBe("AUTH");
    expect(body.error.details["retry_after_sec"]).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

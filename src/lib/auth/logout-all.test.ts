/**
 * unit tests — src/lib/auth/logout-all.ts (AUTH-010 · Wave G P1)
 *
 * - sessionIdFromAccessToken: claim session_id ของ JWT payload (uuid) — decode ไม่ได้ /
 *   ไม่มี claim / ไม่ใช่ uuid = null (audit context.session_id ขาดได้ ไม่ทำ revoke ล้ม)
 * - auditSessionRevokeFailClosed: RPC body ตรง allowlist 0008:474 + retry อีกครั้งเดียว
 *   แล้ว throw ERR-SYS-002 (fail-closed — แบบแผน B7 ที่ src/lib/admin/users.ts:355 ใช้)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    supabaseUrl: "http://supabase.test.local",
    supabaseAnonKey: "test-anon-key",
    supabaseServiceRoleKey: "test-service-key",
    logLevel: "error",
    rateLimit: { authPerMin: 10 },
  }),
}));

import {
  auditSessionRevokeFailClosed,
  LOGOUT_ALL_REASON,
  sessionIdFromAccessToken,
} from "./logout-all";

const USER_ID = "11111111-1111-4111-8111-000000000099";
const SESSION_ID = "22222222-2222-4222-8222-000000000001";

/** access token จำลอง — payload มี/ไม่มี claim session_id ได้ */
function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

describe("sessionIdFromAccessToken", () => {
  it("JWT ที่มี claim session_id (uuid) → คืน uuid นั้น", () => {
    expect(sessionIdFromAccessToken(jwt({ sub: USER_ID, session_id: SESSION_ID }))).toBe(
      SESSION_ID,
    );
  });

  it("ไม่มี claim session_id → null", () => {
    expect(sessionIdFromAccessToken(jwt({ sub: USER_ID }))).toBeNull();
  });

  it("claim ไม่ใช่ uuid (ค่าปลอม) → null (กัน RPC reject เพราะ allowlist)", () => {
    expect(sessionIdFromAccessToken(jwt({ sub: USER_ID, session_id: "not-a-uuid" }))).toBeNull();
  });

  it("token ไม่ใช่ JWT (decode ไม่ได้) → null ไม่ throw", () => {
    expect(sessionIdFromAccessToken("garbage")).toBeNull();
    expect(sessionIdFromAccessToken("a.b.c")).toBeNull();
  });
});

describe("auditSessionRevokeFailClosed", () => {
  /** dispatch จำลอง PostgREST RPC — คืน status ตามลำดับที่ให้ (รันออก = 403 ทุกครั้ง) */
  function mockRpc(statuses: number[]): void {
    const queue = statuses.slice();
    fetchMock.mockImplementation(async () => {
      const status = queue.length > 0 ? (queue.shift() as number) : 403;
      const bodyJson =
        status < 400
          ? "00000000-0000-4000-8000-0000000000aa"
          : { message: "denied", code: "42501" };
      return new Response(JSON.stringify(bodyJson), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
  }

  /** คำขอ RPC ทั้งหมด (จาก fetch mock) */
  function rpcBodies(): Record<string, unknown>[] {
    return fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(String(init.body)) as Record<string, unknown>;
    });
  }

  it("RPC สำเร็จ → body ตรงสัญญา (action/entity/context ตาม allowlist + request_id)", async () => {
    mockRpc([200]);
    await auditSessionRevokeFailClosed({
      userId: USER_ID,
      sessionId: SESSION_ID,
      requestId: "req-42",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = rpcBodies()[0] ?? {};
    expect(body["p_action"]).toBe("AUTH_SESSION_REVOKE");
    expect(body["p_entity_type"]).toBe("user");
    expect(body["p_entity_id"]).toBe(USER_ID);
    expect(body["p_before"]).toBeNull();
    expect(body["p_after"]).toBeNull();
    expect(body["p_actor_roles"]).toBeNull();
    expect(body["p_ip_hash"]).toBeNull();
    expect(body["p_user_agent"]).toBeNull();
    expect(body["p_request_id"]).toBe("req-42");
    expect(body["p_context"]).toEqual({
      user_id: USER_ID,
      session_id: SESSION_ID,
      reason: LOGOUT_ALL_REASON,
    });
  });

  it("sessionId null → context ไม่มีคีย์ session_id (allowlist อนุญาตคีย์ขาด)", async () => {
    mockRpc([200]);
    await auditSessionRevokeFailClosed({ userId: USER_ID, sessionId: null, requestId: null });
    const body = rpcBodies()[0] ?? {};
    expect(body["p_context"]).toEqual({ user_id: USER_ID, reason: LOGOUT_ALL_REASON });
    expect(body["p_request_id"]).toBeNull();
  });

  it("RPC ล้มครั้งแรก ครั้งที่สองผ่าน → ไม่ throw (retry อีกครั้งเดียวตามแบบแผน B7)", async () => {
    mockRpc([403, 200]);
    await auditSessionRevokeFailClosed({
      userId: USER_ID,
      sessionId: SESSION_ID,
      requestId: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("RPC ล้มซ้ำ 2 ครั้ง → throw ERR-SYS-002 (details.reason = logout_all_audit_unavailable)", async () => {
    mockRpc([403, 403]);
    await expect(
      auditSessionRevokeFailClosed({ userId: USER_ID, sessionId: null, requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

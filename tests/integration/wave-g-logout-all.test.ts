/**
 * integration — POST /api/v1/auth/logout-all (AUTH-010 · Wave G P1) บน dev stack จริง
 *
 * สองระดับ:
 * (1) ทางแอปจริง (HTTP :3000): 2 session จาก password grant → logout-all ด้วย session
 *     A → refresh ด้วย refresh token ของ **ทั้ง A และ B** ต้องตาย (scope=global) ·
 *     Set-Cookie ลบ session cookie · audit_logs มีแถว AUTH_SESSION_REVOKE ตรง
 *     allowlist (context.reason = "logout_all" · context.session_id = claim ของ
 *     token ที่ใช้ revoke)
 * (2) fail-closed (in-process — mock fetch เฉพาะ GoTrue logout เป็น 503 ตามสัญญา
 *     ของเทส): route ต้องตอบ 503 ERR-SYS-002 **ไม่ล้าง cookie** และ session จริง
 *     ยังมีชีวิต (refresh grant ผ่าน Kong ได้ปกติ — GoTrue ไม่ถูกแตะ)
 *
 * ล็อก /tmp/ltc-it-lock ตามแบบแผนทีม (เขียน DB จริง — ห้ามรันขนานกับ integration อื่น)
 */
import { mkdirSync, rmdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestUser,
  deleteTestUser,
  psqlRows,
  restCall,
  TEST_PASSWORD,
  type TestUser,
} from "./helpers.js";

const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";
/** ชื่อ cookie ฝั่งแอป (คอนเทนเนอร์แอปเห็น GoTrue ที่ http://kong:8000 → sb-kong-auth-token) */
const AUTH_COOKIE = "sb-kong-auth-token";

// ─── in-process fail-closed: mock next/headers (jar cookie จำลอง) ──────────────
const { jar, cookieSet } = vi.hoisted(() => {
  const jar: { name: string; value: string }[] = [];
  const cookieSet = vi.fn();
  return { jar, cookieSet };
});
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => jar.slice(), set: cookieSet })),
  headers: vi.fn(async () => new Headers()),
}));

import { POST as logoutAllRoute } from "@/app/api/v1/auth/logout-all/route";
import { getConfig } from "@/lib/config";
import { resetRateLimitStore } from "@/lib/rate-limit";

// ─── lock protocol (/tmp/ltc-it-lock — รัน integration ทีละไฟล์ทั้งทีม) ────────
beforeAll(async () => {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    try {
      mkdirSync("/tmp/ltc-it-lock");
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}, 30 * 60_000 + 5_000);

afterAll(() => {
  try {
    rmdirSync("/tmp/ltc-it-lock");
  } catch {
    // ไม่มีล็อกให้ปลด — ข้าม (ปลายทางต้องพยายามปลดเสมอ แต่ปลดไม่ได้ = คนอื่นถืออยู่)
  }
});

// ─── helpers ───────────────────────────────────────────────────────────────────

/** password grant ใหม่ (session ใหม่ทุกครั้ง) — access/refresh token จริงจาก GoTrue */
async function passwordGrant(
  email: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email, password: TEST_PASSWORD },
  );
  if (res.status !== 200) {
    throw new Error(`password grant ล้ม (${res.status}): ${res.text.slice(0, 200)}`);
  }
  const body = res.json as { access_token?: string; refresh_token?: string };
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error("password grant ไม่คืน token ครบ");
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

/** grant refresh — ตัดสิน session ตาย/ยังอยู่ (ตาย = 4xx จาก GoTrue) */
async function refreshGrant(
  refreshToken: string,
): Promise<{ status: number; errorCode: string }> {
  const res = await restCall(
    "POST",
    "/auth/v1/token?grant_type=refresh_token",
    {},
    { refresh_token: refreshToken },
  );
  const body = (res.json ?? {}) as { error_code?: string; error?: string; msg?: string };
  return { status: res.status, errorCode: body.error_code ?? body.error ?? body.msg ?? "" };
}

/** claims ของ JWT (ไม่ตรวจลายเซ็น — ใช้กับ token ที่ GoTrue เพิ่งออกให้เท่านั้น) */
function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * session cookie ค่าจริง (base64- ตาม cookieEncoding ของ @supabase/ssr) จาก token
 * จริงของ grant — รูปเดียวกับที่ browser ถือหลัง login ผ่าน action (user.factors: []
 * ตามแบบแผน dcr14 — branch ของ SDK อ่านตรง ๆ)
 */
function sessionCookieValue(accessToken: string, refreshToken: string): string {
  const claims = jwtClaims(accessToken);
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: claims["exp"],
    user: {
      id: claims["sub"],
      aud: "authenticated",
      role: "authenticated",
      email: "",
      factors: [],
    },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

/** POST /api/v1/auth/logout-all ผ่านแอปจริง (Origin ตาม CSRF ของ BFF) */
async function callLogoutAllHttp(
  cookieValue: string,
  ip: string,
  requestId: string,
): Promise<{ status: number; setCookies: readonly string[] }> {
  const response = await fetch(`${APP_URL}/api/v1/auth/logout-all`, {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      origin: APP_URL,
      cookie: `${AUTH_COOKIE}=${cookieValue}`,
      "x-forwarded-for": ip,
      "x-request-id": requestId,
    },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, setCookies: response.headers.getSetCookie() };
}

const createdUsers: TestUser[] = [];

afterAll(async () => {
  for (const user of createdUsers) {
    try {
      await deleteTestUser(user.id);
    } catch {
      // cleanup ที่ล้มไม่ทำให้ชุดทดสอบแดง — DB ล้างด้วย replay ของ lead ได้
    }
  }
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /api/v1/auth/logout-all (dev stack จริง)", () => {
  it(
    "revoke จริง: session B ตายด้วย (refresh ไม่ผ่าน) + cookie ถูกล้าง + audit AUTH_SESSION_REVOKE ตรง allowlist",
    { timeout: 90_000 },
    async () => {
      const user = await createTestUser("w3loall");
      createdUsers.push(user);
      const a = await passwordGrant(user.email);
      const b = await passwordGrant(user.email);
      // สอง grant = สอง session คนละ session_id (จะได้พิสูจน์ว่า audit จด session ของ A)
      const sidA = jwtClaims(a.accessToken)["session_id"];
      const sidB = jwtClaims(b.accessToken)["session_id"];
      expect(typeof sidA).toBe("string");
      expect(sidA).not.toBe(sidB);

      const res = await callLogoutAllHttp(
        sessionCookieValue(a.accessToken, a.refreshToken),
        "10.60.0.1",
        "w3-loall-1",
      );
      expect(res.status).toBe(204);

      // session cookie (รวม chunk) ถูกลบทั้งหมด — ทุกชิ้น Max-Age=0
      const deletes = res.setCookies.filter((line) => line.startsWith(AUTH_COOKIE));
      expect(deletes.length).toBeGreaterThan(0);
      for (const line of deletes) {
        expect(line).toMatch(/[Mm]ax-[Aa]ge=0/);
      }

      // scope=global — session ตัวเรียก (A) และ session เครื่องอื่น (B) ตายทั้งคู่
      const ra = await refreshGrant(a.refreshToken);
      expect(ra.status).toBeGreaterThanOrEqual(400);
      const rb = await refreshGrant(b.refreshToken);
      expect(rb.status).toBeGreaterThanOrEqual(400);

      // audit — allowlist ['session_id','reason'] (0008:474) + actor จาก context.user_id
      const rows = await psqlRows<{
        action: string;
        actor_user_id: string;
        request_id: string | null;
        reason: string;
        session_id: string;
      }>(
        `select action, actor_user_id::text, request_id, ` +
          `context->>'reason' as reason, context->>'session_id' as session_id ` +
          `from public.audit_logs where entity_id = '${user.id}' ` +
          `and action = 'AUTH_SESSION_REVOKE' order by occurred_at desc limit 5;`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.actor_user_id).toBe(user.id);
      // middleware สร้าง x-request-id ใหม่ทุก request (src/middleware.ts:103) — client
      // ส่งค่าอะไรมาถูกทับเป็น uuid เสมอ · เทสนี้ยืนยันว่า BFF ส่งต่อ id ของ middleware จริง
      expect(rows[0]?.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(rows[0]?.reason).toBe("logout_all");
      expect(rows[0]?.session_id).toBe(sidA); // session ของ token ที่ revoke สำเร็จ
    },
  );

  it(
    "fail-closed (in-process · mock fetch): GoTrue logout ตอบ 503 → route 503 ERR-SYS-002 + ไม่ล้าง cookie + session ยังมีชีวิตจริง",
    { timeout: 90_000 },
    async () => {
      const user = await createTestUser("w3loallfc");
      createdUsers.push(user);
      const s = await passwordGrant(user.email);

      // ชื่อ cookie ตาม SUPABASE_URL ของ process นี้ (host เห็น GoTrue ที่ localhost)
      const cookieName = `sb-${new URL(getConfig().supabaseUrl).hostname.split(".")[0]}-auth-token`;
      jar.length = 0;
      cookieSet.mockClear();
      jar.push({ name: cookieName, value: sessionCookieValue(s.accessToken, s.refreshToken) });
      resetRateLimitStore();

      // mock fetch เฉพาะ GoTrue logout → 503 (upstream ล้ม) — อย่างอื่นผ่านจริง
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("/auth/v1/logout")) {
            return new Response("upstream down", { status: 503 });
          }
          return realFetch(input as Request, init);
        }),
      );
      try {
        const res = await logoutAllRoute(
          new Request("http://app.test/api/v1/auth/logout-all", {
            method: "POST",
            headers: { "x-forwarded-for": "10.60.0.2", "x-request-id": "w3-loall-fc" },
          }),
        );
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("ERR-SYS-002");
        // fail-closed — cookie session ยังอยู่ครบ (ไม่มีการเขียน/ลบใด ๆ)
        expect(cookieSet).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }

      // หลักฐานว่า GoTrue ไม่ถูกแตะ: refresh grant ด้วย refresh token เดิมยัง 200
      const alive = await refreshGrant(s.refreshToken);
      expect(alive.status).toBe(200);
    },
  );
});

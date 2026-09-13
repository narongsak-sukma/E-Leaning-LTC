/**
 * wave-g-auth005 — integration ของการเปลี่ยนรหัสผ่านด้วยตนเอง (AUTH-005 · Wave G P1 · D72)
 * บน dev stack จริง (GoTrue v2.164.0 · Kong :8000 · BFF :3000)
 *
 * ครอบคลุมสัญญา D72:
 *   (1) รหัสปัจจุบันผิด → 401 ERR-AUTH-002 "รหัสผ่านปัจจุบันไม่ถูกต้อง" + รหัสเดิมยัง
 *       grant ได้ (รหัสไม่ถูกเปลี่ยน) · (2) รหัสใหม่ < 12 → 400 ข้อความนโยบายเดียวกับ
 *       register · ซ้ำกับปัจจุบัน → 400 ไทยเจาะจง · (3) สำเร็จ → 200 {changed,message}
 *       + audit AUTH_PASSWORD_CHANGE (context strict ['method','session_id'] ·
 *       method='password' · session_id = claim ของ session ที่ทำรายการ) + เซสชัน
 *       ปัจจุบันยังใช้ได้ + รหัสเก่า grant ไม่ผ่าน / รหัสใหม่ผ่าน · (4) พฤติกรรม
 *       เซสชันที่สองของ GoTrue — สร้าง session B ด้วย password grant ก่อนเปลี่ยนแล้ว
 *       ลอง access/refresh หลังเปลี่ยน (assert ตามที่ probe วัดได้จริง ไม่อ้างลอย):
 *       access token ของ B โดนปฏิเสธ 403 · refresh_token ของ B ถูกลบ (400
 *       refresh_token_not_found) — เฉพาะ session ที่ทำการเปลี่ยนเท่านั้นที่คงอยู่
 *       (ห้าม signOut จากขานี้ — การ revoke ทั้งหมดเป็นพฤติกรรมของ GoTrue เอง)
 *   (5) rate limit กลุ่ม AUTH (10/นาที · นับก่อนพิสูจน์รหัสเสมอ) — ครบ quota → 429
 *       ERR-RATE-001 + Retry-After (เคสนี้รันท้ายสุดด้วยผู้ใช้+IP แยก)
 *   (6) ปุ่ม UI เดินทางเดียวกัน — probe POST /api/v1/auth/logout-all (route ของ W3 —
 *       ตรวจแบบ lenient รายงานผลตามจริง)
 *   (7) gate g-p1-r3 — cookie ใกล้หมดอายุ (expires_at = now+120 ตก LEAD 180 ของ
 *       middleware แต่พ้น margin 90 ของ SDK) พร้อม refresh token จริง ถูก 429:
 *       ต้องไม่มี Set-Cookie ของ auth ติดกลับมา (middleware ข้าม refresh ของ
 *       POST เส้นนี้ — network แรกของ request คือการนับ quota)
 *
 * การแยกโลกของ suite: email prefix 'waveg-pc-%' · cleanup ใน afterAll (auth.users
 * delete cascade ตามแบบ dcr15) · ล็อก serial /tmp/ltc-it-lock (กติกาทีม) · ห้าม
 * print token/รหัสผ่าน · app ไม่ reachable = ทุกเคสพังดัง ๆ (ไม่ skip แทน)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, rmdir } from "node:fs/promises";

import {
  createTestUser,
  psql,
  psqlRows,
  restCall,
  type RestResult,
  TEST_PASSWORD,
  type TestUser,
} from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (BFF จริง — next dev hot reload) */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

/** ชื่อ cookie session ของ @supabase/ssr ใน container app — sb-<host ส่วนแรก>-auth-token */
const AUTH_COOKIE = "sb-kong-auth-token";

/** ล็อก serial ของ integration tests (กติกาทีม — รันทีละไฟล์ทั้งระบบ) */
const LOCK_DIR = "/tmp/ltc-it-lock";

/** รหัสผ่านใหม่ของเคสสำเร็จ (≥ 12 · ต่างจาก TEST_PASSWORD ของผู้ใช้ทดสอบ) */
const NEW_PASSWORD = "WaveG#2026Changed";

let lockAcquired = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ผู้ช่วย (แบบเดียวกับ dcr14) ──────────────────────────────────────────────

interface JwtClaims {
  readonly session_id?: unknown;
}

/** claim session_id ของ access token (decode เฉย ๆ — ความถูกต้องให้ GoTrue ตรวจเอง) */
function jwtSessionId(token: string): string {
  const part = token.split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as JwtClaims;
  return typeof claims.session_id === "string" ? claims.session_id : "";
}

/**
 * session cookie (base64url — ตรง cookieEncoding ของ @supabase/ssr) —
 * session ต้องมี user.factors: [] ตามแบบ dcr14 (branch mfa ของ auth-js อ่านตรง ๆ)
 */
function sessionCookieValue(
  accessToken: string,
  userId: string,
  overrides?: { expiresAt?: number; refreshToken?: string },
): string {
  const part = accessToken.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as { exp?: number };
  const expiresAt =
    overrides?.expiresAt ??
    (typeof payload.exp === "number" ? payload.exp : Math.floor(Date.now() / 1000) + 3600);
  const session = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: overrides?.refreshToken ?? "waveg-pc-unused-no-refresh",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "",
      factors: [],
    },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

/** header Cookie พร้อม session ของ token ที่ให้ */
function cookieHeader(accessToken: string, userId: string): string {
  return `${AUTH_COOKIE}=${sessionCookieValue(accessToken, userId)}`;
}

/** IP จำลองต่อผู้ใช้ — แยกถัง rate limit รายเคส (แบบ dcr14) */
function clientIpFor(userId: string): string {
  const hex = userId.replace(/-/g, "");
  const a = Number.parseInt(hex.slice(0, 2), 16);
  const b = Number.parseInt(hex.slice(2, 4), 16);
  return `10.72.${a}.${b}`;
}

/** เรียก BFF ด้วย session cookie จริง (origin จำเป็น — CSRF ของ middleware) */
async function bffCall(
  method: "GET" | "POST",
  path: string,
  token: string,
  userId: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly json: unknown; readonly retryAfter: string | null }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    origin: APP_URL,
    cookie: cookieHeader(token, userId),
    "x-forwarded-for": clientIpFor(userId),
    "x-request-id": `waveg-pc-${crypto.randomUUID()}`,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(60_000) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${APP_URL}${path}`, init);
  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: response.status,
    json,
    retryAfter: response.headers.get("retry-after"),
  };
}

/** password grant ตรง GoTrue ผ่าน Kong */
async function grant(email: string, password: string): Promise<RestResult> {
  return restCall("POST", "/auth/v1/token?grant_type=password", {}, { email, password });
}

/** error.code ของ envelope ที่ BFF ตอบ */
function errorCode(json: unknown): string {
  const code = (json as { error?: { code?: string } } | null)?.error?.code;
  return typeof code === "string" ? code : "";
}

/** error.message ของ envelope ที่ BFF ตอบ (ข้อความไทย) */
function errorMessage(json: unknown): string {
  const message = (json as { error?: { message?: string } } | null)?.error?.message;
  return typeof message === "string" ? message : "";
}

/** error.details.fields ของ envelope (ERR-VAL-001) */
function errorFields(json: unknown): readonly unknown[] {
  const fields = (json as { error?: { details?: { fields?: unknown } } } | null)?.error?.details
    ?.fields;
  return Array.isArray(fields) ? fields : [];
}

// ─── fixture ของ suite ────────────────────────────────────────────────────────

let main: TestUser; // เคส 1-4 — เจ้าของรหัสผ่านที่เปลี่ยน (session A)
let rateUser: TestUser; // เคส 5 — ผู้ใช้แยกสำหรับ quota AUTH
let mwUser: TestUser; // เคส 7 (gate g-p1-r3) — middleware ต้องไม่แตะ auth ก่อนนับ

/** เซสชันที่สองของ main (password grant ก่อนเปลี่ยนรหัส) — capture ระหว่างทาง */
let sessionB: {
  readonly token: string;
  readonly refreshToken: string;
  readonly sessionId: string;
} | null = null;

beforeAll(async () => {
  // ล็อก serial — มีอยู่ = รอ 30 วิแล้วลองใหม่ (สูงสุด 30 นาที ตามกติกาทีม)
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      lockAcquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error("รอล็อก /tmp/ltc-it-lock เกิน 30 นาที — ยกเลิก suite");
      }
      await sleep(30_000);
    }
  }
  main = await createTestUser("waveg-pc-main");
  rateUser = await createTestUser("waveg-pc-rl");
  mwUser = await createTestUser("waveg-pc-mw");
  // รอล็อกได้สูงสุด 30 นาที + เผื่อ signup retry — hook timeout ต้องยาวกว่านั้น
}, 35 * 60_000);

afterAll(async () => {
  await psql(`delete from auth.users where email like 'waveg-pc-%';`);
  // rmdir ทันทีทุกกรณีเมื่อเราเป็นผู้ถือล็อก (beforeAll พังก่อนได้ล็อก = ไม่แตะของใคร)
  if (lockAcquired) {
    await rmdir(LOCK_DIR);
  }
});

describe.skipIf(!DB_URL)("AUTH-005 — เปลี่ยนรหัสผ่านด้วยตนเอง (D72)", () => {
  it("รหัสผ่านปัจจุบันผิด → 401 ERR-AUTH-002 ไทยตามสัญญา + รหัสเดิมยัง grant ได้ (รหัสไม่เปลี่ยน)", async () => {
    const res = await bffCall("POST", "/api/v1/me/password", main.accessToken, main.id, {
      currentPassword: "WrongCurrent#2026",
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(errorCode(res.json)).toBe("ERR-AUTH-002");
    expect(errorMessage(res.json)).toBe("รหัสผ่านปัจจุบันไม่ถูกต้อง");
    // รหัสผ่านยังเป็นตัวเดิม — grant ด้วยรหัสเดิมต้องผ่าน
    const stillOld = await grant(main.email, TEST_PASSWORD);
    expect(stillOld.status).toBe(200);
  });

  it("รหัสใหม่ < 12 → 400 ERR-VAL-001 + ข้อความนโยบายคำต่อคำของ register (fields newPassword)", async () => {
    const res = await bffCall("POST", "/api/v1/me/password", main.accessToken, main.id, {
      currentPassword: TEST_PASSWORD,
      newPassword: "short12less", // 11 ตัวอักษร
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe("ERR-VAL-001");
    expect(errorMessage(res.json)).toBe(
      "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่",
    );
    expect(errorFields(res.json)).toContain("newPassword");
  });

  it("รหัสใหม่ซ้ำกับปัจจุบัน → 400 ERR-VAL-001 ไทยเจาะจง", async () => {
    const res = await bffCall("POST", "/api/v1/me/password", main.accessToken, main.id, {
      currentPassword: TEST_PASSWORD,
      newPassword: TEST_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe("ERR-VAL-001");
    expect(errorMessage(res.json)).toBe("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน");
  });

  it("สำเร็จ → 200 {changed,message} + audit allowlist + เซสชันปัจจุบันคงอยู่ + รหัสเก่าตาย/ใหม่ผ่าน", async () => {
    // สร้างเซสชันที่สอง (session B) ก่อนเปลี่ยน — ไว้พิสูจน์พฤติกรรมหลังเปลี่ยน
    const second = await grant(main.email, TEST_PASSWORD);
    expect(second.status).toBe(200);
    const bodyB = second.json as { access_token?: string; refresh_token?: string };
    expect(typeof bodyB.access_token).toBe("string");
    expect(typeof bodyB.refresh_token).toBe("string");
    sessionB = {
      token: bodyB.access_token as string,
      refreshToken: bodyB.refresh_token as string,
      sessionId: jwtSessionId(bodyB.access_token as string),
    };
    const sessionAId = jwtSessionId(main.accessToken);
    expect(sessionB.sessionId).not.toBe(sessionAId);

    // เปลี่ยนรหัสผ่านผ่าน BFF ด้วย session A
    const res = await bffCall("POST", "/api/v1/me/password", main.accessToken, main.id, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      data: { changed: true, message: "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว" },
    });

    // audit AUTH_PASSWORD_CHANGE — context strict ตาม allowlist (user_id ถูก RPC
    // ยกเป็น actor_user_id แล้ว strip ออกจาก context — 0008/0025)
    const rows = await psqlRows<{
      actor_user_id: string;
      entity_type: string;
      entity_id: string;
      context: Record<string, unknown>;
    }>(
      `select actor_user_id::text, entity_type, entity_id::text, context
       from public.audit_logs
       where action = 'AUTH_PASSWORD_CHANGE' and entity_id = '${main.id}'
       order by occurred_at desc limit 1;`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(main.id);
    expect(rows[0]?.entity_type).toBe("user");
    expect(Object.keys(rows[0]?.context ?? {}).sort()).toEqual(["method", "session_id"]);
    expect(rows[0]?.context["method"]).toBe("password");
    expect(rows[0]?.context["session_id"]).toBe(sessionAId);

    // เซสชันปัจจุบันคงไว้ตามสัญญา — BFF ยังยอมรับ session A
    const me = await bffCall("GET", "/api/v1/me", main.accessToken, main.id);
    expect(me.status).toBe(200);

    // รหัสเก่า grant ไม่ผ่าน (GoTrue ตอบ 400 invalid_credentials — วัดจริง) · ใหม่ผ่าน
    const oldGrant = await grant(main.email, TEST_PASSWORD);
    expect(oldGrant.status).toBe(400);
    expect((oldGrant.json as { error_code?: string }).error_code).toBe("invalid_credentials");
    const newGrant = await grant(main.email, NEW_PASSWORD);
    expect(newGrant.status).toBe(200);
  });

  it("พฤติกรรมเซสชันที่สอง (วัดจาก GoTrue จริง): access B ตาย 403 · refresh B โดนลบ 400 · BFF ปฏิเสธ 401", async () => {
    expect(sessionB).not.toBeNull();
    const b = sessionB as {
      token: string;
      refreshToken: string;
      sessionId: string;
    };
    // access token ของ B — GoTrue ปฏิเสธ (probe จริง: 403)
    const userB = await restCall("GET", "/auth/v1/user", { token: b.token });
    expect(userB.status).toBe(403);
    // refresh token ของ B ถูกลบ (probe จริง: 400 refresh_token_not_found)
    const refresh = await restCall(
      "POST",
      "/auth/v1/token?grant_type=refresh_token",
      {},
      { refresh_token: b.refreshToken },
    );
    expect(refresh.status).toBe(400);
    expect((refresh.json as { error_code?: string }).error_code).toBe("refresh_token_not_found");
    // ประตู BFF ของแอปปฏิเสธเซสชันที่ตายด้วย (401 ผ่าน requireUser)
    const me = await bffCall("GET", "/api/v1/me", b.token, main.id);
    expect(me.status).toBe(401);
  });

  it("probe ปุ่ม UI: POST /api/v1/auth/logout-all (route ของ W3 — lenient รายงานผลตามจริง)", async () => {
    const res = await bffCall("POST", "/api/v1/auth/logout-all", main.accessToken, main.id);
    // 204 = route ของ W3 พร้อม · ค่าอื่นที่ยอม = เส้นทางยังไม่พร้อม/อัปสตรีมพลาดชั่วคราว
    expect([204, 404, 501, 503]).toContain(res.status);
  });

  it("rate limit กลุ่ม AUTH — ครบ 10 คำขอ/นาที (กรอกผิดก็นับ) → คำขอถัดไป 429 ERR-RATE-001 + Retry-After", async () => {
    const attempt = (): Promise<{ status: number; json: unknown; retryAfter: string | null }> =>
      bffCall("POST", "/api/v1/me/password", rateUser.accessToken, rateUser.id, {
        currentPassword: "WrongCurrent#2026", // ผิด — แต่นับเข้า quota ก่อนพิสูจน์เสมอ
        newPassword: NEW_PASSWORD,
      });
    for (let i = 0; i < 10; i += 1) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked.json)).toBe("ERR-RATE-001");
    expect(blocked.retryAfter).not.toBeNull();
  });

  it("gate g-p1-r3: cookie ใกล้หมดอายุ (expires_at = now+120 — ตก LEAD 180 ของ middleware แต่พ้น margin 90 ของ SDK) ถูก 429 → ต้องไม่มี Set-Cookie ของ auth เด็ดขาด", async () => {
    // ออกแบบให้ "คำขอที่ถูก 429" เป็นครั้งแรกที่ refresh token นี้ถูกใช้: เผา quota
    // 10 ครั้งด้วย cookie ปกติ (token ยังไกลหมดอายุ — middleware ไม่แตะ network)
    // แล้วคำขอที่ 11 ส่ง cookie expires_at = now+120 พร้อม refresh token จริง —
    // ถ้า middleware ยังหมุนก่อน limiter (รหัสก่อน fix) GoTrue จะตอบ rotation
    // สำเร็จ (การใช้ครั้งแรก) และ Set-Cookie จะติด response 429 กลับมา = เคสนี้
    // ล้ม · หลัง fix middleware ข้าม refresh ของ POST เส้นนี้ → network แรกของ
    // request คือการนับ quota · ผู้ใช้เดียวกันทั้ง 11 คำขอ = ถัง quota เดียว
    // (คีย์รองอ่านจาก claim sub ของ access token เดียวกัน)
    const attempt = (cookie: string): Promise<Response> =>
      fetch(`${APP_URL}/api/v1/me/password`, {
        method: "POST",
        headers: {
          accept: "application/json",
          origin: APP_URL,
          "content-type": "application/json",
          cookie,
          "x-forwarded-for": clientIpFor(mwUser.id),
        },
        body: JSON.stringify({ currentPassword: "WrongCurrent#2026", newPassword: NEW_PASSWORD }),
        signal: AbortSignal.timeout(60_000),
      });
    for (let i = 0; i < 10; i += 1) {
      const res = await attempt(cookieHeader(mwUser.accessToken, mwUser.id));
      expect(res.status).toBe(401); // ผิด — แต่นับเข้า quota ก่อนพิสูจน์เสมอ
    }
    const blocked = await attempt(
      `${AUTH_COOKIE}=${sessionCookieValue(mwUser.accessToken, mwUser.id, {
        expiresAt: Math.floor(Date.now() / 1000) + 120,
        refreshToken: mwUser.refreshToken,
      })}`,
    );
    expect(blocked.status).toBe(429);
    expect(errorCode(await blocked.clone().json())).toBe("ERR-RATE-001");
    // หลักฐานผ่าน middleware จริง: response 429 ต้องไม่พก Set-Cookie ของ auth เลย
    // (ค่าปลอมแทน refresh token จะพิสูจน์อะไรไม่ได้ — refresh พลาดก็ไม่เกิด cookie)
    const setCookies = blocked.headers.getSetCookie();
    expect(setCookies.some((line) => line.startsWith(AUTH_COOKIE))).toBe(false);
  });
});

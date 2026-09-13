/**
 * DCR-14 — integration tests ของสาย MFA ครบวงจร (Wave F · D-f-1) บน dev stack จริง —
 * ผ่าน BFF จริงของ container app (:3000) + GoTrue factors REST + RPC ผ่าน Kong:
 *
 *   a) enroll → verify (TOTP คำนวณจาก secret จริง) ผ่าน /api/v1/me/mfa/* ทั้งสาย
 *      · enroll ซ้ำ → 400 factor_exists · status ของ factor จริง = verified
 *   b) โค้ดสำรองครบวงจร: regenerate ด้วย session aal2 → 8 โค้ดรูป xxxx-xxxx
 *      · ตอบ no-store · GET backups (metadata ล้วน ไม่มีโค้ด) · consume ผ่าน
 *      RPC จริง → valid · โค้ดเดิมซ้ำ → valid:false (single-use) · unused ลดจริง
 *   c) login สองขั้นจริงของ staff:viewer (บทบาทบังคับ MFA): รหัสผ่านผ่าน →
 *      pending cookie (ไม่มี session cookie ใด ๆ) → รหัสผิด → การ์ดไทย invalid →
 *      รหัสถูก → session cookie aal2 จริง + pending ถูกล้าง
 *   d) ปิด MFA: บทบาทบังคับถูก 403 ERR-RBAC-001 (ข้อความไทยมีคำ MFA — แม้ recent-MFA
 *      ผ่าน) · aal1 ล้วน → 403 ERR-AUTH-004 · citizen มี factor + recent-MFA →
 *      200 disabled · factor หายจริง + ชุดโค้ดสำรองถูก invalidate
 *
 * การแยกโลกของ suite: email prefix 'dcr14-mfa-%' (cleanup ตามลำดับ FK —
 * mfa_factors/mfa_challenges ของ GoTrue cascade ตาม auth.users) · ห้าม log
 * token/JWT/secret ใด ๆ ใน output (D24) · app ไม่ reachable = skip ทุกเคส
 * (สแตกบางสภาพรันแค่ db+kong)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHmac } from "node:crypto";

import {
  ANON_KEY,
  createTestUser,
  psql,
  restCall,
  SERVICE_KEY,
  TEST_PASSWORD,
  type RestResult,
  type TestUser,
} from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (next dev — hot reload ผ่าน volume mount) — BFF จริงของทุกเคส */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

/** ชื่อ cookie session ของ @supabase/ssr ใน container app — sb-<host ส่วนแรก>-auth-token */
const AUTH_COOKIE = "sb-kong-auth-token";

/** pending cookie ของ login สองขั้น (src/lib/auth/mfa.ts MFA_PENDING_COOKIE) */
const PENDING_COOKIE = "ltc_mfa_pending";

/** app เข้าถึงได้หรือไม่ — ไม่ได้ = skip ทุกเคส */
let appReachable = false;

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ─────────────────────────────────────────────────

let mfaUser: TestUser; // เคส a/b — citizen · REST enroll → verify → โค้ดสำรอง
let staffUser: TestUser; // เคส c/d — staff:viewer (บทบาทบังคับ MFA)
let plainUser: TestUser; // เคส d — citizen · disable ได้เมื่อ recent-MFA ผ่าน

// ─── TOTP (RFC 6238 — HMAC-SHA1 · step 30s · 6 หลัก) — เหมือน src/lib/auth/mfa.ts ──

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** base32 decode (RFC 4648 — alphabet มาตรฐาน ไม่มี padding) */
function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/=+$/g, "")) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** รหัส TOTP 6 หลัก ณ หน้าต่างเวลาที่กำหนด */
function totpAt(secret: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(bin % 1_000_000).padStart(6, "0");
}

// ─── cookie session จริงสำหรับ BFF (รูปแบบ @supabase/ssr base64url — แบบ dcr13) ───

interface JwtPayload {
  readonly aal?: unknown;
  readonly exp?: number;
}

/**
 * base64url ของ session JSON — ตรงสูตร cookieEncoding:"base64url" ของ @supabase/ssr
 *
 * session ต้องมี `user.factors: []` — branch ของ auth-js ใน mfa.getAuthenticatorAssuranceLevel()
 * อ่าน session.user.factors ตรง ๆ (ไม่ guard undefined) — ขาด = TypeError → BFF fail-closed 500
 */
function sessionCookieValue(accessToken: string, userId: string): string {
  const part = accessToken.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as JwtPayload;
  const expiresAt = typeof payload.exp === "number" ? payload.exp : Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "dcr14-unused-no-refresh",
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

/** header Cookie พร้อม session ของ token ให้ (userId = id จริงของเจ้าของ session) */
function cookieHeader(accessToken: string, userId: string): string {
  return `${AUTH_COOKIE}=${sessionCookieValue(accessToken, userId)}`;
}

/**
 * ค่า session cookie จาก Set-Cookie ของ response — รวม chunk (@supabase/ssr แบ่งเมื่อ
 * ค่าเกินขนาด cookie: name.0, name.1 …) หรือชิ้นเดียว · ไม่มีเลย = null
 */
function sessionValueFromCookies(setCookies: readonly string[]): string | null {
  const parts: string[] = [];
  for (let idx = 0; ; idx += 1) {
    const value = setCookieValue(setCookies, `${AUTH_COOKIE}.${idx}`);
    if (value === null) {
      break;
    }
    parts.push(value);
  }
  if (parts.length > 0) {
    return parts.join("");
  }
  return setCookieValue(setCookies, AUTH_COOKIE);
}

/** ตรวจ claim aal ของ JWT (ไม่ log token — ใช้กับ token ที่ GoTrue คืนจาก verify เท่านั้น) */
function jwtAal(token: string): string {
  const part = token.split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as JwtPayload;
  return typeof claims.aal === "string" ? claims.aal : "";
}

// ─── GoTrue factors REST (Kong :8000 — ทางเดียวกับ helpers-aal2) ───────────────

/** password grant ใหม่เสมอ — token ที่ mint ก่อน verify ใด ๆ ตายหมด (ดู F-4 intel) */
async function freshAal1(user: TestUser): Promise<string> {
  const login = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email: user.email, password: TEST_PASSWORD },
  );
  const token = (login.json as { access_token?: string }).access_token ?? "";
  if (login.status !== 200 || token === "") {
    throw new Error(`freshAal1 ล้ม (HTTP ${login.status})`);
  }
  return token;
}

/**
 * enroll factor TOTP ของผู้ใช้ผ่าน GoTrue REST แล้ว verify จริง (verified) —
 * คืน {factorId, secret} สำหรับคำนวณรหัสในเทส · ใช้ fresh aal1 grant ภายใน
 * (verify จะฆ่า session อื่น — token คืนก่อนหน้านี้ทั้งหมดใช้ไม่ได้แล้ว)
 */
async function enrollVerifiedFactor(
  user: TestUser,
): Promise<{ readonly factorId: string; readonly secret: string }> {
  const aal1 = await freshAal1(user);
  const enroll = await restCall(
    "POST",
    "/auth/v1/factors",
    { token: aal1 },
    { factor_type: "totp", friendly_name: "dcr14-mfa-harness" },
  );
  const factorId = (enroll.json as { id?: string }).id ?? "";
  const secret = (enroll.json as { totp?: { secret?: string } }).totp?.secret ?? "";
  if (enroll.status !== 200 || factorId === "" || secret === "") {
    throw new Error(`enrollVerifiedFactor: enroll ล้ม (HTTP ${enroll.status})`);
  }
  const challenge = await restCall("POST", `/auth/v1/factors/${factorId}/challenge`, { token: aal1 }, {});
  const challengeId = (challenge.json as { id?: string }).id ?? "";
  if (challenge.status !== 200 || challengeId === "") {
    throw new Error("enrollVerifiedFactor: challenge ล้ม");
  }
  const verify = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/verify`,
    { token: aal1 },
    { challenge_id: challengeId, code: totpAt(secret, Date.now() / 1000) },
  );
  if (verify.status !== 200) {
    throw new Error("enrollVerifiedFactor: verify ล้ม (ข้ามขอบหน้าต่าง 30s — รันซ้ำแล้วผ่าน)");
  }
  return { factorId, secret };
}

/**
 * mint session aal2 จริงด้วย factor verified "ที่มีอยู่" (ไม่ enroll เพิ่ม —
 * ต่างจาก mintAal2Token ของ helpers-aal2) · fresh password grant → challenge →
 * verify → คืน access_token ที่ aal=aal2 · rollover ขอบหน้าต่าง 30s = ลองหน้าต่างถัดไป
 */
async function mintAal2WithFactor(
  user: TestUser,
  factorId: string,
  secret: string,
): Promise<string> {
  const aal1 = await freshAal1(user);
  const challenge = await restCall("POST", `/auth/v1/factors/${factorId}/challenge`, { token: aal1 }, {});
  const challengeId = (challenge.json as { id?: string }).id ?? "";
  if (challenge.status !== 200 || challengeId === "") {
    throw new Error("mintAal2WithFactor: challenge ล้ม");
  }
  const verify = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/verify`,
    { token: aal1 },
    { challenge_id: challengeId, code: totpAt(secret, Date.now() / 1000) },
  );
  if (verify.status === 200) {
    const token = (verify.json as { access_token?: string }).access_token ?? "";
    if (token === "" || jwtAal(token) !== "aal2") {
      throw new Error("mintAal2WithFactor: token ใหม่ไม่ใช่ aal2");
    }
    return token;
  }
  // ข้ามขอบหน้าต่าง — challenge ใหม่ + รหัสหน้าต่างถัดไป
  const challenge2 = await restCall("POST", `/auth/v1/factors/${factorId}/challenge`, { token: aal1 }, {});
  const challengeId2 = (challenge2.json as { id?: string }).id ?? "";
  if (challenge2.status !== 200 || challengeId2 === "") {
    throw new Error("mintAal2WithFactor: challenge (retry) ล้ม");
  }
  const verify2 = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/verify`,
    { token: aal1 },
    { challenge_id: challengeId2, code: totpAt(secret, Date.now() / 1000 + 30) },
  );
  const token2 = (verify2.json as { access_token?: string }).access_token ?? "";
  if (verify2.status !== 200 || token2 === "" || jwtAal(token2) !== "aal2") {
    throw new Error("mintAal2WithFactor: verify (retry) ล้ม — ไม่ได้ aal2");
  }
  return token2;
}

// ─── เรียก BFF จริง /api/v1/me/mfa/* (container app :3000 — session cookie จริง) ───

/**
 * IP จำลองประจำผู้ใช้ — rate limiter ของ BFF (D12-11) นับ bucket IP รวมทุก user
 * (กลุ่ม MFA = 10/นาที) · suite ยิง ~11 ครั้งจากเครื่องเดียวจึงโดน 429 ได้ —
 * จำลอง "ไคลเอนต์คนละเครื่อง" ด้วย x-forwarded-for ต่อ user (clientIpFrom อ่านค่านี้ก่อน)
 */
function clientIpFor(userId: string): string {
  const hex = userId.replace(/-/g, "");
  const a = Number.parseInt(hex.slice(0, 2), 16);
  const b = Number.parseInt(hex.slice(2, 4), 16);
  return `10.14.${a}.${b}`;
}

/** เรียก BFF — cookie session จริงจาก token ที่ให้ · คืน status/json/headers */
async function bffMfa(
  method: "GET" | "POST",
  path: string,
  token: string,
  userId: string,
  body?: unknown,
): Promise<{
  readonly status: number;
  readonly json: unknown;
  readonly setCookies: readonly string[];
  readonly cacheControl: string;
}> {
  const headers: Record<string, string> = {
    accept: "application/json",
    origin: APP_URL, // CSRF origin check ของ BFF — ไม่ส่ง = 403 csrf_origin_mismatch
    cookie: cookieHeader(token, userId),
    "x-forwarded-for": clientIpFor(userId),
    "x-request-id": `dcr14-${crypto.randomUUID()}`,
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
    setCookies: response.headers.getSetCookie(),
    cacheControl: response.headers.get("cache-control") ?? "",
  };
}

/** แยกค่า cookie ตามชื่อจาก Set-Cookie หลายแถว (คืน value ตามดิบ — ยังไม่ decode) */
function setCookieValue(setCookies: readonly string[], name: string): string | null {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = (pair ?? "").indexOf("=");
    if (eq > 0 && pair?.slice(0, eq) === name) {
      return pair.slice(eq + 1);
    }
  }
  return null;
}

/** แยก action id จาก HTML ของฟอร์ม Server Action (hidden input $ACTION_ID_<hash>) */
function parseActionId(html: string): string {
  const m = /\$ACTION_ID_([0-9a-f]+)/.exec(html);
  if (m === null) {
    throw new Error("parseActionId: ไม่เจอ action id ใน HTML");
  }
  return m[1] ?? "";
}

/**
 * POST ฟอร์ม Server Action แบบ no-JS (urlencoded + Origin) — คืน status,
 * Location (redirect: manual), Set-Cookie ทั้งหมด และ body HTML
 */
async function appFormPost(
  url: string,
  actionId: string,
  fields: Record<string, string>,
  cookies: string,
): Promise<{
  readonly status: number;
  readonly location: string;
  readonly setCookies: readonly string[];
  readonly html: string;
}> {
  // Next.js no-JS Server Action POST = multipart/form-data (ตาม encType ของฟอร์มที่ RSC render)
  const form = new FormData();
  form.append(`$ACTION_ID_${actionId}`, "");
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const response = await fetch(`${APP_URL}${url}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: APP_URL,
      cookie: cookies,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    setCookies: response.headers.getSetCookie(),
    html: await response.text(),
  };
}

/** GET หน้า HTML ของ app พร้อม cookie (ถ้ามี) — คืน status + HTML ตามดิบ */
async function appGet(url: string, cookies: string): Promise<{ readonly status: number; readonly html: string }> {
  const response = await fetch(`${APP_URL}${url}`, {
    headers: cookies === "" ? {} : { cookie: cookies },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, html: await response.text() };
}

/** เรียก RPC ในนามผู้ใช้ (JWT จริง — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
}

/** error code ของ envelope ที่ BFF ตอบ (เช่น ERR-RBAC-001) */
function errorCode(json: unknown): string {
  const code = (json as { error?: { code?: string } } | null)?.error?.code;
  return typeof code === "string" ? code : "";
}

/** error message ของ envelope ที่ BFF ตอบ (ข้อความไทย) */
function errorMessage(json: unknown): string {
  const message = (json as { error?: { message?: string } } | null)?.error?.message;
  return typeof message === "string" ? message : "";
}

// ─── cleanup (idempotent — เรียงตาม FK · mfa_factors ของ GoTrue cascade ตาม auth.users) ───

/** ล้างโลกของ suite — scope ด้วย email prefix 'dcr14-mfa-%' · audit_logs คงไว้ */
async function cleanupDcr14World(): Promise<void> {
  await psql(`
    delete from public.role_assignments
     where user_id in (select id from auth.users where email like 'dcr14-mfa-%');
    delete from public.profiles
     where id in (select id from auth.users where email like 'dcr14-mfa-%');
    delete from auth.users where email like 'dcr14-mfa-%';
  `);
}

// ─── suite ───────────────────────────────────────────────────────────────────────

describe.skipIf(!DB_URL)(
  "DCR-14 สาย MFA ครบวงจร (enroll → verify · โค้ดสำรอง · login สองขั้น · ปิด MFA)",
  () => {
    let staffSecret = "";
    let plainFactorId = "";
    let plainSecret = "";
    let mfaFactorId = "";
    let mfaSecret = "";
    let staffAal2 = "";

    beforeAll(async () => {
      await cleanupDcr14World();
      mfaUser = await createTestUser("dcr14-mfa-rest", "citizen");
      staffUser = await createTestUser("dcr14-mfa-staff", "staff:viewer");
      plainUser = await createTestUser("dcr14-mfa-plain", "citizen");
      // probe container app — ไม่ได้ = skip ทุกเคส (db+kong เท่านั้น)
      try {
        const probe = await fetch(APP_URL, { signal: AbortSignal.timeout(5_000) });
        appReachable = probe.status < 500;
      } catch {
        appReachable = false;
      }
    }, 300_000);

    afterAll(async () => {
      await cleanupDcr14World();
    });

    // ─── เคส a: REST enroll → verify ครบสาย (citizen · aal1) ─────────────────────

    it("เคส a enroll → verify ผ่าน /api/v1/me/mfa/* ครบสาย · enroll ซ้ำ = factor_exists · factor จริง verified", async (ctx) => {
      ctx.skip(!appReachable);
      expect(mfaUser).toBeDefined();
      // (1) enroll — aal1 ผ่านได้ (บทบาทบังคับ MFA ต้องผูกได้ตอนยังไม่มี MFA)
      const enroll = await bffMfa("POST", "/api/v1/me/mfa/enroll", mfaUser.accessToken, mfaUser.id);
      expect(enroll.status, JSON.stringify(enroll.json)).toBe(200);
      const view = (enroll.json as { data?: Record<string, unknown> }).data ?? {};
      const factorId = typeof view.factorId === "string" ? view.factorId : "";
      const secret = typeof view.secret === "string" ? view.secret : "";
      const otpauthUri = typeof view.otpauthUri === "string" ? view.otpauthUri : "";
      expect(factorId).toMatch(/^[0-9a-f-]{36}$/);
      expect(secret.length).toBeGreaterThanOrEqual(32);
      expect(otpauthUri.startsWith("otpauth://totp/")).toBe(true);
      mfaFactorId = factorId;
      mfaSecret = secret;
      // (2) verify — explicit factorId (factor ยัง unverified — fallback "ตัวเดียวที่ verified"
      //     มองไม่เห็นตัวนี้) · รหัสคำนวณจาก secret จริง (ขอบหน้าต่าง 30s ข้ามพอดี = ลองถัดไป)
      let verify = await bffMfa("POST", "/api/v1/me/mfa/verify", mfaUser.accessToken, mfaUser.id, {
        code: totpAt(secret, Date.now() / 1000),
        factorId,
      });
      if (verify.status !== 200) {
        verify = await bffMfa("POST", "/api/v1/me/mfa/verify", mfaUser.accessToken, mfaUser.id, {
          code: totpAt(secret, Date.now() / 1000 + 30),
          factorId,
        });
      }
      expect(verify.status, JSON.stringify(verify.json)).toBe(200);
      expect((verify.json as { data?: { verified?: boolean } }).data?.verified).toBe(true);
      // (3) enroll ซ้ำ → 400 factor_exists
      const again = await bffMfa("POST", "/api/v1/me/mfa/enroll", mfaUser.accessToken, mfaUser.id);
      expect(again.status).toBe(400);
      expect(errorCode(again.json)).toBe("ERR-VAL-001");
      expect(JSON.stringify(again.json)).toContain("factor_exists");
      // (4) factor จริงใน GoTrue = verified — ผ่าน admin factors API (service key):
      //     GET /auth/v1/factors ระดับ user คืน 405 ว่าง ๆ ใน GoTrue build นี้ (probe จริง)
      const factors = await restCall(
        "GET",
        `/auth/v1/admin/users/${mfaUser.id}/factors`,
        { apiKey: SERVICE_KEY, token: SERVICE_KEY },
      );
      expect(factors.status, factors.text.slice(0, 300)).toBe(200);
      const all = Array.isArray(factors.json) ? factors.json : [];
      const found = all.find((f) => (f as { id?: string }).id === factorId);
      expect(found ? (found as { status?: string }).status : undefined).toBe("verified");
    }, 60_000);

    // ─── เคส b: โค้ดสำรอง — regenerate (ต้อง aal2) → status → consume single-use ──

    it("เคส b โค้ดสำรอง: regenerate aal1=403 → aal2 ได้ 8 โค้ด no-store → status ไม่มีโค้ด → consume valid → ซ้ำ invalid", async (ctx) => {
      ctx.skip(!appReachable);
      expect(mfaUser).toBeDefined();
      // (0) aal1 ล้วน → 403 ERR-AUTH-004 (recent-MFA ≤ 15 นาที)
      const aal1 = await freshAal1(mfaUser);
      const denied = await bffMfa(
        "POST",
        "/api/v1/me/mfa/backups/regenerate",
        aal1,
        mfaUser.id,
      );
      expect(denied.status).toBe(403);
      expect(errorCode(denied.json)).toBe("ERR-AUTH-004");
      // (1) aal2 จริง (challenge+verify กับ factor ของเคส a) → regenerate ผ่าน
      const aal2 = await mintAal2WithFactor(mfaUser, mfaFactorId, mfaSecret);
      const regen = await bffMfa(
        "POST",
        "/api/v1/me/mfa/backups/regenerate",
        aal2,
        mfaUser.id,
      );
      expect(regen.status, JSON.stringify(regen.json)).toBe(200);
      const codes = (regen.json as { data?: { codes?: string[] } }).data?.codes ?? [];
      expect(codes).toHaveLength(8);
      for (const code of codes) {
        expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/);
      }
      expect(regen.cacheControl).toContain("no-store");
      // (2) GET backups — metadata ล้วน (ไม่มี codes/hash ใน response)
      const status = await bffMfa("GET", "/api/v1/me/mfa/backups", aal2, mfaUser.id);
      expect(status.status).toBe(200);
      const view = (status.json as { data?: Record<string, unknown> }).data ?? {};
      expect(view.generated).toBe(true);
      expect(view.unused).toBe(8);
      expect(view.total).toBe(8);
      expect(typeof view.lastGeneratedAt === "string" || view.lastGeneratedAt === null).toBe(true);
      expect(status.json).not.toContain("codes");
      // (3) consume โค้ดตัวแรก (RPC จริง — single-use ใน DB)
      const first = codes[0] ?? "";
      const consume = await userRpc("mfa_backup_codes_consume", aal2, { p_code: first });
      expect(consume.status, consume.text.slice(0, 300)).toBe(200);
      expect((consume.json as { valid?: boolean }).valid).toBe(true);
      expect((consume.json as { remaining?: number }).remaining).toBe(7);
      // (4) โค้ดเดิมซ้ำ → valid:false (single-use) · unused ลดจริง
      const replay = await userRpc("mfa_backup_codes_consume", aal2, { p_code: first });
      expect((replay.json as { valid?: boolean }).valid).toBe(false);
      const after = await bffMfa("GET", "/api/v1/me/mfa/backups", aal2, mfaUser.id);
      expect((after.json as { data?: { unused?: number } }).data?.unused).toBe(7);
    }, 60_000);

    // ─── เคส c: login สองขั้นจริง (staff:viewer — บทบาทบังคับ MFA) ───────────────

    it("เคส c login สองขั้น: รหัสผ่าน → pending cookie (ไม่มี session) → ผิด = invalid → ถูก = session aal2 + pending ถูกล้าง", async (ctx) => {
      ctx.skip(!appReachable);
      expect(staffUser).toBeDefined();
      // (0) ผูก factor verified ก่อนล็อกอิน — password step จึงเข้าเส้นทาง pending
      const factor = await enrollVerifiedFactor(staffUser);
      staffSecret = factor.secret;

      // (1) GET /login → action id ของฟอร์ม
      const loginPage = await appGet("/login", "");
      expect(loginPage.status).toBe(200);
      const loginActionId = parseActionId(loginPage.html);

      // (2) POST /login — รหัสผ่านถูก → 303 /login/verify + pending · "ไม่มี session cookie"
      const post1 = await appFormPost("/login", loginActionId, {
        next: "/",
        email: staffUser.email,
        password: TEST_PASSWORD,
      }, "");
      expect(post1.status).toBe(303);
      expect(post1.location).toBe("/login/verify");
      const pendingRaw = setCookieValue(post1.setCookies, PENDING_COOKIE);
      expect(pendingRaw).not.toBeNull();
      // ไม่มี session cookie (รวม chunk) ใด ๆ — password step ห้ามออก session
      expect(sessionValueFromCookies(post1.setCookies)).toBeNull();
      // pending decode ได้ {a, r} (คู่ token จริง — ห้าม log)
      const decoded = JSON.parse(decodeURIComponent(pendingRaw ?? "")) as { a?: unknown; r?: unknown };
      expect(typeof decoded.a === "string" && decoded.a.length > 40).toBe(true);
      expect(typeof decoded.r === "string" && decoded.r.length > 10).toBe(true);

      // (3) GET /login/verify พร้อม pending → ฟอร์มยืนยันจริง
      const pendingCookie = `${PENDING_COOKIE}=${pendingRaw}`;
      const verifyPage = await appGet("/login/verify", pendingCookie);
      expect(verifyPage.status).toBe(200);
      expect(verifyPage.html).toContain("ยืนยันตัวตน");

      // (4) รหัสผิด → state=invalid → การ์ดไทย
      const verifyActionId = parseActionId(verifyPage.html);
      const wrong = await appFormPost("/login/verify", verifyActionId, {
        next: "/",
        code: "000000",
      }, pendingCookie);
      expect(wrong.status).toBe(303);
      expect(wrong.location).toContain("state=invalid");
      const wrongPage = await appGet("/login/verify?state=invalid", pendingCookie);
      expect(wrongPage.html).toContain("รหัสยืนยันไม่ถูกต้อง");

      // (5) รหัสถูก → 303 "/" + sb cookie aal2 จริง + pending ถูกล้าง
      let right = await appFormPost("/login/verify", verifyActionId, {
        next: "/",
        code: totpAt(staffSecret, Date.now() / 1000),
      }, pendingCookie);
      if (!right.location.includes("state=invalid") && right.location !== "/") {
        throw new Error(`เคส c: redirect ไม่คาดคิด ${right.location}`);
      }
      if (right.location.includes("state=invalid")) {
        // ข้ามขอบหน้าต่าง 30s พอดี — ลองรหัสหน้าต่างถัดไปครั้งเดียว
        right = await appFormPost("/login/verify", verifyActionId, {
          next: "/",
          code: totpAt(staffSecret, Date.now() / 1000 + 30),
        }, pendingCookie);
      }
      expect(right.status).toBe(303);
      expect(right.location).toBe("/");
      const sbVal = sessionValueFromCookies(right.setCookies);
      expect(sbVal).not.toBeNull();
      expect(sbVal?.startsWith("base64-")).toBe(true);
      const session = JSON.parse(Buffer.from((sbVal ?? "").slice("base64-".length), "base64url").toString("utf8")) as {
        access_token?: string;
      };
      expect(jwtAal(session.access_token ?? "")).toBe("aal2");
      staffAal2 = session.access_token ?? "";
      expect(staffAal2.length).toBeGreaterThan(40);
      // pending ถูกล้าง (value ว่าง + maxAge=0)
      expect(setCookieValue(right.setCookies, PENDING_COOKIE)).toBe("");
    }, 60_000);

    // ─── เคส d: ปิด MFA — guard บทบาท + recent-MFA + ผลข้างเคียงจริง ─────────────

    it("เคส d ปิด MFA: บทบาทบังคับ = 403 ERR-RBAC-001 (ไทยมีคำ MFA) · aal1 = 403 ERR-AUTH-004 · citizen recent-MFA = disabled จริง", async (ctx) => {
      ctx.skip(!appReachable);
      expect(staffUser).toBeDefined();
      expect(plainUser).toBeDefined();
      // (1) บทบาทบังคับ (staff:viewer) — แม้ recent-MFA ผ่านก็ห้ามปิด → 403 ERR-RBAC-001
      expect(staffAal2.length).toBeGreaterThan(40);
      const staffDeny = await bffMfa("POST", "/api/v1/me/mfa/disable", staffAal2, staffUser.id);
      expect(staffDeny.status).toBe(403);
      expect(errorCode(staffDeny.json)).toBe("ERR-RBAC-001");
      expect(errorMessage(staffDeny.json)).toContain("MFA");
      // (2) citizen aal1 ล้วน → 403 ERR-AUTH-004 (recent-MFA)
      const plainAal1 = await freshAal1(plainUser);
      const aal1Deny = await bffMfa("POST", "/api/v1/me/mfa/disable", plainAal1, plainUser.id);
      expect(aal1Deny.status).toBe(403);
      expect(errorCode(aal1Deny.json)).toBe("ERR-AUTH-004");
      // (3) citizen ผูก factor + recent-MFA → ปิดได้จริง
      const pf = await enrollVerifiedFactor(plainUser);
      plainFactorId = pf.factorId;
      plainSecret = pf.secret;
      const aal2 = await mintAal2WithFactor(plainUser, plainFactorId, plainSecret);
      const ok = await bffMfa("POST", "/api/v1/me/mfa/disable", aal2, plainUser.id);
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect((ok.json as { data?: { disabled?: boolean } }).data?.disabled).toBe(true);
      // (4) ผลข้างเคียงจริง — factor verified หาย (admin API — user GET /factors = 405 ใน build นี้)
      const factors = await restCall(
        "GET",
        `/auth/v1/admin/users/${plainUser.id}/factors`,
        { apiKey: SERVICE_KEY, token: SERVICE_KEY },
      );
      expect(factors.status, factors.text.slice(0, 300)).toBe(200);
      const all = Array.isArray(factors.json) ? factors.json : [];
      const stillVerified = all.filter((f) =>
        (f as { factor_type?: string; status?: string }).factor_type === "totp" &&
        (f as { status?: string }).status === "verified"
      );
      expect(stillVerified).toHaveLength(0);
      const backups = await bffMfa("GET", "/api/v1/me/mfa/backups", aal2, plainUser.id);
      expect((backups.json as { data?: { generated?: boolean } }).data?.generated).toBe(false);
    }, 60_000);
  },
);

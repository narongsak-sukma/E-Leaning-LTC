/**
 * integration — rate limit ของ loginAction (Wave G P1) บนแอปจริง (:3000)
 *
 * ยิงฟอร์ม /login แบบ no-JS (multipart + Origin — แบบแผน dcr14) ด้วย IP จำลอง
 * (x-forwarded-for ส่งเอง — dev ไม่มี proxy ทับ) เพื่อแยก bucket ของเทสนี้:
 * (1) รหัสผ่านผิด 10 ครั้ง (authPerMin=10 จาก .env) ผ่านไปยิง GoTrue → ครั้งที่ 11 =
 *     redirect /login?error=ERR-RATE-001 **ก่อนแตะ GoTrue** (หน้าเว็บ render ข้อความ
 *     ไทย "มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่" จากทะเบียน error)
 * (2) รอให้หน้าต่างหมด (windowSec=60 ของ group AUTH — รอ 61 วิ) → login ถูกต้องผ่าน
 *     ปกติ (redirect /)
 * (3) MFA สองขั้นไม่พัง: บัญชี factor TOTP verified → ขั้น password = /login/verify +
 *     cookie ltc_mfa_pending (ยังไม่มี session cookie) → ยิงรหัส 6 หลักถูก =
 *     session aal2 จริง + pending ถูกล้าง (login ทั้ง flow ใช้ได้เหมือนก่อนแก้)
 */
import { createHmac } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestUser, deleteTestUser, restCall, TEST_PASSWORD, type TestUser } from "./helpers.js";

const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";
/** IP จำลองของเทสนี้ — แยก bucket จาก activity อื่นของแอป (ipFromHeaders อ่าน XFF ตัวแรก) */
const TEST_IP = "10.70.0.9";
const PENDING_COOKIE = "ltc_mfa_pending";
const AUTH_COOKIE = "sb-kong-auth-token";

// ─── lock protocol (/tmp/ltc-it-lock) ──────────────────────────────────────────
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
    // ไม่มีล็อกให้ปลด — ข้าม
  }
});

// ─── helpers (แบบแผน dcr14 — form Server Action แบบ no-JS + TOTP จริง) ─────────

/** แยก action id จาก HTML ของฟอร์ม Server Action (hidden input $ACTION_ID_<hash>) */
function parseActionId(html: string): string {
  const m = /\$ACTION_ID_([0-9a-f]+)/.exec(html);
  if (m === null) {
    throw new Error("parseActionId: ไม่เจอ action id ใน HTML");
  }
  return m[1] ?? "";
}

/** GET หน้า HTML ของแอป */
async function appGet(url: string, cookies: string): Promise<{ status: number; html: string }> {
  const response = await fetch(`${APP_URL}${url}`, {
    headers: cookies === "" ? {} : { cookie: cookies },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, html: await response.text() };
}

/** POST ฟอร์ม Server Action แบบ no-JS — คืน status/Location/Set-Cookie */
async function appFormPost(
  url: string,
  actionId: string,
  fields: Record<string, string>,
  cookies: string,
  forwardedFor = TEST_IP,
): Promise<{ status: number; location: string; setCookies: readonly string[]; html: string }> {
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
      "x-forwarded-for": forwardedFor,
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

/** เข้าสู่ระบบขั้น 1 (ฟอร์ม /login) — GET action id ใหม่ทุกครั้งก่อน POST */
async function formLogin(
  email: string,
  password: string,
): Promise<{ status: number; location: string; setCookies: readonly string[] }> {
  const page = await appGet("/login", "");
  expect(page.status).toBe(200);
  const actionId = parseActionId(page.html);
  return appFormPost("/login", actionId, { email, password }, "");
}

/** แยกค่า cookie ตามชื่อจาก Set-Cookie หลายแถว (รวม chunk sb-…token.0/.1) */
function cookieValueFromSet(setCookies: readonly string[], name: string): string | null {
  const parts: string[] = [];
  for (let idx = 0; ; idx += 1) {
    const value = rawCookieValue(setCookies, `${name}.${idx}`);
    if (value === null) {
      break;
    }
    parts.push(value);
  }
  if (parts.length > 0) {
    return parts.join("");
  }
  return rawCookieValue(setCookies, name);
}

function rawCookieValue(setCookies: readonly string[], name: string): string | null {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = (pair ?? "").indexOf("=");
    if (eq > 0 && pair?.slice(0, eq) === name) {
      return pair.slice(eq + 1);
    }
  }
  return null;
}

// ─── TOTP (แบบแผน helpers-aal2 — local copy ให้ไฟล์นี้พอตัวเอง) ────────────────

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/=+$/g, "")) {
    const idx = alphabet.indexOf(ch);
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

/** รหัส TOTP 6 หลัก (RFC 6238 — HMAC-SHA1 · step 30 วินาที) ณ หน้าต่างเวลาที่กำหนด */
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

/** enroll factor TOTP ให้ผู้ใช้ (password grant ใหม่ → enroll → challenge → verify) — คืน secret */
async function enrollVerifiedTotp(user: TestUser): Promise<string> {
  const login = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email: user.email, password: TEST_PASSWORD },
  );
  if (login.status !== 200) {
    throw new Error(`enrollTotp: password grant ล้ม (${login.status})`);
  }
  const aal1 = (login.json as { access_token?: string }).access_token ?? "";
  const enroll = await restCall(
    "POST",
    "/auth/v1/factors",
    { token: aal1 },
    { factor_type: "totp", friendly_name: "w3-login-ratelimit-it" },
  );
  if (enroll.status !== 200) {
    throw new Error(`enrollTotp: enroll ล้ม (${enroll.status}): ${enroll.text.slice(0, 200)}`);
  }
  const factorId = (enroll.json as { id?: string }).id ?? "";
  const secret = (enroll.json as { totp?: { secret?: string } }).totp?.secret ?? "";
  const challenge = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/challenge`,
    { token: aal1 },
    {},
  );
  if (challenge.status !== 200) {
    throw new Error(`enrollTotp: challenge ล้ม (${challenge.status})`);
  }
  const challengeId = (challenge.json as { id?: string }).id ?? "";
  const verify = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/verify`,
    { token: aal1 },
    { challenge_id: challengeId, code: totpAt(secret, Date.now() / 1000) },
  );
  if (verify.status !== 200) {
    throw new Error(`enrollTotp: verify ล้ม (${verify.status}): ${verify.text.slice(0, 200)}`);
  }
  return secret;
}

const createdUsers: TestUser[] = [];

afterAll(async () => {
  for (const user of createdUsers) {
    try {
      await deleteTestUser(user.id);
    } catch {
      // cleanup ที่ล้มไม่ทำให้ชุดทดสอบแดง
    }
  }
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("loginAction rate limit (แอปจริง :3000)", () => {
  it(
    "รหัสผ่านผิดจนครบ 10 → ครั้งที่ 11 = ERR-RATE-001 (ไทย) ก่อนแตะ GoTrue",
    { timeout: 120_000 },
    async () => {
      // 10 อีเมลคนละตัว (ไม่มีตัวไหนมีจริง) — GoTrue ตอบ invalid_credentials ตรง ๆ
      // ไม่ชน per-email limit ของ GoTrue เอง · IP เดียวกัน (XFF) รวมนับเข้า bucket เดียว
      for (let i = 1; i <= 10; i += 1) {
        const res = await formLogin(`w3rl-wrong-${i}-${Date.now()}@ltc.test`, "wrong-pass");
        expect(res.status).toBe(303);
        expect(res.location).toBe("/login?error=ERR-AUTH-002");
      }
      // ครั้งที่ 11 — ถูกตัดก่อนยิง GoTrue (authPerMin=10 ต่อ IP)
      const throttled = await formLogin(`w3rl-wrong-11-${Date.now()}@ltc.test`, "wrong-pass");
      expect(throttled.status).toBe(303);
      expect(throttled.location).toBe("/login?error=ERR-RATE-001");

      // หน้า login render ข้อความไทยจากทะเบียน (ERR-RATE-001)
      const page = await appGet("/login?error=ERR-RATE-001", "");
      expect(page.status).toBe(200);
      expect(page.html).toContain("มีการเรียกใช้บ่อยเกินไป");
    },
  );

  it(
    "รอหน้าต่างผ่าน (windowSec=60 → รอ 61 วิ) → login ถูกต้องกลับมาใช้ได้ (ไม่พังหลังโดนตัด)",
    { timeout: 150_000 },
    async () => {
      const user = await createTestUser("w3rlrecover");
      createdUsers.push(user);
      // 61 วิ > windowSec 60 ของ group AUTH (rate-limit.ts) — บันทึกหน้าต่างจริงที่ใช้
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      const res = await formLogin(user.email, TEST_PASSWORD);
      expect(res.status).toBe(303);
      expect(res.location).toBe("/");
    },
  );

  it(
    "MFA สองขั้นไม่พัง: ขั้น password = /login/verify + pending (ไม่มี session cookie) → รหัสถูก = session aal2 + pending ถูกล้าง",
    { timeout: 120_000 },
    async () => {
      const user = await createTestUser("w3rlmfa");
      createdUsers.push(user);
      const secret = await enrollVerifiedTotp(user);

      // ขั้น 1 — ฟอร์ม /login: รหัสผ่านถูก + มี factor verified → 303 /login/verify
      const post1 = await formLogin(user.email, TEST_PASSWORD);
      expect(post1.status).toBe(303);
      expect(post1.location).toBe("/login/verify");
      const pendingRaw = cookieValueFromSet(post1.setCookies, PENDING_COOKIE);
      expect(pendingRaw).not.toBeNull();
      expect(pendingRaw).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // ไม่มี session cookie (รวม chunk) — password step ห้ามออก session
      expect(cookieValueFromSet(post1.setCookies, AUTH_COOKIE)).toBeNull();

      // ขั้น 2 — ฟอร์ม /login/verify: รหัส TOTP ถูก → 303 "/" + session จริง
      const pendingCookie = `${PENDING_COOKIE}=${pendingRaw}`;
      const verifyPage = await appGet("/login/verify", pendingCookie);
      expect(verifyPage.status).toBe(200);
      const verifyActionId = parseActionId(verifyPage.html);
      let right = await appFormPost(
        "/login/verify",
        verifyActionId,
        { code: totpAt(secret, Date.now() / 1000) },
        pendingCookie,
        TEST_IP,
      );
      if (right.location.includes("state=invalid")) {
        // ข้ามขอบหน้าต่าง 30s พอดี — ลองรหัสหน้าต่างถัดไปครั้งเดียว (แบบ dcr14)
        right = await appFormPost(
          "/login/verify",
          verifyActionId,
          { code: totpAt(secret, Date.now() / 1000 + 30) },
          pendingCookie,
          TEST_IP,
        );
      }
      expect(right.status).toBe(303);
      expect(right.location).toBe("/");
      const sessionValue = cookieValueFromSet(right.setCookies, AUTH_COOKIE);
      expect(sessionValue).not.toBeNull();
      expect(sessionValue?.startsWith("base64-")).toBe(true);
      // pending ถูกล้าง (value ว่าง + maxAge=0)
      expect(rawCookieValue(right.setCookies, PENDING_COOKIE)).toBe("");
    },
  );
});

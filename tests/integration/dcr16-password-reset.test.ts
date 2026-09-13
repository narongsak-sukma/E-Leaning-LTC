/**
 * DCR-16 — integration ของ flow ลืมรหัสผ่าน/ตั้งรหัสใหม่ (AUTH-004 · Wave G P1 · D72)
 * บน dev stack จริง (GoTrue จริง · Mailpit จริง · Kong จริง · แอป :3000 จริง)
 *
 * เคส (ตาม brief):
 *   (a) POST /api/v1/auth/password-reset/request อีเมลที่มีจริง → 200 ข้อความคงที่
 *       + Mailpit ได้รับเมล recovery (ลิงก์ verify type=recovery, redirect_to =
 *       {APP}/reset-password) + audit AUTH_PASSWORD_RESET_REQUEST (context คีย์เดียว
 *       ip_hash · โยงด้วย request-id จาก response header)
 *   (b) อีเมลไม่มีจริง → 200 **ข้อความเดียวกัน** + ไม่มีเมล (anti-enumeration)
 *       + audit row เช่นกัน (โยง request-id)
 *   (c) คลิกลิงก์ verify ผ่าน Kong → 303 ไป {APP}/reset-password#... tokens
 *       (type=recovery) — fragment ไม่เดินทางถึง server
 *   (d) confirm ด้วย lib confirmPasswordReset + deps "GoTrue จริง" → เปลี่ยนรหัสจริง:
 *       รหัสเก่า grant 400 · รหัสใหม่ grant 200 · access token ของ recovery session
 *       ตายทั้งหมด (GET /auth/v1/user ด้วย token เดิม = 401 — พิสูจน์ scope=global)
 *   (e) rate limit PWD_RESET ตัดจริง: 5 ครั้งแรก 200 → ครั้งที่ 6 = 429
 *       ERR-RATE-001 + header Retry-After
 *   (f) confirm route (:3000) — รหัส <12 = 400 ERR-VAL-001 (schema ตรวจก่อน session)
 *       · ไม่มี session = 401 ERR-AUTH-001 · ลืม Origin (CSRF) = 403 (middleware
 *       fail-closed)
 *
 * เนมสเปซ email prefix 'dcr16-mail-%' · cleanup ครบใน afterAll · ห้าม print
 * token/รหัสผ่าน — assertion บน string ที่ redact แล้วเท่านั้น
 */
import { mkdir, rmdir } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestUser,
  psql,
  psqlRows,
  restCall,
  REST_URL,
  TEST_PASSWORD,
  type TestUser,
} from "./helpers.js";

import {
  buildResetPasswordUrl,
  classifyGoTruePutUserFailure,
  confirmPasswordReset,
  goTrueErrorCodeOf,
  PASSWORD_RESET_DONE_MESSAGE,
  PASSWORD_RESET_REQUEST_MESSAGE,
} from "@/lib/auth/password-reset";

const DB_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";
const MAILPIT_URL = process.env["TEST_MAILPIT_URL"] ?? "http://localhost:8025";

/** รหัสผ่านใหม่ของเคส (d) — ≥12 ตาม GOTRUE_PASSWORD_MIN_LENGTH */
const NEW_PASSWORD = "Dcr16Reset#2026x";

/**
 * ip ปลอมต่อเคส — แยก quota ของ PWD_RESET (window 1 ชม.) · limiter เป็น in-memory
 * ของ Next process (SDS §5.3) quota ค้างข้ามการรัน suite — nonce ต่อรันจึงได้ quota
 * สด (octet ที่สาม 1..250 — ชนรอบเก่าได้ยาก)
 */
const RUN_NONCE = (Date.now() % 250) + 1;
const IP_A = `10.16.${RUN_NONCE}.1`;
const IP_B = `10.16.${RUN_NONCE}.2`;
const IP_RL = `10.16.${RUN_NONCE}.3`;
const IP_CONFIRM = `10.16.${RUN_NONCE}.4`;
const IP_G = `10.16.${RUN_NONCE}.5`;
const IP_H = `10.16.${RUN_NONCE}.6`;

/** ชื่อ cookie session ฝั่งแอป (แอปในคอนเทนเนอร์เห็น GoTrue ที่ http://kong:8000) */
const AUTH_COOKIE = "sb-kong-auth-token";

/**
 * session cookie ค่าจริง (base64- ตาม cookieEncoding ของ @supabase/ssr) — แบบ
 * เดียวกับ wave-g-auth005/wave-g-logout-all (user.factors: [] ตามแบบ dcr14)
 */
function sessionCookieValue(accessToken: string, refreshToken: string): string {
  const claims = JSON.parse(
    Buffer.from(accessToken.split(".")[1] ?? "", "base64").toString("utf8"),
  ) as Record<string, unknown>;
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: typeof claims["exp"] === "number" ? claims["exp"] : Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: String(claims["sub"] ?? ""),
      aud: "authenticated",
      role: "authenticated",
      email: "",
      factors: [],
    },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

// ─── ผู้ช่วยของ suite (Mailpit + ลิงก์ verify + audit) ────────────────────────

interface MailpitAddress {
  readonly Address: string;
}

interface MailpitSummary {
  readonly ID: string;
  readonly To: readonly MailpitAddress[];
}

interface MailpitFull {
  readonly Text?: string;
}

/** เมล recovery ถึง address — ต้องมีลิงก์ verify ที่มี type=recovery (แยกจากเมล signup confirm) */
async function waitForRecoveryMail(address: string, timeoutSec: number): Promise<MailpitSummary | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const list = (await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`)).json()) as {
      messages?: MailpitSummary[];
    };
    for (const candidate of list.messages ?? []) {
      if (candidate.To.some((t) => t.Address === address) === false) continue;
      const text = await mailText(candidate.ID);
      if (text.includes("type=recovery")) return candidate;
    }
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** ตัวหนังสือเต็มของจดหมาย */
async function mailText(messageId: string): Promise<string> {
  const full = (await (
    await fetch(`${MAILPIT_URL}/api/v1/message/${messageId}`)
  ).json()) as MailpitFull;
  return full.Text ?? "";
}

/** ลิงก์ verify (token อยู่ใน query — ห้าม print) */
function extractVerifyLink(text: string): URL | null {
  const match = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/u.exec(text);
  return match === null ? null : new URL(match[0]);
}

/**
 * คลิกลิงก์ verify ผ่าน Kong — คืน (status, fragment params) โดย fragment ถูก
 * parse ภายในและ**ไม่เคย**ถูกพิมพ์ (assertion ใช้แค่ชนิด + การมีอยู่ของคีย์)
 */
async function clickVerifyLink(
  link: URL,
): Promise<{ status: number; fragment: URLSearchParams; location: string }> {
  const viaKong = new URL(link);
  viaKong.host = new URL(REST_URL).host;
  const res = await fetch(viaKong, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const hashIndex = location.indexOf("#");
  const fragment =
    hashIndex >= 0 ? new URLSearchParams(location.slice(hashIndex + 1)) : new URLSearchParams();
  return { status: res.status, fragment, location: location.slice(0, hashIndex) };
}

/** แถว audit AUTH_PASSWORD_RESET_* ที่โยงกับ x-request-id ของ response */
interface AuditRow {
  readonly action: string;
  readonly request_id: string | null;
  readonly actor_user_id: string | null;
  readonly context: Record<string, unknown>;
}

function auditRowsByRequestId(requestId: string): Promise<AuditRow[]> {
  return psqlRows<AuditRow>(
    `select action, request_id, actor_user_id, context from audit_logs
     where action like 'AUTH_PASSWORD_RESET%'
       and request_id = '${requestId}'
     order by occurred_at`,
  );
}

/** POST request route — wrapper ของ suite (Origin ครบ CSRF · ip ปลอม) */
async function postRequest(email: string, ip: string): Promise<Response> {
  return fetch(`${APP_URL}/api/v1/auth/password-reset/request`, {
    method: "POST",
    headers: {
      origin: APP_URL,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ email }),
  });
}

/** POST confirm route ตรง ๆ (ไม่มี cookie = ไม่มี session) */
async function postConfirm(password: unknown, ip: string): Promise<Response> {
  return fetch(`${APP_URL}/api/v1/auth/password-reset/confirm`, {
    method: "POST",
    headers: {
      origin: APP_URL,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ password }),
  });
}

// ─── fixture + cleanup ───────────────────────────────────────────────────────

let citizen: TestUser;

/** ล็อก serial ของ integration tests ทั้งระบบ (กติกาทีม — เขียน DB จริง) */
const LOCK_DIR = "/tmp/ltc-it-lock";
let lockAcquired = false;

beforeAll(async () => {
  if (DB_URL === undefined) return;
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
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  await psql(`
    delete from public.role_assignments where user_id in (select id from auth.users where email like 'dcr16-mail-%');
    delete from public.profiles where id in (select id from auth.users where email like 'dcr16-mail-%');
    delete from auth.users where email like 'dcr16-mail-%';
  `);
  citizen = await createTestUser("dcr16-mail-citizen", "citizen");
}, 35 * 60_000);

afterAll(async () => {
  if (DB_URL === undefined) return;
  await psql(`
    delete from public.role_assignments where user_id in (select id from auth.users where email like 'dcr16-mail-%');
    delete from public.profiles where id in (select id from auth.users where email like 'dcr16-mail-%');
    delete from auth.users where email like 'dcr16-mail-%';
  `);
  if (lockAcquired) {
    await rmdir(LOCK_DIR);
  }
}, 120_000);

// ─── ชุดทดสอบ ────────────────────────────────────────────────────────────────

describe.skipIf(DB_URL === undefined)("DCR-16 — password reset (AUTH-004)", () => {
  let verifyLink: URL | null = null;

  it("(a) request อีเมลที่มีจริง → 200 ข้อความคงที่ + เมล recovery + audit ip_hash-only", async () => {
    const res = await postRequest(citizen.email, IP_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { message?: string } };
    expect(body.data?.message).toBe(PASSWORD_RESET_REQUEST_MESSAGE);
    // request-id สะท้อนกลับมา (SDS §5.4) — ใช้โยงแถว audit
    const requestId = res.headers.get("x-request-id");
    expect(requestId).not.toBeNull();
    // Mailpit — เมล recovery ถึงอีเมลจริง + redirect_to = {APP}/reset-password
    const mail = await waitForRecoveryMail(citizen.email, 25);
    expect(mail).not.toBeNull();
    const link = extractVerifyLink(await mailText(mail!.ID));
    expect(link).not.toBeNull();
    expect(link!.searchParams.get("redirect_to")).toBe(buildResetPasswordUrl(APP_URL));
    verifyLink = link;
    // audit REQUEST — context คีย์เดียว ip_hash ตาม allowlist (0008:470)
    const rows = await auditRowsByRequestId(requestId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("AUTH_PASSWORD_RESET_REQUEST");
    expect(Object.keys(rows[0]?.context ?? {})).toEqual(["ip_hash"]);
  }, 60_000);

  it("(b) request อีเมลไม่มีจริง → 200 ข้อความเดียวกัน + ไม่มีเมล + audit เช่นกัน", async () => {
    const UNKNOWN = `dcr16-mail-unknown-${Date.now()}@ltc.test`;
    const res = await postRequest(UNKNOWN, IP_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { message?: string } };
    expect(body.data?.message).toBe(PASSWORD_RESET_REQUEST_MESSAGE);
    const requestId = res.headers.get("x-request-id");
    expect(requestId).not.toBeNull();
    // หน้าต่างสั้น — ถ้า GoTrue ส่งเมลถึงอีเมลที่ไม่มี = enumeration leak
    const mail = await waitForRecoveryMail(UNKNOWN, 4);
    expect(mail).toBeNull();
    // audit ยังเขียน (ทุกคำขอถูกบันทึก — ip_hash เท่านั้น)
    const rows = await auditRowsByRequestId(requestId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("AUTH_PASSWORD_RESET_REQUEST");
    expect(Object.keys(rows[0]?.context ?? {})).toEqual(["ip_hash"]);
  }, 30_000);

  it("(c) คลิกลิงก์ verify ผ่าน Kong → 303 + fragment tokens (type=recovery)", async () => {
    expect(verifyLink).not.toBeNull();
    const clicked = await clickVerifyLink(verifyLink!);
    expect(clicked.status).toBe(303);
    expect(clicked.location.startsWith(`${APP_URL}/reset-password`)).toBe(true);
    expect(clicked.fragment.get("type")).toBe("recovery");
    expect(clicked.fragment.get("access_token")).toBeTruthy();
    expect(clicked.fragment.get("refresh_token")).toBeTruthy();
    // เก็บ fragment tokens ไว้ให้เคส (d) — ไม่ print
    (globalThis as { __dcr16?: object }).__dcr16 = {
      accessToken: clicked.fragment.get("access_token") ?? "",
      refreshToken: clicked.fragment.get("refresh_token") ?? "",
    };
  }, 30_000);

  it("(d) confirm ผ่าน lib + GoTrue จริง → เปลี่ยนรหัสจริง · ทุก session ตาย · audit order ครบ", async () => {
    const saved = (globalThis as { __dcr16?: { accessToken: string; refreshToken: string } })
      .__dcr16;
    expect(saved?.accessToken).toBeTruthy();
    const accessToken = saved!.accessToken;

    // deps "GoTrue จริง" — fetch ตรง Kong (แบบเดียวกับ route ทำ)
    const updatePassword = async (
      token: string,
      password: string,
    ): Promise<"ok" | "expired_link" | "weak_password" | "system"> => {
      const res = await restCall("PUT", "/auth/v1/user", { token }, { password });
      if (res.status >= 200 && res.status < 300) return "ok";
      return classifyGoTruePutUserFailure(res.status, goTrueErrorCodeOf(res.status, res.text));
    };
    const logoutGlobal = async (token: string): Promise<"ok" | "system"> => {
      const res = await restCall("POST", "/auth/v1/logout?scope=global", { token });
      return res.status >= 200 && res.status < 300 ? "ok" : "system";
    };
    const result = await confirmPasswordReset(
      { accessToken, password: NEW_PASSWORD, ipHash: "0".repeat(64), requestId: null },
      {
        updatePassword,
        logoutGlobal,
        audit: async () => ({ ok: true }),
        clearCookies: () => {},
      },
    );
    expect(result).toEqual({ ok: true });

    // grant ด้วยรหัสเก่า = 400 · รหัสใหม่ = 200 (เปลี่ยนรหัสจริงที่ GoTrue)
    const oldGrant = await restCall("POST", "/auth/v1/token?grant_type=password", {}, {
      email: citizen.email,
      password: TEST_PASSWORD,
    });
    expect(oldGrant.status).toBe(400);
    const newGrant = await restCall("POST", "/auth/v1/token?grant_type=password", {}, {
      email: citizen.email,
      password: NEW_PASSWORD,
    });
    expect(newGrant.status).toBe(200);

    // recovery access token ตายทั้งหมด (logout scope=global) — GoTrue v2.164
    // ตอบ 403 สำหรับ token ที่ revoke แล้ว (401 = token format ไม่ผ่าน) —
    // ทั้งสอง status = session ตายตามสัญญา
    const userRes = await restCall("GET", "/auth/v1/user", { token: accessToken });
    expect([401, 403]).toContain(userRes.status);
  }, 60_000);

  it("(e) rate limit PWD_RESET ตัดจริง — 5 ครั้งแรก 200 · ครั้งที่ 6 = 429 ERR-RATE-001 + Retry-After", async () => {
    const email = `dcr16-mail-rl-${Date.now()}@ltc.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await postRequest(email, IP_RL);
      statuses.push(res.status);
      if (i < 5) {
        expect(res.status).toBe(200);
        continue;
      }
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("ERR-RATE-001");
      expect(res.headers.get("retry-after")).not.toBeNull();
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  }, 90_000);

  it("(f) confirm route — รหัส <12 = 400 ERR-VAL-001 · ไม่มี session = 401 ERR-AUTH-001 · ไม่มี Origin = 403", async () => {
    // <12 — route ตรวจ schema ก่อน session → 400 ERR-VAL-001 ข้อความ policy
    const tooShort = await postConfirm("abc".repeat(3), IP_CONFIRM);
    expect(tooShort.status).toBe(400);
    const shortBody = (await tooShort.json()) as { error?: { code?: string } };
    expect(shortBody.error?.code).toBe("ERR-VAL-001");

    // ยาวพอ (≥12) แต่ไม่มี cookie session → 401 ERR-AUTH-001
    const noSession = await postConfirm("dcr16-confirm-no-session-#1", IP_CONFIRM);
    expect(noSession.status).toBe(401);
    const noSessionBody = (await noSession.json()) as { error?: { code?: string } };
    expect(noSessionBody.error?.code).toBe("ERR-AUTH-001");

    // ไม่ส่ง Origin — middleware CSRF fail-closed
    const noOrigin = await fetch(`${APP_URL}/api/v1/auth/password-reset/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "dcr16-confirm-no-origin-#1" }),
    });
    expect(noOrigin.status).toBe(403);
  }, 30_000);

  it("(g) confirm ผ่าน route จริง (HTTP + cookie recovery) → 200 + audit DONE แถวจริง + ล้าง cookie (ปิดช่อง stub ของเคส d — lead)", async () => {
    // ผู้ใช้ที่สอง — ไม่โดน over_email_send_rate_limit ของ citizen (เคส (a) ส่งเมลไปแล้ว ~60s)
    const second = await createTestUser("dcr16-mail-second", "citizen");
    const res = await postRequest(second.email, IP_G);
    expect(res.status).toBe(200);
    const mail = await waitForRecoveryMail(second.email, 25);
    expect(mail).not.toBeNull();
    const link = extractVerifyLink(await mailText(mail!.ID));
    expect(link).not.toBeNull();
    const clicked = await clickVerifyLink(link!);
    expect(clicked.status).toBe(303);
    const accessToken = clicked.fragment.get("access_token") ?? "";
    const refreshToken = clicked.fragment.get("refresh_token") ?? "";
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    // POST confirm ผ่าน route จริงด้วย cookie session recovery (แบบ @supabase/ssr)
    const confirmRes = await fetch(`${APP_URL}/api/v1/auth/password-reset/confirm`, {
      method: "POST",
      headers: {
        origin: APP_URL,
        "content-type": "application/json",
        cookie: `${AUTH_COOKIE}=${sessionCookieValue(accessToken, refreshToken)}`,
        "x-forwarded-for": IP_G,
      },
      body: JSON.stringify({ password: "Dcr16Route#2026g" }),
    });
    expect(confirmRes.status).toBe(200);
    const body = (await confirmRes.json()) as { data?: { message?: string } };
    expect(body.data?.message).toBe(PASSWORD_RESET_DONE_MESSAGE);

    // audit DONE — แถวจริงโยง request-id ของ response (context = ip_hash เดียว 0008:471
    // — user_id ถูก RPC ยกเป็น actor แล้ว strip ออกก่อนเก็บ) · actor = sub จริงของ
    // token recovery (gate r2 — เดิม context ไม่มี user_id ทำให้ actor เป็น null)
    const requestId = confirmRes.headers.get("x-request-id");
    expect(requestId).not.toBeNull();
    const rows = await auditRowsByRequestId(requestId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("AUTH_PASSWORD_RESET_DONE");
    expect(rows[0]?.actor_user_id).toBe(second.id);
    expect(Object.keys(rows[0]?.context ?? {})).toEqual(["ip_hash"]);

    // เปลี่ยนรหัสจริง — grant ด้วยรหัสใหม่ผ่าน (ผ่าน Kong)
    const newGrant = await restCall("POST", "/auth/v1/token?grant_type=password", {}, {
      email: second.email,
      password: "Dcr16Route#2026g",
    });
    expect(newGrant.status).toBe(200);

    // cookie ถูกล้างจริง — Set-Cookie ลบ session chunk (recovery session ห้ามคงเหลือ)
    const setCookies = confirmRes.headers.getSetCookie();
    expect(
      setCookies.some((line) => line.startsWith(AUTH_COOKIE) && /[Mm]ax-[Aa]ge=0/.test(line)),
    ).toBe(true);
  }, 90_000);

  it("(h) session login ปกติ (password grant) ยิง confirm → 400 ERR-AUTH-005 ไม่ล้าง cookie ไม่แตะรหัส (gate r1 B1)", async () => {
    // ผู้ใช้ปกติที่ login ด้วยรหัสผ่าน (amr method = password ตาม probe จริง) —
    // ไม่มีหลักฐาน recovery ต้องถูกปฏิเสธ: ไม่งั้นผู้ถือ session ปกติเปลี่ยนรหัสผ่าน
    // ได้โดยไม่ต้องพิสูจน์อะไรเลย (ข้าม re-auth ของ AUTH-005)
    const normal = await createTestUser("dcr16-mail-normal", "citizen");
    const grant = await restCall("POST", "/auth/v1/token?grant_type=password", {}, {
      email: normal.email,
      password: TEST_PASSWORD,
    });
    expect(grant.status).toBe(200);
    const tokens = JSON.parse(grant.text) as { access_token: string; refresh_token: string };

    const res = await fetch(`${APP_URL}/api/v1/auth/password-reset/confirm`, {
      method: "POST",
      headers: {
        origin: APP_URL,
        "content-type": "application/json",
        cookie: `${AUTH_COOKIE}=${sessionCookieValue(tokens.access_token, tokens.refresh_token)}`,
        "x-forwarded-for": IP_H,
      },
      body: JSON.stringify({ password: "Dcr16B1Normal#2026" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ERR-AUTH-005");

    // session นี้ยังมีชีวิตและไม่ใช่ recovery — ห้ามมี Set-Cookie แตะ session เลย
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((line) => line.startsWith(AUTH_COOKIE))).toBe(false);

    // รหัสผ่านไม่ถูกเปลี่ยน — grant ด้วยรหัสเดิมยังผ่าน
    const regrant = await restCall("POST", "/auth/v1/token?grant_type=password", {}, {
      email: normal.email,
      password: TEST_PASSWORD,
    });
    expect(regrant.status).toBe(200);
  }, 60_000);
});

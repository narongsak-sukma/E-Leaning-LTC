/**
 * DCR-15 — integration ของการเปลี่ยนอีเมลของตนเอง (Wave F · D-f-2) บน dev stack จริง
 * (GoTrue จริง · Mailpit จริง · Kong จริง — ผ่านชุด helpers เดียวกับ DCR-10..12)
 *
 * เคส (ตาม mission):
 *   (a) citizen ยื่นคำขอ (requestEmailChange จริง + deps จริงผ่าน GoTrue/Kong)
 *       → Mailpit มีอีเมลยืนยันไปที่อีเมล "ใหม่" + audit USER_EMAIL_CHANGE_REQUEST
 *       พร้อม context.new_email_sha256 ตรง hashEmailForAudit + auth.users.email
 *       ยังเป็นอีเมลเดิม (double opt-in) · รหัสผ่านผิด = ไม่ส่งอีเมล ไม่ audit
 *   (d) ก่อนยืนยัน — อีเมลเดิมยังเข้าสู่ระบบได้ (password grant 200)
 *   (b) ยืนยันผ่านลิงก์ GET ผ่าน Kong :8000 (ไม่มี auth) → สองขั้น (secure email
 *       change): ลิงก์อีเมลใหม่ → 303 fragment "sent to the other email" + ลิงก์ที่
 *       สองไปอีเมลเดิม → 303 fragment access_token + db email เปลี่ยนจริง + audit
 *       USER_EMAIL_CHANGE_CONFIRMED (old/new sha256 ครบ) · คลิกซ้ำ = fragment error
 *       (ลิงก์ใช้ครั้งเดียว) · หน้า callback ที่ :3000 ตอบ 200 + SSR การ์ด generic
 *   (c) staff:viewer aal1 เรียก RPC ตรง → 4xx "ERR-AUTH-004|mfa_required" ·
 *       mintAal2Token แล้วเรียกใหม่ → 200 {audited:true} · hash ผิดรูปแบบ →
 *       ERR-VAL-001|hash_format
 *
 * เนมสเปซ email prefix 'dcr15-mail-%' · cleanup ครบใน afterAll (auth.users delete
 * cascade) · audit_logs คงไว้ (append-only ตามดีไซน์) · ห้าม print token/รหัสผ่าน
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildEmailChangeCallbackUrl,
  hashEmailForAudit,
  requestEmailChange,
  type EmailChangeDeps,
} from "@/lib/auth/email-change";

import {
  ANON_KEY,
  createTestUser,
  psql,
  psqlRows,
  psqlScalar,
  restCall,
  REST_URL,
  TEST_PASSWORD,
  type TestUser,
} from "./helpers.js";
import { mintAal2Token } from "./helpers-aal2.js";
// waveh-r1 M1: throwaway SDK ผ่าน trackedClient (fetch injection) — ห้าม createClient ตรง
import { createTrackedClient } from "./test-io";

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (:3000) — เคส b โผล่หน้า callback จริง */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

/** Mailpit API (compose MAILER — กล่องจดหมายจริงของ dev stack) */
const MAILPIT_URL = process.env["TEST_MAILPIT_URL"] ?? "http://localhost:8025";

/** callback URL ที่ action ส่งเป็น emailRedirectTo (origin แอป + path จาก lib) */
const CALLBACK_URL = buildEmailChangeCallbackUrl(
  process.env.PUBLIC_BASE_URL ?? APP_URL,
);

// ─── fixture ของ suite ───────────────────────────────────────────────────────

let citizen: TestUser; // เคส a/b/d — เจ้าของอีเมลที่ขอเปลี่ยน
let staff: TestUser; // เคส c — staff:viewer (บทบาทบังคับ MFA) ยัง aal1

// ─── ผู้ช่วยของ suite (Mailpit + ลิงก์ verify) ────────────────────────────────

interface MailpitAddress {
  readonly Address: string;
  readonly Name?: string;
}

interface MailpitSummary {
  readonly ID: string;
  readonly To: readonly MailpitAddress[];
  readonly Subject?: string;
}

interface MailpitFull {
  readonly Text?: string;
}

/** poll กล่อง Mailpit จนมีจดหมายถึง address ภายใน timeoutSec (คืน null ถ้าไม่มา) */
async function waitForMail(address: string, timeoutSec: number): Promise<MailpitSummary | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const list = (await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`)).json()) as {
      messages?: MailpitSummary[];
    };
    const hit = (list.messages ?? []).find((m) => m.To.some((t) => t.Address === address));
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** ตัวหนังสือเต็มของจดหมาย (Text part) */
async function mailText(messageId: string): Promise<string> {
  const full = (await (
    await fetch(`${MAILPIT_URL}/api/v1/message/${messageId}`)
  ).json()) as MailpitFull;
  return full.Text ?? "";
}

/** ลิงก์ verify ของ GoTrue แรกที่เจอในจดหมาย (token อยู่ใน query — ห้าม print) */
function extractVerifyLink(text: string): URL | null {
  const match = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/u.exec(text);
  return match === null ? null : new URL(match[0]);
}

/**
 * คลิกลิงก์ยืนยัน "ผ่าน Kong :8000 โดยไม่มี auth ใด ๆ" — GoTrue ตอบ 303 →
 * redirect_to (ตาม redirect_to ใน query ของลิงก์) โดยแนบสถานะใน fragment เท่านั้น;
 * คืน Location แบบ redact (ไม่ตัด token ใด ๆ ออกมาพิมพ์)
 */
async function clickVerifyLink(link: URL): Promise<{ status: number; location: string }> {
  const viaKong = new URL(link);
  viaKong.host = new URL(REST_URL).host;
  const res = await fetch(viaKong, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  return {
    status: res.status,
    location: location.replace(/(access_token|refresh_token|token|token_hash)=[^&]*/gu, "$1=<redacted>"),
  };
}

/** มีแถว audit USER_EMAIL_CHANGE_* ของ user นี้ (action + context) */
interface AuditRow {
  readonly action: string;
  readonly context: {
    readonly new_email_sha256?: string;
    readonly old_email_sha256?: string;
  };
}

function auditRows(userId: string): Promise<AuditRow[]> {
  return psqlRows<AuditRow>(
    `select action, context from audit_logs
     where action like 'USER_EMAIL_CHANGE%' and entity_id = '${userId}'
     order by occurred_at`,
  );
}

/** email ปัจจุบันใน auth.users (จุดความจริงของ GoTrue) */
function dbEmail(userId: string): Promise<string> {
  return psqlScalar(`select email from auth.users where id = '${userId}'`);
}

// ─── ก่อน/หลังชุด ────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (DB_URL === undefined) return;
  // เก็บกวาดเศษของรอบก่อน (ทับซ้อนได้เมื่อ suite ถูกรันซ้ำ)
  await psql(`
    delete from public.role_assignments where user_id in (select id from auth.users where email like 'dcr15-mail-%');
    delete from public.profiles where id in (select id from auth.users where email like 'dcr15-mail-%');
    delete from auth.users where email like 'dcr15-mail-%';
  `);
  citizen = await createTestUser("dcr15-mail-citizen", "citizen");
  staff = await createTestUser("dcr15-mail-staff", "staff:viewer");
}, 300_000);

afterAll(async () => {
  if (DB_URL === undefined) return;
  await psql(`
    delete from public.role_assignments where user_id in (select id from auth.users where email like 'dcr15-mail-%');
    delete from public.profiles where id in (select id from auth.users where email like 'dcr15-mail-%');
    delete from auth.users where email like 'dcr15-mail-%';
  `);
}, 120_000);

// ─── deps จริงของ requestEmailChange (สายเดียวกับ Server Action actions.ts) ───

/** password grant ใหม่ (คืน access+refresh — ห้าม print ทั้งคู่) */
async function passwordGrant(userEmail: string): Promise<{ accessToken: string; refreshToken: string }> {
  const grant = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email: userEmail, password: TEST_PASSWORD },
  );
  const body = (grant.json ?? {}) as { access_token?: string; refresh_token?: string };
  if (grant.status >= 400 || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error(`password grant ล้ม (HTTP ${grant.status})`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

/**
 * deps แบบ "เดิน GoTrue จริง" — verifyPassword ผ่าน client ทิ้งได้
 * (persistSession:false — session จาก re-auth ถูกทิ้งทันที) · updateUserEmail ผ่าน
 * setSession จาก grant สด + updateUser(email, { emailRedirectTo }) · auditRequest
 * ผ่าน RPC ด้วย user JWT จริง — ลำดับ (c)(e)(f) ถูกคุมโดย lib ไม่ใช่เทส
 */
function realDeps(userEmail: string): EmailChangeDeps {
  const throwaway = () => createTrackedClient({ label: "dcr15-email-throwaway" }).client;
  return {
    verifyPassword: async (_email, password) => {
      const { error } = await throwaway().auth.signInWithPassword({ email: userEmail, password });
      if (error === null) return "ok";
      if (error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit") {
        return "rate_limited";
      }
      if (error.code === "invalid_credentials" || error.code === "user_banned") return "invalid";
      return "system";
    },
    updateUserEmail: async (email, redirectTo) => {
      const client = throwaway();
      const { accessToken, refreshToken } = await passwordGrant(userEmail);
      const { error: sessionError } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (sessionError !== null) {
        return { ok: false, code: null, message: `setSession ล้ม: ${sessionError.message}` };
      }
      const { error } = await client.auth.updateUser({ email }, { emailRedirectTo: redirectTo });
      if (error !== null) {
        return { ok: false, code: error.code ?? null, message: error.message ?? null };
      }
      return { ok: true };
    },
    auditRequest: async (sha256) => {
      const { accessToken } = await passwordGrant(userEmail);
      const res = await restCall(
        "POST",
        "/rest/v1/rpc/my_audit_email_change_request",
        { apiKey: ANON_KEY, token: accessToken },
        { p_new_email_sha256: sha256 },
      );
      if (res.status >= 400) {
        return { ok: false, message: res.text.slice(0, 200) };
      }
      return { ok: true };
    },
  };
}

// ─── ชุดทดสอบ ────────────────────────────────────────────────────────────────

describe.skipIf(DB_URL === undefined)("DCR-15 — email change (D-f-2)", () => {
  it("(a-neg) รหัสผ่านผิด → password_mismatch · ไม่มีอีเมลส่ง · ไม่มี audit", async () => {
    const NEW = `dcr15-mail-new-neg-${Date.now()}@ltc.test`;
    const result = await requestEmailChange(
      {
        newEmail: NEW,
        password: "wrong-password-integration",
        currentEmail: citizen.email,
        roles: ["citizen"],
        aal: "aal1",
        rateLimitIp: "10.15.0.1",
        callbackUrl: CALLBACK_URL,
      },
      realDeps(citizen.email),
    );
    expect(result).toEqual({
      ok: false,
      failure: "password_mismatch",
      errorCode: "ERR-AUTH-002",
    });
    // หน้าต่างสั้นพอสำหรับ "ไม่มีอีเมลถูกส่ง" (เส้นทางสำเร็จมาภายในไม่กี่วินาที)
    const mail = await waitForMail(NEW, 4);
    expect(mail).toBeNull();
    expect(await auditRows(citizen.id)).toEqual([]);
  }, 30_000);

  it("(a) citizen ยื่นคำขอ → อีเมลยืนยันไปที่อีเมลใหม่ + audit REQUEST + db ยังอีเมลเดิม", async () => {
    const NEW = `dcr15-mail-new-${Date.now()}@ltc.test`;
    const result = await requestEmailChange(
      {
        newEmail: NEW,
        password: TEST_PASSWORD,
        currentEmail: citizen.email,
        roles: ["citizen"],
        aal: "aal1",
        rateLimitIp: "10.15.0.2",
        callbackUrl: CALLBACK_URL,
      },
      realDeps(citizen.email),
    );
    expect(result.ok).toBe(true);
    // hash ใน audit ต้องตรง lib hashEmailForAudit (sha256 ของ lower+trim)
    const rows = await auditRows(citizen.id);
    expect(rows.map((r) => r.action)).toEqual(["USER_EMAIL_CHANGE_REQUEST"]);
    expect(rows[0]?.context.new_email_sha256).toBe(hashEmailForAudit(NEW));
    // double opt-in — db ยังไม่เปลี่ยนจนกว่าจะคลิกลิงก์ครบสองขั้น
    expect(await dbEmail(citizen.id)).toBe(citizen.email);
    // Mailpit จริง — จดหมายถึงอีเมลใหม่ พร้อมลิงก์ verify + redirect_to = callback
    const mail = await waitForMail(NEW, 20);
    expect(mail).not.toBeNull();
    const text = await mailText(mail!.ID);
    const link = extractVerifyLink(text);
    expect(link).not.toBeNull();
    expect(link!.searchParams.get("redirect_to")).toBe(CALLBACK_URL);
    // เก็บลิงก์ไว้ให้เคส (b) ใช้ต่อ
    (globalThis as { __dcr15?: object }).__dcr15 = {
      newEmail: NEW,
      newLink: link,
    };
  }, 60_000);

  it("(d) ก่อนยืนยัน — อีเมลเดิมยังเข้าสู่ระบบได้ (password grant 200)", async () => {
    const grant = await restCall(
      "POST",
      "/auth/v1/token?grant_type=password",
      {},
      { email: citizen.email, password: TEST_PASSWORD },
    );
    expect(grant.status).toBe(200);
  }, 30_000);

  it("(b1) คลิกลิงก์อีเมลใหม่ผ่าน Kong → 303 fragment 'sent to the other email'", async () => {
    const saved = (globalThis as { __dcr15?: { newEmail: string; newLink: URL | null } }).__dcr15;
    expect(saved?.newLink).not.toBeNull();
    const link = saved!.newLink!;
    const clicked = await clickVerifyLink(link);
    expect(clicked.status).toBe(303);
    expect(clicked.location.startsWith(`${CALLBACK_URL}#`)).toBe(true);
    // fragment `message=` ของ GoTrue — `+` คือช่องว่างใน form-encoding
    expect(clicked.location.replace(/\+/gu, " ")).toContain("sent to the other email");
    // ขั้น 1 ยังไม่เปลี่ยนอีเมล
    expect(await dbEmail(citizen.id)).toBe(citizen.email);
  }, 30_000);

  it("(b2) ลิงก์ที่สองจากอีเมลเดิม → 303 fragment session + db เปลี่ยน + audit CONFIRMED", async () => {
    const saved = (globalThis as { __dcr15?: { newEmail: string; newLink: URL | null } }).__dcr15;
    const NEW = saved!.newEmail;
    // GoTrue ส่งลิงก์ยืนยันฉบับที่สองไปที่อีเมลเดิม (secure email change — probe จริง)
    const mail2 = await waitForMail(citizen.email, 25);
    expect(mail2).not.toBeNull();
    const link2 = extractVerifyLink(await mailText(mail2!.ID));
    expect(link2).not.toBeNull();
    const clicked = await clickVerifyLink(link2!);
    expect(clicked.status).toBe(303);
    expect(clicked.location.startsWith(`${CALLBACK_URL}#`)).toBe(true);
    expect(clicked.location).toContain("access_token=<redacted>");
    expect(clicked.location).toContain("type=email_change");
    // GoTrue ผูกอีเมลใหม่จริง → trigger 0044 เขียน audit CONFIRMED เอง
    expect(await dbEmail(citizen.id)).toBe(NEW);
    const rows = await auditRows(citizen.id);
    expect(rows.map((r) => r.action)).toEqual([
      "USER_EMAIL_CHANGE_REQUEST",
      "USER_EMAIL_CHANGE_CONFIRMED",
    ]);
    expect(rows[1]?.context.new_email_sha256).toBe(hashEmailForAudit(NEW));
    expect(rows[1]?.context.old_email_sha256).toBe(hashEmailForAudit(citizen.email));
  }, 60_000);

  it("(b3) ลิงก์ใช้ครั้งเดียว (คลิกซ้ำ = fragment error) · อีเมลเดิมเข้าสู่ระบบไม่ได้แล้ว · หน้า callback ตอบ 200", async () => {
    const saved = (globalThis as { __dcr15?: { newLink: URL | null } }).__dcr15;
    // คลิกลิงก์แรกซ้ำ (single-use) → GoTrue 303 fragment error
    const replay = await clickVerifyLink(saved!.newLink!);
    expect(replay.status).toBe(303);
    expect(decodeURIComponent(replay.location)).toContain("error=access_denied");
    // อีเมลเดิมใช้เข้าสู่ระบบไม่ได้อีกต่อไป (จุดจบ double opt-in)
    const oldLogin = await restCall(
      "POST",
      "/auth/v1/token?grant_type=password",
      {},
      { email: citizen.email, password: TEST_PASSWORD },
    );
    expect(oldLogin.status).toBe(400);
    // หน้าผลลัพธ์สาธารณะ (:3000 ไม่มี auth) — 200 + SSR การ์ด generic (client component)
    const page = await fetch(`${APP_URL}/email-change/callback`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ไม่พบผลการยืนยัน");
  }, 30_000);

  it("(c) staff:viewer aal1 เรียก RPC ตรง → mfa_required · aal2 ผ่าน · hash ผิดรูปแบบถูกตวจดัก", async () => {
    // hash ที่ valid (รูปแบบผ่าน) — RPC ตรวจรูปแบบก่อน guard MFA
    const targetHash = hashEmailForAudit(`dcr15-mail-staff-new-${Date.now()}@ltc.test`);
    // aal1 + บทบาทบังคับ MFA → ERR-AUTH-004|mfa_required (fail-closed ที่ DB)
    const denied = await restCall(
      "POST",
      "/rest/v1/rpc/my_audit_email_change_request",
      { apiKey: ANON_KEY, token: staff.accessToken },
      { p_new_email_sha256: targetHash },
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.text).toContain("ERR-AUTH-004");
    expect(denied.text).toContain("mfa_required");
    // hash ผิดรูปแบบ → ERR-VAL-001|hash_format (ตรวจก่อน guard MFA ใน RPC)
    const badHash = await restCall(
      "POST",
      "/rest/v1/rpc/my_audit_email_change_request",
      { apiKey: ANON_KEY, token: staff.accessToken },
      { p_new_email_sha256: "nothex" },
    );
    expect(badHash.status).toBeGreaterThanOrEqual(400);
    expect(badHash.text).toContain("hash_format");
    // mint aal2 จริง (TOTP flow) → RPC ผ่าน → {audited:true}
    const aal2 = await mintAal2Token(staff);
    const allowed = await restCall(
      "POST",
      "/rest/v1/rpc/my_audit_email_change_request",
      { apiKey: ANON_KEY, token: aal2 },
      { p_new_email_sha256: targetHash },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.json).toMatchObject({ audited: true });
    // แถว audit REQUEST ของ staff ถูกเขียนจริง
    const rows = await auditRows(staff.id);
    expect(rows.map((r) => r.action)).toEqual(["USER_EMAIL_CHANGE_REQUEST"]);
    expect(rows[0]?.context.new_email_sha256).toBe(targetHash);
  }, 120_000);
});

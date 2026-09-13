/**
 * DCR-13 — integration tests สถานะแบน GoTrue บนรายชื่อผู้ใช้ admin (Wave F · D-f-5 · [#91])
 *
 * ตาม migration 0041 (live): RPC admin_list_users เพิ่ม additive `is_banned` (boolean =
 * banned_until ยังไม่หมดอายุ) + `banned_until` (timestamptz|null — อาจเป็นค่าในอดีต =
 * แบนหมดอายุ) — BFF GET /api/v1/admin/users ขยาย AdminUserResource additive สองฟิลด์
 * และหน้า /admin/users แสดง badge "ถูกระงับ" เมื่อ isBanned
 *
 * เคส (ผ่าน BFF จริงของ container app :3000 — session cookie จริงที่ mint จาก JWT จริง):
 *   a. super_admin (aal2) ค้นหาด้วย prefix ของ display_name → 200 · เจอแถวผู้ใช้ใหม่ ·
 *      isBanned=false (และ bannedUntil=null — ไม่เคยถูกแบน)
 *   b. แบนจริงผ่าน GoTrue admin API (service key):
 *      b1 แบนสั้น 3s → หมดอายุ → isBanned=false แต่ bannedUntil คงค่าอดีต (passthrough)
 *      b2 แบน 876000h → isBanned=true + bannedUntil อนาคต
 *      b3 unban "none" → isBanned=false · bannedUntil ต้องไม่เป็นค่าอนาคต (สัญญา)
 *   c. keyset: 3 ผู้ใช้ · limit=2 → hasMore + nextCursor ตามซองของ route · ตาม cursor →
 *      แถวที่เหลือครบ ไม่ซ้ำ
 *   d. aal1 super_admin (grant ใหม่ ณ จุดเรียก — GoTrue เพิกถอน session อื่นเมื่อ
 *      ยืนยัน MFA) → BFF ปฏิเสธที่ MFA gate (403 ERR-AUTH-004) · RPC ผ่าน Kong
 *      ปฏิเสธ mfa_required ก่อนข้อมูล (ชั้นสอง)
 *   e. staff:exam (aal2) → 403 ERR-RBAC-001 — BFF matrix ให้ user:view ตาม doc
 *      แต่ guard ของ RPC (0035: sv/sr/sa เท่านั้น) ปฏิเสธ · แถวข้อมูลไม่หลุด
 *   f. PII_ACCESS audit: ทุก list สำเร็จมีแถว audit_logs (actor = admin) — นับก่อน/หลัง
 *      ด้วย request_id ของรอบ (BFF สะท้อน x-request-id เข้า audit — service path 0025)
 *
 * การแยกโลกของ suite (แบบ DCR-10/11/12):
 *   - ผู้ใช้ทดสอบ email prefix 'dcr13-users-%' · display_name เครื่องหมายรอบ (marker)
 *   - cleanup tracked-first ตามลำดับ FK (beforeAll + afterAll — idempotent) ·
 *     audit_logs คงไว้ (append-only ตามดีไซน์)
 *   - ห้าม log key/JWT ใน output ใด ๆ (D24) — SERVICE_KEY ใช้ผ่าน helpers เท่านั้น
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestUser,
  psql,
  psqlScalar,
  psqlRows,
  restCall,
  SERVICE_KEY,
  TEST_PASSWORD,
  type RestResult,
  type TestUser,
} from "./helpers.js";
import { mintAal2Token } from "./helpers-aal2.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (next dev — hot reload ผ่าน volume mount) — BFF จริงของทุกเคส */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

/** ชื่อ cookie session ของ @supabase/ssr ใน container app — sb-<host ส่วนแรก>-auth-token */
const AUTH_COOKIE = "sb-kong-auth-token";

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ───────────────────────────────────────────────

let adminSA: TestUser; // super_admin — ผู้เรียกหลักของทุกเคส
let staffExam: TestUser; // เคส e — staff:exam ไม่มี user:view (RBAC §2)
let banTarget: TestUser; // เคส a/b/f — ผู้ใช้ใหม่เป้าหมายแบน
let keyA: TestUser; // เคส c — keyset 3 คน (สร้างก่อน → created_at เก่าสุด)
let keyB: TestUser;
let keyC: TestUser;

/** session aal2 จริง (mint ครั้งเดียวใน beforeAll) */
let adminAal2 = "";
let examAal2 = "";

/** container app เข้าถึงได้หรือไม่ — ไม่ได้ = skip ทุกเคส (สแตกบางสภาพรันแค่ db+kong) */
let appReachable = false;

/** ตัวชี้รอบ (ตัวอักษร a-f เท่านั้น — กันชนคอลัมน์อื่นในช่วงเครื่องหมายของรอบ) */
function runMarker(): string {
  const letters = crypto.randomUUID().replace(/[^a-f]/g, "");
  return (letters + "abcdef").slice(0, 6);
}

const marker = runMarker();
const targetName = `dcr13-users-target-${marker}`;
const keysetName = `dcr13-users-keyset-${marker}`;

// ─── cookie session จริงสำหรับ BFF (รูปแบบ @supabase/ssr base64url) ────────────

interface JwtPayload {
  readonly exp?: number;
}

/**
 * base64url ของ session JSON — ตรงสูตร cookieEncoding:"base64url" ของ @supabase/ssr
 *
 * session ต้องมี `user` (อย่างน้อย factors: []) — branch ของ auth-js ใน
 * mfa.getAuthenticatorAssuranceLevel() อ่าน session.user.factors ตรง ๆ (ไม่ guard
 * undefined) — ขาด = TypeError → BFF fail-closed ERR-SYS-001 (500) ทุกเคสที่ใช้ cookie
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
    refresh_token: "dcr13-unused-no-refresh",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "",
      factors: [], // currentLevel มาจาก aal claim ของ JWT จริง — factors เสริมไม่จำเป็น
    },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

/** header Cookie พร้อม session ของ token ที่ให้ (userId = id จริงของเจ้าของ session) */
function cookieHeader(accessToken: string, userId: string): string {
  return `${AUTH_COOKIE}=${sessionCookieValue(accessToken, userId)}`;
}

// ─── เรียก BFF จริง GET /api/v1/admin/users ─────────────────────────────────

interface AdminUserRowDto {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly roles: readonly string[];
  readonly hasVerifiedLicense: boolean;
  readonly isBanned: boolean;
  readonly bannedUntil: string | null;
}

interface AdminUsersPageDto {
  readonly data: readonly AdminUserRowDto[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

interface AdminErrorDto {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

/** RestResult + x-request-id ที่ BFF สะท้อนกลับ (middleware ผูกให้ทุก request — SDS §5.4) */
interface BffListResult {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  readonly requestId: string | null;
}

/** GET /api/v1/admin/users ผ่าน container app — พา session cookie จริง + x-request-id */
async function bffListUsers(
  params: { readonly query?: string; readonly limit?: number; readonly cursor?: string },
  token: string,
  requestId: string,
  userId: string,
): Promise<BffListResult> {
  const search = new URLSearchParams();
  if (params.query !== undefined) {
    search.set("query", params.query);
  }
  if (params.limit !== undefined) {
    search.set("limit", String(params.limit));
  }
  if (params.cursor !== undefined) {
    search.set("cursor", params.cursor);
  }
  const response = await fetch(`${APP_URL}/api/v1/admin/users?${search.toString()}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: cookieHeader(token, userId),
      "x-request-id": requestId,
    },
    signal: AbortSignal.timeout(60_000), // next dev compile route ตอนเปิดครั้งแรก
  });
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
    text,
    requestId: response.headers.get("x-request-id"),
  };
}

/** หยิบแถวของผู้ใช้จากหน้า BFF (fail-loud เมื่อไม่เจอ) */
function rowOf(page: AdminUsersPageDto, userId: string): AdminUserRowDto {
  const row = page.data.find((entry) => entry.id === userId);
  if (row === undefined) {
    throw new Error(`BFF list ไม่พบแถวของผู้ใช้ ${userId} (ได้ ${page.data.length} แถว)`);
  }
  return row;
}

// ─── GoTrue admin API (service key — ห้าม print) ─────────────────────────────

/** PUT /auth/v1/admin/users/{id} — ban/unban จริงผ่าน GoTrue (service key) */
async function goTrueSetBanDuration(userId: string, banDuration: string): Promise<RestResult> {
  return restCall(
    "PUT",
    `/auth/v1/admin/users/${userId}`,
    { apiKey: SERVICE_KEY, token: SERVICE_KEY },
    { ban_duration: banDuration },
  );
}

// ─── cleanup (idempotent — เรียงตาม FK — RESTRICT) ───────────────────────────

/** ล้างโลกของ suite — scope ด้วย email prefix · audit_logs คงไว้ (append-only) */
async function cleanupDcr13World(): Promise<void> {
  await psql(`
    delete from public.role_assignments
     where user_id in (select id from auth.users where email like 'dcr13-users-%');
    delete from public.profiles
     where id in (select id from auth.users where email like 'dcr13-users-%');
    delete from auth.users where email like 'dcr13-users-%';
  `);
}

describe.skipIf(!DB_URL)(
  "DCR-13 สถานะแบน GoTrue บน GET /api/v1/admin/users (is_banned/banned_until — 0041 · D-f-5)",
  () => {
    beforeAll(async () => {
      await cleanupDcr13World(); // ล้างของค้างจากรอบก่อน (idempotent)
      adminSA = await createTestUser("dcr13-users-admin", "super_admin");
      staffExam = await createTestUser("dcr13-users-exam", "staff:exam");
      banTarget = await createTestUser("dcr13-users-target", "citizen");
      keyA = await createTestUser("dcr13-users-keyset", "citizen");
      keyB = await createTestUser("dcr13-users-keyset", "citizen");
      keyC = await createTestUser("dcr13-users-keyset", "citizen");
      // display_name ต้องชี้เจาะจง — q ของ RPC prefix-match บน display_name/email
      await psql(`
        update public.profiles set display_name = '${targetName}' where id = '${banTarget.id}';
        update public.profiles set display_name = '${keysetName}-A' where id = '${keyA.id}';
        update public.profiles set display_name = '${keysetName}-B' where id = '${keyB.id}';
        update public.profiles set display_name = '${keysetName}-C' where id = '${keyC.id}';
      `);
      adminAal2 = await mintAal2Token(adminSA);
      examAal2 = await mintAal2Token(staffExam);
      // probe container app — ไม่มี = ทุกเคส ctx.skip (ไม่พังทั้ง suite)
      try {
        const probe = await fetch(APP_URL, { signal: AbortSignal.timeout(5_000) });
        appReachable = probe.status < 500;
      } catch {
        appReachable = false;
      }
    }, 300_000);

    afterAll(async () => {
      await cleanupDcr13World();
    });

    // ─── เคส a — super_admin (aal2) ค้นเจอผู้ใช้ใหม่ สถานะไม่ถูกแบน ────────────

    it("เคส a super_admin (aal2) ค้นหาด้วย prefix display_name → 200 · เจอแถว · isBanned=false", async (ctx) => {
      if (!appReachable) {
        return ctx.skip();
      }
      const res = await bffListUsers(
        { query: targetName, limit: 20 },
        adminAal2,
        crypto.randomUUID(),
        adminSA.id,
      );
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const body = res.json as AdminUsersPageDto;
      const row = rowOf(body, banTarget.id);
      expect(row.displayName).toBe(targetName);
      expect(row.email).toContain("dcr13-users-target-");
      expect(row.isBanned).toBe(false);
      expect(row.bannedUntil).toBeNull(); // ไม่เคยถูกแบน — GoTrue ไม่มีค่าค้าง
      // ทุกแถวของหน้าถือสองฟิลด์ใหม่ครบ (additive contract — ห้าม strip)
      for (const entry of body.data) {
        expect(typeof entry.isBanned).toBe("boolean");
        expect(entry.bannedUntil === null || typeof entry.bannedUntil === "string").toBe(true);
      }
    }, 90_000);

    // ─── เคส b — แบนจริงผ่าน GoTrue admin API · สัญญา isBanned/bannedUntil ─────

    it("เคส b แบนจริง: หมดอายุแล้ว isBanned=false แต่ bannedUntil คงค่าอดีต · แบน 876000h → true+อนาคต · unban → false", async (ctx) => {
      if (!appReachable) {
        return ctx.skip();
      }
      // b1) แบนสั้น 3 วินาที แล้วรอให้หมดอายุ — banned_until ค้างค่าอดีต
      const shortBan = await goTrueSetBanDuration(banTarget.id, "3s");
      expect(shortBan.status, shortBan.text.slice(0, 200)).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const expired = await bffListUsers(
        { query: targetName },
        adminAal2,
        crypto.randomUUID(),
        adminSA.id,
      );
      expect(expired.status, expired.text.slice(0, 300)).toBe(200);
      const expiredRow = rowOf(expired.json as AdminUsersPageDto, banTarget.id);
      expect(expiredRow.isBanned).toBe(false); // banned_until เลยอดีตแล้ว
      expect(expiredRow.bannedUntil).not.toBeNull();
      expect(new Date(expiredRow.bannedUntil ?? "").getTime()).toBeLessThan(Date.now());

      // b2) แบนยาว — ตัวอย่าง "ปิดใช้งานเชิงถาวร" ของ repo (BAN_DURATION_DISABLE)
      const longBan = await goTrueSetBanDuration(banTarget.id, "876000h");
      expect(longBan.status, longBan.text.slice(0, 200)).toBe(200);
      const banned = await bffListUsers(
        { query: targetName },
        adminAal2,
        crypto.randomUUID(),
        adminSA.id,
      );
      expect(banned.status, banned.text.slice(0, 300)).toBe(200);
      const bannedRow = rowOf(banned.json as AdminUsersPageDto, banTarget.id);
      expect(bannedRow.isBanned).toBe(true);
      expect(bannedRow.bannedUntil).not.toBeNull();
      expect(new Date(bannedRow.bannedUntil ?? "").getTime()).toBeGreaterThan(Date.now());

      // b3) unban — isBanned กลับ false · bannedUntil ต้องไม่เป็นค่าอนาคต (สัญญา)
      const unban = await goTrueSetBanDuration(banTarget.id, "none");
      expect(unban.status, unban.text.slice(0, 200)).toBe(200);
      const unbanned = await bffListUsers(
        { query: targetName },
        adminAal2,
        crypto.randomUUID(),
        adminSA.id,
      );
      expect(unbanned.status, unbanned.text.slice(0, 300)).toBe(200);
      const unbannedRow = rowOf(unbanned.json as AdminUsersPageDto, banTarget.id);
      expect(unbannedRow.isBanned).toBe(false);
      const until = unbannedRow.bannedUntil;
      expect(until === null || new Date(until).getTime() < Date.now()).toBe(true);
    }, 120_000);

    // ─── เคส c — keyset pagination ตามซองของ route (hasMore/nextCursor) ────────

    it("เคส c keyset: 3 ผู้ใช้ limit=2 → หน้าแรก 2 แถว + hasMore · ตาม cursor ได้แถวที่เหลือ ไม่ซ้ำ", async (ctx) => {
      if (!appReachable) {
        return ctx.skip();
      }
      const first = await bffListUsers(
        { query: keysetName, limit: 2 },
        adminAal2,
        crypto.randomUUID(),
        adminSA.id,
      );
      expect(first.status, first.text.slice(0, 300)).toBe(200);
      const firstPage = first.json as AdminUsersPageDto;
      expect(firstPage.data).toHaveLength(2);
      expect(firstPage.page.hasMore).toBe(true);
      expect(typeof firstPage.page.nextCursor).toBe("string");
      // keyset (created_at, id) DESC — ผู้สร้างทีหลังมาก่อน
      expect(firstPage.data.map((entry) => entry.id)).toEqual([keyC.id, keyB.id]);
      const second = await bffListUsers(
        { query: keysetName, limit: 2, cursor: firstPage.page.nextCursor ?? "" },
        adminAal2,
        crypto.randomUUID(),
        adminSA.id,
      );
      expect(second.status, second.text.slice(0, 300)).toBe(200);
      const secondPage = second.json as AdminUsersPageDto;
      expect(secondPage.data.map((entry) => entry.id)).toEqual([keyA.id]);
      expect(secondPage.page.hasMore).toBe(false);
      expect(secondPage.page.nextCursor).toBeNull();
      // ไม่มีแถวซ้ำข้ามหน้า
      const union = [...firstPage.data, ...secondPage.data].map((entry) => entry.id);
      expect(new Set(union).size).toBe(union.length);
      expect(new Set(union)).toEqual(new Set([keyA.id, keyB.id, keyC.id]));
    }, 90_000);

    // ─── เคส d — aal1 super_admin: BFF MFA gate + RPC guard ก่อนข้อมูล ──────────

    it("เคส d aal1 super_admin → BFF 403 ERR-AUTH-004 (MFA gate) · RPC ปฏิเสธ mfa_required ก่อนข้อมูล", async (ctx) => {
      if (!appReachable) {
        return ctx.skip();
      }
      // token aal1 ของรอบ — grant ใหม่ ณ จุดเรียก: GoTrue จะเพิกถอน session อื่นของ
      // ผู้ใช้เมื่อยืนยัน MFA (factor verify — "sign out other sessions") ทำให้ token
      // จาก createTestUser ที่ mint ตอน beforeAll ตายเป็น session_not_found แล้ว
      const freshGrant = await restCall(
        "POST",
        "/auth/v1/token?grant_type=password",
        {},
        { email: adminSA.email, password: TEST_PASSWORD },
      );
      const freshBody = (freshGrant.json ?? {}) as { access_token?: string };
      expect(freshGrant.status, freshGrant.text.slice(0, 200)).toBe(200);
      const aal1Token = freshBody.access_token ?? "";
      expect(aal1Token.startsWith("ey")).toBe(true); // JWT จริง — ไม่ใช่ body แปลกปลอม
      // เงื่อนไขก่อน: GoTrue ต้องยอมรับ token นี้ (200) — 403 ที่ได้จึงเป็น
      // ฝีมือ MFA gate ของ BFF แท้ ๆ ไม่ใช่ token ใช้ไม่ได้
      const directUser = await restCall("GET", "/auth/v1/user", { token: aal1Token });
      expect(directUser.status, directUser.text.slice(0, 200)).toBe(200);
      const bff = await bffListUsers(
        { query: targetName },
        aal1Token,
        crypto.randomUUID(),
        adminSA.id,
      );
      expect(bff.status, `BFF aal1 → ${bff.status}: ${bff.text.slice(0, 300)}`).toBe(403);
      const err = (bff.json as AdminErrorDto | null)?.error;
      expect(err?.code).toBe("ERR-AUTH-004");
      // ชั้นสอง: RPC ผ่าน Kong ด้วย aal1 — guard ของ RPC ปฏิเสธก่อนคืนแถวใด ๆ
      const rpc = await restCall(
        "POST",
        "/rest/v1/rpc/admin_list_users",
        { token: aal1Token },
        {
          p_query: null,
          p_status: null,
          p_cursor_created_at: null,
          p_cursor_id: null,
          p_limit: 5,
        },
      );
      expect(rpc.status, rpc.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(rpc.text).toContain("mfa_required");
    }, 90_000);

    // ─── เคส e — staff:exam (aal2) ไม่มี user:view → 403 ERR-RBAC-001 ──────────

    it("เคส e staff:exam (aal2) → 403 ERR-RBAC-001 — guard ของ RPC (sv/sr/sa เท่านั้น) ไม่ปล่อยแถวหลุด", async (ctx) => {
      if (!appReachable) {
        return ctx.skip();
      }
      const res = await bffListUsers(
        { query: targetName },
        examAal2,
        crypto.randomUUID(),
        staffExam.id,
      );
      expect(res.status).toBe(403);
      const err = (res.json as AdminErrorDto | null)?.error;
      expect(err?.code).toBe("ERR-RBAC-001");
      // สองชั้น: matrix ของ BFF (rbac.ts — ทะเบียนผ่าน unit D25/O-5) ให้ user:view กับ
      // staff:exam ตาม doc จริง ปฏิเสธจริงเกิดที่ guard ของ RPC (0035: sv/sr/sa เท่านั้น)
      // → details ของ label mapping คือ reason ไม่ใช่ permission · และแถวข้อมูลห้ามหลุด
      expect(err?.details?.["reason"]).toBe("user_view_forbidden");
      expect((res.json as unknown as { data?: unknown }).data).toBeUndefined();
    }, 90_000);

    // ─── เคส f — PII_ACCESS audit fail-closed ต่อการ list สำเร็จ ───────────────

    it("เคส f list สำเร็จ 1 ครั้ง → แถว PII_ACCESS ≥1 ใหม่ (actor = admin · request_id ของรอบ)", async (ctx) => {
      if (!appReachable) {
        return ctx.skip();
      }
      // ก่อน — actor เกิดใหม่ของรอบนี้ ยังไม่มีแถว PII_ACCESS (รอบก่อนถูก cleanup
      // ลบ auth.users ทิ้ง แถว audit เก่า actor ต่างคน — นับเฉพาะ actor รอบนี้)
      const before = await psqlScalar(`
        select count(*)::text from public.audit_logs
         where action = 'PII_ACCESS' and actor_user_id = '${adminSA.id}';
      `);
      const requestId = crypto.randomUUID(); // ส่งไปก็ถูก middleware เขียนทับ — ใช้ตัวสะท้อนแทน
      const res = await bffListUsers({ query: targetName }, adminAal2, requestId, adminSA.id);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      // request-id ของรอบ = ตัวที่ middleware ผูกให้และ BFF สะท้อนกลับ (SDS §5.4) —
      // route บันทึก audit ตาม header ที่ถึง handler (middleware ตั้งใหม่ทุก request)
      const auditRequestId = res.requestId;
      if (auditRequestId === null) {
        throw new Error("BFF ไม่สะท้อน x-request-id — ตรวจแถว audit ตรงจุดไม่ได้");
      }
      const after = await psqlScalar(`
        select count(*)::text from public.audit_logs
         where action = 'PII_ACCESS' and actor_user_id = '${adminSA.id}';
      `);
      expect(Number(after)).toBeGreaterThanOrEqual(Number(before) + 1);
      // อ่านแถวจริงของรอบ — ตรงตามสัญญา PII_ACCESS (0008/0025: actor lift จาก
      // context.user_id · request_id ของ service path ต้องไม่ถูก override เป็น null)
      const rows = await psqlRows<{
        actor: string;
        entity_type: string;
        entity_id: string | null;
        request_id: string | null;
        endpoint: string | null;
        purpose: string | null;
      }>(`
        select actor_user_id::text as actor,
               entity_type,
               entity_id::text as entity_id,
               request_id,
               context ->> 'endpoint' as endpoint,
               context ->> 'purpose' as purpose
          from public.audit_logs
         where action = 'PII_ACCESS' and request_id = '${auditRequestId}';
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe(adminSA.id);
      expect(rows[0]?.entity_type).toBe("user");
      expect(rows[0]?.entity_id).toBeNull(); // list = aggregate (target null)
      expect(rows[0]?.request_id).toBe(auditRequestId);
      expect(rows[0]?.endpoint).toBe("/api/v1/admin/users");
      expect(rows[0]?.purpose).toBe("admin_users_search");
    }, 90_000);
  },
);

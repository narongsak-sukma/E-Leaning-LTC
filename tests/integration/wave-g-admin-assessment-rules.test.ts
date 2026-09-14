/**
 * Integration — Wave G P3 (D87): POST /api/v1/admin/assessments/{id}/rules บนสแตกจริง
 * (db + kong + container app) · API-SPECIFICATION §3.8 แถว 226 + RPC admin_add_assessment_rules
 * (0049) · pattern ตาม wave-g-qb-bank-detail.test.ts
 *
 * ครอบ:
 * - 201 + version = max+1 จริง (seed v1 → POST ได้ v2) · แถว DB สะท้อน exam_review_mode
 * - 403 สองแบบ: instructor (ERR-RBAC-001 ก่อนแตะ DB) · staff:exam แต่ aal1 (ERR-AUTH-004)
 * - flip โหมดเปิดเฉลยสองทิศผ่าน HTTP (never → GET embed สะท้อน → กลับ after_final_attempt)
 * - VAL pass_pct 0 → 400 ERR-VAL-001 (ขา BFF zod ตรวจก่อน RPC — ตามทะเบียน §2 แถว 72;
 *   เอกสาร §3.8 แถว 226 เดิมเขียน 422 ซึ่ง implementable ไม่ได้ → wave นี้แก้เป็น 400
 *   พร้อมเหตุผลแล้ว)
 * - NF: assessment ถูก soft-delete → 404 ERR-NF-001 จาก RPC
 * - audit: ASSESSMENT_CONFIG_CHANGE (0049 ข้อ 5) ลง audit_logs ของ version ใหม่
 *   ทุกครั้งที่ POST ผ่าน endpoint (ปิด 3 ทาง — POST v1 เดิมรวมอยู่ด้วย)
 * - embed "กติกาล่าสุด" เลือกด้วย version สูงสุด (ไม่ใช่ effective_from ล่าสุด) —
 *   ย้อนหลัง/effective_from เท่ากันต้องไม่หมุนแถวที่ GET ตอบ (M4)
 * - R2-M3 (gate GP3 r2): ผู้เรียนที่ลงทะเรียน active เห็นแถวกติกา (ar_read) แต่
 *   ขอคอลัมน์ selection ทางตรง PostgREST = 42501 — 0051 revoke ของ 0050 · ทางอ่าน
 *   ของเจ้าหน้าที่ = RPC admin_latest_assessment_rules (0051)
 * - app ไม่พร้อม: skip ตามปกติ ยกเว้น TEST_REQUIRE_APP=1 (battery §2.4) = ล้มทันที
 *   ห้ามผ่าน battery โดยไม่ได้พิสูจน์บน BFF จริง · R2-m1: ไม่มี TEST_DATABASE_URL
 *   ในโหมด battery = ล้มที่ระดับโมดูล (describe.skipIf ข้าม requireAppOrSkip ทั้งไฟล์)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON_KEY, TEST_PASSWORD, createTestUser, psql, psqlScalar, restCall, type TestUser } from "./helpers.js";
import { STAFF_EXAM_DEMO_ID } from "./helpers-d8.js";
import { mintAal2Token } from "./helpers-aal2.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (next dev) — BFF จริงของทุกเคส */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

/** ชื่อ cookie session ของ @supabase/ssr ใน container app — sb-<host ส่วนแรก>-auth-token */
const AUTH_COOKIE = "sb-kong-auth-token";

// ─── fixture ids ตายตัว (on conflict do nothing — seed ซ้ำได้ · ลบทันทีใน cleanup) ──

const COURSE_ID = "cccccccc-0000-4000-8000-0000000000d1";
/** หลักสูตรที่ instructor เป็นเจ้าของ (กลุ่ม 7 · R3-M2) — แยกจาก fixture หลักของ staff:exam */
const INST_COURSE_ID = "cccccccc-0000-4000-8000-0000000000e1";
const ASSESS_ID = "aaaaaaaa-0000-4000-8000-0000000000d1";
const RULES_V1 = "aaaaaaaa-0000-4000-8000-0000000000d2";

/** path ของ endpoint ใหม่ + list GET สำหรับดู embed */
const RULES_PATH = `/api/v1/admin/assessments/${ASSESS_ID}/rules`;
const LIST_PATH = "/api/v1/admin/assessments";

/** body ขั้นต่ำของ POST — passPct เป็นฟิลด์บังคับเดียว ที่เหลือ default จาก schema */
const MIN_BODY = { passPct: 70 };

// ─── cleanup + seed ───────────────────────────────────────────────────────────

/** ลบโลก fixture ทั้งหมด — เรียงตามลำดับ FK · audit_logs เป็น append-only (trigger
 * prevent_audit_mutation ห้าม DELETE — BRIEF §8/D6/D11-7) จึงไม่แตะ audit เลย:
 * แถว audit ของ fixture ค้างไว้เป็นหลักฐานตามธรรมชาติของระบบ (ไม่มี FK ย้อนกลับ) */
async function cleanupWorld(): Promise<void> {
  await psql(`
    delete from public.assessment_rules where assessment_id = '${ASSESS_ID}';
    delete from public.assessments where id = '${ASSESS_ID}';
    delete from public.enrollments where course_id = '${COURSE_ID}';
    delete from public.courses where id = '${COURSE_ID}';
    delete from public.role_assignments where user_id in (select id from auth.users where email like 'wgp3-rules-%');
    delete from public.profiles where id in (select id from auth.users where email like 'wgp3-rules-%');
    delete from auth.users where email like 'wgp3-rules-%';
  `);
}

/** seed หลักสูตร + ชุดข้อสอบ published + กติกา v1 (exam_review_mode default) — โครงเดียวกับ seedWindows */
async function seedWorld(): Promise<void> {
  await psql(`
    insert into public.courses
      (id, code, category_id, created_by, title_th, is_public, status, published_at)
    values
      ('${COURSE_ID}', 'E14-GP3-RULES',
       (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
       'หลักสูตร probe กติกา (wave-g-admin-assessment-rules)', true, 'published', now())
    on conflict (id) do nothing;
    insert into public.assessments
      (id, course_id, code, title, description, is_final, status, published_at) values
      ('${ASSESS_ID}', '${COURSE_ID}', 'EXAM-GP3-RULES', 'สอบ probe กติกา (GP3)', null, false, 'published', now())
    on conflict (id) do nothing;
    insert into public.assessment_rules
      (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
       attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection,
       require_course_complete, proctoring_mode, effective_from) values
      ('${RULES_V1}', '${ASSESS_ID}', 1, 60, 30, 70, 3, 1440, true, true,
       '{}'::jsonb, true, 'basic', now() - interval '1 day')
    on conflict (id) do nothing;
  `);
}

// ─── cookie session + ตัวเรียก BFF ────────────────────────────────────────────

interface JwtPayload {
  readonly exp?: number;
}

/**
 * base64url ของ session JSON — ตรงสูตร cookieEncoding:"base64url" ของ @supabase/ssr
 * (โครงเดียวกับ dcr13 · user.factors ต้องมี — mfa.getAuthenticatorAssuranceLevel อ่านตรง)
 */
function sessionCookieValue(accessToken: string, userId: string): string {
  const part = accessToken.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as JwtPayload;
  const expiresAt = typeof payload.exp === "number"
    ? payload.exp
    : Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "wgp3-unused-no-refresh",
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

function cookieHeader(accessToken: string, userId: string): string {
  return `${AUTH_COOKIE}=${sessionCookieValue(accessToken, userId)}`;
}

interface BffResult {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
  readonly requestId: string | null;
}

/** GET ผ่าน BFF จริงด้วย cookie session (middleware สร้าง x-request-id ให้เอง) */
async function bffGet(path: string, token: string, userId: string): Promise<BffResult> {
  const response = await fetch(`${APP_URL}${path}`, {
    headers: {
      cookie: cookieHeader(token, userId),
      "x-forwarded-for": "10.7.0.1",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON — คง null */ }
  return { status: response.status, text, json, requestId: response.headers.get("x-request-id") };
}

/**
 * POST ผ่าน BFF — แนบ Origin: APP_URL (CSRF เชิงโครงสร้าง SDS §5.4: Node fetch
 * ไม่มี Origin/Sec-Fetch-Site เอง → fail-closed ปฏิเสธ 403 csrf_origin_mismatch)
 */
async function bffPost(path: string, token: string, userId: string, body?: unknown): Promise<BffResult> {
  const response = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(token, userId),
      "content-type": "application/json",
      origin: APP_URL,
      "x-forwarded-for": "10.7.0.1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON — คง null */ }
  return { status: response.status, text, json, requestId: response.headers.get("x-request-id") };
}

// ─── ผู้ใช้ + สถานะรวมของ suite ───────────────────────────────────────────────

let staffExam: TestUser;
let instructor: TestUser;
let learner: TestUser;
let registrar: TestUser;
let examAal2 = "";
let instructorAal2 = "";
let registrarAal2 = "";

/** container app เข้าถึงได้หรือไม่ — ไม่ได้ = skip ทุกเคส (สแตกบางสภาพรันแค่ db+kong) */
let appReachable = false;

/**
 * app ไม่พร้อม → skip เคสตามปกติ ยกเว้น TEST_REQUIRE_APP=1 (battery §2.4) —
 * โหมด battery ห้ามเขียวแบบไม่ได้พิสูจน์บน BFF จริง: skip เงียบ = false pass → โยน error
 */
function requireAppOrSkip(ctx: { skip(): void }): void {
  if (appReachable) {
    return;
  }
  if (process.env["TEST_REQUIRE_APP"] === "1") {
    throw new Error(
      `app ไม่พร้อมที่ ${APP_URL} แต่ TEST_REQUIRE_APP=1 — battery ห้าม skip เคส BFF`,
    );
  }
  ctx.skip();
}

// R2-m1 (gate GP3 r2): describe.skipIf(!DB_URL) ทำให้ "ไม่มี TEST_DATABASE_URL" ข้าม
// ทั้งไฟล์โดยไม่แตะ requireAppOrSkip เลย — battery (TEST_REQUIRE_APP=1) จะเขียวโดย
// ไม่พิสูจน์อะไร → โหมด battery ต้องตายทันทีที่โหลดไฟล์เมื่อไม่มี DB
if (process.env["TEST_REQUIRE_APP"] === "1" && !DB_URL) {
  throw new Error(
    "TEST_REQUIRE_APP=1 แต่ไม่มี TEST_DATABASE_URL — battery ห้ามรันแบบไม่มี DB",
  );
}
const describeDb = DB_URL ? describe : describe.skip;

describeDb(
  "Wave G P3 — POST /admin/assessments/{id}/rules + embed exam_review_mode (D87)",
  () => {
    beforeAll(async () => {
      await cleanupWorld();
      staffExam = await createTestUser("wgp3-rules-exam", "staff:exam");
      instructor = await createTestUser("wgp3-rules-inst", "instructor");
      learner = await createTestUser("wgp3-rules-learn", "lawyer");
      registrar = await createTestUser("wgp3-rules-reg", "staff:registrar");
      await seedWorld();
      examAal2 = await mintAal2Token(staffExam);
      instructorAal2 = await mintAal2Token(instructor);
      registrarAal2 = await mintAal2Token(registrar);
      try {
        const probe = await fetch(APP_URL, { signal: AbortSignal.timeout(5_000) });
        appReachable = probe.status < 500;
      } catch {
        appReachable = false;
      }
    }, 300_000);

    afterAll(async () => {
      await cleanupWorld();
    });

    // ─── กลุ่ม 1 — 201 + version = max+1 + embed สะท้อน ──────────────────────

    it("staff:exam → 201 · version = max+1 จริง (seed v1 → ได้ v2) · แถว DB สะท้อน body", async (ctx) => {
      requireAppOrSkip(ctx);
      const res = await bffPost(RULES_PATH, examAal2, staffExam.id, {
        ...MIN_BODY,
        passPct: 80,
        timeLimitMinutes: 90,
        examReviewMode: "after_final_attempt",
      });
      expect(res.status, res.text.slice(0, 300)).toBe(201);
      expect(typeof res.requestId).toBe("string");
      const body = res.json as { data: { version: number; examReviewMode: string; passPct: number } };
      expect(body.data.version).toBe(2); // seed v1 → max+1 = 2
      expect(body.data.passPct).toBe(80);
      expect(body.data.examReviewMode).toBe("after_final_attempt");
      // แถวจริงใน DB ตรง response
      const dbVersion = await psqlScalar(
        `select max(version) from public.assessment_rules where assessment_id = '${ASSESS_ID}'`,
      );
      expect(dbVersion).toBe("2");
      const dbMode = await psqlScalar(
        `select exam_review_mode from public.assessment_rules
          where assessment_id = '${ASSESS_ID}' and version = 2`,
      );
      expect(dbMode).toBe("after_final_attempt");
    }, 60_000);

    it("flip สองทิศ: never → GET embed สะท้อน never → กลับ after_final_attempt → GET สะท้อนกลับ", async (ctx) => {
      requireAppOrSkip(ctx);
      // ทิศ 1 — POST never (ได้ v3)
      const postNever = await bffPost(RULES_PATH, examAal2, staffExam.id, {
        ...MIN_BODY,
        examReviewMode: "never",
      });
      expect(postNever.status, postNever.text.slice(0, 300)).toBe(201);
      const neverBody = postNever.json as { data: { version: number } };
      expect(neverBody.data.version).toBe(3);
      // GET list — embed กติกาล่าสุดสะท้อน never
      const getNever = await bffGet(LIST_PATH, examAal2, staffExam.id);
      expect(getNever.status, getNever.text.slice(0, 300)).toBe(200);
      const neverList = getNever.json as {
        data: Array<{ id: string; rules: { version: number; examReviewMode: string } | null }>;
      };
      const neverRow = neverList.data.find((item) => item.id === ASSESS_ID);
      expect(neverRow?.rules?.version).toBe(3);
      expect(neverRow?.rules?.examReviewMode).toBe("never");
      // ทิศ 2 — POST กลับ after_final_attempt (ได้ v4) + GET สะท้อนกลับ
      const postBack = await bffPost(RULES_PATH, examAal2, staffExam.id, {
        ...MIN_BODY,
        examReviewMode: "after_final_attempt",
        passPct: 65,
        maxAttempts: 5,
      });
      expect(postBack.status, postBack.text.slice(0, 300)).toBe(201);
      const backBody = postBack.json as { data: { version: number; examReviewMode: string } };
      expect(backBody.data.version).toBe(4);
      expect(backBody.data.examReviewMode).toBe("after_final_attempt");
      const getBack = await bffGet(LIST_PATH, examAal2, staffExam.id);
      const backList = getBack.json as {
        data: Array<{ id: string; rules: { version: number; examReviewMode: string } | null }>;
      };
      const backRow = backList.data.find((item) => item.id === ASSESS_ID);
      expect(backRow?.rules?.version).toBe(4);
      expect(backRow?.rules?.examReviewMode).toBe("after_final_attempt");
    }, 90_000);

    // ─── กลุ่ม 2 — 403: บทบาท + aal ──────────────────────────────────────────

    it("instructor → 403 ERR-RBAC-001 ก่อนเรียก RPC · ไม่มี version ใหม่ใน DB", async (ctx) => {
      requireAppOrSkip(ctx);
      const res = await bffPost(RULES_PATH, instructorAal2, instructor.id, MIN_BODY);
      expect(res.status).toBe(403);
      const body = res.json as { error: { code: string } };
      expect(body.error.code).toBe("ERR-RBAC-001");
      const dbVersion = await psqlScalar(
        `select max(version) from public.assessment_rules where assessment_id = '${ASSESS_ID}'`,
      );
      expect(dbVersion).toBe("4"); // คง v4 — ไม่มีแถวใหม่
    }, 60_000);

    it("staff:exam แต่ session aal1 → 403 ERR-AUTH-004 (mfa_required)", async (ctx) => {
      requireAppOrSkip(ctx);
      // token aal1 ของรอบ — grant ใหม่ ณ จุดเรียก (แบบ dcr13 เคส d): GoTrue เพิกถอน
      // session อื่นของผู้ใช้เมื่อยืนยัน MFA (factor verify ใน mintAal2Token ตอน
      // beforeAll) ทำให้ accessToken ดิบจาก createTestUser ตาย → 401 ไม่ใช่ 403
      const freshGrant = await restCall(
        "POST",
        "/auth/v1/token?grant_type=password",
        {},
        { email: staffExam.email, password: TEST_PASSWORD },
      );
      expect(freshGrant.status, freshGrant.text.slice(0, 200)).toBe(200);
      const aal1Token = ((freshGrant.json ?? {}) as { access_token?: string }).access_token ?? "";
      expect(aal1Token.startsWith("ey")).toBe(true); // JWT จริง — ไม่ใช่ body แปลกปลอม
      const res = await bffPost(RULES_PATH, aal1Token, staffExam.id, MIN_BODY);
      expect(res.status).toBe(403);
      const body = res.json as { error: { code: string } };
      expect(body.error.code).toBe("ERR-AUTH-004");
    }, 60_000);

    // ─── กลุ่ม 3 — VAL/NF ────────────────────────────────────────────────────

    it("passPct 0 → 400 ERR-VAL-001 (ขา BFF zod ตรวจก่อน RPC — ทะเบียน §2 แถว 72; §3.8 แถว 226 เดิมเขียน 422 → แก้เป็น 400 แล้วใน wave นี้)", async (ctx) => {
      requireAppOrSkip(ctx);
      const res = await bffPost(RULES_PATH, examAal2, staffExam.id, { passPct: 0 });
      expect(res.status).toBe(400);
      const body = res.json as { error: { code: string } };
      expect(body.error.code).toBe("ERR-VAL-001");
      const dbVersion = await psqlScalar(
        `select max(version) from public.assessment_rules where assessment_id = '${ASSESS_ID}'`,
      );
      expect(dbVersion).toBe("4"); // ไม่มี version ใหม่
    }, 60_000);

    it("assessment ถูก soft-delete → 404 ERR-NF-001 จาก RPC · คืนสถานะหลังเคส", async (ctx) => {
      requireAppOrSkip(ctx);
      await psql(`update public.assessments set deleted_at = now() where id = '${ASSESS_ID}'`);
      try {
        const res = await bffPost(RULES_PATH, examAal2, staffExam.id, MIN_BODY);
        expect(res.status).toBe(404);
        const body = res.json as { error: { code: string; details?: { reason?: string } } };
        expect(body.error.code).toBe("ERR-NF-001");
        expect(body.error.details?.reason).toBe("assessment_not_found");
      } finally {
        await psql(`update public.assessments set deleted_at = null where id = '${ASSESS_ID}'`);
      }
    }, 60_000);

    // ─── กลุ่ม 4 — audit ผ่าน endpoint ───────────────────────────────────────

    it("POST ผ่าน endpoint → audit_logs มี ASSESSMENT_CONFIG_CHANGE ของ version ใหม่ + actor ถูกคน", async (auditCtx) => {
      requireAppOrSkip(auditCtx);
      const marker = await psqlScalar("select now()");
      const res = await bffPost(RULES_PATH, examAal2, staffExam.id, {
        ...MIN_BODY,
        passPct: 75,
      });
      expect(res.status, res.text.slice(0, 300)).toBe(201);
      const body = res.json as { data: { version: number } };
      expect(body.data.version).toBe(5);
      const auditCount = await psqlScalar(`
        select count(*) from public.audit_logs
         where action = 'ASSESSMENT_CONFIG_CHANGE'
           and occurred_at >= '${marker}'::timestamptz
           and entity_id in (
             select id from public.assessment_rules
              where assessment_id = '${ASSESS_ID}' and version = 5)
      `);
      expect(Number(auditCount)).toBeGreaterThanOrEqual(1);
      const actor = await psqlScalar(`
        select actor_user_id from public.audit_logs
         where action = 'ASSESSMENT_CONFIG_CHANGE'
           and entity_id in (
             select id from public.assessment_rules
              where assessment_id = '${ASSESS_ID}' and version = 5)
         order by occurred_at desc limit 1
      `);
      expect(actor).toBe(staffExam.id);
    }, 60_000);

    // ─── กลุ่ม 5 — สัญญา embed "ล่าสุด" = version สูงสุด (M4) ─────────────────

    it("embed เลือก version สูงสุด แม้แถวนั้น effective_from ย้อนหลัง/เท่ากัน (เกณฑ์เดียวกับ max+1 ของ RPC)", async (ctx) => {
      requireAppOrSkip(ctx);
      // max ปัจจุบันหลังเคสก่อนหน้า (อย่างน้อย v5 จากเคส audit) — ยืด 2 แถวด้วย psql:
      // v(max+1) ย้อน effective_from 30 วัน · v(max+2) effective_from เดียวกันเป๊ะ
      // (now() ใน statement เดียว = ค่าเดียวกันทุกแถว) — เก่าสั่งเรียง effective_from
      // desc จะตอบแถว POST ล่าสุด (effective_from = ตอนนี้) ไม่ใช่ version สูงสุด
      const maxVersion = Number(
        await psqlScalar(
          `select max(version) from public.assessment_rules where assessment_id = '${ASSESS_ID}'`,
        ),
      );
      expect(maxVersion).toBeGreaterThanOrEqual(1);
      const backdatedVersion = maxVersion + 1;
      const tieVersion = maxVersion + 2;
      await psql(`
        insert into public.assessment_rules
          (id, assessment_id, version, time_limit_minutes, question_count, pass_pct,
           max_attempts, attempt_cooldown_minutes, shuffle_questions, shuffle_options,
           selection, require_course_complete, proctoring_mode, effective_from) values
          ('aaaaaaaa-0000-4000-8000-0000000000d6', '${ASSESS_ID}', ${backdatedVersion},
           60, 30, 70, 3, 1440, true, true, '{}'::jsonb, true, 'basic',
           now() - interval '30 days'),
          ('aaaaaaaa-0000-4000-8000-0000000000d7', '${ASSESS_ID}', ${tieVersion},
           60, 30, 70, 3, 1440, true, true, '{}'::jsonb, true, 'basic',
           now() - interval '30 days')
        on conflict (id) do nothing;
      `);
      try {
        const get = await bffGet(LIST_PATH, examAal2, staffExam.id);
        expect(get.status, get.text.slice(0, 300)).toBe(200);
        const list = get.json as {
          data: Array<{ id: string; rules: { version: number } | null }>;
        };
        const row = list.data.find((item) => item.id === ASSESS_ID);
        expect(row?.rules?.version).toBe(tieVersion); // version สูงสุดชนะ — ไม่แพ้เพราะย้อนหลัง
        // DB ยืนยันแถวสองแถวนั้นมีจริง + effective_from เท่ากันเป๊ะ (ไม่ใช่ไม่ได้แทรก)
        const tieCount = await psqlScalar(`
          select count(*) from public.assessment_rules
           where assessment_id = '${ASSESS_ID}'
             and version in (${backdatedVersion}, ${tieVersion})
             and effective_from = (select effective_from from public.assessment_rules
                                     where assessment_id = '${ASSESS_ID}' and version = ${backdatedVersion})
        `);
        expect(Number(tieCount)).toBe(2);
      } finally {
        await psql(`
          delete from public.assessment_rules
           where assessment_id = '${ASSESS_ID}' and version > ${maxVersion};
        `);
      }
    }, 60_000);

    // ─── กลุ่ม 6 — R2-M3: ปิดทางผู้เรียนอ่าน selection ทางตรง PostgREST (0051) ──

    it("ผู้เรียนที่ลงทะเรียน active เห็นแถวกติกา (ar_read) แต่ selection ถูก 42501 — ทางอ่านเดียวคือ RPC เจ้าหน้าที่", async (ctx) => {
      requireAppOrSkip(ctx);
      // ผู้เรียนลงทะเรียน active ตามทางจริง (RPC enroll — เหมือน progress IT) เพื่อเปิด
      // เส้นทาง ar_read (0010 L694-L702): "ผู้เรียน enrolled-active ของหลักสูตรที่ assessment
      // published" เห็นแถว assessment_rules — นี่คือช่องที่ 0050 เปิดทิ้งให้ (R2-M3)
      const enroll = await restCall(
        "POST",
        "/rest/v1/rpc/enroll",
        { apiKey: ANON_KEY, token: learner.accessToken },
        { p_course_id: COURSE_ID },
      );
      expect(enroll.status, enroll.text.slice(0, 200)).toBe(200);
      try {
        // positive control: คอลัมน์ที่ยังได้ grant SELECT (0010/0019) อ่านได้ผ่าน JWT ผู้เรียน
        // — พิสูจน์ว่า "แถว" นี้มองเห็นได้จริงตาม ar_read ไม่ใช่โดน row policy บังทั้งหมด
        const allowed = await restCall(
          "GET",
          `/rest/v1/assessment_rules?select=assessment_id,version&assessment_id=eq.${ASSESS_ID}`,
          { token: learner.accessToken },
        );
        expect(allowed.status, allowed.text.slice(0, 300)).toBe(200);
        const rows = (allowed.json as Array<{ assessment_id: string }>) ?? [];
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]?.assessment_id).toBe(ASSESS_ID);
        // ตัวจริง: ขอเพิ่มคอลัมน์ selection ด้วย JWT ผู้เรียนคนเดิม → PostgREST ปฏิเสธที่
        // column privilege (0051 revoke ของ 0050) — ผู้เรียนกับเจ้าหน้าที่เป็น role เดียว
        // กัน (authenticated) จึงแยกกันได้ที่คอลัมน์นี้เท่านั้น
        const probe = await restCall(
          "GET",
          `/rest/v1/assessment_rules?select=assessment_id,selection&assessment_id=eq.${ASSESS_ID}`,
          { token: learner.accessToken },
        );
        expect(probe.status, probe.text.slice(0, 300)).toBe(403);
        expect(probe.text).toContain("42501");
        // สถานะ grant จริงใน DB: role authenticated ไม่มี SELECT บน selection อีก (D-f-13)
        const canSelect = await psqlScalar(`
          select has_column_privilege('authenticated', 'public.assessment_rules', 'selection', 'SELECT');
        `);
        expect(canSelect.trim()).toBe("f");
      } finally {
        await psql(`
          delete from public.enrollments
           where course_id = '${COURSE_ID}' and user_id = '${learner.id}';
        `);
      }
    }, 60_000);

    // ─── กลุ่ม 7 — R3-M2 (gate GP3 r3): audience RPC 0052 = 2 สายแรกของ ar_read จริง ──
    // regression 0051: instructor/registrar ผ่าน RBAC ของ BFF แล้วโดน RPC ยก 42501 →
    // POST กลายเป็น 503 หลัง INSERT สำเร็จ · GET กลายเป็น 503 — 0052 คืน 201/200 ตาม as-built

    it("R3-M2: instructor POST หลักสูตรตัวเอง → 201 rules=null (เดิม 0051 = 503 หลัง INSERT สำเร็จ) + GET เห็นเฉพาะของตัวเอง + ?id= ชี้แถวเดียวได้", async (ctx) => {
      requireAppOrSkip(ctx);
      // หลักสูตรที่ instructor เป็นเจ้าของจริง (asm_insert/asm_read + RPC 0052 row-filter
      // ผูก created_by ของ courses — ไม่ใช่ fixture หลักที่เป็นของ staff:exam)
      await psql(`
        insert into public.courses
          (id, code, category_id, created_by, title_th, is_public, status, published_at)
        values
          ('${INST_COURSE_ID}', 'E14-GP3-R3-INST',
           (select id from public.course_categories order by id limit 1), '${instructor.id}',
           'หลักสูตร instructor เจ้าของ (R3-M2)', true, 'published', now())
        on conflict (id) do nothing;
      `);
      try {
        const res = await bffPost(LIST_PATH, instructorAal2, instructor.id, {
          courseId: INST_COURSE_ID,
          code: "EXAM-GP3-R3-01",
          title: "ชุดข้อสอบ draft ของ instructor (R3-M2)",
        });
        expect(res.status, res.text.slice(0, 300)).toBe(201);
        const created = (
          res.json as { data: { id: string; status: string; createdBy: string; rules: unknown } }
        ).data;
        expect(created.status).toBe("draft");
        expect(created.createdBy).toBe(instructor.id);
        expect(created.rules).toBeNull(); // ยังไม่มีกติกา — RPC 0052 ตอบแถวว่าง ไม่ใช่ 42501
        // GET list ของ instructor: RLS กรองเห็นเฉพาะหลักสูตรตัวเอง (ไม่เห็น fixture ของ staff:exam)
        const list = await bffGet(LIST_PATH, instructorAal2, instructor.id);
        expect(list.status, list.text.slice(0, 300)).toBe(200);
        const ids = ((list.json as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        expect(ids).toContain(created.id);
        expect(ids).not.toContain(ASSESS_ID);
        // R3-M1 read-back บนสแตกจริง: ?id=<uuid> ตอบแถวเดียวของชุดที่เพิ่งสร้าง
        const single = await bffGet(`${LIST_PATH}?id=${created.id}`, instructorAal2, instructor.id);
        expect(single.status, single.text.slice(0, 300)).toBe(200);
        const singleRows = ((single.json as { data: Array<{ id: string }> }).data ?? []);
        expect(singleRows).toHaveLength(1);
        expect(singleRows[0]?.id).toBe(created.id);
      } finally {
        await psql(`
          delete from public.assessment_rules where assessment_id in
            (select id from public.assessments where course_id = '${INST_COURSE_ID}');
          delete from public.assessments where course_id = '${INST_COURSE_ID}';
          delete from public.enrollments where course_id = '${INST_COURSE_ID}';
          delete from public.courses where id = '${INST_COURSE_ID}';
        `);
      }
    }, 90_000);

    it("R3-M2: staff:registrar GET → 200 เห็น fixture + กติกา merge จาก RPC 0052 (เดิม 0051 = 503 หลังผ่าน RBAC ของ BFF)", async (ctx) => {
      requireAppOrSkip(ctx);
      // กรอง courseId = fixture หลัก → deterministic หนึ่งแถวพอดี (ไม่เกี่ยว pagination)
      const res = await bffGet(`${LIST_PATH}?courseId=${COURSE_ID}`, registrarAal2, registrar.id);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const rows =
        (res.json as { data: Array<{ id: string; rules: { version: number } | null }> }).data ?? [];
      expect(rows.map((row) => row.id)).toEqual([ASSESS_ID]);
      expect(rows[0]?.rules?.version).toBeGreaterThanOrEqual(1); // กติกา merge จาก RPC 0052 ได้จริง
    }, 60_000);
  });

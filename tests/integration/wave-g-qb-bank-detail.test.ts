/**
 * Integration — Wave G P2 (D73-D79): BFF question-bank detail / list / edit / status
 * บนสแตกจริง (db + kong + container app) · API-SPECIFICATION §3.8 แถว 218-222
 *
 * ครอบ:
 * - detail/list 3 บทบาท (staff:exam · instructor เจ้าของ · staff:viewer) · 404 ต่างจากคลังว่าง
 * - is_correct ออกเฉพาะ edit GET (D74) · Cache-Control: private, no-store ทุกทางออกของ edit
 * - transition matrix + instructor ปฏิเสธที่ RPC + ข้อไร้ตัวเลือก = 400 (D75 · 0047)
 * - version + audit_logs (action QB_QUESTION_STATUS) + request_id ลงช่องจริง
 * - audit ล้ม → rollback ทั้ง TX (two-TX — ล็อก ltc:audit_chain ค้างแล้ว terminate backend)
 * - revoke UPDATE ตรงจาก authenticated (0047 ข้อ 2)
 * - two-session probe (D77): retire แข่ง start_attempt — หน้าต่าง A (นับ pool ผ่านแล้ว pool หาย
 *   — as-built bug ที่ W1 จับได้ ปิดด้วย 0048: guard ต้องยก ERR-ASM-003 + prosrc ต้องมี re-check)
 *   และหน้าต่าง B (เลือกแล้ว snapshot อ่านทีหลัง — ยอมรับข้อที่เลือกไว้) · replay คำสั่งทีละ statement
 * - before/after pool: เริ่มสอบได้ → retire → คลังไม่พอ ERR-ASM-003
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANON_KEY,
  createTestUser,
  psql,
  psqlRows,
  psqlScalar,
  REPO_ROOT,
  restCall,
  type TestUser,
} from "./helpers.js";
import { mintAal2Token } from "./helpers-aal2.js";
import { STAFF_EXAM_DEMO_ID } from "./helpers-d8.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (next dev) — BFF จริงของทุกเคส */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

/** ชื่อ cookie session ของ @supabase/ssr ใน container app — sb-<host ส่วนแรก>-auth-token */
const AUTH_COOKIE = "sb-kong-auth-token";

// ─── fixture ids ตายตัว (on conflict do nothing — seed ซ้ำได้ · ลบทันทีใน cleanup) ──

const BANK_A = "bbbbbbbb-0000-4000-8000-0000000000a1"; // คลังของ instructor (เจ้าของ)
const BANK_EMPTY = "bbbbbbbb-0000-4000-8000-0000000000a2"; // คลังว่าง — ต่างจาก 404
const BANK_WA = "bbbbbbbb-0000-4000-8000-0000000000b1"; // หน้าต่าง A
const BANK_WB = "bbbbbbbb-0000-4000-8000-0000000000c1"; // หน้าต่าง B

const Q_DRAFT = "dddddddd-0000-4000-8000-0000000000a1";
const Q_ACTIVE = "dddddddd-0000-4000-8000-0000000000a2";
const Q_RETIRED = "dddddddd-0000-4000-8000-0000000000a3";
const Q_NOOPT = "dddddddd-0000-4000-8000-0000000000a4";

const Q_WA1 = "dddddddd-0000-4000-8000-0000000000b1";
const Q_WA2 = "dddddddd-0000-4000-8000-0000000000b2";
const Q_WB1 = "dddddddd-0000-4000-8000-0000000000c1";
const Q_WB2 = "dddddddd-0000-4000-8000-0000000000c2";

const COURSE_WA = "cccccccc-0000-4000-8000-0000000000b1";
const ASSESS_WA = "aaaaaaaa-0000-4000-8000-0000000000b1";
const RULES_WA = "aaaaaaaa-0000-4000-8000-0000000000b2";

const COURSE_WB = "cccccccc-0000-4000-8000-0000000000c1";
const ASSESS_WB = "aaaaaaaa-0000-4000-8000-0000000000c1";
const RULES_WB = "aaaaaaaa-0000-4000-8000-0000000000c2";

/** ตัวเลือกของแต่ละข้อ — 2 ตัวต่อข้อ (พอสำหรับ pre-check ≥1) — id 36 ตัวเป๊ะ ไม่ชนข้ามข้อ */
function optionIdsOf(questionId: string): string[] {
  const tail2 = (questionId.split("-").at(-1) ?? "x1").slice(-2);
  return [1, 2].map((slot) => `eeeeeeee-0000-4000-8000-${slot}000000000${tail2}`);
}

/** ทุกข้อของ fixture — ใช้กวาด question_options */
const ALL_QUESTIONS = [Q_DRAFT, Q_ACTIVE, Q_RETIRED, Q_NOOPT, Q_WA1, Q_WA2, Q_WB1, Q_WB2];

/** แปลง array literal ของ pg ("{a,b}") เป็นรายการ uuid — ใช้กับผล selection ของ replay */
function uuidArrayFromPg(raw: string): string[] {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
  return inner === "" ? [] : inner.split(",").map((item) => item.trim());
}

// ─── PsqlSession — เชื่อมต่อ psql ค้างไว้สำหรับ two-session probe (TX หลาย statement) ──

/**
 * session psql เดียวที่ stdin ยังเปิด — รันคำสั่งต่อเนื่องใน TX เดียวได้ (begin...rollback)
 * จบแต่ละคำสั่งด้วย marker select — รอ marker บน stdout พร้อม timeout (timeout = ไม่ผ่าน)
 */
class PsqlSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private errBuf = "";
  private seq = 0;
  private closed = false;
  private pending: {
    readonly marker: string;
    readonly resolve: (value: string) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  } | null = null;

  start(): void {
    const child = spawn(
      "docker",
      [
        "compose", "exec", "-T", "db", "sh", "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At',
      ],
      { cwd: REPO_ROOT },
    );
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += String(chunk);
      this.pump();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.errBuf += String(chunk);
    });
    child.on("close", (code: number | null) => {
      this.closed = true;
      if (this.pending !== null) {
        const waiting = this.pending;
        this.pending = null;
        clearTimeout(waiting.timer);
        waiting.reject(new Error(
          `psql session ปิดก่อนกำหนด (exit ${code ?? "?"}): ` +
          `${(this.errBuf || this.buffer).slice(-300)}`,
        ));
      }
    });
  }

  private pump(): void {
    if (this.pending === null) {
      return;
    }
    const index = this.buffer.indexOf(this.pending.marker);
    if (index === -1) {
      return;
    }
    const value = this.buffer.slice(0, index).trim();
    this.buffer = this.buffer.slice(index + this.pending.marker.length);
    const waiting = this.pending;
    this.pending = null;
    clearTimeout(waiting.timer);
    waiting.resolve(value);
  }

  /** รัน SQL หนึ่งคำสั่ง (หลาย statement ในคำสั่งเดียวได้) — คืน stdout ก่อน marker */
  exec(sql: string, timeoutMs = 20_000): Promise<string> {
    const child = this.child;
    if (this.closed || child === null) {
      return Promise.reject(new Error("psql session ปิดแล้ว — เรียก start() ก่อน"));
    }
    this.seq += 1;
    const marker = `<<GP2-${this.seq}>>`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`psql session timeout ${timeoutMs}ms: ${sql.slice(0, 100)}`));
      }, timeoutMs);
      this.pending = { marker, resolve, reject, timer };
      child.stdin.write(`${sql}\nselect '${marker}';\n`);
    });
  }

  /** ออกจาก session อย่างสะอาด (\q) — ไม่ throw แม้ค้าง (kill หลัง 3s) */
  async end(): Promise<void> {
    const child = this.child;
    if (child === null || this.closed) {
      return;
    }
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ปิดแล้ว */ }
        resolve();
      }, 3_000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.write("\\q\n");
    });
  }
}

// ─── fixture: ล้าง + seed (id ตายตัว — เรียกซ้ำได้) ────────────────────────────

/** ล้างโลกของ suite (เรียงตาม FK — RESTRICT) · audit_logs append-only คงไว้ตามดีไซน์ */
async function cleanupWaveGp2World(): Promise<void> {
  await psql(`
    delete from public.attempt_answers
     where attempt_id in (select id from public.assessment_attempts
                           where assessment_id in ('${ASSESS_WA}', '${ASSESS_WB}'));
    delete from public.assessment_attempts where assessment_id in ('${ASSESS_WA}', '${ASSESS_WB}');
    delete from public.question_options
     where question_id in (${ALL_QUESTIONS.map((id) => `'${id}'`).join(",")});
    delete from public.questions where bank_id in ('${BANK_A}', '${BANK_EMPTY}', '${BANK_WA}', '${BANK_WB}');
    delete from public.question_banks where id in ('${BANK_A}', '${BANK_EMPTY}', '${BANK_WA}', '${BANK_WB}');
    delete from public.assessment_rules where id in ('${RULES_WA}', '${RULES_WB}');
    delete from public.assessments where id in ('${ASSESS_WA}', '${ASSESS_WB}');
    delete from public.enrollments where course_id in ('${COURSE_WA}', '${COURSE_WB}');
    delete from public.courses where id in ('${COURSE_WA}', '${COURSE_WB}');
    delete from public.role_assignments where user_id in (select id from auth.users where email like 'wgp2-qb-%');
    delete from public.profiles where id in (select id from auth.users where email like 'wgp2-qb-%');
    delete from auth.users where email like 'wgp2-qb-%';
  `);
}

/** seed คลังของ instructor + ข้อ 4 สถานะ (draft/active/retired/draft-ไม่มีตัวเลือก) */
async function seedBankA(instructorId: string, staffExamId: string): Promise<void> {
  await psql(`
    insert into public.question_banks
      (id, code, name, created_by, course_id, description, is_active) values
      ('${BANK_A}', 'QB-GP2-A', 'ธนาคารข้อสอบ Wave G P2 (integration)', '${instructorId}',
       null, 'seed ของ wave-g-qb-bank-detail', true),
      ('${BANK_EMPTY}', 'QB-GP2-E', 'คลังว่าง Wave G P2', '${STAFF_EXAM_DEMO_ID}',
       null, 'คลังไม่มีข้อ — ต้อง 200 data:[] ไม่ใช่ 404', true)
    on conflict (id) do nothing;
  `);
  await psql(`
    insert into public.questions
      (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
    values
      ('${Q_DRAFT}',  '${BANK_A}', 'single_choice', 'easy',   'โจทย์ร่างของ GP2 (draft)', null, 1, 'draft',   array['gp2-it'], '${instructorId}', 1),
      ('${Q_ACTIVE}', '${BANK_A}', 'single_choice', 'medium', 'โจทย์ใช้งานของ GP2 (active)', null, 2, 'draft',   array['gp2-it'], '${instructorId}', 1),
      ('${Q_RETIRED}', '${BANK_A}', 'single_choice', 'hard',  'โจทย์ปลดระวังของ GP2 (retired)', null, 1, 'draft',  array['gp2-it'], '${instructorId}', 1),
      ('${Q_NOOPT}',  '${BANK_A}', 'single_choice', 'easy',   'โจทย์ไร้ตัวเลือกของ GP2', null, 1, 'draft',   array['gp2-it'], '${instructorId}', 1)
    on conflict (id) do nothing;
  `);
  const optionRows: string[] = [];
  for (const [index, qid] of [Q_DRAFT, Q_ACTIVE, Q_RETIRED].entries()) {
    for (const [slot, oid] of optionIdsOf(qid).entries()) {
      optionRows.push(
        `('${oid}', '${qid}', 'ตัวเลือก ${index + 1}.${slot + 1} ของ GP2', ${slot === 0 ? "true" : "false"}, ${slot + 1})`,
      );
    }
  }
  await psql(`
    insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
    values ${optionRows.join(",\n      ")};
  `);
  // เปิดใช้/ปลดระวังในนาม staff:exam (guard_question_activation ต้องผ่าน) —
  // UPDATE ตรงได้เพราะ seed รันเป็น superuser (revoke UPDATE ของ 0047 ผูกกับ authenticated)
  await psql(`
    begin;
    set local "request.jwt.claims" = '{"sub":"${staffExamId}","role":"authenticated"}';
    update public.questions set status = 'active' where id in ('${Q_ACTIVE}', '${Q_RETIRED}');
    update public.questions set status = 'retired' where id = '${Q_RETIRED}';
    commit;
  `);
}

/** seed หน้าต่าง A/B — คลังละ 2 ข้อ active มีตัวเลือก + หลักสูตร/สอบ/rules (question_count=2 · shuffle=false) */
async function seedWindows(staffExamId: string): Promise<void> {
  await psql(`
    insert into public.courses
      (id, code, category_id, created_by, title_th, is_public, status, published_at)
    values
      ('${COURSE_WA}', 'E14-GP2-WA',
       (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
       'หลักสูตร probe หน้าต่าง A (wave-g-qb-bank-detail)', true, 'published', now()),
      ('${COURSE_WB}', 'E14-GP2-WB',
       (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
       'หลักสูตร probe หน้าต่าง B (wave-g-qb-bank-detail)', true, 'published', now())
    on conflict (id) do nothing;
    insert into public.assessments
      (id, course_id, code, title, description, is_final, status, published_at) values
      ('${ASSESS_WA}', '${COURSE_WA}', 'EXAM-GP2-WA', 'สอบ probe หน้าต่าง A', null, false, 'published', now()),
      ('${ASSESS_WB}', '${COURSE_WB}', 'EXAM-GP2-WB', 'สอบ probe หน้าต่าง B', null, false, 'published', now())
    on conflict (id) do nothing;
    insert into public.assessment_rules
      (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
       attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection,
       require_course_complete, proctoring_mode, effective_from) values
      ('${RULES_WA}', '${ASSESS_WA}', 1, 5, 2, 70, 5, 0, false, false,
       '{"bank_ids":["${BANK_WA}"]}'::jsonb, false, 'none', now() - interval '1 day'),
      ('${RULES_WB}', '${ASSESS_WB}', 1, 5, 2, 70, 5, 0, false, false,
       '{"bank_ids":["${BANK_WB}"]}'::jsonb, false, 'none', now() - interval '1 day')
    on conflict (id) do nothing;
    insert into public.question_banks
      (id, code, name, created_by, course_id, description, is_active) values
      ('${BANK_WA}', 'QB-GP2-WA', 'คลัง probe หน้าต่าง A', '${staffExamId}',
       '${COURSE_WA}', 'seed probe D77 หน้าต่าง A', true),
      ('${BANK_WB}', 'QB-GP2-WB', 'คลัง probe หน้าต่าง B', '${staffExamId}',
       '${COURSE_WB}', 'seed probe D77 หน้าต่าง B', true)
    on conflict (id) do nothing;
    insert into public.questions
      (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
    values
      ('${Q_WA1}', '${BANK_WA}', 'single_choice', 'easy', 'โจทย์ WA-1', null, 1, 'draft', array['gp2-it'], '${staffExamId}', 1),
      ('${Q_WA2}', '${BANK_WA}', 'single_choice', 'easy', 'โจทย์ WA-2', null, 1, 'draft', array['gp2-it'], '${staffExamId}', 1),
      ('${Q_WB1}', '${BANK_WB}', 'single_choice', 'easy', 'โจทย์ WB-1', null, 1, 'draft', array['gp2-it'], '${staffExamId}', 1),
      ('${Q_WB2}', '${BANK_WB}', 'single_choice', 'easy', 'โจทย์ WB-2', null, 1, 'draft', array['gp2-it'], '${staffExamId}', 1)
    on conflict (id) do nothing;
  `);
  const winOptionRows: string[] = [];
  for (const qid of [Q_WA1, Q_WA2, Q_WB1, Q_WB2]) {
    for (const [slot, oid] of optionIdsOf(qid).entries()) {
      winOptionRows.push(
        `('${oid}', '${qid}', 'ตัวเลือก ${slot + 1} ของ ${qid.slice(-2)}', ${slot === 0 ? "true" : "false"}, ${slot + 1})`,
      );
    }
  }
  await psql(`
    insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
    values ${winOptionRows.join(",\n      ")};
  `);
  await psql(`
    begin;
    set local "request.jwt.claims" = '{"sub":"${staffExamId}","role":"authenticated"}';
    update public.questions set status = 'active' where id in ('${Q_WA1}', '${Q_WA2}', '${Q_WB1}', '${Q_WB2}');
    commit;
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
    refresh_token: "wgp2-unused-no-refresh",
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
  readonly cacheControl: string | null;
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
  return {
    status: response.status,
    text,
    json,
    requestId: response.headers.get("x-request-id"),
    cacheControl: response.headers.get("cache-control"),
  };
}

/**
 * PATCH ผ่าน BFF — แนบ Origin: APP_URL (CSRF เชิงโครงสร้าง SDS §5.4: Node fetch
 * ไม่มี Origin/Sec-Fetch-Site เอง → fail-closed ปฏิเสธ 403 csrf_origin_mismatch)
 */
async function bffPatch(
  path: string,
  token: string,
  userId: string,
  body?: unknown,
  rawBody?: string,
): Promise<BffResult> {
  const headers: Record<string, string> = {
    cookie: cookieHeader(token, userId),
    "content-type": "application/json",
    origin: APP_URL,
    "x-forwarded-for": "10.7.0.1",
  };
  const init: RequestInit = { method: "PATCH", headers, signal: AbortSignal.timeout(45_000) };
  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${APP_URL}${path}`, init);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON — คง null */ }
  return {
    status: response.status,
    text,
    json,
    requestId: response.headers.get("x-request-id"),
    cacheControl: response.headers.get("cache-control"),
  };
}

/** S2 — retire ข้อจากเซสชันอื่น (one-shot psql แยก connection · commit ทันที) */
async function retireFromOtherSession(questionId: string): Promise<void> {
  await psql(`update public.questions set status = 'retired' where id = '${questionId}';`);
}

/** คืนสถานะ active หลัง probe — ผ่าน guard ด้วย claims ของ staff:exam (แบบ seed) */
async function activateFromOtherSession(questionId: string, staffExamId: string): Promise<void> {
  await psql(`
    begin;
    set local "request.jwt.claims" = '{"sub":"${staffExamId}","role":"authenticated"}';
    update public.questions set status = 'active' where id = '${questionId}';
    commit;
  `);
}

// ─── ผู้ใช้ + สถานะรวมของ suite ───────────────────────────────────────────────

let staffExam: TestUser;
let instructor: TestUser; // เจ้าของ BANK_A
let viewer: TestUser;
let learner: TestUser; // ผู้เริ่มสอบ (before/after pool)

let examAal2 = "";
let instructorAal2 = "";
let viewerAal2 = "";
let learnerAal2 = "";

/** container app เข้าถึงได้หรือไม่ — ไม่ได้ = skip ทุกเคส (สแตกบางสภาพรันแค่ db+kong) */
let appReachable = false;

const LIST_PATH = `/api/v1/admin/question-banks/${BANK_A}/questions`;
const DETAIL_PATH = `/api/v1/admin/question-banks/${BANK_A}`;

describe.skipIf(!DB_URL)(
  "Wave G P2 — BFF question-bank detail/list/edit/status + two-session probe (D77)",
  () => {
    beforeAll(async () => {
      await cleanupWaveGp2World();
      staffExam = await createTestUser("wgp2-qb-exam", "staff:exam");
      instructor = await createTestUser("wgp2-qb-inst", "instructor");
      viewer = await createTestUser("wgp2-qb-view", "staff:viewer");
      learner = await createTestUser("wgp2-qb-learn", "lawyer");
      await seedBankA(instructor.id, staffExam.id);
      await seedWindows(staffExam.id);
      // ลงทะเบียนผู้สอบ (start_attempt ตามทางจริง — แบบ dcr10)
      for (const courseId of [COURSE_WA, COURSE_WB]) {
        await restCall(
          "POST",
          "/rest/v1/rpc/enroll",
          { apiKey: ANON_KEY, token: learner.accessToken },
          { p_course_id: courseId },
        );
      }
      examAal2 = await mintAal2Token(staffExam);
      instructorAal2 = await mintAal2Token(instructor);
      viewerAal2 = await mintAal2Token(viewer);
      learnerAal2 = await mintAal2Token(learner);
      try {
        const probe = await fetch(APP_URL, { signal: AbortSignal.timeout(5_000) });
        appReachable = probe.status < 500;
      } catch {
        appReachable = false;
      }
    }, 300_000);

    afterAll(async () => {
      await cleanupWaveGp2World();
    });

    // ─── กลุ่ม 1 — GET detail (D73): 3 บทบาท + 404 ต่างจาก 400 ─────────────────

    it("detail: staff:exam → 200 {data} · questionCount=4 · สะท้อน x-request-id", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffGet(DETAIL_PATH, examAal2, staffExam.id);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      expect(typeof res.requestId).toBe("string");
      const body = res.json as { data: { code: string; questionCount: number } };
      expect(body.data.code).toBe("QB-GP2-A");
      expect(body.data.questionCount).toBe(4);
    }, 60_000);

    it("detail: instructor เจ้าของคลัง → 200 (RLS qb_read ผ่านเจ้าของ)", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffGet(DETAIL_PATH, instructorAal2, instructor.id);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const body = res.json as { data: { code: string; questionCount: number } };
      expect(body.data.questionCount).toBe(4);
    }, 60_000);

    it("detail: staff:viewer → 200 (question_bank:view พอ) · learner → 403", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const viewerRes = await bffGet(DETAIL_PATH, viewerAal2, viewer.id);
      expect(viewerRes.status, viewerRes.text.slice(0, 300)).toBe(200);
      const learnerRes = await bffGet(DETAIL_PATH, learnerAal2, learner.id);
      expect(learnerRes.status).toBe(403);
      const body = learnerRes.json as { error: { code: string } };
      expect(body.error.code).toBe("ERR-RBAC-001");
    }, 60_000);

    it("detail: คลังไม่มีจริง → 404 ERR-NF-001 question_bank_not_found · uuid ผิดรูป → 400 fields id", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const missing = await bffGet(
        `/api/v1/admin/question-banks/00000000-0000-4000-8000-00000000dead`,
        examAal2,
        staffExam.id,
      );
      expect(missing.status).toBe(404);
      const missingBody = missing.json as { error: { code: string; details?: { reason?: string } } };
      expect(missingBody.error.code).toBe("ERR-NF-001");
      expect(missingBody.error.details?.reason).toBe("question_bank_not_found");
      const malformed = await bffGet(
        `/api/v1/admin/question-banks/not-a-uuid`,
        examAal2,
        staffExam.id,
      );
      expect(malformed.status).toBe(400);
      const malformedBody = malformed.json as { error: { code: string; details?: { fields?: string[] } } };
      expect(malformedBody.error.code).toBe("ERR-VAL-001");
      expect(malformedBody.error.details?.fields).toEqual(["id"]);
    }, 60_000);

    // ─── กลุ่ม 2 — GET list (D78): cursor + ไม่มีเฉลย + ว่าง ≠ 404 ─────────────

    it("list: staff:exam → 200 ครบ 4 แถว · ไม่มี is_correct/isCorrect · hasMore=false", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffGet(LIST_PATH, examAal2, staffExam.id);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      expect(res.text.includes("is_correct")).toBe(false);
      expect(res.text.includes("isCorrect")).toBe(false);
      const body = res.json as { data: Array<{ id: string }>; page: { hasMore: boolean; nextCursor: string | null } };
      expect(body.data).toHaveLength(4);
      expect(body.page.hasMore).toBe(false);
      expect(body.page.nextCursor).toBeNull();
    }, 60_000);

    it("list: ?limit=2 เดิน cursor 2 หน้า → ครบ 4 id ไม่ซ้ำ · หน้าสอง hasMore=false", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const page1 = await bffGet(`${LIST_PATH}?limit=2`, examAal2, staffExam.id);
      expect(page1.status, page1.text.slice(0, 300)).toBe(200);
      const body1 = page1.json as { data: Array<{ id: string }>; page: { hasMore: boolean; nextCursor: string | null } };
      expect(body1.page.hasMore).toBe(true);
      expect(typeof body1.page.nextCursor).toBe("string");
      const page2 = await bffGet(
        `${LIST_PATH}?limit=2&cursor=${encodeURIComponent(body1.page.nextCursor as string)}`,
        examAal2,
        staffExam.id,
      );
      expect(page2.status, page2.text.slice(0, 300)).toBe(200);
      const body2 = page2.json as { data: Array<{ id: string }>; page: { hasMore: boolean } };
      expect(body2.page.hasMore).toBe(false);
      const ids = [...body1.data, ...body2.data].map((row) => row.id);
      expect(new Set(ids).size).toBe(4);
      expect(new Set(ids)).toEqual(new Set(ALL_QUESTIONS.slice(0, 4)));
    }, 60_000);

    it("list: instructor เจ้าของ → 200 · staff:viewer → 200", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const inst = await bffGet(LIST_PATH, instructorAal2, instructor.id);
      expect(inst.status, inst.text.slice(0, 300)).toBe(200);
      const view = await bffGet(LIST_PATH, viewerAal2, viewer.id);
      expect(view.status, view.text.slice(0, 300)).toBe(200);
    }, 60_000);

    it("list: คลังว่าง → 200 data:[] hasMore=false · คลังไม่มี → 404 question_bank_not_found", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const empty = await bffGet(
        `/api/v1/admin/question-banks/${BANK_EMPTY}/questions`,
        examAal2,
        staffExam.id,
      );
      expect(empty.status, empty.text.slice(0, 300)).toBe(200);
      const emptyBody = empty.json as { data: unknown[]; page: { hasMore: boolean } };
      expect(emptyBody.data).toEqual([]);
      expect(emptyBody.page.hasMore).toBe(false);
      const missing = await bffGet(
        `/api/v1/admin/question-banks/00000000-0000-4000-8000-00000000dead/questions`,
        examAal2,
        staffExam.id,
      );
      expect(missing.status).toBe(404);
      const missingBody = missing.json as { error: { details?: { reason?: string } } };
      expect(missingBody.error.details?.reason).toBe("question_bank_not_found");
    }, 60_000);

    it("list: ?limit=101 (>max) → 400 ERR-VAL-001", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffGet(`${LIST_PATH}?limit=101`, examAal2, staffExam.id);
      expect(res.status).toBe(400);
      const body = res.json as { error: { code: string } };
      expect(body.error.code).toBe("ERR-VAL-001");
    }, 60_000);

    // ─── กลุ่ม 3 — GET edit (D74): เฉลยเฉพาะเส้นนี้ + no-store ทุกทางออก ─────────

    it("edit: staff:exam → 200 isCorrect ครบ · Cache-Control: private, no-store · ไม่มี snake_case รั่ว", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffGet(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}`,
        examAal2,
        staffExam.id,
      );
      expect(res.status, res.text.slice(0, 400)).toBe(200);
      expect(res.cacheControl).toBe("private, no-store");
      expect(res.text.includes("is_correct")).toBe(false);
      const body = res.json as {
        data: {
          id: string;
          questionText: string;
          status: string;
          version: number;
          options: Array<{ id: string; optionText: string; sortOrder: number; isCorrect: boolean }>;
        };
      };
      expect(body.data.id).toBe(Q_ACTIVE);
      expect(body.data.options).toHaveLength(2);
      expect(body.data.options[0]?.isCorrect).toBe(true);
      expect(body.data.options[1]?.isCorrect).toBe(false);
    }, 60_000);

    it("edit: qid ต่างคลัง → 404 ไม่เปิดเผยการมีอยู่ · error ก็ no-store", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffGet(
        `/api/v1/admin/question-banks/${BANK_WA}/questions/${Q_ACTIVE}`,
        examAal2,
        staffExam.id,
      );
      expect(res.status).toBe(404);
      const body = res.json as { error: { code: string; details?: { reason?: string } } };
      expect(body.error.code).toBe("ERR-NF-001");
      expect(body.error.details?.reason).toBe("question_not_found");
      expect(res.cacheControl).toBe("private, no-store");
    }, 60_000);

    it("edit: staff:viewer → 403 · qid ไม่มีจริง → 404 · ทุก error แนบ no-store", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const view = await bffGet(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}`,
        viewerAal2,
        viewer.id,
      );
      expect(view.status).toBe(403);
      expect(view.cacheControl).toBe("private, no-store");
      const missing = await bffGet(
        `/api/v1/admin/question-banks/${BANK_A}/questions/00000000-0000-4000-8000-00000000dead`,
        examAal2,
        staffExam.id,
      );
      expect(missing.status).toBe(404);
      expect(missing.cacheControl).toBe("private, no-store");
    }, 60_000);

    it("edit: instructor เจ้าของคลัง → 200 พร้อม isCorrect (question_bank:update)", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffGet(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_DRAFT}`,
        instructorAal2,
        instructor.id,
      );
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      expect(res.cacheControl).toBe("private, no-store");
      const body = res.json as { data: { options: Array<{ isCorrect: boolean }> } };
      expect(body.data.options[0]?.isCorrect).toBe(true);
    }, 60_000);

    // ─── กลุ่ม 4 — PATCH status (D75 · 0047): matrix + version + audit ──────────

    it("status: draft→active → 200 version 2 · DB จริงเปลี่ยน · audit request_id/context/actor ตรง response", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_DRAFT}/status`,
        examAal2,
        staffExam.id,
        { status: "active" },
      );
      expect(res.status, res.text.slice(0, 400)).toBe(200);
      const body = res.json as { data: { questionId: string; status: string; version: number } };
      expect(body.data).toEqual({ questionId: Q_DRAFT, status: "active", version: 2 });
      expect(typeof res.requestId).toBe("string");
      const dbVersion = await psqlScalar(
        `select version from public.questions where id = '${Q_DRAFT}';`,
      );
      expect(dbVersion).toBe("2");
      const audits = await psqlRows<{
        request_id: string | null;
        actor_user_id: string;
        context: { from: string; to: string; version: number };
      }>(`
        select request_id, actor_user_id::text as actor_user_id, context
        from public.audit_logs
        where action = 'QB_QUESTION_STATUS' and entity_id = '${Q_DRAFT}'
        order by occurred_at desc limit 1;
      `);
      expect(audits).toHaveLength(1);
      const audit = audits[0] as {
        request_id: string | null;
        actor_user_id: string;
        context: { from: string; to: string; version: number };
      };
      expect(audit.request_id).toBe(res.requestId);
      expect(audit.actor_user_id).toBe(staffExam.id);
      expect(audit.context).toEqual({
        question_id: Q_DRAFT,
        from: "draft",
        to: "active",
        version: 2,
      });
    }, 90_000);

    it("status: active→active (same-status) → 400 ERR-VAL-001 question_status_transition · version คงเดิม", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}/status`,
        examAal2,
        staffExam.id,
        { status: "active" },
      );
      expect(res.status).toBe(400);
      const body = res.json as { error: { code: string; details?: { reason?: string } } };
      expect(body.error.code).toBe("ERR-VAL-001");
      expect(body.error.details?.reason).toBe("question_status_transition");
      const dbStatus = await psqlScalar(
        `select status from public.questions where id = '${Q_ACTIVE}';`,
      );
      expect(dbStatus).toBe("active");
    }, 60_000);

    it("status: active→retired → 200 version 2 · retired→active → 200 version 3 (matrix สองทิศ)", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const retire = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}/status`,
        examAal2,
        staffExam.id,
        { status: "retired" },
      );
      expect(retire.status, retire.text.slice(0, 300)).toBe(200);
      const retireBody = retire.json as { data: { status: string; version: number } };
      expect(retireBody.data).toEqual({ questionId: Q_ACTIVE, status: "retired", version: 2 });
      const reactivate = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}/status`,
        examAal2,
        staffExam.id,
        { status: "active" },
      );
      expect(reactivate.status, reactivate.text.slice(0, 300)).toBe(200);
      const reactivateBody = reactivate.json as { data: { status: string; version: number } };
      expect(reactivateBody.data).toEqual({ questionId: Q_ACTIVE, status: "active", version: 3 });
      const dbRow = await psqlRows<{ status: string; version: number }>(`
        select status::text as status, version from public.questions where id = '${Q_ACTIVE}';
      `);
      expect(dbRow).toEqual([{ status: "active", version: 3 }]);
    }, 90_000);

    it("status: draft→retired → 400 matrix · draft→active ข้อไร้ตัวเลือก → 400 question_needs_options", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const retireDraft = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_NOOPT}/status`,
        examAal2,
        staffExam.id,
        { status: "retired" },
      );
      expect(retireDraft.status).toBe(400);
      const retireBody = retireDraft.json as { error: { code: string; details?: { reason?: string } } };
      expect(retireBody.error.code).toBe("ERR-VAL-001");
      expect(retireBody.error.details?.reason).toBe("question_status_transition");
      const needsOptions = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_NOOPT}/status`,
        examAal2,
        staffExam.id,
        { status: "active" },
      );
      expect(needsOptions.status).toBe(400);
      const needsBody = needsOptions.json as { error: { code: string; details?: { reason?: string } } };
      expect(needsBody.error.code).toBe("ERR-VAL-001");
      expect(needsBody.error.details?.reason).toBe("question_needs_options");
    }, 60_000);

    it("status: instructor เจ้าของคลัง → ผ่าน BFF แต่ RPC ปฏิเสธ 403 ERR-RBAC-001 question_status_forbidden (D75)", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}/status`,
        instructorAal2,
        instructor.id,
        { status: "retired" },
      );
      expect(res.status).toBe(403);
      const body = res.json as { error: { code: string; details?: { reason?: string } } };
      expect(body.error.code).toBe("ERR-RBAC-001");
      expect(body.error.details?.reason).toBe("question_status_forbidden");
      const dbStatus = await psqlScalar(
        `select status from public.questions where id = '${Q_ACTIVE}';`,
      );
      expect(dbStatus).toBe("active");
    }, 60_000);

    it("status: staff:viewer → 403 ที่ BFF ก่อน RPC (ไม่มี question_bank:update)", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}/status`,
        viewerAal2,
        viewer.id,
        { status: "retired" },
      );
      expect(res.status).toBe(403);
      const body = res.json as { error: { code: string; details?: { reason?: string } } };
      expect(body.error.code).toBe("ERR-RBAC-001");
      expect(body.error.details?.reason).toBeUndefined();
    }, 60_000);

    it("status: body strict — ค่าสถานะนอก enum/คีย์แปลก/JSON เสีย → 400 ก่อนแตะ RPC", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const path = `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_ACTIVE}/status`;
      const badValue = await bffPatch(path, examAal2, staffExam.id, { status: "published" });
      expect(badValue.status).toBe(400);
      const badValueBody = badValue.json as { error: { code: string; details?: { fields?: string[] } } };
      expect(badValueBody.error.code).toBe("ERR-VAL-001");
      expect(badValueBody.error.details?.fields).toEqual(["status"]);
      const extraKey = await bffPatch(path, examAal2, staffExam.id, { status: "active", extra: true });
      expect(extraKey.status).toBe(400);
      const extraKeyBody = extraKey.json as { error: { code: string; details?: { fields?: string[] } } };
      expect(extraKeyBody.error.code).toBe("ERR-VAL-001");
      const malformed = await bffPatch(path, examAal2, staffExam.id, undefined, "{bad json");
      expect(malformed.status).toBe(400);
      const malformedBody = malformed.json as { error: { code: string; details?: { fields?: string[] } } };
      expect(malformedBody.error.code).toBe("ERR-VAL-001");
      expect(malformedBody.error.details?.fields).toEqual(["body"]);
    }, 90_000);

    it("status: revoke UPDATE ตรงจาก authenticated (0047 ข้อ 2) — update ตรงต้อง permission denied", async () => {
      await expect(psql(`
        begin;
        set local role authenticated;
        set local "request.jwt.claims" = '{"sub":"${staffExam.id}","role":"authenticated"}';
        update public.questions set status = 'retired' where id = '${Q_ACTIVE}';
        rollback;
      `)).rejects.toThrow();
      const dbVersion = await psqlScalar(
        `select version from public.questions where id = '${Q_ACTIVE}';`,
      );
      expect(dbVersion).toBe("3");
    }, 60_000);

    // ─── กลุ่ม 5 — audit ล้ม → rollback ทั้ง TX (two-TX assert แบบ dcr*) ─────────

    it("audit rollback: ล็อก audit-chain ค้าง → PATCH ค้างที่ขั้น audit → terminate backend → 503 · version/audit ไม่แตะ", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const sessionOne = new PsqlSession();
      sessionOne.start();
      try {
        await sessionOne.exec(
          "begin; select pg_advisory_xact_lock(hashtext('ltc:audit_chain')::bigint);",
        );
        const patchPromise = bffPatch(
          `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_RETIRED}/status`,
          examAal2,
          staffExam.id,
          { status: "active" },
        );
        let killedPid: string | null = null;
        for (let attempt = 0; 40 > attempt; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const found = await psqlScalar(`
            select coalesce(string_agg(pid::text, ','), '')
            from pg_stat_activity
            where datname = 'postgres' and wait_event_type = 'Lock'
              and query ilike '%admin_set_question_status%';
          `);
          if (found !== "") {
            killedPid = found;
            break;
          }
        }
        expect(killedPid, "ไม่พบ RPC admin_set_question_status ที่ถูกบล็อกบน audit-chain lock ภายใน 20s (timeout = ไม่ผ่าน)").not.toBeNull();
        await psql(`select pg_terminate_backend(${killedPid});`);
        const res = await patchPromise;
        expect(res.status, res.text.slice(0, 300)).toBe(503);
        const body = res.json as { error: { code: string; details?: { reason?: string } } };
        expect(body.error.code).toBe("ERR-SYS-002");
        expect(body.error.details?.reason).toBe("question_status_update_failed");
        const dbRow = await psqlRows<{ status: string; version: number }>(`
          select status::text as status, version from public.questions where id = '${Q_RETIRED}';
        `);
        expect(dbRow).toEqual([{ status: "retired", version: 1 }]);
        // audit ของคำขอที่ตายกลางทางไม่ลงถาวร — จำกัดขอบเขตด้วย request_id ของ
        // คำขอนี้ (fixture id คงที่ + audit_logs append-only → ห้ามนับรวมรอบก่อน)
        const killedRequestAudits = await psqlScalar(`
          select count(*) from public.audit_logs where request_id = '${res.requestId}';
        `);
        expect(killedRequestAudits).toBe("0");
      } finally {
        await sessionOne.exec("rollback;");
        await sessionOne.end();
      }
    }, 120_000);

    it("audit rollback แล้วระบบฟื้น: retired→active ปกติ → 200 version 2", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const res = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_A}/questions/${Q_RETIRED}/status`,
        examAal2,
        staffExam.id,
        { status: "active" },
      );
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const body = res.json as { data: { status: string; version: number } };
      expect(body.data).toEqual({ questionId: Q_RETIRED, status: "active", version: 2 });
    }, 60_000);

    // ─── กลุ่ม 6 — before/after pool: retire แล้วคลังไม่พอ (ERR-ASM-003) ─────────

    it("pool: start_attempt ผ่านก่อน retire → retire Q_WA2 → start_attempt ซ้ำ = ERR-ASM-003", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const before = await restCall(
        "POST",
        "/rest/v1/rpc/start_attempt",
        { apiKey: ANON_KEY, token: learner.accessToken },
        { p_assessment_id: ASSESS_WA },
      );
      expect(before.status, before.text.slice(0, 300)).toBe(200);
      const attemptId = (before.json as { attempt_id: string }).attempt_id;
      expect(typeof attemptId).toBe("string");
      const retire = await bffPatch(
        `/api/v1/admin/question-banks/${BANK_WA}/questions/${Q_WA2}/status`,
        examAal2,
        staffExam.id,
        { status: "retired" },
      );
      expect(retire.status, retire.text.slice(0, 300)).toBe(200);
      // ปิด attempt แรก (voided) — ไม่งั้น start ครั้งที่สองโดน ERR-ASM-002
      // (มีการสอบที่ยังไม่จบอยู่แล้ว) ก่อนถึงเช็คคลังข้อไม่พอ (0022:91/101)
      await psql(`
        update public.assessment_attempts set status = 'voided'
         where id = '${attemptId}';
      `);
      const after = await restCall(
        "POST",
        "/rest/v1/rpc/start_attempt",
        { apiKey: ANON_KEY, token: learner.accessToken },
        { p_assessment_id: ASSESS_WA },
      );
      expect(after.status, after.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(after.text).toContain("ERR-ASM-003");
      await activateFromOtherSession(Q_WA2, staffExam.id);
    }, 90_000);

    // ─── กลุ่ม 7 — two-session probe (D77): retire แข่ง start_attempt ───────────
    // replay คำสั่งของ 0022/0048 ทีละ statement ใน TX เปิดของ S1 (Read Committed —
    // statement ละ snapshot): นับ pool (:183) → [S2 retire] → เลือก ID (:197) →
    // guard 0048 ยก ERR-ASM-003 · S1 rollback เสมอ (ไม่เขียน attempt จริง)
    //
    // หน้าต่าง A (as-built bug ที่ W1 จับได้ — selection สั้นกว่า rules แล้วยัง
    // สร้าง attempt) ปิดแล้วด้วย migration 0048: re-check หลัง selection ตาม
    // แบบแผน mix branch · พิสูจน์สองชั้น: (1) replay เงื่อนไข guard บนสถานะ
    // แข่งจริง (cardinality ของ selection ที่ได้จริง < question_count ของ rules
    // แถวจริง = guard ต้องยก) (2) prosrc ของฟังก์ชันที่ deploy ต้องมี re-check
    // (migration ใหล่มาแทนที่แล้วลืม guard = เทสต้องแดง)

    it("probe หน้าต่าง A: นับ pool ผ่าน (2) → retire commit → เลือกได้ 1 → guard 0048 ต้องยก ERR-ASM-003 (ไม่สร้าง attempt สั้น)", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const sessionOne = new PsqlSession();
      sessionOne.start();
      try {
        await sessionOne.exec("begin;");
        const pool = await sessionOne.exec(`
          select count(*)::text
          from public.questions q
          join public.question_banks qb on qb.id = q.bank_id
          where q.status = 'active'
            and q.bank_id = any (array['${BANK_WA}']::uuid[])
            and exists (select 1 from public.question_options o where o.question_id = q.id);
        `);
        expect(pool, "นับ pool ก่อน retire ต้องได้ 2 (พอตาม rules.question_count)").toBe("2");
        await retireFromOtherSession(Q_WA2);
        const readBack = await sessionOne.exec(
          `select status from public.questions where id = '${Q_WA2}';`,
        );
        expect(readBack, "S1 ต้องเห็น retire commit แล้ว (sync ตรวจสอบได้)").toBe("retired");
        const selection = await sessionOne.exec(`
          select coalesce(array_agg(t.id)::text, '{}')
          from (
            select q.id from public.questions q
            join public.question_banks qb on qb.id = q.bank_id
            where q.status = 'active'
              and q.bank_id = any (array['${BANK_WA}']::uuid[])
              and exists (select 1 from public.question_options o where o.question_id = q.id)
            order by q.created_at::text || q.id::text, q.created_at, q.id
            limit 2
          ) t;
        `);
        const qids = uuidArrayFromPg(selection);
        expect(
          qids,
          "หน้าต่าง A ต้องยังเกิดจริง: retire commit กลางคันทำให้ selection ได้ 1 (< rules.question_count)",
        ).toHaveLength(1);
        // (1) replay เงื่อนไข guard 0048 กับข้อมูลจริงของสถานะแข่งนี้ — ตรงกับที่
        // ฟังก์ชันรันหลัง selection: cardinality(v_qids) < v_rules.question_count
        const guardFires = await sessionOne.exec(`
          select (cardinality(array[${qids.map((id) => `'${id}'`).join(",")}]::uuid[]) <
                  (select question_count from public.assessment_rules where id = '${RULES_WA}'))::text;
        `);
        expect(
          guardFires,
          "guard 0048 ต้องจับสถานะนี้ (cardinality(v_qids) < v_rules.question_count) → ยก ERR-ASM-003 ก่อนสร้าง attempt",
        ).toBe("true");
        // (1b) gate r1 M3-A: พิสูจน์ execute path ของ raise จริง ไม่ใช่แค่ boolean —
        // DO block คัดลอกตัว guard ต้นฉบับของ 0048 (ข้อความเดิมทุกไบต์) รันกับ
        // qids/rules จริงของสถานะแข่งนี้ · exception handler ของ DO จับ raise
        // แล้วบันทึก sqlerrm ลง temp table (จบ TX อัตโนมัติ) — psql ไม่ตาย
        await sessionOne.exec("create temp table guard_raised (msg text) on commit drop;");
        await sessionOne.exec(`
          do $g$
          begin
            if cardinality(array[${qids.map((id) => `'${id}'`).join(",")}]::uuid[]) <
               (select question_count from public.assessment_rules where id = '${RULES_WA}') then
              raise exception 'ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว: คลังข้อไม่พอ (ERR-ASM-003)';
            end if;
            insert into guard_raised values ('not-raised');
          exception when others then
            insert into guard_raised values (sqlerrm);
          end
          $g$;
        `);
        const raised = await sessionOne.exec("select msg from guard_raised;");
        expect(
          raised,
          "raise ของ guard 0048 ต้อง execute จริงกับสถานะแข่งนี้ (ข้อความต้นฉบับ มี ERR-ASM-003)",
        ).toContain("ERR-ASM-003");
        expect(raised).toContain("คลังข้อไม่พอ");
      } finally {
        await sessionOne.exec("rollback;");
        await sessionOne.end();
        await activateFromOtherSession(Q_WA2, staffExam.id);
      }
      // (2) deployment proof — ฟังก์ชันที่ deploy จริงต้องมี re-check ของ 0048
      const deployedGuard = await psqlScalar(`
        select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'start_attempt'
          and p.prosrc like '%cardinality(v_qids) < v_rules.question_count%';
      `);
      expect(
        deployedGuard,
        "start_attempt ที่ deploy ต้องมี re-check 0048 ใน prosrc (หาย = regression หน้าต่าง A)",
      ).toBe("1");
    }, 120_000);

    it("probe หน้าต่าง B: เลือก ID ก่อน → retire ผ่าน RPC จริง → replay snapshot CTE ของ 0048 ต้องได้ครบตามกติกา (version หลัง retire)", async (ctx) => {
      if (!appReachable) return ctx.skip();
      const sessionOne = new PsqlSession();
      sessionOne.start();
      try {
        await sessionOne.exec("begin;");
        const pool = await sessionOne.exec(`
          select count(*)::text
          from public.questions q
          join public.question_banks qb on qb.id = q.bank_id
          where q.status = 'active'
            and q.bank_id = any (array['${BANK_WB}']::uuid[])
            and exists (select 1 from public.question_options o where o.question_id = q.id);
        `);
        expect(pool).toBe("2");
        const selection = await sessionOne.exec(`
          select coalesce(array_agg(t.id)::text, '{}')
          from (
            select q.id from public.questions q
            join public.question_banks qb on qb.id = q.bank_id
            where q.status = 'active'
              and q.bank_id = any (array['${BANK_WB}']::uuid[])
              and exists (select 1 from public.question_options o where o.question_id = q.id)
            order by q.created_at::text || q.id::text, q.created_at, q.id
            limit 2
          ) t;
        `);
        const qids = uuidArrayFromPg(selection);
        expect(qids).toHaveLength(2);
        // S2 retire ผ่าน RPC จริง (admin_set_question_status) ผ่าน BFF — ได้ทั้ง
        // status='retired' และ version ยกเป็น 2 + audit (ต่างจาก UPDATE ตรงที่
        // ไม่ bump version — gate r1 M3-B: expected outcome ของ r4 ผูก version)
        const retire = await bffPatch(
          `/api/v1/admin/question-banks/${BANK_WB}/questions/${Q_WB2}/status`,
          examAal2,
          staffExam.id,
          { status: "retired" },
        );
        expect(retire.status, retire.text.slice(0, 300)).toBe(200);
        const readBack = await sessionOne.exec(
          `select status::text || '|' || version::text from public.questions where id = '${Q_WB2}';`,
        );
        expect(readBack, "S1 ต้องเห็น retire commit แล้วพร้อม version ยก (sync ตรวจสอบได้)").toBe("retired|2");
        // replay snapshot CTE ของ 0048 ตัวจริง (ord+snap :237-264) ใน TX เปิดของ
        // S1 — เหมือน statement ถัดไปของ start_attempt หลัง selection: ไม่
        // re-check status (ยอมรับข้อที่เลือกไว้) · options ≥1 ต่อข้อ · seq
        // ตั้งแต่ 1 ไล่เรียงไม่ซ้ำ · version ที่ snapshot เห็น = หลัง retire
        // (Read Committed statement ใหม่อ่าน commit ล่าสุด)
        const snapReplay = await sessionOne.exec(`
          with ord as (
            select q.id as qid, q.question_text, q.points, q.version, q.type,
                   row_number() over (order by case when (select shuffle_questions from public.assessment_rules where id = '${RULES_WB}')
                                                  then md5(q.id::text || 'probe-seed')
                                                  else q.created_at::text || q.id::text end,
                                             q.created_at, q.id) as seq
            from public.questions q
            where q.id = any (array[${qids.map((id) => `'${id}'`).join(",")}]::uuid[])
          ),
          snap as (
            select o.question_id,
                   jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text,
                                                'is_correct', o.is_correct, 'points', ord.points)
                             order by case when (select shuffle_options from public.assessment_rules where id = '${RULES_WB}')
                                           then md5(o.id::text || 'probe-seed')
                                           else lpad(o.sort_order::text, 8, '0') end) as options
            from public.question_options o
            join ord on ord.qid = o.question_id
            group by o.question_id
          )
          select (select count(*)::text from ord)
              || '|' || (select count(*)::text from snap)
              || '|' || (select min(jsonb_array_length(options))::text from snap)
              || '|' || (select count(distinct seq)::text from ord)
              || '|' || (select min(seq)::text || '..' || max(seq)::text from ord)
              || '|' || (select version::text from ord where qid = '${Q_WB2}')
              || '|' || (select question_count::text from public.assessment_rules where id = '${RULES_WB}');
        `);
        const [ordCount, snapCount, minOptions, distinctSeq, seqRange, wb2Version, rulesCount] =
          snapReplay.split("|");
        expect(ordCount, "ord = จำนวนข้อที่เลือกไว้ (ยอมรับข้อที่เลือก — ไม่ re-check status)").toBe("2");
        expect(snapCount, "snap = มี options ครบทุกข้อที่เลือก").toBe("2");
        expect(minOptions, "options ต่อข้อ ≥ 1 (D20-M3)").toBe("2");
        expect(distinctSeq, "seq ไม่ซ้ำ").toBe("2");
        expect(seqRange, "seq ไล่ 1..n").toBe("1..2");
        expect(
          wb2Version,
          "version ที่ snapshot เห็น = หลัง retire (Read Committed statement ใหม่เห็น commit ล่าสุด)",
        ).toBe("2");
        expect(rulesCount, "invariant รวม: จำนวนข้อ = rules.question_count").toBe("2");
      } finally {
        await sessionOne.exec("rollback;");
        await sessionOne.end();
        await activateFromOtherSession(Q_WB2, staffExam.id);
      }
    }, 120_000);
  },
);

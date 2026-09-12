/**
 * DCR-7 — integration tests ส่วนที่ d8-exam-cert-flow ยังไม่ครอบ (เติมเฉพาะช่องว่าง):
 *   1) learner_attempt_paper_view คืนคีย์ `type` ทั้งสองทาง (0022 — DCR-7/PB-18 · D55-1):
 *      snapshot ใหม่ (มีคีย์ type ตาม 0022) → type ตาม snapshot ('single_choice')
 *      snapshot เก่าที่ไม่มีคีย์ type → default 'multiple_choice' (coalesce ใน view 0022)
 *      (d8-exam-cert-flow ตรวจเฉพาะการตัดเฉลย/แต้มของ question_paper — ไม่ได้แตะ type)
 *   2) admin_list_certificates (0023): keyset pagination บน tuple (issued_at, id) แบบ
 *      ลำดับเสถียร desc + ฟิลด์ตาม returns table + ตัวกรอง status/cert_no/verify_code/
 *      course_id + การ clamp จำนวน (p_limit 0 → 1 แถว · 1000 → สูงสุด 101 แถว —
 *      พิสูจน์ "ครอบ" จริงด้วย fixture ใบ ≥102 แถว: clamp ตัดเหลือ 101 พอดี ·
 *      prefix ของ cert_no ตัดจริง (ไม่ใช่เลขเต็ม) และ keyset กรณี issued_at เท่ากัน
 *      ตัดสินด้วย id ตาม tuple — ปิดข้อ m2 ของ codex gate r1)
 *      หมายเหตุ: 0023 ไม่ได้นิยาม audit ระดับ DB สำหรับ list (audit PII_ACCESS ทำที่
 *      BFF ตามหัวไฟล์ 0023 — อยู่นอกขอบเขต DB ของชุดนี้)
 *
 * ผู้ใช้ทดสอบ = GoTrue signup จริง (paper view ใช้ auth.uid() — ต้องมี JWT ฝั่ง user)
 * ใบประกาศนียบัตร fixture ผ่าน RPC service_role จริง (issue → reissue) แบบ suite เดิม
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANON_KEY,
  createTestUser,
  psql,
  restCall,
  SERVICE_KEY,
  type RestResult,
  type TestUser,
} from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── ชนิดข้อมูลของ response/view ที่ assert ───────────────────────────────────

/** แถวของ admin_list_certificates — ตาม returns table ของ 0023 */
interface CertListRow {
  readonly id: string;
  readonly cert_no: string;
  readonly verify_code: string;
  readonly status: string;
  readonly issued_at: string;
  readonly user_id: string;
  readonly holder_name: string;
  readonly course_id: string;
  readonly course_title: string;
}

/** โครง question_paper ที่ learner_attempt_paper_view คืน (ตัดเฉลย/แต้ม + เพิ่ม type ตาม 0022) */
interface PaperRow {
  readonly attempt_id: string;
  readonly question_id: string;
  readonly seq: number;
  readonly question_paper: {
    readonly question_id: string;
    readonly version: number;
    readonly text: string;
    readonly type: string;
    readonly options: readonly { readonly id: string; readonly text: string }[];
  };
}

// ─── id อ้างอิงของ seed — อ่านอย่างเดียว ไม่แตะ ────────────────────────────────

const SEED_EXAM_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
const SEED_RULES_ID = "dddddddd-dddd-4ddd-8ddd-000000000001";
/** หลักสูตร seed (LTC-103) — ใช้เป็น "หลักสูตรอื่น" ในตัวกรอง course_id */
const SEED_COURSE3_ID = "44444444-4444-4444-8444-000000000003";
/** โจทย์ seed 2 ข้อ — ใช้เป็น question_id ของ snapshot fixture (FK ต้องเป็นโจทย์จริง) */
const SEED_Q1 = "f0f0f0f0-f0f0-4f0f-8f0f-000000000001";
const SEED_Q2 = "f0f0f0f0-f0f0-4f0f-8f0f-000000000002";
/** profile สาธิต staff:exam ของ seed — actor ออกใบ (แบบ suite เดิม) */
const STAFF_EXAM_DEMO_ID = "11111111-1111-4111-8111-000000000002";

// ─── id ตายตัวของ fixture ชุดนี้ (ล้างซ้ำได้ — ไม่ชน seed/ชุดอื่น) ─────────────

const E9D7_COURSE_ID = "99999999-9999-4999-8999-00000000e971";
const E9D7_ENROLLMENT_ID = "bb000000-0000-4000-8000-00000000e972";
/** attempt "ผ่าน" — เงื่อนไขคิว eligible เพื่อ issue/reissue จริงผ่าน RPC */
const E9D7_PASSED_ATTEMPT_ID = "aa000000-0000-4000-8000-00000000e973";
/** attempt in_progress พร้อม snapshot 2 รูปแบบ — เป้าของ paper view */
const E9D7_PAPER_ATTEMPT_ID = "aa000000-0000-4000-8000-00000000e974";
/** หลักสูตรของโลกใบ 102 ใบ (clamp/tie ของ m2) — แยกจากหลักสูตรหลักของชุด */
const E9D7_BIG_COURSE_ID = "99999999-9999-4999-8999-00000000e975";

/** id ของใบใบที่ n (1..102) ของโลกใบ 102 ใบ — ตายตัว เรียงตามเลข เพื่อ assert ลำดับ id desc */
function bigCertId(n: number): string {
  return `99999999-9999-4999-8999-0000000e${n.toString().padStart(4, "0")}`;
}

/** comparator อ้างอิงของลำดับ list — tuple (issued_at desc, id desc) ตาม ORDER BY ของ 0023 */
function byIssuedDescIdDesc(a: CertListRow, b: CertListRow): number {
  if (a.issued_at !== b.issued_at) {
    return a.issued_at < b.issued_at ? 1 : -1;
  }
  return a.id < b.id ? 1 : -1;
}

/** เรียก RPC ของบทบาท service_role ผ่าน REST (duplicate เล็ก ๆ — ไม่แก้ helpers เดิม) */
function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/** เรียก admin_list_certificates ด้วยพารามิเตอร์ที่กำหนด แล้วคืนแถว (assert 200 ไว้ก่อน) */
async function listCerts(params: Record<string, unknown>): Promise<CertListRow[]> {
  const result = await svcRpc("admin_list_certificates", params);
  expect(result.status, result.text.slice(0, 300)).toBe(200);
  return result.json as CertListRow[];
}

describe.skipIf(!DB_URL)("DCR-7 กระดาษข้อสอบคีย์ type + รายการใบประกาศนียบัตร (list RPC บน DB จริง)", () => {
  let user: TestUser;
  /** ใบหลัง reissue (valid) และใบเดิมที่ถูก supersede (superseded) */
  let validCert: { id: string; cert_no: string; verify_code: string };
  let supersededCert: { id: string; cert_no: string };

  /** ล้างโลกของชุดนี้ทั้งหมด (เรียงตาม FK — RESTRICT) ครอบของค้างจากรอบที่พังกลางทาง */
  async function cleanupE9D7World(): Promise<void> {
    await psql(`
      delete from public.certificate_verifications
       where verify_code in (select c.verify_code from public.certificates c
                              where c.user_id in (select id from auth.users
                                                   where email like 'e9-dcr7-%'));
      delete from public.certificates
       where user_id in (select id from auth.users where email like 'e9-dcr7-%');
      delete from public.attempt_answers where attempt_id = '${E9D7_PAPER_ATTEMPT_ID}';
      delete from public.assessment_attempts
       where id in ('${E9D7_PASSED_ATTEMPT_ID}', '${E9D7_PAPER_ATTEMPT_ID}');
      delete from public.lesson_progress
       where enrollment_id in (select id from public.enrollments
                                where user_id in (select id from auth.users
                                                   where email like 'e9-dcr7-%'));
      delete from public.enrollments
       where user_id in (select id from auth.users where email like 'e9-dcr7-%');
      delete from public.role_assignments
       where user_id in (select id from auth.users where email like 'e9-dcr7-%');
      delete from public.profiles
       where id in (select id from auth.users where email like 'e9-dcr7-%');
      delete from auth.users where email like 'e9-dcr7-%';
      delete from public.courses
       where id in ('${E9D7_COURSE_ID}', '${E9D7_BIG_COURSE_ID}');
    `);
  }

  /** หว่าน fixture: หลักสูตร + enrollment completed + attempt ผ่าน + attempt in_progress พร้อม snapshot 2 รูปแบบ */
  async function seedE9D7Fixtures(): Promise<void> {
    /** snapshot ใหม่ (หลัง 0022) — มีคีย์ type */
    const snapshotTyped = {
      question_id: SEED_Q1,
      version: 1,
      text: "โจทย์ fixture ข้อที่ 1 (snapshot ใหม่มีคีย์ type)",
      points: 1,
      type: "single_choice",
      options: [
        { id: "f1f1f1f1-f1f1-4f1f-8f1f-00000000e971", text: "ตัวเลือกก", is_correct: true, points: 1 },
        { id: "f1f1f1f1-f1f1-4f1f-8f1f-00000000e972", text: "ตัวเลือกข", is_correct: false, points: 0 },
      ],
    };
    // snapshot แบบเก่า (ก่อน 0022) — โครงเดียวกันแต่ไม่มีคีย์ type
    const snapshotLegacy: Record<string, unknown> = { ...snapshotTyped, question_id: SEED_Q2 };
    delete snapshotLegacy["type"];

    await psql(`
      insert into public.courses
        (id, code, category_id, created_by, title_th, is_public, status, published_at)
      values
        ('${E9D7_COURSE_ID}', 'E9-DCR7-T',
         (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
         'หลักสูตรทดสอบ DCR-7 (integration)', false, 'published', now())
      on conflict (id) do nothing;
      insert into public.enrollments (id, user_id, course_id, status, completed_at)
      values ('${E9D7_ENROLLMENT_ID}',
              (select id from auth.users where email like 'e9-dcr7-%' limit 1),
              '${E9D7_COURSE_ID}', 'completed', now() - interval '1 hour')
      on conflict (id) do nothing;
      insert into public.assessment_attempts
        (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
         lease_expires_at, started_at, expires_at, submitted_at, score_pct, passed,
         question_count, correct_count)
      values
        -- attempt "ผ่าน" (สำหรับคิว eligible ของ issue/reissue)
        ('${E9D7_PASSED_ATTEMPT_ID}', '${SEED_EXAM_ID}',
         (select id from auth.users where email like 'e9-dcr7-%' limit 1),
         '${E9D7_ENROLLMENT_ID}', '${SEED_RULES_ID}', 1, 'passed',
         'e9-dcr7-integration-session', now() - interval '2 hours',
         now() - interval '2 hours', now() + interval '1 hour',
         now() - interval '90 minutes', 100, true, 5, 5),
        -- attempt in_progress (เป้าของ paper view — expires อีก 1 ชม. กัน cron auto-close)
        ('${E9D7_PAPER_ATTEMPT_ID}', '${SEED_EXAM_ID}',
         (select id from auth.users where email like 'e9-dcr7-%' limit 1),
         '${E9D7_ENROLLMENT_ID}', '${SEED_RULES_ID}', 2, 'in_progress',
         'e9-dcr7-integration-session', now() + interval '5 minutes',
         now() - interval '3 hours', now() + interval '1 hour', null, null, null, 1, null)
      on conflict (id) do nothing;
    `);

    // snapshot ของกระดาษ: ข้อ 1 มี type (ใหม่) · ข้อ 2 ไม่มี type (แบบเก่า) — seq 1, 2
    await psql(`
      insert into public.attempt_answers
        (attempt_id, question_id, seq, option_order, selected_option_ids, question_snapshot)
      values
        ('${E9D7_PAPER_ATTEMPT_ID}', '${SEED_Q1}', 1, null, null,
         '${JSON.stringify(snapshotTyped).replaceAll("'", "''")}'::jsonb),
        ('${E9D7_PAPER_ATTEMPT_ID}', '${SEED_Q2}', 2, null, null,
         '${JSON.stringify(snapshotLegacy).replaceAll("'", "''")}'::jsonb);
    `);
  }

  beforeAll(async () => {
    await cleanupE9D7World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
    user = await createTestUser("e9-dcr7"); // GoTrue จริง — JWT สำหรับ view ที่ใช้ auth.uid()
    // fixture หว่านหลัง signup (SQL ของ fixture อ้าง user ผ่าน email pattern)
    await seedE9D7Fixtures();
    // ตั้งชื่อผู้ถือใบให้ตัวนับ holder_name snapshot ตรงตัว (แก้ได้เฉพาะ display_name —
    // guard ของ profiles: คอลัมน์อื่นเป็นของ super_admin ตาม DD §3.1 · holderNameOf
    // fallback ใช้ display_name เมื่อไม่มี first/last)
    await psql(`
      update public.profiles
         set display_name = 'ทดสอบ รายใบอี9'
       where id = (select id from auth.users where email like 'e9-dcr7-%' limit 1);
    `);
    // ออกใบจริงผ่าน RPC service_role แล้ว reissue — ได้คู่ valid + superseded สำหรับ list/keyset
    const issue = await svcRpc("admin_issue_certificate", {
      p_actor_user_id: STAFF_EXAM_DEMO_ID,
      p_enrollment_id: E9D7_ENROLLMENT_ID,
      p_request_id: crypto.randomUUID(),
    });
    expect(issue.status, issue.text.slice(0, 300)).toBe(200);
    const issued = issue.json as { id: string; cert_no: string; verify_code: string };
    const reissue = await svcRpc("admin_reissue_certificate", {
      p_actor_user_id: STAFF_EXAM_DEMO_ID,
      p_certificate_id: issued.id,
      p_request_id: crypto.randomUUID(),
    });
    expect(reissue.status, reissue.text.slice(0, 300)).toBe(200);
    const reissued = reissue.json as { id: string; cert_no: string; verify_code: string };
    supersededCert = { id: issued.id, cert_no: issued.cert_no };
    validCert = { id: reissued.id, cert_no: reissued.cert_no, verify_code: reissued.verify_code };
    expect(validCert.id).not.toBe(supersededCert.id);
  }, 180_000);

  afterAll(async () => {
    await cleanupE9D7World();
  });

  // ─── 1) paper view: คีย์ type ของข้อสอบ (0022) ──────────────────────────────

  it("paper view: snapshot ใหม่คืนคีย์ type ตาม snapshot ('single_choice') — ตัวเลือกยังเหลือ {id,text} เท่านั้น", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/learner_attempt_paper_view?attempt_id=eq.${E9D7_PAPER_ATTEMPT_ID}` +
        `&select=attempt_id,question_id,seq,question_paper&order=seq.asc`,
      { apiKey: ANON_KEY, token: user.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as PaperRow[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    const typed = rows.find((row) => row.question_id === SEED_Q1);
    expect(typed, "แถวของโจทย์ seed ข้อ 1").toBeDefined();
    expect(typed?.question_paper.type).toBe("single_choice");
    // โครง question_paper: มี type — ยังคงตัด 'points' ระดับบน (แบบแผน 0019)
    expect(Object.keys(typed?.question_paper ?? {})).not.toContain("points");
    expect(
      typed?.question_paper.options.every((option) => {
        return Object.keys(option).sort().join(",") === "id,text";
      }),
    ).toBe(true);
  });

  it("paper view: snapshot เก่าที่ไม่มีคีย์ type → คืน default 'multiple_choice' (coalesce ของ view 0022)", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/learner_attempt_paper_view?attempt_id=eq.${E9D7_PAPER_ATTEMPT_ID}` +
        `&select=attempt_id,question_id,seq,question_paper&order=seq.asc`,
      { apiKey: ANON_KEY, token: user.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as PaperRow[];
    const legacy = rows.find((row) => row.question_id === SEED_Q2);
    expect(legacy, "แถวของโจทย์ seed ข้อ 2").toBeDefined();
    expect(legacy?.question_paper.type).toBe("multiple_choice");
  });

  // ─── 2) admin_list_certificates: ฟิลด์ + ลำดับเสถียร desc ────────────────────

  it("list: คืนใบของผู้ถือครบทุกฟิลด์ตาม returns table — ลำดับเสถียร tuple (issued_at desc, id desc)", async () => {
    const rows = await listCerts({ p_holder_user_id: user.id, p_limit: 101 });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set([validCert.id, supersededCert.id]),
    );
    // ลำดับ tuple (issued_at desc, id desc) — เทียบกับ comparator อ้างอิงในไฟล์นี้
    const sorted = [...rows].sort(byIssuedDescIdDesc);
    expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
    // ฟิลด์ snapshot ตามใบจริง
    for (const row of rows) {
      expect(row.user_id).toBe(user.id);
      expect(row.holder_name).toBe("ทดสอบ รายใบอี9");
      expect(row.course_id).toBe(E9D7_COURSE_ID);
      expect(row.course_title).toBe("หลักสูตรทดสอบ DCR-7 (integration)");
      expect(row.cert_no).toMatch(/^LTC-\d{4}-\d{6}$/);
      expect(row.verify_code).toMatch(/^[0-9A-Za-z_-]{43}$/);
      expect(row.issued_at.length).toBeGreaterThan(0);
    }
    // สถานะต่อใบ: ใบเดิมถูก supersede — ใบใหม่จาก reissue ยัง valid
    expect(rows.find((row) => row.status === "superseded")?.id).toBe(supersededCert.id);
    expect(rows.find((row) => row.status === "valid")?.id).toBe(validCert.id);
  });

  it("list keyset: p_after_issued_at/p_after_id แบ่งหน้าด้วย tuple cursor — หน้าถัดไปเก่ากว่าเสมอ ไม่ซ้ำ ไม่หวนคืน", async () => {
    // หน้าแรก limit 1 = ใบใหม่สุดตามลำดับ (issued_at desc, id desc)
    const page1 = await listCerts({ p_holder_user_id: user.id, p_limit: 1 });
    expect(page1.map((row) => row.id)).toEqual([validCert.id]);
    const cursor1 = page1[0];
    expect(cursor1).toBeDefined();
    // หน้าถัดไปจาก cursor → ใบเก่ากว่าพอดี 1 ใบ ไม่ซ้ำหน้าแรก
    const page2 = await listCerts({
      p_holder_user_id: user.id,
      p_after_issued_at: cursor1?.issued_at,
      p_after_id: cursor1?.id,
      p_limit: 1,
    });
    expect(page2.map((row) => row.id)).toEqual([supersededCert.id]);
    const cursor2 = page2[0];
    expect(cursor2).toBeDefined();
    // ตรวจ tuple อย่างเคร่งครัด: cursor1 ต้องมาก่อน cursor2 ในลำดับ desc (cursor2 เก่ากว่า)
    expect(byIssuedDescIdDesc(cursor1 as CertListRow, cursor2 as CertListRow)).toBe(-1);
    // หน้าสุดท้ายจาก cursor ท้ายสุด → ว่างเปล่า (จบสตรีม — ไม่หวนคืน)
    const page3 = await listCerts({
      p_holder_user_id: user.id,
      p_after_issued_at: cursor2?.issued_at,
      p_after_id: cursor2?.id,
      p_limit: 1,
    });
    expect(page3).toHaveLength(0);
  });

  it("list filters + clamp: status/cert_no(นำหน้า)/verify_code/course_id ตรงเป้า และ p_limit 0→1 แถว 1000→ไม่เกิน 101", async () => {
    // ตัวกรองสถานะ
    const validRows = await listCerts({ p_holder_user_id: user.id, p_status: "valid" });
    expect(validRows.map((row) => row.id)).toEqual([validCert.id]);
    const supersededRows = await listCerts({ p_holder_user_id: user.id, p_status: "superseded" });
    expect(supersededRows.map((row) => row.id)).toEqual([supersededCert.id]);
    // cert_no แบบนำหน้า (ilike prefix) — ใบ valid ของเราเอง
    const byCertNo = await listCerts({ p_holder_user_id: user.id, p_cert_no: validCert.cert_no });
    expect(byCertNo.map((row) => row.id)).toEqual([validCert.id]);
    // verify_code ตรงตัว
    const byVerifyCode = await listCerts({
      p_holder_user_id: user.id,
      p_verify_code: validCert.verify_code,
    });
    expect(byVerifyCode.map((row) => row.id)).toEqual([validCert.id]);
    // course_id: ครอบทั้งคู่ / หลักสูตรอื่น (seed LTC-103) ต้องไม่เจอใบของชุดนี้
    const inCourse = await listCerts({ p_holder_user_id: user.id, p_course_id: E9D7_COURSE_ID });
    expect(inCourse).toHaveLength(2);
    const otherCourse = await listCerts({
      p_holder_user_id: user.id,
      p_course_id: SEED_COURSE3_ID,
    });
    expect(otherCourse).toHaveLength(0);
    // clamp: p_limit 0 → 1 แถว (greatest(...,1)) · p_limit 1000 → ไม่เกินเพดาน 101
    const zeroLimit = await listCerts({ p_holder_user_id: user.id, p_limit: 0 });
    expect(zeroLimit).toHaveLength(1);
    const hugeLimit = await listCerts({ p_limit: 1000 });
    expect(hugeLimit.length).toBeGreaterThan(0);
    expect(hugeLimit.length).toBeLessThanOrEqual(101);
  });

  // ─── 3) โลกใบ 102 ใบ: clamp ครอบจริง + prefix ตัดจริง + keyset tie ของ id (m2 ของ gate r1) ──

  /** หว่านโลกใบ 102 ใบ **แบบขี้เกียจใน test แรกของชุดนี้** (ไม่ยุ่งกับตัวเลข 2 ใบของ
   *  test ก่อนหน้า): ใบ insert ตรง (ไม่ผ่าน RPC) ในคำสั่งเดียว → issued_at เดียวกัน
   *  ทั้ง 102 ใบพอดี = วัตถุดิบของการพิสูจน์ tie-break ด้วย id · enrollment ของโลกนี้
   *  ตั้ง deleted_at เพื่อไม่ชน uq_enrollments_user_course_active (partial เฉพาะ
   *  แถวที่ยังมีชีวิต) และใบตรึง id ตายตัวเพื่อ assert ลำดับได้เป๊ะ */
  async function seedBigCertWorld(): Promise<void> {
    await psql(`
      insert into public.courses
        (id, code, category_id, created_by, title_th, is_public, status, published_at)
      values
        ('${E9D7_BIG_COURSE_ID}', 'E9-DCR7-BIG',
         (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
         'หลักสูตรทดสอบ DCR-7 คิวใหญ่ (integration)', false, 'published', now())
      on conflict (id) do nothing;
      insert into public.enrollments
        (id, user_id, course_id, status, completed_at, deleted_at)
      select ('88888888-8888-4888-8888-0000000f' || lpad(gs::text, 4, '0'))::uuid,
             (select id from auth.users where email like 'e9-dcr7-%' limit 1),
             '${E9D7_BIG_COURSE_ID}', 'completed', now() - interval '1 hour', now()
        from generate_series(1, 102) gs
      on conflict (id) do nothing;
      insert into public.certificates
        (id, cert_no, verify_code, enrollment_id, user_id, course_id, holder_name_snapshot,
         course_title_snapshot, issued_by, issued_at, status)
      select ('99999999-9999-4999-8999-0000000e' || lpad(gs::text, 4, '0'))::uuid,
             'LTC-2099-' || lpad(gs::text, 6, '0'),
             rpad('e9d7big' || lpad(gs::text, 4, '0') || '-', 43, 'x'),
             ('88888888-8888-4888-8888-0000000f' || lpad(gs::text, 4, '0'))::uuid,
             (select id from auth.users where email like 'e9-dcr7-%' limit 1),
             '${E9D7_BIG_COURSE_ID}', 'ทดสอบ คิวใหญ่อี9',
             'หลักสูตรทดสอบ DCR-7 คิวใหญ่ (integration)',
             '${STAFF_EXAM_DEMO_ID}', now(), 'valid'
        from generate_series(1, 102) gs
      on conflict (id) do nothing;
    `);
  }

  it("list clamp ครอบจริง (m2): ผู้ถือมี 104 ใบ + p_limit 1000 → ตัดเหลือ 101 พอดี · prefix cert_no ตัดจริงแยกโลกได้", async () => {
    await seedBigCertWorld(); // โลกใบ 102 ใบเกิดหลัง test ก่อนหน้าทั้งหมด (ตัวเลขเดิมไม่กระทบ)

    // holder มี 104 ใบจริง (102 ของโลกใหญ่ + valid + superseded) — clamp 101 ตัดจริง:
    // แถวที่หายไปต้องเป็น "ท้ายลำดับ" ยิ่งกว่า (โลกใบใบเล็กสุด + ใบ RPC ทั้งสอง)
    const rows = await listCerts({ p_holder_user_id: user.id, p_limit: 1000 });
    expect(rows).toHaveLength(101);
    const sorted = [...rows].sort(byIssuedDescIdDesc);
    expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
    expect(rows.some((row) => row.id === bigCertId(1))).toBe(false); // ท้ายสุดของโลกใบถูกตัด
    expect(rows[0]?.id).toBe(bigCertId(102)); // หัวลำดับ = id มากสุด (issued_at ใหม่สุด)

    // prefix แบบ "ตัดจริง" ไม่ใช่เลขเต็ม (ข้อ m2): 8 ตัวแรก match ทั้งโลกใบ 102 → clamp 101
    const prefixed = await listCerts({ p_holder_user_id: user.id, p_cert_no: "LTC-2099", p_limit: 1000 });
    expect(prefixed).toHaveLength(101);
    for (const row of prefixed) {
      expect(row.cert_no.startsWith("LTC-2099-")).toBe(true);
    }

    // prefix ลึกถึงเลขท้าย: 'LTC-2099-00010' → เจอเฉพาะ 000100-000102 พอดี 3 ใบ
    const subset = await listCerts({ p_holder_user_id: user.id, p_cert_no: "LTC-2099-00010" });
    expect(subset.map((row) => row.cert_no).sort()).toEqual([
      "LTC-2099-000100",
      "LTC-2099-000101",
      "LTC-2099-000102",
    ]);
  }, 120_000);

  it("list keyset tie (m2): issued_at เท่ากันทั้งคิว — cursor tuple ตัดสินด้วย id desc ล้วน ไม่หวนคืน", async () => {
    // โลกใบ 102 ใบถูก insert ด้วยคำสั่งเดียว → issued_at ซ้ำกันทั้งหมด (พิสูจน์จากแถวจริง)
    const all = await listCerts({ p_holder_user_id: user.id, p_cert_no: "LTC-2099", p_limit: 1000 });
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all.map((row) => row.issued_at)).size).toBe(1);

    // หน้าละ 1: หน้าแรก = id มากสุด · หน้าถัดไปจาก cursor (issued_at เท่ากัน!) ต้องได้
    // id รองลงมา — ถ้า keyset เทียบเฉพาะ issued_at (ไม่ใช่ tuple) เคอร์เซอร์นี้จะไป
    // ไม่ถึงแถวไหนเลย (ไม่มีแถวที่เก่ากว่า) = พังตรงนี้พอดี
    const page1 = await listCerts({ p_holder_user_id: user.id, p_cert_no: "LTC-2099", p_limit: 1 });
    expect(page1[0]?.id).toBe(bigCertId(102));
    const page2 = await listCerts({
      p_holder_user_id: user.id,
      p_cert_no: "LTC-2099",
      p_after_issued_at: page1[0]?.issued_at,
      p_after_id: page1[0]?.id,
      p_limit: 1,
    });
    expect(page2[0]?.id).toBe(bigCertId(101));
    expect(page2[0]?.cert_no).toBe("LTC-2099-000101");
    // ทิศทาง: แถวถัดไป "เก่ากว่า" ตาม tuple — issued_at เท่ากันจึงคือ id น้อยกว่า
    expect(byIssuedDescIdDesc(page1[0] as CertListRow, page2[0] as CertListRow)).toBe(-1);
  });
});

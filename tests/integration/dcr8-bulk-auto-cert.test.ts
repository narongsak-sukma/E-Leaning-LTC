/**
 * DCR-8 — integration tests ของ Wave E Phase 2 บน dev stack จริง (แบบ suite เดิม):
 *   1) ออกใบประกาศนียบัตรเป็นชุด (bulk) — RPC admin_cert_bulk_issue_run(job_id, request_id)
 *      ของ migration 0026 ทำงานบน job ใน cert_bulk_jobs (0023): วน admin_cert_bulk_pick
 *      ชุดละ 200 ออกใบผ่าน cert_issue_core(actor = ผู้สร้าง job, mode 'bulk') ต่อใบใต้
 *      savepoint — ใบใดล้มยกเลิกเฉพาะใบนั้น (TX ต่อใบ · D55-5)
 *   2) ออกใบอัตโนมัติ (CRT-008 · D55-7) — cert_auto_issue_tick(): อ่าน flag
 *      feature_flags.key='cert_auto_issue' (ปิด = skip ไม่ audit) → หยิบ passed-no-valid-cert
 *      ทุกหลักสูตร → ออกใบ mode 'auto' actor = โปรไฟล์ระบบ a170 · idempotent (รอบสองได้ 0)
 *
 * ข้อควรระวังของชุดนี้ (กติกาทีม): dev DB มี cron `ltc-cert-auto-issue` รันจริงทุก 2 นาที
 *   - test ที่แตะ feature_flags เปิด flag ภายใน try และปิดคืน (false) ใน finally เสมอ
 *   - fixture ทั้งชุดใช้ id ตายตัวของตัวเอง + หลักสูตรของตัวเอง (ไม่แชร์ seed/หลักสูตรอื่น)
 *     เพื่อให้ pick ของ job (scoped ตาม course_id) ไม่หยิบแถวของชุดอื่น และล้างคืนได้ครบ
 *     — ชุด bulk กับชุด auto แยกหลักสูตรกันเด็ดขาด (job ของ bulk หยิบชุด auto ไม่ได้
 *     และ tick รอบแรกจึงเจอเฉพาะชุด auto พอดี 2 คน) · ชุดพิสูจน์ "TX ต่อใบ" ของ bulk
 *     (ออกได้ 1 + ล้ม 1 ไม่ฆ่าทั้ง job) ก็แยกหลักสูตรของตัวเองเช่นกัน
 *   - audit_logs เป็น append-only (ห้ามลบตามดีไซน์) — ไม่ล้าง แต่ cert ใหม่แต่ละรอบรัน
 *     ได้ id ใหม่ จึง assert จำนวนแบบเป๊ะได้ทุกรอบ
 *
 * หมายเหตุ: เดิมเส้นทาง per-cert failure ใช้จริงไม่ได้เพราะบั๊ก `sqlerrm()` ของ 0026
 *   (42883 — รายงาน lead แล้วแก้เป็นตัวแปร SQLERRM ใน D59/ea38a01) — ชุดนี้จึงครอบ
 *   เส้นทาง "ใบล้มเฉพาะใบไม่ฆ่าทั้ง job" ได้จริงแล้ว (fixture ผู้ถือชื่อว่างในหลักสูตรแยก)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql, psqlRows, restCall, SERVICE_KEY, type RestResult } from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── ชนิดข้อมูลของ response ที่ assert ─────────────────────────────────────────

/** สัญญา jsonb ของ admin_cert_bulk_issue_run (0026 — jsonb_build_object ตรงชุดนี้) */
interface BulkRunResult {
  readonly job_id: string;
  readonly status: string;
  readonly issued_count: number;
  readonly failed_count: number;
  readonly total_attempts: number;
}

/** สัญญา jsonb ของ cert_auto_issue_tick — 2 รูปแบบ (skip / ออกใบ) */
interface TickResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly issued_count?: number;
  readonly failed_count?: number;
}

// ─── id อ้างอิงของ seed (supabase/seed.sql) — อ่านอย่างเดียว ไม่แตะ ─────────────

/** ข้อสอบปลายหลักสูตรจริงของ seed (fixture ยื่น attempt "ผ่าน" บนรอบสอบนี้โดยตรงผ่าน SQL) */
const SEED_EXAM_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
/** กติกาเวอร์ชัน 1 ของข้อสอบ seed (assessment_rules ที่มีผล ณ ตอนนี้) */
const SEED_RULES_ID = "dddddddd-dddd-4ddd-8ddd-000000000001";
/** actor ระบบของโหมด auto — โปรไฟล์ที่ 0026 (0) สร้าง: 'ระบบออกใบอัตโนมัติ (CRT-008)' */
const AUTO_ACTOR_ID = "00000000-0000-4000-8000-00000000a170";

// ─── id ตายตัวของ fixture ชุด DCR-8 (ล้างซ้ำได้ — ไม่ชน seed/ชุดอื่น) ──────────

/** หลักสูตรของชุด bulk — แยกจาก seed เพื่อให้ pick ของ job (course-scoped) ครอบเฉพาะ fixture */
const E9_COURSE_ID = "99999999-9999-4999-8999-00000000e901";
/** หลักสูตรที่สองของชุด auto — แยกออกจาก bulk เพื่อให้ pick ของ job 2 (course-scoped)
 *  เห็นเฉพาะชุด bulk และ tick ที่ pick ทุกหลักสูตรเจอเฉพาะชุด auto พอดีตามสัญญา */
const E9_COURSE2_ID = "99999999-9999-4999-8999-00000000e902";
/** หลักสูตรที่สามของชุดพิสูจน์ "TX ต่อใบ" — แยกออกจาก job 1 จึงไม่เปลี่ยนสัญญาออก 2 ใบสำเร็จ */
const E9_COURSE3_ID = "99999999-9999-4999-8999-00000000e903";
/** profile staff ของชุด — ผู้สร้าง job (cert_bulk_jobs.created_by) = actor ของใบที่ออกแบบ bulk */
const E9_STAFF_ID = "11111111-1111-4111-8111-00000000e901";
/** job แรก (ออกใบจริง) และ job ที่สอง (พิสูจน์ anti-join — คิวว่าง) */
const E9_JOB1_ID = "dd000000-0000-4000-8000-00000000e901";
const E9_JOB2_ID = "dd000000-0000-4000-8000-00000000e902";
/** job ที่สาม (พิสูจน์ TX ต่อใบ — คิวมีทั้งคนออกได้และคนล้มตายตัว) */
const E9_JOB3_ID = "dd000000-0000-4000-8000-00000000e903";

interface E9Person {
  readonly course: string;
  readonly profile: string;
  readonly enrollment: string;
  readonly attempt: string;
  readonly display: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly emailLocal: string;
}

/** สร้าง id ตายตัวของคนที่ n (1..6) — profile/enrollment/attempt แยกกลุ่ม uuid ไม่ทับกัน */
function person(
  n: number,
  display: string,
  firstName: string | null,
  lastName: string | null,
  course: string,
): E9Person {
  const suffix = `e90${n}`; // กลุ่มสุดท้ายของ uuid ต้องยาว 12 อักขระ
  return {
    course,
    profile: `22222222-2222-4222-8222-00000000${suffix}`,
    enrollment: `bb000000-0000-4000-8000-00000000${suffix}`,
    attempt: `aa000000-0000-4000-8000-00000000${suffix}`,
    display,
    firstName,
    lastName,
    emailLocal: `e9-dcr8-${n}`,
  };
}

/**
 * ผู้เรียน fixture 6 คน (แยกหลักสูตรชุดตัวเองเด็ดขาด เพื่อความ deterministic ของ pick):
 *   1-2 = ชุด bulk (หลักสูตร 1) — ชื่อครบ → job 1 ออกใบได้ 2 ใบ
 *   3   = ชุดพิสูจน์ TX ต่อใบ (หลักสูตร 3) — ชื่อว่าง → ใบล้ม (holder_name_missing)
 *   6   = คู่ของชุด TX ต่อใบ (หลักสูตร 3 เดียวกับคน 3) — ชื่อครบ → ออกได้ ใบเดียว
 *   4-5 = ชุด auto (หลักสูตร 2 — แยกหลักสูตรตาม task) — ใช้ทดสอบ tick หลังจบชุด bulk
 */
const PEOPLE: readonly E9Person[] = [
  person(1, "ผู้เรียนทดสอบ DCR-8 หนึ่ง", "สมชายทดสอบ", "ใจดีหนึ่ง", E9_COURSE_ID),
  person(2, "ผู้เรียนทดสอบ DCR-8 สอง", "สมหญิงทดสอบ", "ใจงามสอง", E9_COURSE_ID),
  person(3, "", null, null, E9_COURSE3_ID),
  person(6, "ผู้เรียนทดสอบ DCR-8 หก", "สมรทดสอบ", "ใจซื่อหก", E9_COURSE3_ID),
  person(4, "ผู้เรียนอัตโนมัติหนึ่ง", "อัตโนมัติทดสอบ", "หนึ่ง", E9_COURSE2_ID),
  person(5, "ผู้เรียนอัตโนมัติสอง", "อัตโนมัติทดสอบ", "สอง", E9_COURSE2_ID),
];

const BULK_OK = PEOPLE.slice(0, 2); // ชุด bulk — ออกใบได้
const FAIL_PAIR = PEOPLE.slice(2, 4); // ชุด TX ต่อใบ (หลักสูตร 3): คน 3 ล้ม (ชื่อว่าง) + คน 6 ออกได้
const FAIL_NAMELESS = PEOPLE.slice(2, 3); // ตัวที่ล้มของชุด TX ต่อใบ (ชื่อว่าง)
const FAIL_NAMED = PEOPLE.slice(3, 4); // ตัวที่ออกได้ของชุด TX ต่อใบ (ชื่อครบ)
const AUTO_SET = PEOPLE.slice(4); // ชุดของโหมด auto (หลักสูตร 2 — แยกตามที่ task กำหนด)

// ─── helper ของไฟล์นี้ (duplicate เล็ก ๆ ตามกติกา — ไม่แก้ helpers เดิม) ────────

/** เรียก RPC ของบทบาท service_role ผ่าน REST (ทางเดียวที่ชุดเข้าถึง RPC เหล่านี้ได้ ตาม 0019/0026) */
function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/** error message ที่ PostgREST คืน (raise exception → ข้อความไทย + รหัส ERR-...) */
function errMessage(json: unknown): string {
  const body = (json ?? {}) as { message?: string };
  return body.message ?? "";
}

/**
 * เว้นรอบ cron: jobname `ltc-cert-auto-issue` ยิงทุก 2 นาที (นาทีคู่ตามเวลา UTC ของ container)
 * ถ้า boundary คู่ถัดไปใกล้กว่า 10 วินาที ให้หน่วงพ้น boundary ไป 5 วินาที — กัน cron
 * แย่งออกใบก่อน tick ของ test (ไม่งั้นตัวเลข issued_count ของรอบแรกอาจเพี้ยน)
 */
async function avoidCronBoundary(): Promise<void> {
  const now = Date.now();
  const minuteStart = now - (now % 60_000);
  for (let i = 1; i <= 3; i += 1) {
    const boundary = minuteStart + i * 60_000;
    const distance = boundary - now;
    if (new Date(boundary).getUTCMinutes() % 2 === 0 && distance < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, distance + 5_000));
      return;
    }
  }
}

/** ล้างโลกของชุด DCR-8 ทั้งหมด (เรียงตาม FK — RESTRICT) + ปิด flag ทิ้งเป็นสถานะปลอดภัย */
async function cleanupE9Dcr8World(): Promise<void> {
  const enrollmentList = PEOPLE.map((p) => `'${p.enrollment}'`).join(",");
  const attemptList = PEOPLE.map((p) => `'${p.attempt}'`).join(",");
  const profileList = [`'${E9_STAFF_ID}'`, ...PEOPLE.map((p) => `'${p.profile}'`)].join(",");
  await psql(`
    -- cron ltc-cert-auto-issue รันจริงทุก 2 นาที — flag ต้องจบเป็น false เสมอ
    update public.feature_flags set enabled = false where key = 'cert_auto_issue';
    delete from public.certificate_verifications
     where verify_code in (select c.verify_code from public.certificates c
                            where enrollment_id in (${enrollmentList}));
    delete from public.certificates where enrollment_id in (${enrollmentList});
    delete from public.cert_bulk_jobs where id in ('${E9_JOB1_ID}', '${E9_JOB2_ID}', '${E9_JOB3_ID}');
    delete from public.assessment_attempts where id in (${attemptList});
    delete from public.enrollments where id in (${enrollmentList});
    -- หลักสูตรทั้งสามต้องลบก่อนโปรไฟล์ staff (FK courses.created_by → profiles — RESTRICT)
    delete from public.courses where id in ('${E9_COURSE_ID}', '${E9_COURSE2_ID}', '${E9_COURSE3_ID}');
    delete from public.profiles where id in (${profileList});
  `);
}

/** หว่าน fixture ของชุด: หลักสูตร + โปรไฟล์ + enrollment completed + attempt "ผ่าน" (SQL ตรง) */
async function seedE9Dcr8Fixtures(): Promise<void> {
  // โปรไฟล์มาก่อนหลักสูตร (FK courses.created_by → profiles — ตรวจทันที ไม่ deferred)
  await psql(`
    -- โปรไฟล์ staff = ผู้สร้าง job (created_by) → actor ของใบที่ออกแบบ bulk
    insert into public.profiles
      (id, display_name, first_name, last_name, email, preferred_locale)
    values
      ('${E9_STAFF_ID}', 'ผู้ดูแลทดสอบ DCR-8', 'ผู้ดูแลทดสอบ', 'อี9', 'e9-dcr8-staff@ltc.test', 'th')
    on conflict (id) do nothing;
    insert into public.profiles
      (id, display_name, first_name, last_name, email, preferred_locale)
    values ${PEOPLE.map(
      (p) =>
        `('${p.profile}', '${p.display}', ${p.firstName === null ? "null" : `'${p.firstName}'`}, ` +
        `${p.lastName === null ? "null" : `'${p.lastName}'`}, '${p.emailLocal}@ltc.test', 'th')`,
    ).join(",\n        ")}
    on conflict (id) do nothing;
  `);
  await psql(`
    insert into public.courses
      (id, code, category_id, created_by, title_th, is_public, status, published_at)
    values
      ('${E9_COURSE_ID}', 'E9-DCR8-T',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 (integration)', false, 'published', now()),
      ('${E9_COURSE2_ID}', 'E9-DCR8-A',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 ชุดอัตโนมัติ (integration)', false, 'published', now()),
      ('${E9_COURSE3_ID}', 'E9-DCR8-F',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 ชุดใบล้ม (integration)', false, 'published', now())
    on conflict (id) do nothing;
    -- job 3 แถว (pending) — admin_cert_bulk_issue_run ต้องเจอ job ก่อนจึงรันได้
    -- (job 1-2 scoped หลักสูตร bulk · job 3 scoped หลักสูตรชุดใบล้ม — กัน pick ไขว้ชุด)
    insert into public.cert_bulk_jobs (id, created_by, course_id, status)
    values
      ('${E9_JOB1_ID}', '${E9_STAFF_ID}', '${E9_COURSE_ID}', 'pending'),
      ('${E9_JOB2_ID}', '${E9_STAFF_ID}', '${E9_COURSE_ID}', 'pending'),
      ('${E9_JOB3_ID}', '${E9_STAFF_ID}', '${E9_COURSE3_ID}', 'pending')
    on conflict (id) do nothing;
  `);
  for (const [index, p] of PEOPLE.entries()) {
    await psql(`
      insert into public.enrollments (id, user_id, course_id, status, completed_at)
      values ('${p.enrollment}', '${p.profile}', '${p.course}', 'completed',
              now() - interval '1 hour')
      on conflict (id) do nothing;
      insert into public.assessment_attempts
        (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
         lease_expires_at, started_at, expires_at, submitted_at, score_pct, passed,
         question_count, correct_count)
      values
        ('${p.attempt}', '${SEED_EXAM_ID}', '${p.profile}', '${p.enrollment}', '${SEED_RULES_ID}',
         1, 'passed', 'e9-dcr8-integration-session', now() - interval '2 hours',
         now() - interval '2 hours', now() + interval '1 hour',
         now() - interval '${120 - index * 5} minutes', 100, true, 5, 5)
      on conflict (id) do nothing;
    `);
  }
}

describe.skipIf(!DB_URL)("DCR-8 ออกใบประกาศนียบัตรเป็นชุด + อัตโนมัติ (bulk + CRT-008 บน DB จริง)", () => {
  beforeAll(async () => {
    await cleanupE9Dcr8World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
    await seedE9Dcr8Fixtures();
  }, 60_000);

  afterAll(async () => {
    await cleanupE9Dcr8World(); // รวมถึงบังคับ flag = false ครั้งสุดท้าย (safety net)
  });

  // ─── 1) bulk path: job ออกใบจริง ────────────────────────────────────────────

  it("bulk: admin_cert_bulk_issue_run ออกใบครบ 2 ใบ — สัญญา jsonb เป๊ะ + ใบ valid + audit mode='bulk' actor=ผู้สร้าง job", async () => {
    const result = await svcRpc("admin_cert_bulk_issue_run", {
      p_job_id: E9_JOB1_ID,
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as BulkRunResult;
    // สัญญา jsonb ของ 0026 — คีย์ตรงชุดนี้เท่านั้น (ไม่มีคีย์แปลกปลอม)
    expect(Object.keys(body).sort()).toEqual([
      "failed_count",
      "issued_count",
      "job_id",
      "status",
      "total_attempts",
    ]);
    expect(body.job_id).toBe(E9_JOB1_ID);
    expect(body.status).toBe("completed");
    expect(body.issued_count).toBe(2);
    expect(body.failed_count).toBe(0);
    expect(body.total_attempts).toBe(2);

    // แถว job: สถานะจบ + ความคืบหน้าครบ (ทุกใบออกสำเร็จ — last_error ต้องว่าง)
    const jobs = await psqlRows<{
      status: string;
      issued: number;
      failed: number;
      total: number;
      lastError: string;
      finishedAt: string | null;
      createdBy: string;
    }>(`
      select status::text, issued_count as issued, failed_count as failed,
             total_attempts as total, coalesce(last_error, '') as "lastError",
             finished_at::text as "finishedAt", created_by::text as "createdBy"
        from public.cert_bulk_jobs where id = '${E9_JOB1_ID}';
    `);
    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.issued).toBe(2);
    expect(jobs[0]?.failed).toBe(0);
    expect(jobs[0]?.total).toBe(2);
    expect(jobs[0]?.lastError).toBe("");
    expect(jobs[0]?.finishedAt).not.toBeNull();
    expect(jobs[0]?.createdBy).toBe(E9_STAFF_ID);

    // ใบ: valid ครบ 2 ใบ — issued_by = ผู้สร้าง job (ไม่ใช่คนอื่น) และไม่ supersedes ใบใด
    const okEnrollments = BULK_OK.map((p) => `'${p.enrollment}'`).join(",");
    const certs = await psqlRows<{
      id: string;
      enrollment: string;
      issuedBy: string;
      status: string;
      supersedes: string | null;
    }>(`
      select id::text, enrollment_id::text as enrollment, issued_by::text as "issuedBy",
             status::text, supersedes_cert_id::text as supersedes
        from public.certificates
       where enrollment_id in (${okEnrollments}) order by enrollment_id;
    `);
    expect(certs).toHaveLength(2);
    for (const cert of certs) {
      expect(cert.status).toBe("valid");
      expect(cert.issuedBy).toBe(E9_STAFF_ID);
      expect(cert.supersedes).toBeNull();
    }

    // audit: CERT_ISSUE 2 แถว (ใบละ 1) — context->>'mode'='bulk' + actor = ผู้สร้าง job
    const audit = await psqlRows<{ bulk: number; otherMode: number }>(`
      select count(*) filter (where context ->> 'mode' = 'bulk')::int as bulk,
             count(*) filter (where coalesce(context ->> 'mode', '') <> 'bulk')::int as "otherMode"
        from public.audit_logs
       where action = 'CERT_ISSUE'
         and entity_id in (select id from public.certificates
                            where enrollment_id in (${okEnrollments}))
         and actor_user_id = '${E9_STAFF_ID}';
    `);
    expect(audit[0]?.bulk).toBe(2);
    expect(audit[0]?.otherMode).toBe(0);
  });

  it("bulk: เรียกซ้ำ job เดิมหลังจบ → ปฏิเสธ ERR-VAL-001|bulk_job_already_finished", async () => {
    const result = await svcRpc("admin_cert_bulk_issue_run", {
      p_job_id: E9_JOB1_ID,
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    const message = errMessage(result.json);
    expect(message).toContain("ERR-VAL-001");
    expect(message).toContain("bulk_job_already_finished");
  });

  it("bulk: job ไม่มีอยู่จริง → ปฏิเสธ ERR-NF-001|bulk_job_not_found", async () => {
    const result = await svcRpc("admin_cert_bulk_issue_run", {
      p_job_id: crypto.randomUUID(),
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    const message = errMessage(result.json);
    expect(message).toContain("ERR-NF-001");
    expect(message).toContain("bulk_job_not_found");
  });

  it("bulk: คิวออกครบแล้ว — job ใหม่ได้ issued_count=0 (anti-join กันออกซ้ำ) + ใบรวมยังเป็น 2", async () => {
    // คิวของ job 2 (scoped หลักสูตร bulk) ว่างตามฐาน: คน 1-2 มีใบ valid แล้ว (anti-join
    // ตัดออก) ส่วนชุด auto อยู่หลักสูตร 2 ที่ pick ของ job หยิบไม่ถึง — ไม่ต้องลบแถวใดเพิ่ม
    const result = await svcRpc("admin_cert_bulk_issue_run", {
      p_job_id: E9_JOB2_ID,
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as BulkRunResult;
    expect(Object.keys(body).sort()).toEqual([
      "failed_count",
      "issued_count",
      "job_id",
      "status",
      "total_attempts",
    ]);
    expect(body.job_id).toBe(E9_JOB2_ID);
    expect(body.status).toBe("completed");
    expect(body.issued_count).toBe(0);
    expect(body.failed_count).toBe(0);
    expect(body.total_attempts).toBe(0);
    // ใบ valid รวมของชุด bulk ยังเป็น 2 — ไม่มีการออกซ้ำเพิ่ม
    const certs = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificates
       where enrollment_id in (${BULK_OK.map((p) => `'${p.enrollment}'`).join(",")})
         and status = 'valid';
    `);
    expect(certs[0]?.n).toBe(2);
  });

  it("bulk: ใบล้มเฉพาะใบไม่ฆ่าทั้ง job (TX ต่อใบ · D55-5) — ออกได้ 1 ล้ม 1 (ผู้ถือชื่อว่าง) job จบ completed", async () => {
    // คิวของ job 3 = หลักสูตรชุดใบล้ม: คนมีชื่อครบ 1 + ชื่อว่าง 1 → ต้องออกได้เฉพาะคนมีชื่อ
    // ส่วนคนชื่อว่างล้มด้วย holder_name_missing — ใบอื่นและสถานะ job ไม่กระทบ (TX ต่อใบ)
    const result = await svcRpc("admin_cert_bulk_issue_run", {
      p_job_id: E9_JOB3_ID,
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as BulkRunResult;
    expect(Object.keys(body).sort()).toEqual([
      "failed_count",
      "issued_count",
      "job_id",
      "status",
      "total_attempts",
    ]);
    expect(body.job_id).toBe(E9_JOB3_ID);
    expect(body.status).toBe("completed");
    expect(body.issued_count).toBe(1);
    expect(body.failed_count).toBe(1);
    expect(body.total_attempts).toBe(2);

    // แถว job: failed_count=1 + last_error ไม่ null (ข้อความไทยจริงของสาเหตุที่ใบล้ม)
    const jobs = await psqlRows<{
      status: string;
      issued: number;
      failed: number;
      total: number;
      lastError: string;
      finishedAt: string | null;
    }>(`
      select status::text, issued_count as issued, failed_count as failed,
             total_attempts as total, coalesce(last_error, '') as "lastError",
             finished_at::text as "finishedAt"
        from public.cert_bulk_jobs where id = '${E9_JOB3_ID}';
    `);
    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.issued).toBe(1);
    expect(jobs[0]?.failed).toBe(1);
    expect(jobs[0]?.total).toBe(2);
    expect(jobs[0]?.lastError).toContain("ข้อมูลไม่ถูกต้อง"); // ข้อความไทยของ raise จริง
    expect(jobs[0]?.lastError).toContain("ERR-VAL-001");
    expect(jobs[0]?.lastError).toContain("holder_name_missing");
    expect(jobs[0]?.finishedAt).not.toBeNull();

    // ใบ: valid เฉพาะคนมีชื่อ 1 ใบ — คนชื่อว่างไม่มีใบเกิดขึ้นเลย (rollback เฉพาะใบ)
    const named = FAIL_NAMED[0];
    const nameless = FAIL_NAMELESS[0];
    const certs = await psqlRows<{ enrollment: string; status: string; issuedBy: string }>(`
      select enrollment_id::text as enrollment, status::text, issued_by::text as "issuedBy"
        from public.certificates
       where enrollment_id in (${FAIL_PAIR.map((p) => `'${p.enrollment}'`).join(",")});
    `);
    expect(certs).toHaveLength(1);
    expect(certs[0]?.enrollment).toBe(named?.enrollment);
    expect(certs[0]?.status).toBe("valid");
    expect(certs[0]?.issuedBy).toBe(E9_STAFF_ID);
    const namelessCerts = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificates
       where enrollment_id = '${nameless?.enrollment ?? ""}';
    `);
    expect(namelessCerts[0]?.n).toBe(0);

    // audit: CERT_ISSUE mode='bulk' เฉพาะใบสำเร็จ แถวเดียว — ใบที่ล้มไม่มี audit ค้าง
    const audit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_ISSUE'
         and context ->> 'mode' = 'bulk'
         and actor_user_id = '${E9_STAFF_ID}'
         and (entity_id in (select id from public.certificates
                             where enrollment_id in (${FAIL_PAIR.map((p) => `'${p.enrollment}'`).join(",")})));
    `);
    expect(audit[0]?.n).toBe(1);

    // เก็บกวาดคิว: ตัดคนชื่อว่างออกจากฐาน — คิวที่เหลือของ test ถัด ๆ ไป (tick) จึง
    // deterministic (แถวชื่อว่างจะล้มตลอดทำ failed_count ของ tick ไม่เท่า 0)
    await psql(`
      delete from public.assessment_attempts where id = '${nameless?.attempt ?? ""}';
      delete from public.enrollments where id = '${nameless?.enrollment ?? ""}';
      delete from public.profiles where id = '${nameless?.profile ?? ""}';
    `);
  });

  // ─── 2) auto path (CRT-008): cert_auto_issue_tick + feature_flags ───────────

  it("auto: flag ปิด → tick ข้ามด้วย {skipped:true,reason:'flag_off'} — สัญญา jsonb คีย์ตรงชุด", async () => {
    // บังคับ flag ปิดก่อน (สถานะ baseline ปลอดภัย — cron ยิงจริงทุก 2 นาที)
    await psql(`update public.feature_flags set enabled = false where key = 'cert_auto_issue';`);
    const result = await svcRpc("cert_auto_issue_tick", {});
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as TickResult;
    expect(Object.keys(body).sort()).toEqual(["reason", "skipped"]);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("flag_off");
  });

  it("auto: เปิด flag → tick ออกใบให้ผู้ผ่านที่ยังไม่มี (fixture แยกชุด) mode='auto' actor=a170 · tick รอบสองได้ 0 · ปิด flag คืนใน finally", async () => {
    await avoidCronBoundary(); // เว้นระยะจากคาบ cron — กัน cron แย่งออกใบก่อน tick ของ test
    try {
      await psql(`update public.feature_flags set enabled = true where key = 'cert_auto_issue';`);

      // ── tick รอบแรก: คิวว่างตามฐาน (ชุด bulk ออกครบแล้ว) → หยิบเฉพาะ fixture อัตโนมัติ 2 คน
      const first = await svcRpc("cert_auto_issue_tick", {});
      expect(first.status, first.text.slice(0, 300)).toBe(200);
      const firstBody = first.json as TickResult;
      expect(Object.keys(firstBody).sort()).toEqual(["failed_count", "issued_count", "skipped"]);
      expect(firstBody.skipped).toBe(false);
      expect(firstBody.issued_count).toBe(2);
      expect(firstBody.failed_count).toBe(0);
      expect(firstBody.reason).toBeUndefined();

      // ใบ: fixture อัตโนมัติคนละ 1 ใบ valid — issued_by = โปรไฟล์ระบบ a170
      const autoEnrollments = AUTO_SET.map((p) => `'${p.enrollment}'`).join(",");
      const certs = await psqlRows<{ enrollment: string; n: number; issuedBy: string }>(`
        select e.id::text as enrollment, count(c.id)::int as n,
               min(c.issued_by::text) as "issuedBy"
          from public.enrollments e
          left join public.certificates c on c.enrollment_id = e.id and c.status = 'valid'
         where e.id in (${autoEnrollments})
         group by e.id order by e.id;
      `);
      expect(certs).toHaveLength(2);
      for (const row of certs) {
        expect(row.n).toBe(1);
        expect(row.issuedBy).toBe(AUTO_ACTOR_ID);
      }

      // audit: CERT_ISSUE 2 แถว — context->>'mode'='auto' + actor_user_id = a170
      const audit = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.audit_logs
         where action = 'CERT_ISSUE'
           and entity_id in (select id from public.certificates
                              where enrollment_id in (${autoEnrollments}))
           and context ->> 'mode' = 'auto'
           and actor_user_id = '${AUTO_ACTOR_ID}';
      `);
      expect(audit[0]?.n).toBe(2);

      // ── tick รอบสอง: คิวหมด → idempotent (issued_count=0) สัญญา jsonb คงเดิม
      const second = await svcRpc("cert_auto_issue_tick", {});
      expect(second.status, second.text.slice(0, 300)).toBe(200);
      const secondBody = second.json as TickResult;
      expect(Object.keys(secondBody).sort()).toEqual(["failed_count", "issued_count", "skipped"]);
      expect(secondBody.skipped).toBe(false);
      expect(secondBody.issued_count).toBe(0);
      expect(secondBody.failed_count).toBe(0);
    } finally {
      // กติกาเด็ดขาด: ปิด flag คืนเสมอ — แม้ assert ใดพังกลางทาง
      await psql(`update public.feature_flags set enabled = false where key = 'cert_auto_issue';`);
    }
  }, 120_000);
});

/**
 * DCR-8 — integration tests ของ Wave E Phase 2 บน dev stack จริง (โมเดล worker ของ 0027):
 *   1) ออกใบประกาศนียบัตรเป็นชุด (bulk) — procedure `admin_cert_bulk_issue_step(job, max, result)`
 *      ทำงานบน job ของ cert_bulk_jobs (0023): เดินคิวผ่าน admin_cert_bulk_pick ทีละแถวด้วย
 *      cursor (submitted_at, attempt_id) ออกใบผ่าน cert_issue_core(actor = ผู้สร้าง job,
 *      mode 'bulk') แล้ว **commit ต่อใบ** — ใบใดล้มยกเลิกเฉพาะใบนั้น ความคืบหน้าของ job
 *      ค้างจริงระหว่างทาง (M2) · แถวที่ล้มถูกเดินผ่าน ไม่ปิดกั้นคิว (M1)
 *   2) ออกใบอัตโนมัติ (CRT-008 · D55-7) — `cert_auto_issue_tick(course, max, result)`:
 *      อ่าน flag feature_flags.key='cert_auto_issue' (ปิด = skip ไม่ audit) → หยิบ
 *      passed-no-valid-cert **ตามขอบเขตหลักสูตรที่ระบุ** → ออกใบ mode 'auto' actor =
 *      โปรไฟล์ระบบ a170 · idempotent (รอบสองได้ 0)
 *
 * การเรียก procedure: PostgREST (REST) เรียก CALL ไม่ได้ — ชุดนี้ใช้ psql (supabase_admin
 *   superuser ตามสิทธิ์ EXECUTE ของ 0027) แล้ว JSON.parse ค่า inout p_result ที่ psql -At
 *   พิมพ์ออกมา · procedure raise exception = psql ล้ม (exit ≠ 0) โดย stderr มีข้อความ
 *   ไทย + รหัส ERR-... — ใช้ rejects.toThrow(ป้าย) ตรวจ
 *
 * ข้อควรระวังของชุดนี้ (กติกาทีม): dev DB มี cron จริงสองตัว (`ltc-cert-bulk-step` ทุก
 *   นาที · `ltc-cert-auto-issue` ทุก 2 นาที) — beforeAll **พักทั้งสองตัว** (cron.unschedule)
 *   และ afterAll ตั้งคืนตามนิยามเดิมของ 0027 ตัวอักษรเดียว เพื่อให้ตัวเลขของ test
 *   deterministic (worker จริงไม่แย่ง job/คิวของ fixture กลาง test)
 *   - test ที่แตะ feature_flags เปิด flag ภายใน try และปิดคืน (false) ใน finally เสมอ
 *   - fixture ทั้งชุดใช้ id ตายตัวของตัวเอง + หลักสูตรของตัวเอง (ไม่แชร์ seed/หลักสูตร
 *     อื่น) — tick ของ auto ส่งหลักสูตร fixture เอง = แตะเฉพาะขอบเขตตัวเองโดยก่อสร้าง
 *     (M3: แถวนอก fixture ใน DB ร่วมไม่ถูกออกใบ+audit โดย test)
 *   - audit_logs เป็น append-only (ห้ามลบตามดีไซน์) — ไม่ล้าง แต่ cert ใหม่แต่ละรอบรัน
 *     ได้ id ใหม่ จึง assert จำนวนแบบเป๊ะได้ทุกรอบ
 *
 * ชุด regression ของ gate r1 (0027):
 *   M1 กันแถวล้มปิดคิว — หลักสูตร 4 (bulk): คนชื่อว่าง 200 คนหน้าคิว + คนมีชื่อ 1 คน
 *      ท้ายคิว → job ต้องเดินผ่านคนล้มทั้ง 200 ออกใบคนท้ายได้ และจบ completed (แบบเดิม
 *      exit เมื่อทั้งชุดล้ม = คนท้ายตายทั้งชีวิต) · หลักสูตร 5 (auto): รูปเดียวกันแบบ 3+1
 *   M2 ความคืบหน้า durable + TX ต่อใบ — หลักสูตร 6: job 3 คนออกได้ เรียกด้วยเพดาน
 *      p_max_certs=2 → กลับมาเป็น status 'running' + ใบ 2 ใบกับ counts ค้างจริงแล้ว
 *      (มองเห็นจาก session อื่น) → เรียกซ้ำจบ completed 3 ไม่มีใบซ้ำ
 *   M3 scope ของ auto — assert ฝั่งชุดอัตโนมัติว่าโลกนอก fixture (หลักสูตร 4) ไม่มีใบ
 *      เกิดขึ้นระหว่าง flag เปิด
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql, psqlRows } from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── ชนิดข้อมูลของผล procedure ที่ assert ──────────────────────────────────────

/** สัญญา jsonb ของ admin_cert_bulk_issue_step (0027) — completed/running: 5 คีย์ ·
 *  idle/locked: { job_id, status } สองคีย์ */
interface StepResult {
  readonly job_id: string | null;
  readonly status: string;
  readonly issued_count?: number;
  readonly failed_count?: number;
  readonly total_attempts?: number;
}

/** สัญญา jsonb ของ cert_auto_issue_tick (0027) — 2 รูปแบบ (skip / ออกใบ) */
interface TickResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly issued_count?: number;
  readonly failed_count?: number;
}

// ─── id อ้างอิงของ seed (supabase/seed.sql) — อ่านอย่างเดียว ไม่แตะ ──────────────

/** ข้อสอบปลายหลักสูตรจริงของ seed (fixture ยื่น attempt "ผ่าน" บนรอบสอบนี้โดยตรงผ่าน SQL) */
const SEED_EXAM_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
/** กติกาเวอร์ชัน 1 ของข้อสอบ seed (assessment_rules ที่มีผล ณ ตอนนี้) */
const SEED_RULES_ID = "dddddddd-dddd-4ddd-8ddd-000000000001";
/** actor ระบบของโหมด auto — โปรไฟล์ที่ 0026 (0) สร้าง: 'ระบบออกใบอัตโนมัติ (CRT-008)' */
const AUTO_ACTOR_ID = "00000000-0000-4000-8000-00000000a170";

// ─── id ตายตัวของ fixture ชุด DCR-8 (ล้างซ้ำได้ — ไม่ชน seed/ชุดอื่น) ─────────────

/** หลักสูตร 1 ของชุด bulk — แยกจาก seed เพื่อให้ pick ของ job (course-scoped) ครอบเฉพาะ fixture */
const E9_COURSE_ID = "99999999-9999-4999-8999-00000000e901";
/** หลักสูตร 2 ของชุด auto — แยกออกจาก bulk ตาม task (tick แตะเฉพาะหลักสูตรนี้) */
const E9_COURSE2_ID = "99999999-9999-4999-8999-00000000e902";
/** หลักสูตร 3 ของชุดพิสูจน์ "TX ต่อใบ" — แยกออกจาก job 1 จึงไม่เปลี่ยนสัญญาออก 2 ใบสำเร็จ */
const E9_COURSE3_ID = "99999999-9999-4999-8999-00000000e903";
/** หลักสูตร 4 ของชุด M1 bulk — คนชื่อว่าง 200 (หน้าคิว) + คนมีชื่อ 1 (ท้ายคิว) */
const E9_COURSE4_ID = "99999999-9999-4999-8999-00000000e904";
/** หลักสูตร 5 ของชุด M1 auto — คนชื่อว่าง 3 (หน้าคิว) + คนมีชื่อ 1 (ท้ายคิว) */
const E9_COURSE5_ID = "99999999-9999-4999-8999-00000000e905";
/** หลักสูตร 6 ของชุด M2 — 3 คนออกได้ สำหรับพิสูจน์ stop ที่เพดาน/resume ไม่ซ้ำใบ */
const E9_COURSE6_ID = "99999999-9999-4999-8999-00000000e906";
/** profile staff ของชุด — ผู้สร้าง job (cert_bulk_jobs.created_by) = actor ของใบที่ออกแบบ bulk */
const E9_STAFF_ID = "11111111-1111-4111-8111-00000000e901";
/** งานทั้งห้า: 1 ออกใบจริง · 2 anti-join · 3 TX ต่อใบ · 4 M1 bulk · 5 M2 stop/resume */
const E9_JOB1_ID = "dd000000-0000-4000-8000-00000000e901";
const E9_JOB2_ID = "dd000000-0000-4000-8000-00000000e902";
const E9_JOB3_ID = "dd000000-0000-4000-8000-00000000e903";
const E9_JOB4_ID = "dd000000-0000-4000-8000-00000000e904";
const E9_JOB5_ID = "dd000000-0000-4000-8000-00000000e905";
/** หลักสูตรทั้งหกของ fixture (ใช้ใน cleanup แบบครอบทั้งโลกของชุด รวมแถว generate_series) */
const E9_COURSES = [
  E9_COURSE_ID,
  E9_COURSE2_ID,
  E9_COURSE3_ID,
  E9_COURSE4_ID,
  E9_COURSE5_ID,
  E9_COURSE6_ID,
] as const;

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

/** สร้าง id ตายตัวของคนที่ n (1..11) — profile/enrollment/attempt แยกกลุ่ม uuid ไม่ทับกัน */
function person(
  n: number,
  display: string,
  firstName: string | null,
  lastName: string | null,
  course: string,
): E9Person {
  const suffix = `e9${n.toString().padStart(2, "0")}`; // กลุ่มสุดท้ายของ uuid ต้องยาว 12 อักขระ
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
 * ผู้เรียน fixture ตามตัว (แยกหลักสูตรชุดตัวเองเด็ดขาด เพื่อความ deterministic ของ pick):
 *   1-2 = ชุด bulk (หลักสูตร 1) — ชื่อครบ → job 1 ออกใบได้ 2 ใบ
 *   3   = ชุดพิสูจน์ TX ต่อใบ (หลักสูตร 3) — ชื่อว่าง → ใบล้ม (holder_name_missing)
 *   6   = คู่ของชุด TX ต่อใบ (หลักสูตร 3 เดียวกับคน 3) — ชื่อครบ → ออกได้ ใบเดียว
 *   4-5 = ชุด auto (หลักสูตร 2) — tick แบบระบุหลักสูตรต้องออกพอดี 2 ใบ
 *   7-9 = ชุด M2 (หลักสูตร 6) — ชื่อครบ 3 คน สำหรับ stop ที่เพดาน 2 แล้ว resume
 *   10  = คนมีชื่อท้ายคิวของชุด M1 auto (หลักสูตร 5 — หน้าคิวเป็นคนชื่อว่าง 3 คน)
 *   11  = คนมีชื่อท้ายคิวของชุด M1 bulk (หลักสูตร 4 — หน้าคิวเป็นคนชื่อว่าง 200 คน)
 * (คนชื่อว่างจำนวนมากของ M1 สร้างด้วย generate_series ใน seedE9Dcr8Fixtures — id กลุ่ม
 *  33333333/44444444/55555555 + หลัก b=ชุด bulk, c=ชุด auto)
 */
const PEOPLE: readonly E9Person[] = [
  person(1, "ผู้เรียนทดสอบ DCR-8 หนึ่ง", "สมชายทดสอบ", "ใจดีหนึ่ง", E9_COURSE_ID),
  person(2, "ผู้เรียนทดสอบ DCR-8 สอง", "สมหญิงทดสอบ", "ใจงามสอง", E9_COURSE_ID),
  person(3, "", null, null, E9_COURSE3_ID),
  person(6, "ผู้เรียนทดสอบ DCR-8 หก", "สมรทดสอบ", "ใจซื่อหก", E9_COURSE3_ID),
  person(4, "ผู้เรียนอัตโนมัติหนึ่ง", "อัตโนมัติทดสอบ", "หนึ่ง", E9_COURSE2_ID),
  person(5, "ผู้เรียนอัตโนมัติสอง", "อัตโนมัติทดสอบ", "สอง", E9_COURSE2_ID),
  person(7, "ผู้เรียนทดสอบ DCR-8 เจ็ด", "สมเกียรติทดสอบ", "ใจสู้เจ็ด", E9_COURSE6_ID),
  person(8, "ผู้เรียนทดสอบ DCR-8 แปด", "สมศรีทดสอบ", "ใจแข็งแปด", E9_COURSE6_ID),
  person(9, "ผู้เรียนทดสอบ DCR-8 เก้า", "สมพรทดสอบ", "ใจเพชรเก้า", E9_COURSE6_ID),
  person(10, "ผู้เรียนเดินผ่านคิวอัตโนมัติ", "เดินผ่านทดสอบ", "ท้ายคิวสิบ", E9_COURSE5_ID),
  person(11, "ผู้เรียนเดินผ่านคิวชุดใหญ่", "เดินผ่านทดสอบ", "ท้ายคิวสิบเอ็ด", E9_COURSE4_ID),
];

const BULK_OK = PEOPLE.slice(0, 2); // ชุด bulk — ออกใบได้
const FAIL_PAIR = PEOPLE.slice(2, 4); // ชุด TX ต่อใบ (หลักสูตร 3): คน 3 ล้ม (ชื่อว่าง) + คน 6 ออกได้
const FAIL_NAMELESS = PEOPLE.slice(2, 3); // ตัวที่ล้มของชุด TX ต่อใบ (ชื่อว่าง)
const FAIL_NAMED = PEOPLE.slice(3, 4); // ตัวที่ออกได้ของชุด TX ต่อใบ (ชื่อครบ)
const AUTO_SET = PEOPLE.slice(4, 6); // ชุดของโหมด auto (หลักสูตร 2 — แยกตามที่ task กำหนด)
const M2_SET = PEOPLE.slice(6, 9); // ชุด stop/resume (หลักสูตร 6)
const M1A_NAMED = PEOPLE.slice(9, 10); // คนมีชื่อท้ายคิวของ M1 auto (หลักสูตร 5)
const M1B_NAMED = PEOPLE.slice(10, 11); // คนมีชื่อท้ายคิวของ M1 bulk (หลักสูตร 4)

// ─── helper ของไฟล์นี้ (duplicate เล็ก ๆ ตามกติกา — ไม่แก้ helpers เดิม) ─────────

/**
 * เรียก procedure ของ 0027 ผ่าน psql (PostgREST เรียก CALL ไม่ได้) — คืนค่า inout
 * p_result ที่ psql -At พิมพ์ (jsonb บรรทัดเดียว → JSON.parse) · procedure raise
 * exception = psql ล้มพร้อม stderr มีข้อความไทย + ป้าย ERR-...|reason
 */
async function callProc<T>(call: string): Promise<T> {
  const out = await psql(`${call};`);
  return JSON.parse(out.trim()) as T;
}

/** พัก cron ของ cert ทั้งสองตัวช่วงรัน suite — ไม่พักแล้ว worker จริง (ทุกนาที) จะ
 *  หยิบ job ของ fixture ไปรันก่อน call ของ test ทำตัวเลขไม่ deterministic · ตั้งคืน
 *  ใน afterAll ด้วยนิยามเดิมของ 0027 ตัวอักษรเดียว (idempotent — รันซ้ำได้) */
async function pauseCertCrons(): Promise<void> {
  await psql(`
    do $do$
    begin
      if exists (select 1 from cron.job where jobname = 'ltc-cert-bulk-step') then
        perform cron.unschedule('ltc-cert-bulk-step');
      end if;
      if exists (select 1 from cron.job where jobname = 'ltc-cert-auto-issue') then
        perform cron.unschedule('ltc-cert-auto-issue');
      end if;
    end
    $do$;
  `);
}

/** ตั้ง cron ของ cert คืนตามนิยามของ 0027 (คำสั่ง/คาบเดิมทุกตัวอักษร) — เฉพาะตัวที่หาย */
async function restoreCertCrons(): Promise<void> {
  await psql(`
    do $do$
    begin
      if not exists (select 1 from cron.job where jobname = 'ltc-cert-auto-issue') then
        perform cron.schedule('ltc-cert-auto-issue', '*/2 * * * *',
          'call public.cert_auto_issue_tick(null, 1000, null)');
      end if;
      if not exists (select 1 from cron.job where jobname = 'ltc-cert-bulk-step') then
        perform cron.schedule('ltc-cert-bulk-step', '* * * * *',
          'call public.admin_cert_bulk_issue_step(null, 1000, null)');
      end if;
    end
    $do$;
  `);
}

/** ล้างโลกของชุด DCR-8 ทั้งหมด (เรียงตาม FK — RESTRICT) + ปิด flag ทิ้งเป็นสถานะปลอดภัย
 *  ลบแบบครอบทั้งหลักสูตรของชุด (ครอบแถว generate_series ของ M1 ด้วย) */
async function cleanupE9Dcr8World(): Promise<void> {
  const courseList = E9_COURSES.map((c) => `'${c}'`).join(",");
  const profileList = [`'${E9_STAFF_ID}'`, ...PEOPLE.map((p) => `'${p.profile}'`)].join(",");
  await psql(`
    -- flag ต้องจบเป็น false เสมอ (cron จริงกลับมาทำงานหลัง afterAll)
    update public.feature_flags set enabled = false where key = 'cert_auto_issue';
    delete from public.certificate_verifications
     where verify_code in (select c.verify_code from public.certificates c
                            where enrollment_id in (select id from public.enrollments
                                                     where course_id in (${courseList})));
    delete from public.certificates
     where enrollment_id in (select id from public.enrollments where course_id in (${courseList}));
    delete from public.cert_bulk_jobs
     where id in ('${E9_JOB1_ID}', '${E9_JOB2_ID}', '${E9_JOB3_ID}', '${E9_JOB4_ID}', '${E9_JOB5_ID}');
    delete from public.assessment_attempts
     where enrollment_id in (select id from public.enrollments where course_id in (${courseList}));
    delete from public.enrollments where course_id in (${courseList});
    -- หลักสูตรทั้งหกต้องลบก่อนโปรไฟล์ staff (FK courses.created_by → profiles — RESTRICT)
    delete from public.courses where id in (${courseList});
    delete from public.profiles where id in (${profileList})
      or id::text like '33333333-3333-4333-8333-0000000%';
  `);
}

/**
 * หว่าน fixture ของชุด: หลักสูตร + โปรไฟล์ + enrollment completed + attempt "ผ่าน"
 * (SQL ตรง) + คนชื่อว่างของ M1 ด้วย generate_series · job ทั้งห้า seed ด้วย created_at
 * ไล่อายุ (เก่าสุดก่อน) เพื่อให้ "worker หยิบ job เก่าที่สุด" (step แบบไม่ระบุ job)
 * deterministic
 */
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
       'หลักสูตรทดสอบ DCR-8 ชุดใบล้ม (integration)', false, 'published', now()),
      ('${E9_COURSE4_ID}', 'E9-DCR8-M1B',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 เดินผ่านคิวชุดใหญ่ (integration)', false, 'published', now()),
      ('${E9_COURSE5_ID}', 'E9-DCR8-M1A',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 เดินผ่านคิวอัตโนมัติ (integration)', false, 'published', now()),
      ('${E9_COURSE6_ID}', 'E9-DCR8-M2',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 หยุดกลางทาง (integration)', false, 'published', now())
    on conflict (id) do nothing;
    -- job ห้าแถว (pending) ไล่อายุ created_at — step(null) หยิบเก่าที่สุดก่อนเสมอ
    -- (job 1-2 scoped หลักสูตร bulk · 3 หลักสูตรชุดใบล้ม · 4 ชุด M1 bulk · 5 ชุด M2)
    insert into public.cert_bulk_jobs (id, created_by, course_id, status, created_at)
    values
      ('${E9_JOB1_ID}', '${E9_STAFF_ID}', '${E9_COURSE_ID}', 'pending', now() - interval '60 minutes'),
      ('${E9_JOB2_ID}', '${E9_STAFF_ID}', '${E9_COURSE_ID}', 'pending', now() - interval '50 minutes'),
      ('${E9_JOB3_ID}', '${E9_STAFF_ID}', '${E9_COURSE3_ID}', 'pending', now() - interval '40 minutes'),
      ('${E9_JOB4_ID}', '${E9_STAFF_ID}', '${E9_COURSE4_ID}', 'pending', now() - interval '30 minutes'),
      ('${E9_JOB5_ID}', '${E9_STAFF_ID}', '${E9_COURSE6_ID}', 'pending', now() - interval '20 minutes')
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
  // ── M1 bulk (หลักสูตร 4): คนชื่อว่าง 200 คนหน้าคิว (submitted_at ใหม่กว่าคน 11
  //    ที่ seed ไว้ ~70 นาทีก่อน) — picker เรียง desc จึงเจอคนล้มทั้ง 200 ก่อนถึงคนออกได้
  await psql(`
    insert into public.profiles (id, display_name, first_name, last_name, email, preferred_locale)
    select ('33333333-3333-4333-8333-0000000b' || lpad(gs::text, 4, '0'))::uuid, '', null, null,
           'e9-m1-b-' || gs || '@ltc.test', 'th'
      from generate_series(1, 200) gs
    on conflict (id) do nothing;
    insert into public.enrollments (id, user_id, course_id, status, completed_at)
    select ('44444444-4444-4444-8444-0000000b' || lpad(gs::text, 4, '0'))::uuid,
           ('33333333-3333-4333-8333-0000000b' || lpad(gs::text, 4, '0'))::uuid,
           '${E9_COURSE4_ID}', 'completed', now() - interval '1 hour'
      from generate_series(1, 200) gs
    on conflict (id) do nothing;
    insert into public.assessment_attempts
      (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
       lease_expires_at, started_at, expires_at, submitted_at, score_pct, passed,
       question_count, correct_count)
    select ('55555555-5555-4555-8555-0000000b' || lpad(gs::text, 4, '0'))::uuid,
           '${SEED_EXAM_ID}',
           ('33333333-3333-4333-8333-0000000b' || lpad(gs::text, 4, '0'))::uuid,
           ('44444444-4444-4444-8444-0000000b' || lpad(gs::text, 4, '0'))::uuid,
           '${SEED_RULES_ID}', 1, 'passed', 'e9-dcr8-m1-bulk-session',
           now() - interval '2 hours', now() - interval '2 hours', now() + interval '1 hour',
           now() - interval '30 minutes' + make_interval(secs => gs::double precision),
           100, true, 5, 5
      from generate_series(1, 200) gs
    on conflict (id) do nothing;
  `);
  // ── M1 auto (หลักสูตร 5): คนชื่อว่าง 3 คนหน้าคิว (submitted_at ~40 นาทีก่อน —
  //    ใหม่กว่าคน 10 ที่ ~75 นาทีก่อน)
  await psql(`
    insert into public.profiles (id, display_name, first_name, last_name, email, preferred_locale)
    select ('33333333-3333-4333-8333-0000000c' || lpad(gs::text, 4, '0'))::uuid, '', null, null,
           'e9-m1-a-' || gs || '@ltc.test', 'th'
      from generate_series(1, 3) gs
    on conflict (id) do nothing;
    insert into public.enrollments (id, user_id, course_id, status, completed_at)
    select ('44444444-4444-4444-8444-0000000c' || lpad(gs::text, 4, '0'))::uuid,
           ('33333333-3333-4333-8333-0000000c' || lpad(gs::text, 4, '0'))::uuid,
           '${E9_COURSE5_ID}', 'completed', now() - interval '1 hour'
      from generate_series(1, 3) gs
    on conflict (id) do nothing;
    insert into public.assessment_attempts
      (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
       lease_expires_at, started_at, expires_at, submitted_at, score_pct, passed,
       question_count, correct_count)
    select ('55555555-5555-4555-8555-0000000c' || lpad(gs::text, 4, '0'))::uuid,
           '${SEED_EXAM_ID}',
           ('33333333-3333-4333-8333-0000000c' || lpad(gs::text, 4, '0'))::uuid,
           ('44444444-4444-4444-8444-0000000c' || lpad(gs::text, 4, '0'))::uuid,
           '${SEED_RULES_ID}', 1, 'passed', 'e9-dcr8-m1-auto-session',
           now() - interval '2 hours', now() - interval '2 hours', now() + interval '1 hour',
           now() - interval '40 minutes' + make_interval(secs => gs::double precision * 10),
           100, true, 5, 5
      from generate_series(1, 3) gs
    on conflict (id) do nothing;
  `);
}

describe.skipIf(!DB_URL)("DCR-8 ออกใบประกาศนียบัตรเป็นชุด + อัตโนมัติ (worker ของ 0027 บน DB จริง)", () => {
  beforeAll(async () => {
    await cleanupE9Dcr8World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
    await pauseCertCrons(); // พัก worker จริงช่วงรัน suite (ตั้งคืนใน afterAll)
    await seedE9Dcr8Fixtures();
  }, 60_000);

  afterAll(async () => {
    await cleanupE9Dcr8World(); // รวมถึงบังคับ flag = false ครั้งสุดท้าย (safety net)
    await restoreCertCrons(); // คืนนิยาม cron ของ 0027 ก่อนปล่อย dev stack
  });

  // ─── 1) bulk path: worker รัน job ออกใบจริง ──────────────────────────────────

  it("bulk: step ออกใบครบ 2 ใบ — สัญญา jsonb เป๊ะ + ใบ valid + audit mode='bulk' actor=ผู้สร้าง job", async () => {
    const body = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB1_ID}', 1000, null)`,
    );
    // สัญญา jsonb ของ 0027 — คีย์ตรงชุดนี้เท่านั้น (ไม่มีคีย์แปลกปลอม)
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
    // (โมเดล worker: ใบออกนอก request → request_id ของ audit เป็น null)
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

  it("bulk: เรียกซ้ำ job เดิมหลังจบ → procedure ปฏิเสธ ERR-VAL-001|bulk_job_already_finished", async () => {
    const call = callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB1_ID}', 1000, null)`,
    );
    await expect(call).rejects.toThrow("ERR-VAL-001");
    await expect(call).rejects.toThrow("bulk_job_already_finished");
  });

  it("bulk: job ไม่มีอยู่จริง → procedure ปฏิเสธ ERR-NF-001|bulk_job_not_found", async () => {
    const call = callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${crypto.randomUUID()}', 1000, null)`,
    );
    await expect(call).rejects.toThrow("ERR-NF-001");
    await expect(call).rejects.toThrow("bulk_job_not_found");
  });

  it("bulk: worker แบบไม่ระบุ job หยิบ pending เก่าสุด (job 2) — คิวออกครบแล้วได้ issued=0 (anti-join กันออกซ้ำ)", async () => {
    // ณ ตอนนี้ pending = job 2 (เก่าสุด), 3, 4, 5 — step(null) ต้องเลือก job 2
    // (คิวของ job 2 scoped หลักสูตร bulk ว่างตามฐาน: คน 1-2 มีใบ valid แล้ว)
    const body = await callProc<StepResult>(
      "call public.admin_cert_bulk_issue_step(null, 1000, null)",
    );
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
    const body = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB3_ID}', 1000, null)`,
    );
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
  });

  it("bulk M2: ชนเพดาน p_max_certs=2 กลางคิว → 'running' + ใบ 2 ใบ/counts ค้างจริง → เรียกซ้อจบ completed 3 ไม่ซ้ำใบ", async () => {
    // รอบแรก: คิวของ job 5 = 3 คนออกได้ · เพดาน 2 = หยุดกลางทาง (จำลอง worker ถูกตัด
    // ก่อนจบ) — สัญญา 'running' + counts สะสม 2
    const first = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB5_ID}', 2, null)`,
    );
    expect(Object.keys(first).sort()).toEqual([
      "failed_count",
      "issued_count",
      "job_id",
      "status",
      "total_attempts",
    ]);
    expect(first.job_id).toBe(E9_JOB5_ID);
    expect(first.status).toBe("running");
    expect(first.issued_count).toBe(2);
    expect(first.failed_count).toBe(0);
    expect(first.total_attempts).toBe(2);

    // M2 แกนหลัก: procedure กลับมาแล้ว ความคืบหน้า "ค้างจริง" — session อื่น (psql คน
    // ละ process) เห็นใบ 2 ใบ + counts 2 + สถานะ running + ยังไม่มี finished_at
    const mid = await psqlRows<{
      status: string;
      issued: number;
      total: number;
      finishedAt: string | null;
      certs: number;
    }>(`
      select j.status::text, j.issued_count as issued, j.total_attempts as total,
             j.finished_at::text as "finishedAt",
             (select count(*)::int from public.certificates c
               where c.enrollment_id in (${M2_SET.map((p) => `'${p.enrollment}'`).join(",")})
                 and c.status = 'valid') as certs
        from public.cert_bulk_jobs j where j.id = '${E9_JOB5_ID}';
    `);
    expect(mid[0]?.status).toBe("running");
    expect(mid[0]?.issued).toBe(2);
    expect(mid[0]?.total).toBe(2);
    expect(mid[0]?.finishedAt).toBeNull();
    expect(mid[0]?.certs).toBe(2);

    // รอบสอง (resume): worker รอบถัดไปเห็น job running → anti-join ตัด 2 ใบที่ออกแล้ว
    // ออกใบที่สาม → จบ completed สะสม 3 — ไม่มีใบซ้ำใน enrollment ใด
    const second = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB5_ID}', 1000, null)`,
    );
    expect(second.status).toBe("completed");
    expect(second.issued_count).toBe(3);
    expect(second.failed_count).toBe(0);
    expect(second.total_attempts).toBe(3);

    const final = await psqlRows<{ status: string; certs: number; distinct: number; finishedAt: string | null }>(`
      select j.status::text,
             (select count(*)::int from public.certificates c
               where c.enrollment_id in (${M2_SET.map((p) => `'${p.enrollment}'`).join(",")})
                 and c.status = 'valid') as certs,
             (select count(distinct c.enrollment_id)::int from public.certificates c
               where c.enrollment_id in (${M2_SET.map((p) => `'${p.enrollment}'`).join(",")})
                 and c.status = 'valid') as distinct,
             j.finished_at::text as "finishedAt"
        from public.cert_bulk_jobs j where j.id = '${E9_JOB5_ID}';
    `);
    expect(final[0]?.status).toBe("completed");
    expect(final[0]?.certs).toBe(3);
    expect(final[0]?.distinct).toBe(3);
    expect(final[0]?.finishedAt).not.toBeNull();
  }, 120_000);

  it("bulk M1: คนชื่อว่าง 200 หน้าคิวไม่ปิดกั้น — เดินผ่านทั้งหมด ออกใบคนท้ายคิวได้ จบ completed (1/200)", async () => {
    // แบบเดิม (0026): picker หยิบ "ชุดแรก" ซ้ำ + exit เมื่อทั้งชุดล้ม = job จบเป็น
    // completed ทั้งที่คนท้ายคิว (ตำแหน่ง 201) ออกได้ — 0027 ต้องเดินผ่านจนถึงเขา
    const body = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB4_ID}', 1000, null)`,
    );
    expect(body.job_id).toBe(E9_JOB4_ID);
    expect(body.status).toBe("completed");
    expect(body.issued_count).toBe(1);
    expect(body.failed_count).toBe(200);
    expect(body.total_attempts).toBe(201);

    // คนมีชื่อท้ายคิวได้ใบ valid จริง — นี่คือจุดที่ M1 พังในรอบก่อน
    const named = M1B_NAMED[0];
    const namedCert = await psqlRows<{ n: number; issuedBy: string }>(`
      select count(*)::int as n, min(issued_by::text) as "issuedBy"
        from public.certificates
       where enrollment_id = '${named?.enrollment ?? ""}' and status = 'valid';
    `);
    expect(namedCert[0]?.n).toBe(1);
    expect(namedCert[0]?.issuedBy).toBe(E9_STAFF_ID);

    // คนชื่อว่างทั้ง 200 ไม่มีใบเกิดขึ้น (ล้มทุกคน — rollback เฉพาะใบ)
    const namelessCerts = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificates
       where enrollment_id::text like '44444444-4444-4444-8444-0000000b%';
    `);
    expect(namelessCerts[0]?.n).toBe(0);

    // แถว job: last_error เก็บสาเหตุใบล้มล่าสุด (holder_name_missing) + จบจริง
    const jobs = await psqlRows<{ status: string; lastError: string; finishedAt: string | null }>(`
      select status::text, coalesce(last_error, '') as "lastError", finished_at::text as "finishedAt"
        from public.cert_bulk_jobs where id = '${E9_JOB4_ID}';
    `);
    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.lastError).toContain("holder_name_missing");
    expect(jobs[0]?.finishedAt).not.toBeNull();
  }, 120_000);

  it("bulk: ไม่มี job ค้าง → สัญญา idle { job_id: null, status: 'idle' } (worker จบเร็ว)", async () => {
    // ณ ตอนนี้ job ทั้งห้า completed หมดแล้ว (ไม่มี pending/running เหลือในโลกของชุด)
    const body = await callProc<StepResult>(
      "call public.admin_cert_bulk_issue_step(null, 1000, null)",
    );
    expect(Object.keys(body).sort()).toEqual(["job_id", "status"]);
    expect(body.job_id).toBeNull();
    expect(body.status).toBe("idle");
  });

  // ─── 2) auto path (CRT-008): cert_auto_issue_tick + feature_flags ───────────

  it("auto: flag ปิด → tick ข้ามด้วย {skipped:true,reason:'flag_off'} — สัญญา jsonb คีย์ตรงชุด", async () => {
    // บังคับ flag ปิดก่อน (สถานะ baseline ปลอดภัย)
    await psql(`update public.feature_flags set enabled = false where key = 'cert_auto_issue';`);
    const body = await callProc<TickResult>(
      `call public.cert_auto_issue_tick('${E9_COURSE2_ID}', 1000, null)`,
    );
    expect(Object.keys(body).sort()).toEqual(["reason", "skipped"]);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("flag_off");
  });

  it("auto: เปิด flag → tick แบบระบุหลักสูตรออกใบ fixture พอดี 2 คน mode='auto' actor=a170 · tick รอบสองได้ 0 · ปิด flag คืนใน finally", async () => {
    try {
      await psql(`update public.feature_flags set enabled = true where key = 'cert_auto_issue';`);

      // tick รอบแรก (scoped หลักสูตร 2): เจอเฉพาะ fixture อัตโนมัติ 2 คน
      const first = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE2_ID}', 1000, null)`,
      );
      expect(Object.keys(first).sort()).toEqual(["failed_count", "issued_count", "skipped"]);
      expect(first.skipped).toBe(false);
      expect(first.issued_count).toBe(2);
      expect(first.failed_count).toBe(0);
      expect(first.reason).toBeUndefined();

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

      // tick รอบสอง (scoped เดิม): คิวหมด → idempotent (issued_count=0)
      const second = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE2_ID}', 1000, null)`,
      );
      expect(Object.keys(second).sort()).toEqual(["failed_count", "issued_count", "skipped"]);
      expect(second.skipped).toBe(false);
      expect(second.issued_count).toBe(0);
      expect(second.failed_count).toBe(0);
    } finally {
      // กติกาเด็ดขาด: ปิด flag คืนเสมอ — แม้ assert ใดพังกลางทาง
      await psql(`update public.feature_flags set enabled = false where key = 'cert_auto_issue';`);
    }
  }, 120_000);

  it("auto M1+M3: tick scoped หลักสูตร 5 เดินผ่านคนชื่อว่าง 3 หน้าคิว ออกใบคนท้ายได้ (1/3) · โลกนอก fixture ไม่ถูกแตะ", async () => {
    try {
      await psql(`update public.feature_flags set enabled = true where key = 'cert_auto_issue';`);

      const first = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE5_ID}', 1000, null)`,
      );
      expect(first.skipped).toBe(false);
      expect(first.issued_count).toBe(1);
      expect(first.failed_count).toBe(3);

      // คนมีชื่อท้ายคิวได้ใบ valid โดยระบบ (actor a170) · คนชื่อว่างไม่มีใบ
      const named = M1A_NAMED[0];
      const namedCert = await psqlRows<{ n: number; issuedBy: string }>(`
        select count(*)::int as n, min(issued_by::text) as "issuedBy"
          from public.certificates
         where enrollment_id = '${named?.enrollment ?? ""}' and status = 'valid';
      `);
      expect(namedCert[0]?.n).toBe(1);
      expect(namedCert[0]?.issuedBy).toBe(AUTO_ACTOR_ID);
      const namelessCerts = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.certificates
         where enrollment_id::text like '44444444-4444-4444-8444-0000000c%';
      `);
      expect(namelessCerts[0]?.n).toBe(0);

      // M3: แถวนอกขอบเขต (หลักสูตร 4 ของชุด bulk — ผ่านเงื่อนไขทั้งคิว) ไม่ถูกออกใบ
      // โดย tick ของ test (สัญญา scope ของ 0027 — ต่างจาก sweep กลางของ 0026)
      const outsideScope = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.certificates c
         where c.enrollment_id::text like '44444444-4444-4444-8444-0000000b%';
      `);
      expect(outsideScope[0]?.n).toBe(0);

      // tick รอบสอง (scoped เดิม): คนมีชื่อมีใบแล้ว → issued=0 (คนชื่อว่างยังอยู่ในคิว
      // และยังล้ม — cursor เริ่มใหม่ทุก call ตามสัญญา ไม่จำตำแหน่งข้าม call)
      const second = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE5_ID}', 1000, null)`,
      );
      expect(second.skipped).toBe(false);
      expect(second.issued_count).toBe(0);
      expect(second.failed_count).toBe(3);
    } finally {
      await psql(`update public.feature_flags set enabled = false where key = 'cert_auto_issue';`);
    }
  }, 120_000);
});

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
 *
 * ชุด regression ของ gate r2 (0028):
 *   MAJOR-1 cursor durable ข้าม CALL — bulk: job ใหม่บนคิว 200 ชื่อว่าง ชนเพดาน
 *      120 ×2 รอบ ต้องเดินต่อจนจบ 0/200/200 **ไม่นับซ้ำ** (cursor หาย = รอบสอง
 *      เดิน 120 ตัวเดิม → running 0/240 — assert completed จับได้) · auto: tick
 *      เพดาน 1 ×2 รอบ รอบสามต้องออกคนมีชื่อโดย failed สะสมรอบสาม = 0 (cursor
 *      หาย = ล้มซ้ำ 2 ตัวเดิม = 2) · คิวหมด = reset → แถวเก่า (submitted_at เก่า
 *      กว่า cursor) กลับมาถูกลองใหม่ได้ (retry)
 *   MAJOR-2 เพดาน 100,000 — job สะสม 99,999 + เดินอีก 1 แถว → ปิด 'failed'
 *      พอดีที่ 100,000 · job ที่สะสม 100,000 อยู่แล้ว → ปิด 'failed' ทันทีไม่
 *      ประมวลผลแถวใด
 *   MAJOR-3 step(null) ปลอดภัยบน DB ร่วม — (r3: สองเคส global ย้ายไป DB แยก — ดู
 *      บล็อก r3 ด้านล่าง · afterAll คืน cron ใน finally ยังใช้ต่อ)
 *   MINOR-1 (r2) หลักฐาน M3 — คนนอก scope ที่ **ออกใบได้** (ชื่อครบ ยังไม่มีใบ)
 *      ต้องไม่มีใบ + ไม่มี audit หลัง tick (เดิมตรวจเฉพาะคนชื่อว่างที่ออกไม่ได้อยู่แล้ว)
 *
 * ชุด regression ของ gate r3 (0029 + DB แยก):
 *   MAJOR-1 แถวใหม่รอ sweep เก่าจนเกิน 5 นาที — tick สองเฟส (0029): fresh lane
 *      รับผู้มาใหม่ (submitted_at ใหม่กว่าขอบบนของ sweep) *ก่อน* backlog → ได้ใบใน
 *      tick เดียวกันแม้ sweep เดิมยังถูกเพดานกั้น (หลักสูตร 7: seed คน 18 หลัง
 *      tick เพดาน 1 ×2 → tick 3 ออกใบคน 18 ก่อนคนท้าย backlog) · ชุดที่เดินแล้ว
 *      ของ sweep = ช่วงต่อเนื่อง [cursor, sweep_top] โดยก่อสร้าง
 *   MAJOR-2 step(null) มีช่องตรวจ-แล้ว-เรียก (TOCTOU) บน DB ร่วม — สองเคส
 *      global (picker หยิบเก่าสุด / idle) ย้ายไป **DB แยก** ที่ suite เป็นเจ้าของ
 *      ทั้งหมด (สร้าง+ทำลายเอง: โคลน schema public จาก pg_dump + stub ส่วนนอก
 *      schema + seed จริง + fixture ของตัวเอง) — DB ร่วมไม่ถูกแตะด้วย step(null)
 *      อีก = ไม่มี job ต่างชุดให้หลุดเข้ามาระหว่างตรวจกับเรียก
 *   MINOR-2 (r3) หลักฐาน cursor — assert จำนวนแถว (cur[0]?.ts เฉย ๆ ผ่านแม้ไม่
 *      มีแถว) + ค่าครบทั้งสองคู่ (cursor + sweep_top) + เคส cap เท่าจำนวนแถวพอดี
 *      → reset ทันที (หลักสูตร 5 · tick1 เพดาน 4)
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql, psqlRows, REPO_ROOT } from "./helpers.js";

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
/** หลักสูตร 7 ของชุด MAJOR-1 (r2) auto — ชื่อว่าง 2 หน้าคิว + คนมีชื่อ 1 ท้ายคิว ไล่ข้าม tick */
const E9_COURSE7_ID = "99999999-9999-4999-8999-00000000e907";
/** หลักสูตร 8 ของชุด MAJOR-2 (r2) — พิสูจน์เพดาน 100,000 ของ job (คนเดียวต่อ job) */
const E9_COURSE8_ID = "99999999-9999-4999-8999-00000000e908";
/** profile staff ของชุด — ผู้สร้าง job (cert_bulk_jobs.created_by) = actor ของใบที่ออกแบบ bulk */
const E9_STAFF_ID = "11111111-1111-4111-8111-00000000e901";
/** งานทั้งห้า: 1 ออกใบจริง · 2 anti-join · 3 TX ต่อใบ · 4 M1 bulk · 5 M2 stop/resume */
const E9_JOB1_ID = "dd000000-0000-4000-8000-00000000e901";
const E9_JOB2_ID = "dd000000-0000-4000-8000-00000000e902";
const E9_JOB3_ID = "dd000000-0000-4000-8000-00000000e903";
const E9_JOB4_ID = "dd000000-0000-4000-8000-00000000e904";
const E9_JOB5_ID = "dd000000-0000-4000-8000-00000000e905";
/** งานของชุด r2 (seed เฉพาะใน test ของตัวเอง — ห้ามค้าง pending ก่อน test idle): 6 เพดาน
 *  เข้าใกล้ 100k · 7 ถึง 100k อยู่แล้ว · 8 cursor durable ข้าม CALL บนคิว 200 ชื่อว่าง */
const E9_JOB6_ID = "dd000000-0000-4000-8000-00000000e906";
const E9_JOB7_ID = "dd000000-0000-4000-8000-00000000e907";
const E9_JOB8_ID = "dd000000-0000-4000-8000-00000000e908";
/** หลักสูตรทั้งแปดของ fixture (ใช้ใน cleanup แบบครอบทั้งโลกของชุด รวมแถว generate_series) */
const E9_COURSES = [
  E9_COURSE_ID,
  E9_COURSE2_ID,
  E9_COURSE3_ID,
  E9_COURSE4_ID,
  E9_COURSE5_ID,
  E9_COURSE6_ID,
  E9_COURSE7_ID,
  E9_COURSE8_ID,
] as const;
/** id ของคนที่ seed แบบ lazy ใน test เฉพาะ (ไม่อยู่ใน PEOPLE — ไม่ให้ test ก่อนหน้าเห็น):
 *  15 = คนนอก scope ที่ออกใบได้ (MINOR-1 r2 · หลักสูตร 4) · 16 = แถวเก่าสุดของหลักสูตร 5
 *  (พิสูจน์ reset ของ cursor) · 17 = แถวเก่าสุดของหลักสูตร 7 (เหมือนกันฝั่ง cross-tick)
 *   · 18 = ผู้ผ่านเงื่อนไขที่มาใหม่ระหว่าง sweep ค้าง (r3 MAJOR-1 · หลักสูตร 7 — fresh
 *  lane ต้องรับเขาก่อน backlog ใน tick ถัดไป ไม่ต้องรอ sweep เก่าจบ) */
const E9_P15_OUTSIDE = person(15, "ผู้เรียนนอกขอบเขตอัตโนมัติ", "นอกขอบเขต", "สิบห้า", E9_COURSE4_ID);
const E9_P16_OLDEST = person(16, "ผู้เรียนแถวเก่าสุด", "แถวเก่า", "สิบหก", E9_COURSE5_ID);
const E9_P17_OLDEST = person(17, "ผู้เรียนแถวเก่าสุดเจ็ด", "แถวเก่า", "สิบเจ็ด", E9_COURSE7_ID);
const E9_P18_ARRIVAL = person(18, "ผู้เรียนมากลางรอบสวีป", "มากลางทาง", "สิบแปด", E9_COURSE7_ID);

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

/** สร้าง id ตายตัวของคนที่ n (1..18) — profile/enrollment/attempt แยกกลุ่ม uuid ไม่ทับกัน */
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
 *   10  = คนมีชื่อท้ายคิวของ M1 auto (หลักสูตร 5 — หน้าคิวเป็นคนชื่อว่าง 3 คน)
 *   11  = คนมีชื่อท้ายคิวของ M1 bulk (หลักสูตร 4 — หน้าคิวเป็นคนชื่อว่าง 200 คน)
 *   12  = คนมีชื่อท้ายคิวของ MAJOR-1 (r2) auto ข้าม tick (หลักสูตร 7 — หน้าคิว 2 คน)
 *   13  = คนที่ job ถึงเพดาน 100k ไว้แล้วต้องไม่ออกให้ (หลักสูตร 8 · MAJOR-2 r2)
 *   14  = คนเดียวที่ job เพดานเข้าใกล้ 100k เดินได้ก่อนปิดตัว (หลักสูตร 8 · MAJOR-2 r2)
 * (คน 15/16/17/18 ไม่อยู่ใน PEOPLE — seed แบบ lazy กลาง test ของตัวเอง (seedLazyPerson):
 *  15 = คนนอก scope ที่ออกใบได้ (MINOR-1 r2 · หลักสูตร 4) · 16/17 = แถวเก่าสุดของ
 *  หลักสูตร 5/7 พิสูจน์ reset ของ cursor · 18 = ผู้มาใหม่กลาง sweep (r3 MAJOR-1 ·
 *  หลักสูตร 7) · คนชื่อว่างจำนวนมากของ M1/r2 สร้างด้วย generate_series ใน
 *  seedE9Dcr8Fixtures — id กลุ่ม 33333333/44444444/55555555 + หลัก b=ชุด bulk,
 *  c=ชุด auto, d=ชุด r2 ข้าม tick)
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
  person(12, "ผู้เรียนข้ามติ๊กอัตโนมัติ", "ข้ามติ๊กทดสอบ", "ท้ายคิวสิบสอง", E9_COURSE7_ID),
  person(13, "ผู้เรียนเพดานค้าง", "เพดานทดสอบ", "สิบสาม", E9_COURSE8_ID),
  person(14, "ผู้เรียนเพดานใกล้", "เพดานทดสอบ", "สิบสี่", E9_COURSE8_ID),
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

/** seed คนเดียวแบบ lazy กลาง test (คน 15/16/17/18 — ไม่อยู่ใน PEOPLE ไม่ให้ test
 *  ก่อนหน้าเห็น) · minutesAgo คุมตำแหน่งในคิว (เก่าแรง = ท้ายคิว — ใช้พิสูจน์ว่า
 *  reset ของ cursor ทำให้แถวเก่ากว่าจุดเดินล่าสุดกลับมาถูกเห็นหลัง sweep จบ) */
async function seedLazyPerson(p: E9Person, minutesAgo: number): Promise<void> {
  await psql(`
    insert into public.profiles (id, display_name, first_name, last_name, email, preferred_locale)
    values ('${p.profile}', '${p.display}', ${p.firstName === null ? "null" : `'${p.firstName}'`},
            ${p.lastName === null ? "null" : `'${p.lastName}'`}, '${p.emailLocal}@ltc.test', 'th')
    on conflict (id) do nothing;
    insert into public.enrollments (id, user_id, course_id, status, completed_at)
    values ('${p.enrollment}', '${p.profile}', '${p.course}', 'completed',
            now() - interval '2 hours')
    on conflict (id) do nothing;
    insert into public.assessment_attempts
      (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
       lease_expires_at, started_at, expires_at, submitted_at, score_pct, passed,
       question_count, correct_count)
    values ('${p.attempt}', '${SEED_EXAM_ID}', '${p.profile}', '${p.enrollment}', '${SEED_RULES_ID}',
            1, 'passed', 'e9-dcr8-lazy-session', now() - interval '3 hours',
            now() - interval '3 hours', now() + interval '1 hour',
            now() - interval '${minutesAgo} minutes', 100, true, 5, 5)
    on conflict (id) do nothing;
  `);
}

/** ล้างโลกของชุด DCR-8 ทั้งหมด (เรียงตาม FK — RESTRICT) + ปิด flag ทิ้งเป็นสถานะปลอดภัย
 *  ลบแบบครอบทั้งหลักสูตรของชุด (ครอบแถว generate_series ของ M1 ด้วย) */
async function cleanupE9Dcr8World(): Promise<void> {
  const courseList = E9_COURSES.map((c) => `'${c}'`).join(",");
  const profileList = [`'${E9_STAFF_ID}'`, ...PEOPLE.map((p) => `'${p.profile}'`),
    `'${E9_P15_OUTSIDE.profile}'`, `'${E9_P16_OLDEST.profile}'`, `'${E9_P17_OLDEST.profile}'`,
    `'${E9_P18_ARRIVAL.profile}'`].join(",");
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
     where id in ('${E9_JOB1_ID}', '${E9_JOB2_ID}', '${E9_JOB3_ID}', '${E9_JOB4_ID}', '${E9_JOB5_ID}',
                  '${E9_JOB6_ID}', '${E9_JOB7_ID}', '${E9_JOB8_ID}');
    -- 0028: cursor ของ auto ที่ suite นี้เขียน (เฉพาะ scope ของ fixture — ห้ามแตะ
    -- '*' ของ cron จริง)
    delete from public.cert_auto_cursor
     where scope_key in ('${E9_COURSE2_ID}', '${E9_COURSE5_ID}', '${E9_COURSE7_ID}');
    delete from public.assessment_attempts
     where enrollment_id in (select id from public.enrollments where course_id in (${courseList}));
    delete from public.enrollments where course_id in (${courseList});
    -- หลักสูตรทั้งแปดต้องลบก่อนโปรไฟล์ staff (FK courses.created_by → profiles — RESTRICT)
    delete from public.courses where id in (${courseList});
    delete from public.profiles where id in (${profileList})
      or id::text like '33333333-3333-4333-8333-0000000%';
  `);
}

/**
 * หว่าน fixture ของชุด: หลักสูตร + โปรไฟล์ + enrollment completed + attempt "ผ่าน"
 * (SQL ตรง) + คนชื่อว่างของ M1 ด้วย generate_series · job ทั้งห้า seed ด้วย created_at
 * ไล่อายุ (เก่าสุดก่อน — r3: การหยิบเก่าสุดของ step(null) พิสูจน์บน DB แยกแล้ว ชุดนี้
 * เรียกตรง job เท่านั้น) · deterministic
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
       'หลักสูตรทดสอบ DCR-8 หยุดกลางทาง (integration)', false, 'published', now()),
      ('${E9_COURSE7_ID}', 'E9-DCR8-X1',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 ข้ามติ๊กอัตโนมัติ (integration)', false, 'published', now()),
      ('${E9_COURSE8_ID}', 'E9-DCR8-CP',
       (select id from public.course_categories order by id limit 1), '${E9_STAFF_ID}',
       'หลักสูตรทดสอบ DCR-8 เพดานแสนแถว (integration)', false, 'published', now())
    on conflict (id) do nothing;
    -- job ห้าแถว (pending) ไล่อายุ created_at (r3: การหยิบเก่าสุดของ step(null)
    -- พิสูจน์บน DB แยกแล้ว — ชุดนี้เรียกตรง job เท่านั้น · job 1-2 scoped หลักสูตร
    -- bulk · 3 หลักสูตรชุดใบล้ม · 4 ชุด M1 bulk · 5 ชุด M2)
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

  // ── MAJOR-1 (r2) auto ข้าม tick (หลักสูตร 7): คนชื่อว่าง 2 คนหน้าคิว
  //    (submitted_at ~30 นาทีก่อน — ใหม่กว่าคน 12 ที่ ~65 นาทีก่อน = ท้ายคิว)
  await psql(`
    insert into public.profiles (id, display_name, first_name, last_name, email, preferred_locale)
    select ('33333333-3333-4333-8333-0000000d' || lpad(gs::text, 4, '0'))::uuid, '', null, null,
           'e9-r2-d-' || gs || '@ltc.test', 'th'
      from generate_series(1, 2) gs
    on conflict (id) do nothing;
    insert into public.enrollments (id, user_id, course_id, status, completed_at)
    select ('44444444-4444-4444-8444-0000000d' || lpad(gs::text, 4, '0'))::uuid,
           ('33333333-3333-4333-8333-0000000d' || lpad(gs::text, 4, '0'))::uuid,
           '${E9_COURSE7_ID}', 'completed', now() - interval '1 hour'
      from generate_series(1, 2) gs
    on conflict (id) do nothing;
    insert into public.assessment_attempts
      (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
       lease_expires_at, started_at, expires_at, submitted_at, score_pct, passed,
       question_count, correct_count)
    select ('55555555-5555-4555-8555-0000000d' || lpad(gs::text, 4, '0'))::uuid,
           '${SEED_EXAM_ID}',
           ('33333333-3333-4333-8333-0000000d' || lpad(gs::text, 4, '0'))::uuid,
           ('44444444-4444-4444-8444-0000000d' || lpad(gs::text, 4, '0'))::uuid,
           '${SEED_RULES_ID}', 1, 'passed', 'e9-r2-auto-session',
           now() - interval '2 hours', now() - interval '2 hours', now() + interval '1 hour',
           now() - interval '30 minutes' + make_interval(secs => gs::double precision),
           100, true, 5, 5
      from generate_series(1, 2) gs
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
    // MAJOR-3 (r2): cleanup ล้มก็ต้องคืน cron จริงของ dev stack เสมอ (try/finally —
    // เดิม cleanup ล้ม = ข้าม restore ทิ้ง worker จริงตายเงียบ)
    try {
      await cleanupE9Dcr8World(); // รวมถึงบังคับ flag = false ครั้งสุดท้าย (safety net)
    } finally {
      await restoreCertCrons(); // คืนนิยาม cron ของ 0027/0028 ก่อนปล่อย dev stack
    }
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


  // ─── 1b) ชุด r2 (0028): cursor durable ข้าม CALL + เพดาน 100,000 ของ job ──────

  it("bulk MAJOR-1 (r2): cursor durable ข้าม CALL — ชนเพดาน 120 กลางคิว 200 ชื่อว่าง รอบสองเดินต่อจนจบ completed 0/200/200 ไม่นับซ้ำ", async () => {
    // job 8 สร้างเฉพาะ test นี้ (lazy — ห้ามค้าง pending ก่อน test idle): scoped
    // หลักสูตร 4 ที่ job 4 เดินจบไปแล้ว — คิวที่เหลือ = คนชื่อว่าง 200 (คน 11 มีใบ
    // ถูก anti-join ตัดแล้ว) · แบบเดิม (0027) cursor อยู่ในหน่วยความจำ = รอบสอง
    // เดิน 120 ตัวเดิม → running 0/240 — assert completed จับได้
    await psql(`
      insert into public.cert_bulk_jobs (id, created_by, course_id, status, created_at)
      values ('${E9_JOB8_ID}', '${E9_STAFF_ID}', '${E9_COURSE4_ID}', 'pending',
              now() - interval '10 minutes')
      on conflict (id) do nothing;
    `);
    const first = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB8_ID}', 120, null)`,
    );
    expect(first.job_id).toBe(E9_JOB8_ID);
    expect(first.status).toBe("running");
    expect(first.issued_count).toBe(0);
    expect(first.failed_count).toBe(120);
    expect(first.total_attempts).toBe(120);

    // ความคืบหน้า + **cursor** ค้างจริงข้าม CALL (มองจาก session อื่น — psql คนละ process)
    const mid = await psqlRows<{
      status: string;
      failed: number;
      cursorTs: string | null;
      cursorAid: string | null;
    }>(`
      select status::text, failed_count as failed,
             cursor_submitted_at::text as "cursorTs", cursor_attempt_id::text as "cursorAid"
        from public.cert_bulk_jobs where id = '${E9_JOB8_ID}';
    `);
    expect(mid[0]?.status).toBe("running");
    expect(mid[0]?.failed).toBe(120);
    expect(mid[0]?.cursorTs).not.toBeNull();
    expect(mid[0]?.cursorAid).not.toBeNull();

    // รอบสอง (CALL ใหม่ · worker รอบถัดไป): เดินต่อจาก cursor แถวที่ 121-200 (80
    // แถว) คิวหมด → completed สะสม 0/200/200 — ไม่มีแถวถูกนับซ้ำ
    const second = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB8_ID}', 120, null)`,
    );
    expect(second.job_id).toBe(E9_JOB8_ID);
    expect(second.status).toBe("completed");
    expect(second.issued_count).toBe(0);
    expect(second.failed_count).toBe(200);
    expect(second.total_attempts).toBe(200);
  }, 180_000);

  it("bulk MAJOR-2 (r2): job สะสม 99,999 + เดินอีก 1 แถว (เพดาน p_max_certs=1) → ปิด 'failed' พอดี 100,000 ในรอบเดียวกัน — แถวที่ถูกเดินได้ใบจริง", async () => {
    // job 6 lazy: จำลอง job ที่สะสมความล้ม 99,999 จากรอบก่อน (update counts ตรง ๆ)
    // · คิวหลักสูตร 8 = คน 14 (55 นาที — หน้าคิว) แล้วคน 13 (60 นาที) · แบบเดิม
    // (0027): ตรวจเพดาน*หลัง* branch ชน v_max → p_max_certs=1 ออกเป็น 'running'
    // ทั้งที่ครบ 100,000 แล้ว — assert 'failed' จับได้
    await psql(`
      insert into public.cert_bulk_jobs (id, created_by, course_id, status, created_at)
      values ('${E9_JOB6_ID}', '${E9_STAFF_ID}', '${E9_COURSE8_ID}', 'pending',
              now() - interval '8 minutes')
      on conflict (id) do nothing;
      update public.cert_bulk_jobs
         set failed_count = 99999, total_attempts = 99999
       where id = '${E9_JOB6_ID}';
    `);
    const body = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB6_ID}', 1, null)`,
    );
    expect(body.job_id).toBe(E9_JOB6_ID);
    expect(body.status).toBe("failed");
    expect(body.issued_count).toBe(1);
    expect(body.failed_count).toBe(99999);
    expect(body.total_attempts).toBe(100000);

    // คน 14 (แถวเดียวที่ถูกเดิน) ได้ใบ valid จริง + job ปิดจริง (finished_at +
    // last_error = ข้อความเพดานของ 0028)
    const named = PEOPLE[13]; // คน 14
    const namedCert = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificates
       where enrollment_id = '${named?.enrollment ?? ""}' and status = 'valid';
    `);
    expect(namedCert[0]?.n).toBe(1);
    const jobs = await psqlRows<{ status: string; finishedAt: string | null; lastError: string }>(`
      select status::text, finished_at::text as "finishedAt",
             coalesce(last_error, '') as "lastError"
        from public.cert_bulk_jobs where id = '${E9_JOB6_ID}';
    `);
    expect(jobs[0]?.status).toBe("failed");
    expect(jobs[0]?.finishedAt).not.toBeNull();
    expect(jobs[0]?.lastError).toContain("ERR-SYS-002");
    expect(jobs[0]?.lastError).toContain("bulk_row_limit");
  }, 60_000);

  it("bulk MAJOR-2 (r2): job ที่สะสม 100,000 อยู่แล้ว → ปิด 'failed' ทันทีไม่ประมวลผลแถวใด (คนในคิวไม่ถูกออกใบ)", async () => {
    // job 7 lazy: คิวหลักสูตร 8 ยังเหลือคน 13 (คน 14 มีใบจาก test ก่อน — anti-join
    // ตัดแล้ว) · แบบเดิม (0027) ไม่มี pre-check → เดินคน 13 ก่อนค่อยพบเพดาน = เขา
    // ได้ใบทั้งที่ job ตายไปแล้ว — assert issued 0 + ไม่มีใบ จับได้
    await psql(`
      insert into public.cert_bulk_jobs (id, created_by, course_id, status, created_at)
      values ('${E9_JOB7_ID}', '${E9_STAFF_ID}', '${E9_COURSE8_ID}', 'pending',
              now() - interval '6 minutes')
      on conflict (id) do nothing;
      update public.cert_bulk_jobs
         set failed_count = 100000, total_attempts = 100000
       where id = '${E9_JOB7_ID}';
    `);
    const body = await callProc<StepResult>(
      `call public.admin_cert_bulk_issue_step('${E9_JOB7_ID}', 1000, null)`,
    );
    expect(body.job_id).toBe(E9_JOB7_ID);
    expect(body.status).toBe("failed");
    expect(body.issued_count).toBe(0);
    expect(body.failed_count).toBe(100000);
    expect(body.total_attempts).toBe(100000);

    // คน 13 ไม่มีใบเกิดขึ้นเลย + job ปิดจริงด้วยข้อความเพดาน (pre-check path)
    const skipped = PEOPLE[12]; // คน 13
    const skippedCerts = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificates
       where enrollment_id = '${skipped?.enrollment ?? ""}';
    `);
    expect(skippedCerts[0]?.n).toBe(0);
    const jobs = await psqlRows<{ status: string; finishedAt: string | null; lastError: string }>(`
      select status::text, finished_at::text as "finishedAt",
             coalesce(last_error, '') as "lastError"
        from public.cert_bulk_jobs where id = '${E9_JOB7_ID}';
    `);
    expect(jobs[0]?.status).toBe("failed");
    expect(jobs[0]?.finishedAt).not.toBeNull();
    expect(jobs[0]?.lastError).toContain("bulk_row_limit");
  }, 60_000);

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

  it("auto M1+M3 (r2+r3): tick scoped เดินผ่านคนชื่อว่าง 3 หน้าคิว ออกใบคนท้ายได้ (1/3) · คนนอก scope ที่ออกได้ไม่ถูกแตะ · cap เท่าจำนวนแถวพอดี = reset ทันที", async () => {
    try {
      await psql(`update public.feature_flags set enabled = true where key = 'cert_auto_issue';`);

      // MINOR-1 (r2): คนนอก scope ที่ **ออกใบได้จริง** (ชื่อครบ ผ่าน ยังไม่มีใบ) บน
      // หลักสูตร 4 — seed ก่อน tick แล้วพิสูจน์ว่า tick ของหลักสูตร 5 ไม่แตะเขา (เดิม
      // ตรวจเฉพาะคนชื่อว่างที่ออกไม่ได้อยู่แล้ว — ไม่ใช่หลักฐาน scope)
      await seedLazyPerson(E9_P15_OUTSIDE, 20);

      const first = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE5_ID}', 4, null)`,
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

      // M3 + MINOR-1: คนนอก scope ที่ออกได้ยังไม่มีใบ · ระบบไม่เคยออกใบบนหลักสูตร 4
      // เลย (สัญญา scope ของ 0027/0028 — ต่างจาก sweep กลางของ 0026)
      const outsideCert = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.certificates
         where enrollment_id = '${E9_P15_OUTSIDE.enrollment}';
      `);
      expect(outsideCert[0]?.n).toBe(0);
      const autoOnOutsideCourse = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.certificates c
          join public.enrollments e on e.id = c.enrollment_id
         where e.course_id = '${E9_COURSE4_ID}' and c.issued_by = '${AUTO_ACTOR_ID}';
      `);
      expect(autoOnOutsideCourse[0]?.n).toBe(0);

      // MINOR-2 (r3) แบบเป๊ะ: tick1 เพดาน 4 = จำนวนแถวของคิวพอดี (ชื่อว่าง 3 + คน 10)
      // → เดินครบทั้งคิวใน tick เดียว ชนเพดาน*พร้อม* probe ยืนยันคิวหมด → reset
      // ทันทีทั้งสองคู่ (cursor backlog + ขอบบนของ sweep) — จับด้วยจำนวนแถวของ cursor
      const cur1 = await psqlRows<{
        ts: string | null;
        aid: string | null;
        topTs: string | null;
        topAid: string | null;
      }>(`
        select cursor_submitted_at::text as ts, cursor_attempt_id::text as aid,
               sweep_top_submitted_at::text as "topTs", sweep_top_attempt_id::text as "topAid"
          from public.cert_auto_cursor where scope_key = '${E9_COURSE5_ID}';
      `);
      expect(cur1).toHaveLength(1);
      expect(cur1[0]?.ts).toBeNull();
      expect(cur1[0]?.aid).toBeNull();
      expect(cur1[0]?.topTs).toBeNull();
      expect(cur1[0]?.topAid).toBeNull();

      // tick รอบสอง (เพดาน 1000): sweep ก่อนหน้าจบพร้อม reset (tick1 ชนเพดาน 4 =
      // จำนวนแถวพอดีแล้ว probe ยืนยันคิวหมด) → รอบ retry ใหม่ — คนชื่อว่างถูกลองใหม่
      // (ล้มอีก — bounded ต่อ tick ด้วย p_max_certs)
      const second = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE5_ID}', 1000, null)`,
      );
      expect(second.skipped).toBe(false);
      expect(second.issued_count).toBe(0);
      expect(second.failed_count).toBe(3);
      // MINOR-2 (r3): จำนวนแถว + ค่า — ไม่ใช่ cur[0]?.ts เฉย ๆ (ผ่านแม้ไม่มีแถว)
      const cur2 = await psqlRows<{ ts: string | null }>(`
        select cursor_submitted_at::text as ts
          from public.cert_auto_cursor where scope_key = '${E9_COURSE5_ID}';
      `);
      expect(cur2).toHaveLength(1);
      expect(cur2[0]?.ts).toBeNull();

      // reset proof: แถวที่ submitted_at เก่ากว่าทุกแถวที่เดินไปแล้ว (seed ตอนหลัง)
      // ต้องกลับมาถูกเห็นหลัง sweep จบ — ถ้า cursor ค้างไม่ reset เขาจะล่องหนไปตลอด
      await seedLazyPerson(E9_P16_OLDEST, 90);
      const third = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE5_ID}', 1000, null)`,
      );
      expect(third.skipped).toBe(false);
      expect(third.issued_count).toBe(1);
      expect(third.failed_count).toBe(3);
      const oldestCert = await psqlRows<{ n: number; issuedBy: string }>(`
        select count(*)::int as n, min(issued_by::text) as "issuedBy"
          from public.certificates
         where enrollment_id = '${E9_P16_OLDEST.enrollment}' and status = 'valid';
      `);
      expect(oldestCert[0]?.n).toBe(1);
      expect(oldestCert[0]?.issuedBy).toBe(AUTO_ACTOR_ID);
    } finally {
      await psql(`update public.feature_flags set enabled = false where key = 'cert_auto_issue';`);
    }
  }, 120_000);

  it("auto MAJOR-1 (r2+r3): tick สองเฟส (0029) — ผู้มาใหม่กลาง sweep ได้ใบทันทีใน tick ถัดไป ไม่รอ sweep เก่าจบ (AC ≤5 นาที) · cursor คู่ (backlog + ขอบบน) durable ข้าม CALL · คิวหมด = reset ครบทั้งสองคู่", async () => {
    try {
      await psql(`update public.feature_flags set enabled = true where key = 'cert_auto_issue';`);

      // tick 1 (เพดาน 1): คนชื่อว่างตัวที่ 1 (หัวคิว ~30 นาที) ล้ม — sweep วงแรกของ
      // scope นี้: แถวแรกที่เดิน = ขอบบน (sweep_top) พร้อม cursor backlog ที่ตำแหน่ง
      // เดียวกัน — ทั้งคู่ durable ใน cert_auto_cursor ไม่ใช่หน่วยความจำ procedure
      const t1 = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE7_ID}', 1, null)`,
      );
      expect(t1.skipped).toBe(false);
      expect(t1.issued_count).toBe(0);
      expect(t1.failed_count).toBe(1);
      const cur1 = await psqlRows<{
        ts: string | null;
        aid: string | null;
        topTs: string | null;
        topAid: string | null;
      }>(`
        select cursor_submitted_at::text as ts, cursor_attempt_id::text as aid,
               sweep_top_submitted_at::text as "topTs", sweep_top_attempt_id::text as "topAid"
          from public.cert_auto_cursor where scope_key = '${E9_COURSE7_ID}';
      `);
      // MINOR-2 (r3): assert จำนวนแถวด้วย — cur[0]?.ts เฉย ๆ ผ่านแม้ไม่มีแถว (undefined)
      expect(cur1).toHaveLength(1);
      expect(cur1[0]?.ts).not.toBeNull();
      expect(cur1[0]?.aid).not.toBeNull();
      expect(cur1[0]?.topTs).not.toBeNull();
      expect(cur1[0]?.topAid).not.toBeNull();

      // tick 2 (เพดาน 1 · CALL ใหม่): backlog เดินต่อ → คนชื่อว่างตัวที่ 2 ล้ม —
      // ตัวจับ r2 (0027 cursor หายข้าม CALL = ตัวที่ 1 ซ้ำ) ยังต้องผ่าน: failed = 1
      const t2 = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE7_ID}', 1, null)`,
      );
      expect(t2.skipped).toBe(false);
      expect(t2.issued_count).toBe(0);
      expect(t2.failed_count).toBe(1);
      const cur2 = await psqlRows<{ ts: string | null }>(`
        select cursor_submitted_at::text as ts
          from public.cert_auto_cursor where scope_key = '${E9_COURSE7_ID}';
      `);
      expect(cur2).toHaveLength(1);
      expect(cur2[0]?.ts).not.toBeNull();

      // ── MAJOR-1 (r3): ผู้ผ่านเงื่อนไข "มาใหม่" กลาง sweep ที่ยังถูกเพดานกั้น ──
      // seed หลัง tick 2 ด้วย submitted_at ใหม่กว่าขอบบนของ sweep (sweep_top) —
      // แบบ 0028 เขาล่องหนไปจนกว่า sweep เก่าจะหมดคิวและ reset (ตัวอย่างของ gate:
      // คิวชื่อว่าง 4,000 แถว @1,000/2 นาที = รอถึงนาที 8 ทั้งที่ตัวเองออกได้ทันที —
      // ขัด SRS AC ≤5 นาที)
      await seedLazyPerson(E9_P18_ARRIVAL, 1);

      // tick 3 (เพดาน 1): fresh lane ของ 0029 รับผู้มาใหม่*ก่อน* backlog — ออกใบให้
      // เขาใน tick นี้เองแม้ backlog ยังค้าง (0028 = ออกคนท้าย backlog โดยผู้มาใหม่
      // ยังไม่มีใบ — ใบของ p18 ในรอบนี้คือตัวจับ MAJOR-1 r3)
      const t3 = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE7_ID}', 1, null)`,
      );
      expect(t3.skipped).toBe(false);
      expect(t3.issued_count).toBe(1);
      expect(t3.failed_count).toBe(0);
      const arrivalCert = await psqlRows<{ n: number; issuedBy: string }>(`
        select count(*)::int as n, min(issued_by::text) as "issuedBy"
          from public.certificates
         where enrollment_id = '${E9_P18_ARRIVAL.enrollment}' and status = 'valid';
      `);
      expect(arrivalCert[0]?.n).toBe(1);
      expect(arrivalCert[0]?.issuedBy).toBe(AUTO_ACTOR_ID);
      // คนท้าย backlog (คน 12 — อยู่หลังคนชื่อว่างที่ยังไม่ถูกเดิน) ยังไม่มีใบ: งบของ
      // tick นี้ถูก fresh lane ใช้ไป ไม่ได้แย่งเดิน backlog (รอ tick ถัดไป)
      const tailPerson = PEOPLE[11]; // คน 12 — ท้ายคิวของหลักสูตร 7
      const tailCerts = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.certificates
         where enrollment_id = '${tailPerson?.enrollment ?? ""}';
      `);
      expect(tailCerts[0]?.n).toBe(0);

      // tick 4 (เพดาน 1000): backlog เดินต่อจนจบ — คนท้ายคิวได้ใบ คิวหมดตามธรรมชาติ
      // (ไม่ capped) → reset ครบทั้งสองคู่ (cursor backlog + ขอบบนของ sweep)
      const t4 = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE7_ID}', 1000, null)`,
      );
      expect(t4.skipped).toBe(false);
      expect(t4.issued_count).toBe(1);
      expect(t4.failed_count).toBe(0);
      const tailCert = await psqlRows<{ n: number; issuedBy: string }>(`
        select count(*)::int as n, min(issued_by::text) as "issuedBy"
          from public.certificates
         where enrollment_id = '${tailPerson?.enrollment ?? ""}' and status = 'valid';
      `);
      expect(tailCert[0]?.n).toBe(1);
      expect(tailCert[0]?.issuedBy).toBe(AUTO_ACTOR_ID);
      const cur4 = await psqlRows<{
        ts: string | null;
        aid: string | null;
        topTs: string | null;
        topAid: string | null;
      }>(`
        select cursor_submitted_at::text as ts, cursor_attempt_id::text as aid,
               sweep_top_submitted_at::text as "topTs", sweep_top_attempt_id::text as "topAid"
          from public.cert_auto_cursor where scope_key = '${E9_COURSE7_ID}';
      `);
      expect(cur4).toHaveLength(1);
      expect(cur4[0]?.ts).toBeNull();
      expect(cur4[0]?.aid).toBeNull();
      expect(cur4[0]?.topTs).toBeNull();
      expect(cur4[0]?.topAid).toBeNull();

      // reset proof: แถวเก่าสุด (submitted_at เก่ากว่าทุกแถวที่เดินไปแล้ว — seed ตอน
      // นี้) กลับมาถูกเห็น + คนชื่อว่างทั้งสองถูกลองใหม่ (retry รอบ sweep ใหม่ — ล้มอีก 2)
      await seedLazyPerson(E9_P17_OLDEST, 90);
      const t5 = await callProc<TickResult>(
        `call public.cert_auto_issue_tick('${E9_COURSE7_ID}', 1000, null)`,
      );
      expect(t5.skipped).toBe(false);
      expect(t5.issued_count).toBe(1);
      expect(t5.failed_count).toBe(2);
      const oldestCert = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.certificates
         where enrollment_id = '${E9_P17_OLDEST.enrollment}' and status = 'valid';
      `);
      expect(oldestCert[0]?.n).toBe(1);
    } finally {
      await psql(`update public.feature_flags set enabled = false where key = 'cert_auto_issue';`);
    }
  }, 120_000);
});


// ─── 3) ชุด global step(null) บน DB แยก (r3 MAJOR-2 — suite เป็นเจ้าของ DB ทั้งหมด) ──
// DB ร่วม (describe ด้านบน) ไม่มี step(null) อีกแล้ว: การ "ตรวจก่อนแล้วค่อยเรียก"
// (assertNoForeignJobs เดิม) เป็น TOCTOU ที่ gate r3 ไม่รับ — job ต่างชุดที่ถูก
// สร้างระหว่างสอง statement หลุดเข้ามาได้ · สองเคสเดิม (picker หยิบ pending เก่าสุด /
// idle) จึงย้ายมา DB ที่ suite นี้สร้าง+ทำลายเอง: โคลน schema public จาก dev DB จริง
// (pg_dump -s) + stub ส่วนที่อยู่นอก schema (auth.* ของ Supabase / btree_gist /
// pgcrypto) + seed จริง + fixture ของตัวเอง — โลกของ DB นี้ว่างโดยก่อสร้าง = ไม่มี
// job ต่างชุดให้หลุดเข้ามา และ DB ร่วมไม่ถูกแตะด้วย step(null) อีกเลย

const ISO_DB = "ltc_e9_iso_dcr8";
const ISO_STAFF_ID = "11111111-1111-4111-8111-00000000f901";
const ISO_COURSE_ID = "99999999-9999-4999-8999-00000000f901";
const ISO_JOB_OLD_ID = "dd000000-0000-4000-8000-00000000f901"; // pending 10 นาที
const ISO_JOB_NEW_ID = "dd000000-0000-4000-8000-00000000f902"; // pending 5 นาที
const ISO_LEARNER_PROFILE = "22222222-2222-4222-8222-00000000f901";
const ISO_LEARNER_ENROLLMENT = "bb000000-0000-4000-8000-00000000f901";
const ISO_LEARNER_ATTEMPT = "aa000000-0000-4000-8000-00000000f901";

/** เหมือน psql ของ helpers แต่ชี้ DB แยกของ suite นี้ (r3 MAJOR-2) — สร้าง/ทำลาย
 *  เองใน beforeAll/afterAll · duplicate เล็ก ๆ ตามกติกา — ไม่แก้ helpers เดิม */
function isoSql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose", "exec", "-T", "db", "sh", "-c",
        `PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d ${ISO_DB} -v ON_ERROR_STOP=1 -At`,
      ],
      { cwd: REPO_ROOT },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`isoSql ล้ม (exit ${code ?? "?"}): ${err.trim()}`));
    });
    child.stdin.on("error", () => {}); // อีกฝั่งตายก่อน = จบด้วย close ไม่ใช่ EPIPE crash
    child.stdin.end(sql);
  });
}

async function isoRows<T>(sql: string): Promise<T[]> {
  // ตัด ; ท้ายคำสั่งก่อน wrap เป็น subquery — เหมือน psqlRows ของ helpers
  const inner = sql.trim().replace(/;\s*$/, "");
  const wrapped = `select coalesce(json_agg(q), '[]'::json)::text from (${inner}) q;`;
  return JSON.parse((await isoSql(wrapped)).trim()) as T[];
}

async function isoCall<T>(call: string): Promise<T> {
  return JSON.parse((await isoSql(`${call};`)).trim()) as T;
}

describe.skipIf(!DB_URL)("DCR-8 global worker step(null) บน DB แยก (r3 MAJOR-2)", () => {
  // สร้าง DB เปล่า → stub ส่วนนอก schema public → โคลน schema จาก dev DB จริง →
  // seed → fixture 2 jobs + ผู้เรียน 1 คน (คิวของ job เก่า) — ทั้งหมดของ suite นี้เอง
  beforeAll(async () => {
    await psql(`drop database if exists ${ISO_DB} with (force);`);
    await psql(`create database ${ISO_DB};`);
    await isoSql(`
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;
      create function auth.role() returns text language sql stable as $$ select null::text $$;
      grant usage on schema auth to public;
      create extension btree_gist;
      create extension pgcrypto with schema public;
    `);
    // โคลน schema public จาก dev DB จริง (รวม procedure ของ 0027-0029 + RLS + grants)
    // — กรอง "CREATE SCHEMA public;" (DB ใหม่มีอยู่แล้ว)
    await new Promise<void>((resolve, reject) => {
      const dump = spawn(
        "docker",
        ["compose", "exec", "-T", "db", "sh", "-c",
         'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -s --schema=public postgres'],
        { cwd: REPO_ROOT },
      );
      const restore = spawn(
        "docker",
        ["compose", "exec", "-T", "db", "sh", "-c",
         `PGPASSWORD="$POSTGRES_PASSWORD" grep -v "^CREATE SCHEMA public;" | ` +
         `PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d ${ISO_DB} -v ON_ERROR_STOP=1`],
        { cwd: REPO_ROOT },
      );
      let err = "";
      dump.on("error", reject);
      restore.on("error", reject);
      restore.stderr.on("data", (c) => { err += c.toString(); });
      restore.stdin.on("error", () => {}); // อีกฝั่งตายก่อน = จบด้วย close ไม่ใช่ crash
      dump.stdout.on("data", (c) => { restore.stdin.write(c); });
      dump.stderr.on("data", (c) => { err += c.toString(); });
      dump.on("close", (code) => {
        if (code !== 0) { reject(new Error(`pg_dump ล้ม (exit ${code}): ${err.trim()}`)); return; }
        restore.stdin.end();
      });
      restore.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`restore ล้ม (exit ${code ?? "?"}): ${err.trim()}`));
      });
    });
    await isoSql(readFileSync(`${REPO_ROOT}/supabase/seed.sql`, "utf8"));
    await isoSql(`
      -- pg_dump -s เอาแต่ schema: แถวที่ migration ปะ๊ะ (ไม่ใช่ seed) ต้องเติมเอง —
      -- a170 (actor ระบบของ 0026) + flag row (เผื่อของเดินคิวถูกเรียกในอนาคต)
      insert into public.profiles (id, display_name, first_name, last_name, email, preferred_locale)
      values ('00000000-0000-4000-8000-00000000a170', 'ระบบออกใบอัตโนมัติ (CRT-008)',
              'ระบบ', 'ออกใบอัตโนมัติ', 'system-auto-cert@ltc.test', 'th')
      on conflict (id) do nothing;
      insert into public.feature_flags (key, enabled, note)
      values ('cert_auto_issue', false, 'iso suite — cron จริงคืนที่ DB ร่วมอยู่แล้ว')
      on conflict (key) do nothing;

      insert into public.profiles (id, display_name, first_name, last_name, email, preferred_locale)
      values ('${ISO_STAFF_ID}', 'เจ้าหน้าที่ DB แยก DCR-8', 'เจ้าหน้าที่', 'ไอโซ',
              'iso-dcr8-staff@ltc.test', 'th')
      on conflict (id) do nothing;
      insert into public.profiles (id, display_name, first_name, last_name, email, preferred_locale)
      values ('${ISO_LEARNER_PROFILE}', 'ผู้เรียน DB แยก DCR-8', 'ผู้เรียน', 'ไอโซ',
              'iso-dcr8-learner@ltc.test', 'th')
      on conflict (id) do nothing;
      insert into public.courses
        (id, code, category_id, created_by, title_th, is_public, status, published_at)
      values ('${ISO_COURSE_ID}', 'E9-DCR8-ISO',
              (select id from public.course_categories order by id limit 1),
              '${ISO_STAFF_ID}', 'หลักสูตรทดสอบ DCR-8 บน DB แยก (integration)',
              false, 'published', now())
      on conflict (id) do nothing;
      insert into public.enrollments (id, user_id, course_id, status, completed_at)
      values ('${ISO_LEARNER_ENROLLMENT}', '${ISO_LEARNER_PROFILE}', '${ISO_COURSE_ID}',
              'completed', now() - interval '1 hour')
      on conflict (id) do nothing;
      insert into public.assessment_attempts
        (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
         lease_expires_at, started_at, expires_at, submitted_at, score_pct, passed,
         question_count, correct_count)
      values ('${ISO_LEARNER_ATTEMPT}', '${SEED_EXAM_ID}', '${ISO_LEARNER_PROFILE}',
              '${ISO_LEARNER_ENROLLMENT}', '${SEED_RULES_ID}', 1, 'passed',
              'e9-dcr8-iso-session', now() - interval '2 hours', now() - interval '2 hours',
              now() + interval '1 hour', now() - interval '30 minutes', 100, true, 5, 5)
      on conflict (id) do nothing;
      insert into public.cert_bulk_jobs (id, created_by, course_id, status, created_at)
      values ('${ISO_JOB_OLD_ID}', '${ISO_STAFF_ID}', '${ISO_COURSE_ID}', 'pending',
              now() - interval '10 minutes'),
             ('${ISO_JOB_NEW_ID}', '${ISO_STAFF_ID}', '${ISO_COURSE_ID}', 'pending',
              now() - interval '5 minutes')
      on conflict (id) do nothing;
    `);
  }, 240_000);

  afterAll(async () => {
    // จบเสมอแม้ test ก่อนหน้าล้ม — DB ทดสอบไม่ค้างบน cluster
    await psql(`drop database if exists ${ISO_DB} with (force);`);
  });

  it("iso: step(null) หยิบ job เก่าที่สุด — ออกใบจริง 1 ใบให้คนเดียวของคิว (completed 1/0/1)", async () => {
    const first = await isoCall<StepResult>(
      "call public.admin_cert_bulk_issue_step(null, 1000, null)",
    );
    expect(Object.keys(first).sort()).toEqual([
      "failed_count",
      "issued_count",
      "job_id",
      "status",
      "total_attempts",
    ]);
    expect(first.job_id).toBe(ISO_JOB_OLD_ID); // เก่า (10 นาที) ถูกหยิบก่อนใหม่ (5 นาที)
    expect(first.status).toBe("completed");
    expect(first.issued_count).toBe(1);
    expect(first.failed_count).toBe(0);
    expect(first.total_attempts).toBe(1);

    // ใบ valid actor = ผู้สร้าง job (สัญญาเดียวกับฝั่ง DB ร่วม — mode='bulk')
    const certs = await isoRows<{ n: number; issuedBy: string; status: string }>(`
      select count(*)::int as n, min(issued_by::text) as "issuedBy", min(status::text) as status
        from public.certificates
       where enrollment_id = '${ISO_LEARNER_ENROLLMENT}';
    `);
    expect(certs[0]?.n).toBe(1);
    expect(certs[0]?.issuedBy).toBe(ISO_STAFF_ID);
    expect(certs[0]?.status).toBe("valid");
  }, 120_000);

  it("iso: job ที่เหลือถูกจบก่อน (anti-join) → step(null) คืน idle — ไม่มี job ต่างชุดโดยก่อสร้าง (r3 MAJOR-2)", async () => {
    // job ใหม่ (5 นาที) ยัง pending: step(null) หยิบมาจบ (คิวว่างด้วย anti-join —
    // ผู้เรียนมีใบ valid จาก test ก่อนแล้ว)
    const drain = await isoCall<StepResult>(
      "call public.admin_cert_bulk_issue_step(null, 1000, null)",
    );
    expect(drain.job_id).toBe(ISO_JOB_NEW_ID);
    expect(drain.status).toBe("completed");
    expect(drain.issued_count).toBe(0);
    expect(drain.failed_count).toBe(0);
    expect(drain.total_attempts).toBe(0);

    // โลกของ DB นี้ว่างจริง — idle { job_id: null, status: 'idle' } สองคีย์เท่านั้น
    // (ไม่มีขั้น "ตรวจก่อนเรียก" บน DB ร่วมให้ job ต่างชุดหลุดเข้ามาระหว่างสอง statement)
    const idle = await isoCall<StepResult>(
      "call public.admin_cert_bulk_issue_step(null, 1000, null)",
    );
    expect(Object.keys(idle).sort()).toEqual(["job_id", "status"]);
    expect(idle.job_id).toBeNull();
    expect(idle.status).toBe("idle");
  }, 120_000);
});

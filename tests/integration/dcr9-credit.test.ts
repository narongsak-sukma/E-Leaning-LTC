/**
 * DCR-9 — integration tests ของ Wave E Phase 3 กลไกธนาคารหน่วยกิต บน dev stack จริง
 * (migration 0031_credit_bank.sql — C-1..C-10):
 *   1) accrual idempotent — สอบผ่าน → event_outbox topic 'credit.accrual' 1 แถว (snapshot กฎ
 *      ตอนตรวจ ตาม submit_attempt_core v3) → เรียก credit_accrual_tick() ตรง (ไม่รอ cron
 *      ltc-credit-accrual ที่รันทุก 1 นาทีบน dev DB) → ledger 'accrual' 1 แถว amount ตาม
 *      snapshot · ส่ง event ซ้ำ (re-delivery) + เรียก tick ซ้ำ → ledger ไม่เพิ่ม (tick รายงาน
 *      already_accrued — INSERT ... ON CONFLICT DO NOTHING บน partial UNIQUE ของ 0006)
 *   2) snapshot-at-grading + retire กลางคิว — จับกฎตอนตรวจ → retire กฎนั้นก่อน tick → ledger
 *      ยังใช้ค่า snapshot เดิม (F17 — consumer ไม่ lookup กฎซ้ำ)
 *   3) lazy cycle — lawyer ที่ไม่เคยมีรอบ: tick สร้าง renewal_cycles รอบแรก (anchor = role
 *      lawyer เก่าสุด) คลุมวันสอบผ่าน · เรียก ensure_renewal_cycle ซ้ำ = ได้รอบเดิม
 *   4) citizen skip — citizen สอบผ่าน: tick ปิด event เป็น processed + นับ no_cycle_target
 *      แต่ไม่สร้างรอบ/ledger ให้ (C-4)
 *   5) reversal — ออกใบ → เพิกถอน (admin_revoke_certificate v2): reversal −accrual ใน TX
 *      เดียวกับการเพิกถอน + audit CREDIT_REVERSAL · เพิกถอนซ้ำปฏิเสธ (ERR-VAL-001|not_valid)
 *   6) adjustment authz — admin_credit_adjust: staff:viewer โดน ERR-RBAC-001 · registrar
 *      reason สั้นโดน ERR-CRD-002 · registrar ครบชุด → แถว adjustment + audit CREDIT_ADJUST
 *   7) append-only — UPDATE/DELETE credit_ledger_entries ถูกปฏิเสธ (revoke + trigger 0010)
 *   8) summary math — ledger 3 รายการ (+3.50 / −3.50 / −1.25) → my_credit_summary ของเจ้าของ
 *      earned −1.25 · missing 13.25 (เกณฑ์ default Q1 {general: 12})
 *
 * การแยกโลกของ suite (ไม่ชน seed/ชุดอื่น):
 *   - หลักสูตร fixture 2 หลักสูตรของตัวเอง (is_public=true ให้ citizen ลงทะเบียนได้) +
 *     ข้อสอบเร็วของตัวเอง (2 โจทย์ 1 แต้ม · ผ่าน ≥70% = ต้องถูกทั้งคู่) — id ตายตัวของ suite
 *   - credit_rules สร้างใหม่ต่อรัน (code/id ผูกกับ timestamp ของรัน) — เพราะ retire เป็น
 *     one-way (trigger 0010 อนุญาต draft->active / ->retired เท่านั้น) หากใช้ id ตายตัวแล้ว
 *     run ก่อนพังกลางทางค้างสถานะ retired ไว้ รันใหม่จะพังทันที
 *   - id ตัวเลือกข้อสอบ (question_options) ใช้เนมสเปซ f3f3f3f3 ของตัวเอง — ห้ามคัดลอก
 *     scheme f1f1f1f1 ของ helpers-d8 เด็ดขาด (ชน pkey กับของค้างของชุดอื่นใน DB ร่วม)
 *   - cron จริง `ltc-credit-accrual` (ทุกนาที) ถูกพักช่วงรัน suite (cron.unschedule) แล้ว
 *     ตั้งคืนตามนิยาม 0031 §10 ตัวอักษรเดียวใน afterAll — ตัวเลขของ test จึง deterministic
 *     (แบบแผนเดียวกับ pauseCertCrons ของ DCR-8) · ก่อน seed ระบายคิว event ค้างให้หมดก่อน
 *   - NB: audit_logs + credit_ledger_entries เป็น append-only ตามดีไซน์ — suite ไม่แตะแถว
 *     audit_logs คงไว้เหมือนชุดเดิม · เฉพาะ ledger ของผู้ใช้ fixture ตัวเองที่ต้องล้างเพื่อ
 *     คลาย FK (renewal_cycles/profiles) ให้ beforeAll ทำซ้ำได้: ลบภายใต้ TX เดียวที่ disable
 *     trigger trg_append_only_rows → delete → enable คืน (transactional DDL — ถ้าตายกลาง
 *     ทาง TX rollback ทำให้ trigger กลับมา enabled เองเสมอ) · ขอบเขตลบ = user_id ของผู้ใช้
 *     ทดสอบ suite นี้เท่านั้น (email pattern 'dcr9-credit-%')
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ANON_KEY,
  createTestUser,
  psql,
  psqlRows,
  psqlScalar,
  restCall,
  SERVICE_KEY,
  type RestResult,
  type TestUser,
} from "./helpers.js";
import { jwtPayload, knownCorrectAnswers, STAFF_EXAM_DEMO_ID } from "./helpers-d8.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── id ตายตัวของ fixture ชุดนี้ (เนมสเปซ e12 ของตัวเอง — ไม่ชน seed และชุดอื่น) ────

/** หลักสูตรหลักของ suite (ผู้ใช้ main/cycle/citizen) — published + is_public */
const E12_COURSE_MAIN = "cccccccc-cccc-4ccc-8ccc-e12c0000000a";
/** หลักสูตรของเคส snapshot (ผู้ใช้ snap) — แยกหลักสูตรเพื่อให้กฎ SNAP เป็นกฎเดียวที่แพ่งชนะ */
const E12_COURSE_SNAP = "cccccccc-cccc-4ccc-8ccc-e12c0000000b";
/** รอบสอบเร็ว 2 รอบ (หลัก/สแนป) — time_limit 5 นาที · cooldown 0 · max 5 · 2 โจทย์ 1 แต้ม */
const E12_ASSESSMENTS = {
  main: "cccccccc-cccc-4ccc-8ccc-00000000e12a",
  snap: "cccccccc-cccc-4ccc-8ccc-00000000e12b",
} as const;
const E12_RULES_IDS = {
  main: "dddddddd-dddd-4ddd-8ddd-00000000e12a",
  snap: "dddddddd-dddd-4ddd-8ddd-00000000e12b",
} as const;
const E12_BANKS = {
  main: "eeeeeeee-eeee-4eee-8eee-00000000e12a",
  snap: "eeeeeeee-eeee-4eee-8eee-00000000e12b",
} as const;

/** โจทย์ 2 ข้อต่อรอบสอบ (single_choice · เฉลย = ตัวเลือกลำดับ 1 เสมอ — ฝั่ง harness รู้เฉลย
 *  จาก DB ผ่าน psql ตามกติกา C-7) */
const E12_QUESTIONS = {
  main: [
    "f0f0f0f0-f0f0-4f0f-8f0f-00000000e12a",
    "f0f0f0f0-f0f0-4f0f-8f0f-00000000e12b",
  ],
  snap: [
    "f0f0f0f0-f0f0-4f0f-8f0f-00000000e12c",
    "f0f0f0f0-f0f0-4f0f-8f0f-00000000e12d",
  ],
} as const;

/** ตัวเลือก 4 ตัวต่อข้อ — id ล็อกรูป f3f3f3f3-...-00e120000<ข้อ><ลำดับ> — เนมสเปซ f3f3f3f3
 *  เป็นของ suite นี้แต่เพียงผู้เดียว ห้ามยืม prefix ของ suite อื่น (เช่น f1f1f1f1 ของ
 *  helpers-d8 — เดิมเคยคัดลอกมาแล้วชน pkey กับ options ที่ชุดอื่นทิ้งค้างใน DB ตาม
 *  ลำดับไฟล์ที่ vitest เรียงในแต่ละรัน — pkey ของ question_options คือ guard ร่วมกัน) */
function optionId(questionKey: string, optionNo: number): string {
  return `f3f3f3f3-f3f3-4f3f-8f3f-00e120000${questionKey}${optionNo}`;
}

interface QuestionSeed {
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly correct: string;
  readonly wrongs: readonly [string, string, string];
}

const QUESTIONS_MAIN: readonly QuestionSeed[] = [
  {
    id: E12_QUESTIONS.main[0] ?? "",
    key: "a1",
    text: "D9 ข้อ 1 (หลัก): สัญญาซื้อขายที่ไม่มีการบอกชั้นต้นผู้ซื้อเกี่ยวกับตำหนิสินค้า ผู้ขายต้องรับผิดอย่างไร",
    correct: "รับผิดต่อผู้ซื้อในความเสียหายจากตำหนิสินค้านั้น",
    wrongs: ["ไม่ต้องรับผิดเพราะผู้ซื้อตรวจสอบเอง", "รับผิดเฉพาะเมื่อสัญญาระบุไว้", "ถือว่าสัญญาเป็นโมฆียะทั้งสัญญา"],
  },
  {
    id: E12_QUESTIONS.main[1] ?? "",
    key: "b1",
    text: "D9 ข้อ 2 (หลัก): การฟ้องคดีในศาลแขวง เงื่อนไขเกี่ยวกับทุนทรัพย์เป็นอย่างไร",
    correct: "โต้แย้งทุนทรัพย์ต้องไม่เกินที่กฎหมายกำหนดสำหรับศาลแขวง",
    wrongs: ["ฟ้องได้ทุนทรัพย์เท่าใดก็ได้", "ต้องมีทุนทรัพย์ขั้นต่ำตามกฎหมาย", "ห้ามฟ้องเรื่องทุนทรัพย์ในศาลแขวง"],
  },
];

const QUESTIONS_SNAP: readonly QuestionSeed[] = [
  {
    id: E12_QUESTIONS.snap[0] ?? "",
    key: "c1",
    text: "D9 ข้อ 1 (สแนป): คำฟ้องที่ขาดองค์ประกอบของฟ้อง ศาลมีอำนาจสั่งอย่างไร",
    correct: "สั่งให้แก้ไขคำฟ้องให้รับมาโดยกำหนดเวลาให้",
    wrongs: ["ยกฟ้องทันทีโดยไม่สั่งแก้ไข", "พิพากษายกคำฟ้องเป็นอันขาด", "ส่งคำฟ้องคืนผู้ฟ้องโดยไม่บันทึก"],
  },
  {
    id: E12_QUESTIONS.snap[1] ?? "",
    key: "d1",
    text: "D9 ข้อ 2 (สแนป): การรับฟ้องและนัดสืบพยาน ศาลต้องจัดให้มีการไกล่เกลี่ยหรือไม่",
    correct: "ต้องจัดการไกล่เกลี่ยก่อนพิจารณาแก่นคดีตามที่กฎหมายวางไว้",
    wrongs: ["ไกล่เกลี่ยเมื่อคู่ความร้องขอเท่านั้น", "ห้ามไกล่เกลี่ยในคดีแพ่ง", "ไกล่เกลี่ยหลังพิพากษาชั้นต้น"],
  },
];

/** จุดอ้างอิงเวลาของรัน — ใช้ทำ code ของ credit_rules ไม่ให้ซ้ำข้ามรัน */
const RUN_ID = Date.now();
const RULE_MAIN_CODE = `CR-E12-MAIN-${RUN_ID}`;
const RULE_SNAP_CODE = `CR-E12-SNAP-${RUN_ID}`;
/** ค่า credit ของกฎทั้งสอง (numeric(6,2)) — assert เทียบ text เป๊ะ */
const RULE_MAIN_CREDITS = "3.50";
const RULE_SNAP_CREDITS = "2.50";

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ────────────────────────────────────────────────

/** main (lawyer) — ห่วงโซ่เคส 1 accrual → เคส 5 reversal → เคส 6 เป้า adjustment → เคส 8 summary */
let mainUser: TestUser;
let snapUser: TestUser; // snap (lawyer) — เคส 2 snapshot + retire กลางคิว
let cycleUser: TestUser; // cycle (lawyer) — เคส 3 lazy cycle
let citizenUser: TestUser; // citizen — เคส 4 citizen skip
let viewerUser: TestUser; // staff:viewer — เคส 6 ฝั่งถูกปฏิเสธ
let registrarUser: TestUser; // staff:registrar — เคส 6 ฝั่งดำเนินการสำเร็จ

interface StartResult {
  readonly attempt_id: string;
}
interface SubmitResult {
  readonly status: string;
  readonly passed: boolean;
  readonly score_pct: number;
}
interface TickResult {
  readonly skipped: boolean;
  readonly processed: number;
  readonly already_accrued: number;
  readonly no_cycle_target: number;
  readonly failed: number;
}
interface LedgerRow {
  readonly id: string;
  readonly entry_type: string;
  readonly credit_type: string;
  readonly amount: string;
  readonly source_type: string;
  readonly source_id: string | null;
  readonly original_entry_id: string | null;
  readonly rule_id: string | null;
  readonly created_by: string | null;
}

/** เรียก RPC ในนาม service_role (ทางเดียวที่ suite เข้าถึงได้ตาม 0019 — ออกใบ/เพิกถอน) */
function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/** เรียก RPC ในนามผู้ใช้ (JWT จริงจาก GoTrue — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
}

/** เรียก credit_accrual_tick() ตรงผ่าน psql (superuser มี EXECUTE ตาม 0031) — parse jsonb */
async function runTick(): Promise<TickResult> {
  const out = await psql(`select public.credit_accrual_tick();`);
  return JSON.parse(out.trim()) as TickResult;
}

/** พัก cron จริงของ credit ช่วงรัน suite — ไม่พักแล้ว worker จริง (ทุกนาที) จะกลืน event
 *  ของ fixture ก่อน tick ของ test ทำตัวเลขไม่ deterministic · ตั้งคืนใน afterAll (finally) */
async function pauseCreditCron(): Promise<void> {
  await psql(`
    do $do$
    begin
      if exists (select 1 from cron.job where jobname = 'ltc-credit-accrual') then
        perform cron.unschedule('ltc-credit-accrual');
      end if;
    end
    $do$;
  `);
}

/** ตั้ง cron ของ credit คืนตามนิยาม 0031 §10 ทุกตัวอักษร (idempotent — รันซ้ำได้) */
async function restoreCreditCron(): Promise<void> {
  await psql(`
    do $do$
    begin
      if not exists (select 1 from cron.job where jobname = 'ltc-credit-accrual') then
        perform cron.schedule('ltc-credit-accrual', '* * * * *',
          'select public.credit_accrual_tick()');
      end if;
    end
    $do$;
  `);
}

/** ระบายคิว event ค้าง (จากครั้งก่อน/ชุดอื่น) จน tick ไม่ประมวลผลอะไร — เพื่อให้ตัวเลข
 *  counter ของ tick ระหว่างเทสสะท้อนเฉพาะ event ของ fixture (แถว failed ที่ backoff
 *  available_at ไกลออกไปไม่ถูกหยิบ จึงไม่รบกวนตัวเลข) */
async function drainAccrualQueue(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const result = await runTick();
    if (result.processed + result.already_accrued + result.no_cycle_target === 0) {
      return;
    }
  }
}

/** ล้าง ledger ของผู้ใช้ fixture ภายใต้ TX เดียวกับการ disable/enable trigger append-only —
 *  (เหตุผล + ความปลอดภัยดู header ไฟล์) · ขอบเขต user list เป๊ะ ไม่แตะของคนอื่น */
async function purgeLedgerOf(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const list = userIds.map((id) => `'${id}'`).join(",");
  await psql(`
    begin;
    alter table public.credit_ledger_entries disable trigger trg_append_only_rows;
    delete from public.credit_ledger_entries where user_id in (${list});
    alter table public.credit_ledger_entries enable trigger trg_append_only_rows;
    commit;
  `);
}

/** ล้างโลกของ suite ทั้งชุด (เรียงตาม FK — RESTRICT) ครอบคลุมของค้างจากรอบที่พังกลางทาง ·
 *  audit_logs เป็น append-only ตามดีไซน์ — ตั้งใจคงไว้ (เหมือนชุด D-8) */
async function cleanupE12World(): Promise<void> {
  const users = await psqlRows<{ id: string }>(
    `select id::text from auth.users where email like 'dcr9-credit-%';`,
  );
  // ก้อน user-scoped — รันเมื่อมีผู้ใช้ทดสอบค้างอยู่เท่านั้น (กัน `in ('')` uuid พัง)
  if (users.length > 0) {
    const list = users.map((u) => `'${u.id}'`).join(",");
    await psql(`
      delete from public.event_outbox
       where payload ->> 'source_id' in (select id::text from public.assessment_attempts
                                          where assessment_id in ('${E12_ASSESSMENTS.main}', '${E12_ASSESSMENTS.snap}'))
          or (topic = 'credit.accrual' and payload ->> 'user_id' in (${list}));
      delete from public.attempt_answers
       where attempt_id in (select id from public.assessment_attempts
                             where assessment_id in ('${E12_ASSESSMENTS.main}', '${E12_ASSESSMENTS.snap}'));
      delete from public.assessment_attempts
       where assessment_id in ('${E12_ASSESSMENTS.main}', '${E12_ASSESSMENTS.snap}');
      delete from public.certificate_verifications
       where verify_code in (select verify_code from public.certificates where user_id in (${list}));
      delete from public.certificates where user_id in (${list});
    `);
    await purgeLedgerOf(users.map((u) => u.id));
    await psql(`
      delete from public.renewal_cycles where user_id in (${list});
      delete from public.lesson_progress
       where enrollment_id in (select id from public.enrollments where user_id in (${list}));
      delete from public.enrollments where user_id in (${list});
      delete from public.role_assignments where user_id in (${list});
      delete from public.profiles where id in (${list});
      delete from auth.users where email like 'dcr9-credit-%';
    `);
  }
  // ก้อน fixture — id ตายตัวของ suite ลบได้เสมอ (ครั้งแรกที่ยังไม่มีผู้ใช้ก็ต้องผ่าน)
  await psql(`
    delete from public.credit_rules where code like 'CR-E12-%';
    delete from public.question_options
     where question_id in (${[...E12_QUESTIONS.main, ...E12_QUESTIONS.snap].map((id) => `'${id}'`).join(",")});
    delete from public.questions
     where bank_id in ('${E12_BANKS.main}', '${E12_BANKS.snap}');
    delete from public.question_banks where id in ('${E12_BANKS.main}', '${E12_BANKS.snap}');
    delete from public.assessment_rules where id in ('${E12_RULES_IDS.main}', '${E12_RULES_IDS.snap}');
    delete from public.assessments where id in ('${E12_ASSESSMENTS.main}', '${E12_ASSESSMENTS.snap}');
    delete from public.credit_rules where code like 'CR-E12-%';
    delete from public.courses where id in ('${E12_COURSE_MAIN}', '${E12_COURSE_SNAP}');
  `);
}

/** seed หลักสูตร + ข้อสอบเร็ว + กฎ credit ของรันนี้ (id ตายตัว + on conflict do nothing —
 *  เรียกซ้ำได้ · กฎใช้ code/id ต่อรัน ตามเหตุผลใน header) */
async function seedE12Fixtures(): Promise<void> {
  await psql(`
    insert into public.courses
      (id, code, category_id, created_by, title_th, is_public, status, published_at)
    values
      ('${E12_COURSE_MAIN}', 'E12-DCR9-M',
       (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
       'หลักสูตรทดสอบ DCR-9 หลัก (integration)', true, 'published', now()),
      ('${E12_COURSE_SNAP}', 'E12-DCR9-S',
       (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
       'หลักสูตรทดสอบ DCR-9 snapshot (integration)', true, 'published', now())
    on conflict (id) do nothing;
  `);
  for (const which of ["main", "snap"] as const) {
    const questions = which === "main" ? QUESTIONS_MAIN : QUESTIONS_SNAP;
    const assessmentId = E12_ASSESSMENTS[which];
    const rulesId = E12_RULES_IDS[which];
    const bankId = E12_BANKS[which];
    const courseId = which === "main" ? E12_COURSE_MAIN : E12_COURSE_SNAP;
    await psql(`
      insert into public.assessments
        (id, course_id, code, title, description, is_final, status, published_at) values
        ('${assessmentId}', '${courseId}', 'EXAM-E12-${which}', 'สอบเร็ว D-9 (${which})', null,
         false, 'published', now())
      on conflict (id) do nothing;
    `);
    await psql(`
      insert into public.assessment_rules
        (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
         attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection,
         require_course_complete, proctoring_mode, effective_from) values
        ('${rulesId}', '${assessmentId}', 1, 5, ${questions.length}, 70, 5,
         0, false, false, '{"bank_ids":["${bankId}"]}'::jsonb, false, 'none', now() - interval '1 day')
      on conflict (id) do nothing;
    `);
    await psql(`
      insert into public.question_banks
        (id, code, name, created_by, course_id, description, is_active) values
        ('${bankId}', 'QB-EXAM-E12-${which}', 'ธนาคารข้อสอบ D-9 ${which}', '${STAFF_EXAM_DEMO_ID}',
         '${courseId}', 'seed สอบเร็วของ suite DCR-9', true)
      on conflict (id) do nothing;
    `);
    await psql(`
      insert into public.questions
        (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
      values ${questions
        .map(
          (q) => `('${q.id}', '${bankId}', 'single_choice', 'easy', '${q.text}',
                  'คำอธิบายของ D-9', 1, 'draft', array['d9-integration'], '${STAFF_EXAM_DEMO_ID}', 1)`,
        )
        .join(",\n        ")};
    `);
    await psql(`
      insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
      values ${questions
        .map((q) => {
          return [
            `('${optionId(q.key, 1)}', '${q.id}', '${q.correct}', true, 1)`,
            `('${optionId(q.key, 2)}', '${q.id}', '${q.wrongs[0]}', false, 2)`,
            `('${optionId(q.key, 3)}', '${q.id}', '${q.wrongs[1]}', false, 3)`,
            `('${optionId(q.key, 4)}', '${q.id}', '${q.wrongs[2]}', false, 4)`,
          ].join(",\n        ");
        })
        .join(",\n        ")};
    `);
  }
  // เปิดใช้งานโจทย์ในนาม profile สาธิต staff:exam (guard_question_activation ต้องผ่าน)
  await psql(`
    begin;
    set local "request.jwt.claims" = '{"sub":"${STAFF_EXAM_DEMO_ID}","role":"authenticated"}';
    update public.questions set status = 'active'
     where id in (${[...E12_QUESTIONS.main, ...E12_QUESTIONS.snap].map((id) => `'${id}'`).join(",")});
    commit;
  `);
  // กฎ credit ของรันนี้ — SNAP priority 10 ชนะในหลักสูตรสแนป · MAIN priority 10 ในหลักสูตรหลัก
  await psql(`
    insert into public.credit_rules
      (code, name, course_id, credit_type, credits, valid_days, carry_over,
       required_credits_per_cycle, priority, effective_from, status, renewal_cycle) values
      ('${RULE_MAIN_CODE}', 'กฎหลักของ DCR-9 (+${RULE_MAIN_CREDITS})', '${E12_COURSE_MAIN}',
       'general', ${RULE_MAIN_CREDITS}, 365, false, 12.00, 10, now() - interval '1 day',
       'active', 'annual'),
      ('${RULE_SNAP_CODE}', 'กฎ snapshot ของ DCR-9 (+${RULE_SNAP_CREDITS})', '${E12_COURSE_SNAP}',
       'general', ${RULE_SNAP_CREDITS}, 365, false, 12.00, 10, now() - interval '1 day',
       'active', 'annual');
  `);
}

/** อ่าน id กฎของรันนี้ (insert แบบ default id — อ่านกลับด้วย code) */
async function ruleIdByCode(code: string): Promise<string> {
  return psqlScalar(`select id::text from public.credit_rules where code = '${code}';`);
}

/** ลงทะเบียนหลักสูตรด้วย RPC จริง (ทางเดียวกับ BFF) — คืน enrollment id */
async function enrollViaRpc(user: TestUser, courseId: string): Promise<string> {
  const result = await restCall(
    "POST",
    `/rest/v1/rpc/enroll`,
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_course_id: courseId },
  );
  expect(result.status, result.text.slice(0, 300)).toBe(200);
  return psqlScalar(
    `select id::text from public.enrollments
      where user_id = '${user.id}' and course_id = '${courseId}' limit 1;`,
  );
}

/** สอบผ่านผ่าน RPC จริงทั้ง flow: start → save (เฉลยจาก DB ฝั่ง harness) → submit แล้วคืน
 *  attempt id (assert ผ่าน 100 เสมอ — เฉลยถูกทุกข้อของ 2 โจทย์ 1 แต้ม) */
async function passExamViaRest(
  user: TestUser,
  which: "main" | "snap",
): Promise<string> {
  const start = await restCall(
    "POST",
    "/rest/v1/rpc/start_attempt",
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_assessment_id: E12_ASSESSMENTS[which] },
  );
  expect(start.status, start.text.slice(0, 300)).toBe(200);
  const attemptId = (start.json as StartResult).attempt_id;
  const answers = await knownCorrectAnswers(E12_QUESTIONS[which]);
  for (const [questionId, correct] of answers) {
    const saved = await restCall(
      "POST",
      "/rest/v1/rpc/save_answer",
      { apiKey: ANON_KEY, token: user.accessToken },
      {
        p_attempt_id: attemptId,
        p_question_id: questionId,
        p_selected_option_ids: [correct],
        p_session_id: jwtPayload(user.accessToken).session_id ?? "",
      },
    );
    expect(saved.status, saved.text.slice(0, 300)).toBeLessThan(300);
  }
  const submit = await restCall(
    "POST",
    "/rest/v1/rpc/submit_attempt",
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_attempt_id: attemptId, p_session_id: jwtPayload(user.accessToken).session_id ?? "" },
  );
  expect(submit.status, submit.text.slice(0, 300)).toBe(200);
  const body = submit.json as SubmitResult;
  expect(body.status).toBe("passed");
  expect(body.passed).toBe(true);
  expect(body.score_pct).toBe(100);
  return attemptId;
}

describe.skipIf(!DB_URL)(
  "DCR-9 ธนาคารหน่วยกิต (กลไกของ 0031 บน DB จริง — accrual/lazy cycle/reversal/adjustment/summary)",
  () => {
    beforeAll(async () => {
      await cleanupE12World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
      await pauseCreditCron(); // พัก worker จริงช่วงรัน suite (ตั้งคืนใน afterAll)
      await drainAccrualQueue(); // ระบาย event ค้างให้คิวว่างก่อนเริ่ม
      await seedE12Fixtures();
      mainUser = await createTestUser("dcr9-credit-main", "lawyer");
      snapUser = await createTestUser("dcr9-credit-snap", "lawyer");
      cycleUser = await createTestUser("dcr9-credit-cycle", "lawyer");
      citizenUser = await createTestUser("dcr9-credit-citizen", "citizen");
      viewerUser = await createTestUser("dcr9-credit-viewer", "staff:viewer");
      registrarUser = await createTestUser("dcr9-credit-registrar", "staff:registrar");
      await enrollViaRpc(mainUser, E12_COURSE_MAIN);
      await enrollViaRpc(cycleUser, E12_COURSE_MAIN);
      await enrollViaRpc(citizenUser, E12_COURSE_MAIN);
      await enrollViaRpc(snapUser, E12_COURSE_SNAP);
    }, 300_000);

    afterAll(async () => {
      // คืน cron จริงของ dev stack เสมอ (try/finally — cleanup ล้มห้ามทิ้ง worker ตายเงียบ)
      try {
        await cleanupE12World();
      } finally {
        await restoreCreditCron();
      }
    });

    // ─── เคส 1: accrual idempotent (โจทย์ข้อ 1) ─────────────────────────────────

    it("เคส 1 accrual idempotent: สอบผ่าน → event credit.accrual 1 แถว (snapshot กฎตอนตรวจ) → tick ตรง → ledger accrual 1 แถว 3.50 · ส่ง event ซ้ำ + tick ซ้ำ → แถวไม่เพิ่ม (already_accrued)", async () => {
      const attemptId = await passExamViaRest(mainUser, "main");
      // event เกิดใน TX เดียวกับการตรวจ — 1 แถว พร้อม snapshot กฎของหลักสูตรหลัก
      const events = await psqlRows<{ id: string; credits: string; rule: string; req: string | null }>(`
        select id::text,
               payload -> 'rule' ->> 'credits' as credits,
               payload -> 'rule' ->> 'rule_id' as rule,
               payload -> 'rule' ->> 'required_credits_per_cycle' as req
          from public.event_outbox
         where topic = 'credit.accrual' and payload ->> 'source_id' = '${attemptId}';
      `);
      expect(events).toHaveLength(1);
      const mainRuleId = await ruleIdByCode(RULE_MAIN_CODE);
      expect(events[0]?.credits).toBe(RULE_MAIN_CREDITS);
      expect(events[0]?.rule).toBe(mainRuleId);
      expect(events[0]?.req).toBe("12.00");
      // เรียก tick ตรง (ไม่รอ cron) — ledger เกิดจาก snapshot ของ event
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.processed).toBeGreaterThanOrEqual(1);
      const ledger = await psqlRows<LedgerRow>(`
        select id::text, entry_type::text, credit_type, amount::text, source_type::text,
               source_id::text, original_entry_id::text, rule_id::text, created_by::text
          from public.credit_ledger_entries
         where user_id = '${mainUser.id}' and entry_type = 'accrual';
      `);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.amount).toBe(RULE_MAIN_CREDITS);
      expect(ledger[0]?.credit_type).toBe("general");
      expect(ledger[0]?.source_id).toBe(attemptId);
      expect(ledger[0]?.rule_id).toBe(mainRuleId);
      expect(ledger[0]?.source_type).toBe("assessment_attempt");
      // ตรวจว่า audit CREDIT_ACCRUAL ถูกบันทึก ณ INSERT สำเร็จ (actor = ระบบ)
      const accrualAudit = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.audit_logs
         where action = 'CREDIT_ACCRUAL' and entity_id::text = '${ledger[0]?.id ?? ""}';
      `);
      expect(accrualAudit[0]?.n).toBe(1);
      // ส่ง event ซ้ำ (re-delivery payload เดิม) + เรียก tick ซ้ำ → ledger ไม่เพิ่ม
      await psql(`
        insert into public.event_outbox (topic, payload)
        select topic, payload from public.event_outbox where id = '${events[0]?.id ?? ""}';
      `);
      const reTick = await runTick();
      expect(reTick.already_accrued).toBeGreaterThanOrEqual(1);
      const after = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.credit_ledger_entries
         where user_id = '${mainUser.id}' and entry_type = 'accrual';
      `);
      expect(after[0]?.n).toBe(1);
    });

    // ─── เคส 2: snapshot-at-grading + retire กลางคิว (โจทย์ข้อ 2) ───────────────

    it("เคส 2 snapshot-at-grading + retire กลางคิว: จับกฎ 2.50 ตอนตรวจ → retire กฎ → tick ยังใช้ค่า snapshot เดิม (F17 — ผู้บริโภคไม่ lookup กฎซ้ำ)", async () => {
      const snapRuleId = await ruleIdByCode(RULE_SNAP_CODE);
      const attemptId = await passExamViaRest(snapUser, "snap");
      // event จับค่าตอนตรวจ = 2.50 (กฎของหลักสูตรสแนป)
      const events = await psqlRows<{ credits: string; rule: string }>(`
        select payload -> 'rule' ->> 'credits' as credits,
               payload -> 'rule' ->> 'rule_id' as rule
          from public.event_outbox
         where topic = 'credit.accrual' and payload ->> 'source_id' = '${attemptId}';
      `);
      expect(events).toHaveLength(1);
      expect(events[0]?.credits).toBe(RULE_SNAP_CREDITS);
      expect(events[0]?.rule).toBe(snapRuleId);
      // retire กฎ "กลางคิว" (หลัง event เกิด ก่อน tick) — trigger 0010 อนุญาต ->retired
      await psql(`update public.credit_rules set status = 'retired' where id = '${snapRuleId}';`);
      const statuses = await psqlRows<{ status: string }>(`
        select status::text from public.credit_rules where id = '${snapRuleId}';
      `);
      expect(statuses[0]?.status).toBe("retired");
      // tick ต้องใช้ค่า snapshot เดิม — ถ้า lookup กฎซ้ำจะไม่เจอกฎ active และไม่เกิด ledger
      const tick = await runTick();
      expect(tick.processed).toBeGreaterThanOrEqual(1);
      const ledger = await psqlRows<LedgerRow>(`
        select id::text, entry_type::text, amount::text, rule_id::text
          from public.credit_ledger_entries
         where user_id = '${snapUser.id}' and entry_type = 'accrual';
      `);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.amount).toBe(RULE_SNAP_CREDITS);
      expect(ledger[0]?.rule_id).toBe(snapRuleId);
    });

    // ─── เคส 3: lazy cycle (โจทย์ข้อ 3) ─────────────────────────────────────────

    it("เคส 3 lazy cycle: lawyer ไม่เคยมีรอบ → tick สร้าง renewal_cycles รอบ 1 คลุมวันสอบผ่าน (เกณฑ์ snapshot 12.00) · เรียก ensure_renewal_cycle ซ้ำ = รอบเดิม ไม่สร้างเพิ่ม", async () => {
      const attemptId = await passExamViaRest(cycleUser, "main");
      const passedOn = await psqlScalar(
        `select submitted_at::date::text from public.assessment_attempts where id = '${attemptId}';`,
      );
      const tick = await runTick();
      expect(tick.processed).toBeGreaterThanOrEqual(1);
      const cycles = await psqlRows<{
        id: string;
        cycle_no: number;
        starts_on: string;
        ends_on: string;
        required_general: string;
      }>(`
        select id::text, cycle_no, starts_on::text, ends_on::text,
               required_credits ->> 'general' as required_general
          from public.renewal_cycles
         where user_id = '${cycleUser.id}';
      `);
      expect(cycles).toHaveLength(1);
      const cycle = cycles[0];
      expect(cycle?.cycle_no).toBe(1);
      // รอบคลุมวันสอบผ่านเสมอ (lazy — สร้างรอบที่ cover วันที่สนใจ ไม่ backfill)
      expect(cycle ? passedOn >= cycle.starts_on : false).toBe(true);
      expect(cycle ? passedOn <= cycle.ends_on : false).toBe(true);
      // เกณฑ์ของรอบ = snapshot required_credits_per_cycle จากกฎของ event
      expect(cycle?.required_general).toBe("12.00");
      // เรียก ensure_renewal_cycle ซ้ำ (เงื่อนไขเดิม) = ได้รอบเดิม — ไม่สร้างรอบที่สอง
      const again = await psqlScalar(
        `select public.ensure_renewal_cycle('${cycleUser.id}', current_date, null)::text;`,
      );
      expect(again).toBe(cycle?.id ?? "");
      const count = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.renewal_cycles where user_id = '${cycleUser.id}';
      `);
      expect(count[0]?.n).toBe(1);
    });

    // ─── เคส 4: citizen skip (โจทย์ข้อ 4) ───────────────────────────────────────

    it("เคส 4 citizen skip: citizen สอบผ่าน → event processed + no_cycle_target · ไม่มีแถว renewal_cycles/ledger ของเขา", async () => {
      const attemptId = await passExamViaRest(citizenUser, "main");
      const tick = await runTick();
      expect(tick.no_cycle_target).toBeGreaterThanOrEqual(1);
      // event จบเรียบร้อย (processed) ไม่ใช่ failed
      const events = await psqlRows<{ status: string; error: string | null }>(`
        select status::text, last_error as error
          from public.event_outbox
         where topic = 'credit.accrual' and payload ->> 'source_id' = '${attemptId}';
      `);
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe("processed");
      expect(events[0]?.error).toBeNull();
      // ไม่มีรอบ/ledger ให้ผู้ไม่มีสิทธิ์ถือรอบ
      const cycles = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.renewal_cycles where user_id = '${citizenUser.id}';
      `);
      expect(cycles[0]?.n).toBe(0);
      const ledger = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.credit_ledger_entries where user_id = '${citizenUser.id}';
      `);
      expect(ledger[0]?.n).toBe(0);
    });

    // ─── เคส 5: reversal idempotent + amount (โจทย์ข้อ 5) ───────────────────────

    it("เคส 5 reversal: ออกใบ → เพิกถอน → reversal −3.50 ผูก original accrual + audit CREDIT_REVERSAL · เพิกถอนซ้ำปฏิเสธ (ERR-VAL-001|not_valid) · reversal ไม่เพิ่ม", async () => {
      // ปิดการเรียนให้ enrollment ของ main (fixture ตรง — แบบ dcr8 seedLazyPerson)
      const enrollmentId = await psqlScalar(`
        select id::text from public.enrollments
         where user_id = '${mainUser.id}' and course_id = '${E12_COURSE_MAIN}' limit 1;
      `);
      await psql(`
        update public.enrollments set status = 'completed', completed_at = now()
         where id = '${enrollmentId}';
      `);
      const issue = await svcRpc("admin_issue_certificate", {
        p_actor_user_id: STAFF_EXAM_DEMO_ID,
        p_enrollment_id: enrollmentId,
        p_request_id: crypto.randomUUID(),
      });
      expect(issue.status, issue.text.slice(0, 300)).toBe(200);
      const certId = (issue.json as { id: string }).id;
      const accrual = await psqlRows<{ id: string }>(`
        select id::text from public.credit_ledger_entries
         where user_id = '${mainUser.id}' and entry_type = 'accrual';
      `);
      expect(accrual).toHaveLength(1);
      const accrualId = accrual[0]?.id ?? "";
      // เพิกถอนใบ — reversal เกิดใน TX เดียวกัน (0026 ของ 0031)
      const revoke = await svcRpc("admin_revoke_certificate", {
        p_actor_user_id: STAFF_EXAM_DEMO_ID,
        p_certificate_id: certId,
        p_reason: "เพิกถอนเพื่อทดสอบการหักย้อนหน่วยกิตของ DCR-9",
        p_request_id: crypto.randomUUID(),
      });
      expect(revoke.status, revoke.text.slice(0, 300)).toBe(200);
      const body = revoke.json as {
        credit_reversed_rows: number;
        credit_reversed_total: number;
      };
      expect(body.credit_reversed_rows).toBe(1);
      expect(body.credit_reversed_total).toBe(-3.5);
      const ledger = await psqlRows<LedgerRow>(`
        select id::text, entry_type::text, credit_type, amount::text, source_type::text,
               source_id::text, original_entry_id::text, rule_id::text, created_by::text
          from public.credit_ledger_entries
         where user_id = '${mainUser.id}' and entry_type = 'reversal';
      `);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.amount).toBe("-3.50");
      expect(ledger[0]?.credit_type).toBe("general");
      expect(ledger[0]?.source_type).toBe("certificate_revocation");
      expect(ledger[0]?.source_id).toBe(certId);
      expect(ledger[0]?.original_entry_id).toBe(accrualId);
      expect(ledger[0]?.created_by).toBe(STAFF_EXAM_DEMO_ID);
      // audit: CERT_REVOKE + CREDIT_REVERSAL 1 event ต่อการเพิกถอน (context มี original_entry_ids)
      const audits = await psqlRows<{ action: string; n: number }>(`
        select action, count(*)::int as n from public.audit_logs
         where entity_type = 'certificate' and entity_id::text = '${certId}'
           and action in ('CERT_REVOKE', 'CREDIT_REVERSAL')
         group by action;
      `);
      expect(audits).toHaveLength(2);
      for (const row of audits) {
        expect(row.n).toBe(1);
      }
      // เพิกถอนซ้ำ → ปฏิเสธ (ใบไม่ได้อยู่ในสถานะ valid) และ reversal ไม่เพิ่ม
      const again = await svcRpc("admin_revoke_certificate", {
        p_actor_user_id: STAFF_EXAM_DEMO_ID,
        p_certificate_id: certId,
        p_reason: "เพิกถอนซ้ำเพื่อพิสูจน์ idempotency ของการหักย้อน",
        p_request_id: crypto.randomUUID(),
      });
      expect(again.status).toBeGreaterThanOrEqual(400);
      const errBody = (again.json ?? {}) as { message?: string };
      expect(errBody.message ?? "").toContain("ERR-VAL-001");
      expect(errBody.message ?? "").toContain("not_valid");
      const reversalCount = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.credit_ledger_entries
         where user_id = '${mainUser.id}' and entry_type = 'reversal';
      `);
      expect(reversalCount[0]?.n).toBe(1);
    });

    // ─── เคส 6: adjustment authz (โจทย์ข้อ 6) ───────────────────────────────────

    it("เคส 6 adjustment authz: staff:viewer โดน ERR-RBAC-001 · registrar reason สั้นโดน ERR-CRD-002 · registrar ครบชุด → แถว adjustment −1.25 + audit CREDIT_ADJUST", async () => {
      const cycleId = await psqlScalar(
        `select id::text from public.renewal_cycles where user_id = '${mainUser.id}' limit 1;`,
      );
      expect(cycleId).toMatch(/^[0-9a-f-]{36}$/);
      // staff:viewer — ไม่มีสิทธิ์ปรับ credit
      const denied = await userRpc(
        "admin_credit_adjust",
        viewerUser.accessToken,
        {
          p_user_id: mainUser.id,
          p_cycle_id: cycleId,
          p_credit_type: "general",
          p_amount: -1.25,
          p_reason: "viewer ต้องไม่มีสิทธิ์ปรับหน่วยกิต",
          p_request_id: crypto.randomUUID(),
        },
      );
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(((denied.json ?? {}) as { message?: string }).message ?? "").toContain("ERR-RBAC-001");
      // staff:registrar — reason สั้นกว่า 10 ตัวอักษร = ERR-CRD-002
      const shortReason = await userRpc(
        "admin_credit_adjust",
        registrarUser.accessToken,
        {
          p_user_id: mainUser.id,
          p_cycle_id: cycleId,
          p_credit_type: "general",
          p_amount: -1.25,
          p_reason: "สั้นไป",
          p_request_id: crypto.randomUUID(),
        },
      );
      expect(shortReason.status).toBeGreaterThanOrEqual(400);
      expect(((shortReason.json ?? {}) as { message?: string }).message ?? "").toContain("ERR-CRD-002");
      // registrar ครบชุด — สำเร็จ: แถว adjustment + audit CREDIT_ADJUST
      const ok = await userRpc(
        "admin_credit_adjust",
        registrarUser.accessToken,
        {
          p_user_id: mainUser.id,
          p_cycle_id: cycleId,
          p_credit_type: "general",
          p_amount: -1.25,
          p_reason: "ปรับยอดหลังตรวจสอบพบข้อผิดพลาดของระบบ",
          p_request_id: crypto.randomUUID(),
        },
      );
      expect(ok.status, ok.text.slice(0, 300)).toBe(200);
      const okBody = ok.json as { id: string; amount: number };
      const adjustments = await psqlRows<LedgerRow>(`
        select id::text, entry_type::text, credit_type, amount::text, source_type::text,
               source_id::text, original_entry_id::text, rule_id::text, created_by::text
          from public.credit_ledger_entries
         where user_id = '${mainUser.id}' and entry_type = 'adjustment';
      `);
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0]?.amount).toBe("-1.25");
      expect(adjustments[0]?.credit_type).toBe("general");
      expect(adjustments[0]?.source_type).toBe("manual_adjustment");
      expect(adjustments[0]?.source_id).toBeNull();
      expect(adjustments[0]?.original_entry_id).toBeNull();
      expect(adjustments[0]?.created_by).toBe(registrarUser.id);
      expect(okBody.id).toBe(adjustments[0]?.id ?? "");
      const adjustAudit = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.audit_logs
         where action = 'CREDIT_ADJUST' and entity_id::text = '${adjustments[0]?.id ?? ""}';
      `);
      expect(adjustAudit[0]?.n).toBe(1);
    });

    // ─── เคส 7: append-only ledger (โจทย์ข้อ 7) ─────────────────────────────────

    it("เคส 7 append-only: UPDATE/DELETE credit_ledger_entries ถูกปฏิเสธทั้งเจ้าของ (authenticated) และ service_role — แถวเดิมคงเดิมทุกค่า", async () => {
      const accrual = await psqlRows<{ id: string; amount: string }>(`
        select id::text, amount::text from public.credit_ledger_entries
         where user_id = '${mainUser.id}' and entry_type = 'accrual';
      `);
      expect(accrual).toHaveLength(1);
      const ledgerId = accrual[0]?.id ?? "";
      // เจ้าของเองก็แก้/ลบไม่ได้ (revoke update/delete + trigger append-only 0010)
      const patched = await restCall(
        "PATCH",
        `/rest/v1/credit_ledger_entries?id=eq.${ledgerId}`,
        { apiKey: ANON_KEY, token: mainUser.accessToken },
        { amount: 99.99 },
      );
      expect(patched.status).toBeGreaterThanOrEqual(400);
      const removed = await restCall(
        "DELETE",
        `/rest/v1/credit_ledger_entries?id=eq.${ledgerId}`,
        { apiKey: ANON_KEY, token: mainUser.accessToken },
      );
      expect(removed.status).toBeGreaterThanOrEqual(400);
      // service_role ก็ถูก revoke เช่นกัน (DD §4.4)
      const svcPatched = await restCall(
        "PATCH",
        `/rest/v1/credit_ledger_entries?id=eq.${ledgerId}`,
        { apiKey: SERVICE_KEY, token: SERVICE_KEY },
        { amount: 99.99 },
      );
      expect(svcPatched.status).toBeGreaterThanOrEqual(400);
      const svcRemoved = await restCall(
        "DELETE",
        `/rest/v1/credit_ledger_entries?id=eq.${ledgerId}`,
        { apiKey: SERVICE_KEY, token: SERVICE_KEY },
      );
      expect(svcRemoved.status).toBeGreaterThanOrEqual(400);
      // แถวเดิมคงเดิม — จำนวนและยอดไม่เปลี่ยน
      const rows = await psqlRows<{ n: number; amount: string }>(`
        select count(*)::int as n, (select amount::text from public.credit_ledger_entries
                                     where id = '${ledgerId}') as amount
          from public.credit_ledger_entries where user_id = '${mainUser.id}';
      `);
      expect(rows[0]?.n).toBe(3); // accrual + reversal + adjustment
      expect(rows[0]?.amount).toBe(RULE_MAIN_CREDITS);
    });

    // ─── เคส 8: summary math (โจทย์ข้อ 8) ───────────────────────────────────────

    it("เคส 8 summary math: ledger 3 รายการ (+3.50 / −3.50 / −1.25) → my_credit_summary ของเจ้าของ earned −1.25 · missing 13.25 (เกณฑ์ default {general: 12}) · history 1 รอบ", async () => {
      const summary = await userRpc("my_credit_summary", mainUser.accessToken, {});
      expect(summary.status, summary.text.slice(0, 300)).toBe(200);
      const body = summary.json as {
        user_id: string;
        current: {
          cycle_no: number;
          required_credits: Record<string, number>;
          balances: Record<string, { earned: number; required: number; missing: number }>;
        } | null;
        history: readonly {
          cycle_id: string;
          cycle_no: number;
          balances: Record<string, { earned: number; required: number; missing: number }>;
        }[];
      };
      expect(body.user_id).toBe(mainUser.id);
      expect(body.current).not.toBeNull();
      expect(body.current?.cycle_no).toBe(1);
      expect(body.current?.required_credits.general).toBe(12);
      const general = body.current?.balances.general;
      // 3.50 − 3.50 − 1.25 = −1.25 · missing = 12 − (−1.25) = 13.25
      expect(general?.earned).toBe(-1.25);
      expect(general?.required).toBe(12);
      expect(general?.missing).toBe(13.25);
      expect(body.history).toHaveLength(1);
      expect(body.history[0]?.cycle_no).toBe(1);
      expect(body.history[0]?.balances.general?.earned).toBe(-1.25);
    });
  },
);

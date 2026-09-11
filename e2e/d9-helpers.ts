/**
 * d9-helpers.ts — ชุดเครื่องมือของ suite D-9 (e2e-07..11: สอบ + ออกใบ + verify)
 *
 * ทำไมต้องมีไฟล์นี้ (ธงให้ lead): โจทย์สั่งให้ import `seedFastExams()` จาก
 * tests/integration/helpers-d8.ts ต่อ แต่โหลดใต้ Playwright ไม่ได้จริง 2 เหตุผล
 * (ทดลองจริงแล้ว — ดูรายงานธง):
 *  1) helpers-d8.ts ใช้ import แบบมีนามสกุล "./helpers.js" — ไฟล์จริงชื่อ helpers.ts
 *     (vitest map .js→.ts ให้ แต่ require ของ Playwright ไม่แมป → "Cannot find module")
 *  2) tests/integration/helpers.ts มี `import.meta.url` บรรทัดบนสุด — Playwright แปลงไฟล์
 *     เป็น ESM แล้วโหลดไม่ได้เมื่อ entry ของ spec เป็น CJS (.ts ไม่มี type:module)
 * จึงต้องมิเรอร์ id/SQL ของ "สอบเร็ว" มาไว้ที่นี่ (uuid ตายตัวชุดเดียวกับ D8_IDS —
 * cleanup ของสอง suite จึงล้างโลกเดียวกันได้ ไม่ชนกัน)
 *
 * - ไฟล์ใหม่ของ D-9 — ไม่แตะไฟล์เดิมของ e2e/helpers/* ทุกชนิด (import อย่างเดียว)
 * - ผู้ใช้ทดสอบของตัวเอง (d9-*) สร้างผ่าน helper users เดิม (GoTrue จริง + citizen) แล้วเติม
 *   บทบาทผ่าน psql — course 3 (LTC-103) เป็น is_public=false ผู้เรียนต้องมี `lawyer`
 *   (RLS 0010: is_public หรือ has_any_role(['lawyer']) จึงเห็น/ลงทะเบียนได้)
 * - เฉลยข้อสอบอ่านฝั่ง harness จาก DB ผ่าน psql เท่านั้น — UI ต้องไม่มีเฉลย (C-7);
 *   spec ได้แค่ "ข้อความตัวเลือกถูก/ผิด" ไปคลิก checkbox ในห้องสอบ
 */
import { createServerClient } from "@supabase/ssr";
import { expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";

import { psql, psqlRows } from "./helpers/db";
import { ANON_KEY, REST_BASE, TEST_PASSWORD } from "./helpers/env";
import { restCall } from "./helpers/rest";
import { createLearnerUser, type LearnerUser } from "./helpers/users";

// ─── id ตายตัวของ "สอบเร็ว" (มิเรอร์ค่าจาก tests/integration/helpers-d8.ts ชุดเดียวกัน) ──

/** course 3 (LTC-103) — published, is_public=false, มีบทเรียน document 1 บท */
export const COURSE3_ID = "44444444-4444-4444-8444-000000000003";
/** ข้อสอบปลายหลักสูตรจริงของ seed (require_course_complete=true, cooldown 1440, max 3) */
export const SEED_EXAM_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
/** บทเรียน document เดียวของ course 3 */
export const COURSE3_LESSON_ID = "66666666-6666-4666-8666-000000000006";
/** profile สาธิต staff:exam ของ seed (guard_question_activation ต้องผ่านในนามผู้ใช้นี้) */
export const STAFF_EXAM_DEMO_ID = "11111111-1111-4111-8111-000000000002";

/** id ตายตัวของรอบสอบสอบเร็ว FAST-A (max_attempts 2 · cooldown 0 · 4 ข้อ) */
export const FAST_A = {
  assessment: "cccccccc-cccc-4ccc-8ccc-0000000000d8",
  rules: "dddddddd-dddd-4ddd-8ddd-0000000000d8",
  bank: "eeeeeeee-eeee-4eee-8eee-0000000000d8",
  code: "EXAM-D8-FAST-A",
} as const;

/** id โจทย์ 4 ข้อของ FAST-A (เฉลย = ตัวเลือก sort_order 1 เสมอ — ตามธงของ D-8) */
export const FAST_A_QUESTIONS: readonly string[] = [
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d1",
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d2",
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d3",
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d4",
];

/** ตัวเลือก 4 ตัวต่อข้อ — id ล็อกรูป f1f1f1f1-...-000000000<d|e><ข้อที่><ลำดับ> (มิเรอร์ D-8) */
function optionId(questionKey: string, optionNo: number): string {
  return `f1f1f1f1-f1f1-4f1f-8f1f-000000000${questionKey}${optionNo}`;
}

/** โจทย์ FAST-A (ข้อความจริงตาม helpers-d8 — เฉลยอยู่ตัวเลือกลำดับ 1) */
const FAST_A_CONTENT: readonly {
  readonly key: string;
  readonly text: string;
  readonly correct: string;
  readonly wrongs: readonly [string, string, string];
}[] = [
  {
    key: "d1",
    text: "D8 ข้อ 1: องค์ประกอบของคำฟ้องตามกฎหมายวิธีพิจารณาความแพ่ง ไม่รวมข้อใด",
    correct: "คำร้องขอตั้งผู้จัดการมรดก",
    wrongs: ["ชื่อ-ที่อยู่คู่ความ", "เรื่องที่ฟ้อง", "ข้อความกระชับความและข้อสรุปที่ขอให้ศาลวินิจฉัย"],
  },
  {
    key: "d2",
    text: "D8 ข้อ 2: การยื่นคำฟ้องต่อศาลชั้นต้น ผู้ฟ้องคดีต้องทำอย่างไร",
    correct: "ยื่นต่อศาลที่มีเขตอำนาจและเสียค่าธรรมเนียมตามแบบที่กฎหมายวางไว้",
    wrongs: ["ยื่นต่อองค์กรอิสระด้านตุลาการ", "ส่งสำเนาให้ทนายความของจำเลยก่อน", "แจ้งจำเลยด้วยวาจาในที่ประชุม"],
  },
  {
    key: "d3",
    text: "D8 ข้อ 3: หลักฐานเอกสารที่ยื่นฟ้องเป็นภาษาต่างประเทศ ต้องแนบอะไร",
    correct: "คำแปลภาษาไทยที่ทำขึ้นตามกฎหมาย",
    wrongs: ["คำรับรองของผู้ฟ้อง", "สำเนาถ่ายเอกสารเท่านั้น", "ไม่ต้องแนบสิ่งใดเพิ่ม"],
  },
  {
    key: "d4",
    text: "D8 ข้อ 4: คำสั่งของศาลที่ยังไม่สิ้นสุดคดีเมื่อฝ่ายใดฝ่ายหนึ่งไม่ปฏิบัติ ศาลจะสั่งอย่างไร",
    correct: "สั่งให้ฝ่ายนั้นปฏิบัติภายในกำหนดหรือคิดค่าปรับตามที่เห็นสมควร",
    wrongs: ["ยกฟ้องทันที", "พิพากษาเป็นอันขาดแทนคำสั่งเดิม", "สั่งฟ้องพินาศโดยไม่มีเงื่อนไข"],
  },
];

/**
 * seed รอบสอบสอบเร็ว FAST-A บน course 3 — มิเรอร์ seedFastExams() ของ D-8 (เฉพาะ fastA)
 * เท่ากันทุกประการ: rules (5 นาที/70%/max 2/cooldown 0/no shuffle) + bank + โจทย์ draft
 * + ตัวเลือก แล้วเปิดใช้งานโจทย์ในนาม profile สาธิต staff:exam (guard_question_activation)
 * on conflict do nothing ทุก insert → เรียกซ้ำได้ (beforeAll ทำซ้ำได้)
 */
export async function seedFastExamA(): Promise<void> {
  await cleanupFastExamARows();
  await psql(`
    insert into public.assessments
      (id, course_id, code, title, description, is_final, status, published_at) values
      ('${FAST_A.assessment}', '${COURSE3_ID}', '${FAST_A.code}', 'สอบเร็ว D-8 (fastA)', null,
       false, 'published', now())
    on conflict (id) do nothing;
  `);
  await psql(`
    insert into public.assessment_rules
      (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
       attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection,
       require_course_complete, proctoring_mode, effective_from) values
      ('${FAST_A.rules}', '${FAST_A.assessment}', 1, 5, ${FAST_A_CONTENT.length}, 70, 2,
       0, false, false, '{"bank_ids":["${FAST_A.bank}"]}'::jsonb, false, 'none', now() - interval '1 day')
    on conflict (id) do nothing;
  `);
  await psql(`
    insert into public.question_banks
      (id, code, name, created_by, course_id, description, is_active) values
      ('${FAST_A.bank}', 'QB-${FAST_A.code}', 'ธนาคารข้อสอบ D-8 fastA', '${STAFF_EXAM_DEMO_ID}',
       '${COURSE3_ID}', 'seed สอบเร็วของ suite D-8', true)
    on conflict (id) do nothing;
  `);
  await psql(`
    insert into public.questions
      (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
    values ${FAST_A_CONTENT.map(
      (q) => `('${FAST_A_QUESTIONS[FAST_A_CONTENT.indexOf(q)] ?? ""}', '${FAST_A.bank}', 'single_choice', 'easy', '${q.text}',
              'คำอธิบายของ D-8', 1, 'draft', array['d8-integration'], '${STAFF_EXAM_DEMO_ID}', 1)`,
    ).join(",\n        ")};
  `);
  await psql(`
    insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
    values ${FAST_A_CONTENT.map((q) => {
      const questionId = FAST_A_QUESTIONS[FAST_A_CONTENT.indexOf(q)] ?? "";
      const key = q.key; // เช่น "d1"
      return [
        `('${optionId(key, 1)}', '${questionId}', '${q.correct}', true, 1)`,
        `('${optionId(key, 2)}', '${questionId}', '${q.wrongs[0]}', false, 2)`,
        `('${optionId(key, 3)}', '${questionId}', '${q.wrongs[1]}', false, 3)`,
        `('${optionId(key, 4)}', '${questionId}', '${q.wrongs[2]}', false, 4)`,
      ].join(",\n        ");
    }).join(",\n        ")};
  `);
  // เปิดใช้งานโจทย์ในนาม profile สาธิต staff:exam (guard_question_activation ต้องผ่าน)
  await psql(`
    begin;
    set local "request.jwt.claims" = '{"sub":"${STAFF_EXAM_DEMO_ID}","role":"authenticated"}';
    update public.questions set status = 'active'
     where id in (${FAST_A_QUESTIONS.map((id) => `'${id}'`).join(",")});
    commit;
  `);
}

/**
 * ลบแถวสอบเร็ว FAST-A ทั้งชุด — เรียงตาม FK (RESTRICT):
 * event_outbox/attempt_answers/assessment_attempts ของรอบนี้ (ผู้ใช้ใดก็ได้ — id รอบเป็น
 * uuid ตายตัวของ suite) ก่อนลบโจทย์/ตัวเลือก/ธนาคาร/กติกา/รอบสอบ ไม่งั้น beforeAll ซ้ำชน FK
 */
export async function cleanupFastExamARows(): Promise<void> {
  const questionList = FAST_A_QUESTIONS.map((id) => `'${id}'`).join(",");
  await psql(`
    delete from public.event_outbox
     where payload ->> 'source_id' in (
       select id::text from public.assessment_attempts where assessment_id = '${FAST_A.assessment}');
    delete from public.attempt_answers
     where attempt_id in (select id from public.assessment_attempts where assessment_id = '${FAST_A.assessment}');
    delete from public.assessment_attempts where assessment_id = '${FAST_A.assessment}';
    delete from public.question_options where question_id in (${questionList});
    delete from public.questions where bank_id = '${FAST_A.bank}';
    delete from public.question_banks where id = '${FAST_A.bank}';
    delete from public.assessment_rules where id = '${FAST_A.rules}';
    delete from public.assessments where id = '${FAST_A.assessment}';
  `);
}

/**
 * ล้างโลกของ suite D-9 ทั้งชุด (เทียบเท่า cleanupD8World ของ D-8) — เรียกใน beforeAll
 * เพื่อเก็บของค้างจากรอบก่อนที่พังกลางทาง และใน afterAll เพื่อเก็บของตัวเอง:
 * - แถวของผู้ใช้ email pattern 'd9-%' (ทุก spec ของ D-9 สร้าง prefix d9-) ครบ FK-chain
 * - แถวสอบเร็ว FAST-A (รวม attempts ของผู้ใช้อื่นบนรอบนี้ — id ตายตัวของ suite)
 * NB: audit_logs เป็น append-only ตามดีไซน์ — ตั้งใจคงไว้
 */
export async function cleanupD9World(): Promise<void> {
  const d9Users = `(select id from auth.users where email like 'd9-%')`;
  await psql(`
    delete from public.event_outbox
     where payload ->> 'source_id' in (
       select id::text from public.assessment_attempts where user_id in ${d9Users});
    delete from public.attempt_answers
     where attempt_id in (select id from public.assessment_attempts where user_id in ${d9Users});
    delete from public.assessment_attempts where user_id in ${d9Users};
    delete from public.certificate_verifications
     where verify_code in (select c.verify_code from public.certificates c where c.user_id in ${d9Users});
    delete from public.certificates where user_id in ${d9Users};
    delete from public.media_assets
     where uploaded_by in ${d9Users}
       and not exists (select 1 from public.certificates c where c.pdf_media_id = media_assets.id)
       and not exists (select 1 from public.courses cr where cr.cover_media_id = media_assets.id)
       and not exists (select 1 from public.lessons l where l.media_id = media_assets.id)
       and not exists (select 1 from public.lawyer_licenses ll where ll.evidence_media_id = media_assets.id)
       and not exists (select 1 from public.license_applications la where la.evidence_media_id = media_assets.id)
       and not exists (select 1 from public.report_exports re where re.file_media_id = media_assets.id);
    delete from public.lesson_progress
     where enrollment_id in (select id from public.enrollments where user_id in ${d9Users});
    delete from public.enrollments where user_id in ${d9Users};
    delete from public.role_assignments where user_id in ${d9Users};
    delete from public.profiles where id in ${d9Users};
    delete from auth.users where email like 'd9-%';
  `);
  await cleanupFastExamARows();
}

/** ผู้ใช้ทดสอบพร้อมบทบาท */
export interface D9User extends LearnerUser {
  readonly roles: readonly string[];
}

/**
 * สร้างผู้เรียนบทบาท lawyer (GoTrue จริง + citizen จาก helper เดิม + lawyer เพิ่มผ่าน psql)
 * — course 3 is_public=false ผู้เรียนต้องมี lawyer จึงเห็นหลักสูตรและลงทะเบียนได้
 */
export async function createLawyerLearner(prefix: string): Promise<D9User> {
  const user = await createLearnerUser(prefix);
  await psql(
    `insert into public.role_assignments (user_id, role, granted_by, reason)
     values ('${user.id}', 'lawyer', null, 'e2e D-9 (course 3 เฉพาะทนายความ)');`,
  );
  return { ...user, roles: ["citizen", "lawyer"] };
}

/**
 * สร้างผู้ใช้บทบาทเจ้าหน้าที่ (staff:registrar / instructor) — seed ไม่มี auth.users ของ
 * บทบาทเหล่านี้ (profiles สาธิตของ seed ไม่มีแถว auth.users จึง login ผ่านฟอร์มไม่ได้)
 */
export async function createStaffRoleUser(prefix: string, role: string): Promise<D9User> {
  const user = await createLearnerUser(prefix);
  await psql(
    `insert into public.role_assignments (user_id, role, granted_by, reason)
     values ('${user.id}', '${role}', null, 'e2e D-9 (${role})');`,
  );
  return { ...user, roles: ["citizen", role] };
}

/**
 * ลบผู้ใช้ d9 คนเดียวครบทุกแถวที่ FK ผูกอยู่ (เรียงตาม RESTRICT):
 * event_outbox(ของ attempt) → attempt_answers → assessment_attempts →
 * certificate_verifications → certificates → media_assets(PDF ใบประกาศที่ uploaded_by
 * เป็นผู้ออกใบ/ผู้เรียน — ลบเฉพาะแถวที่ไม่มีตารางใดอ้างอิงค้าง) → lesson_progress →
 * enrollments → role_assignments → profiles → auth.users
 * NB: audit_logs เป็น append-only ตามดีไซน์ (trigger ห้ามลบทุก role) — ตั้งใจคงไว้เหมือน D-8;
 *     ไฟล์ใน storage.objects ของ PDF คงค้างได้ (ไม่มี FK — ไม่บังการรันซ้ำ)
 */
export async function deleteD9User(userId: string): Promise<void> {
  await psql(`
    delete from public.event_outbox
     where payload ->> 'source_id' in (
       select id::text from public.assessment_attempts where user_id = '${userId}');
    delete from public.attempt_answers
     where attempt_id in (select id from public.assessment_attempts where user_id = '${userId}');
    delete from public.assessment_attempts where user_id = '${userId}';
    delete from public.certificate_verifications
     where verify_code in (select verify_code from public.certificates where user_id = '${userId}');
    delete from public.certificates where user_id = '${userId}';
    delete from public.media_assets
     where uploaded_by = '${userId}'
       and not exists (select 1 from public.certificates c where c.pdf_media_id = media_assets.id)
       and not exists (select 1 from public.courses cr where cr.cover_media_id = media_assets.id)
       and not exists (select 1 from public.lessons l where l.media_id = media_assets.id)
       and not exists (select 1 from public.lawyer_licenses ll where ll.evidence_media_id = media_assets.id)
       and not exists (select 1 from public.license_applications la where la.evidence_media_id = media_assets.id)
       and not exists (select 1 from public.report_exports re where re.file_media_id = media_assets.id);
    delete from public.lesson_progress
     where enrollment_id in (select id from public.enrollments where user_id = '${userId}');
    delete from public.enrollments where user_id = '${userId}';
    delete from public.role_assignments where user_id = '${userId}';
    delete from public.profiles where id = '${userId}';
    delete from auth.users where id = '${userId}';
  `);
}

/**
 * ลงทะเบียนผ่าน UI จริง — ปุ่ม "ลงทะเบียนเรียน" บนหน้าหลักสูตร แล้วรอพาไปหน้าเรียน
 * - รองรับ "ลงทะเบียนแล้ว" (ลิงก์ "เข้าเรียนต่อ" ปรากฏแทนปุ่ม — เช่น retry หลังพังกลางทาง)
 *   ถือว่าขั้นลงทะเบียนสำเร็จแล้ว ไม่ต้องทำซ้ำ
 * - โหลดหน้าซ้ำได้สูงสุด 3 ครั้ง — ธง: dev app มีอาการ "SSR ค้าง/รีเซ็ตการเชื่อมต่อ"
 *   เป็นครั้งคราวระหว่าง suite ยาว ๆ (ล็อกแอป: "Server is approaching the used memory
 *   threshold, restarting..." — แอปรีสตาร์ทเองกลาง suite) การ reload ช่วยได้กรณีอาการเบา
 */
export async function enrollViaUi(page: Page, courseId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`/courses/${courseId}`);
    const alreadyEnrolled = page.getByRole("link", { name: "เข้าเรียนต่อ" });
    if (await alreadyEnrolled.isVisible().catch(() => false)) {
      return;
    }
    try {
      await page.getByRole("button", { name: "ลงทะเบียนเรียน" }).click({ timeout: 15_000 });
      await page.waitForURL(`**/courses/${courseId}/learn**`, { timeout: 20_000 });
      return;
    } catch {
      if (attempt === 3) {
        throw new Error(
          `ลงทะเบียนผ่าน UI ไม่สำเร็จหลังโหลดหน้าซ้ำ 3 ครั้ง (course ${courseId}) — ปุ่มลงทะเบียนไม่ปรากฏหรือคลิกไม่ได้`,
        );
      }
    }
  }
}

/**
 * เรียนบทเรียน document จน completed ผ่าน UI จริง — กดปุ่ม "อ่านจบแล้ว"
 * (DocumentViewer attestation → BFF documentRead) แล้วรอ outline ติด "เรียนจบแล้ว"
 * (รองรับบทเรียนที่เรียนจบแล้วแล้ว — ปุ่ม "อ่านจบแล้ว" จะไม่ปรากฏ ถือว่าขั้นนี้ผ่านแล้ว)
 */
export async function completeDocumentViaUi(
  page: Page,
  courseId: string,
  lessonId: string,
): Promise<void> {
  await page.goto(`/courses/${courseId}/learn/${lessonId}`);
  const doneButton = page.getByRole("button", { name: "อ่านจบแล้ว" });
  if ((await doneButton.count()) === 0) {
    return; // เรียนจบแล้วก่อนหน้า (เช่น retry หลังพังกลางทาง) — ขั้นนี้สำเร็จแล้ว
  }
  await doneButton.click();
  await expect(page.getByText("ส่งยืนยันการอ่านจบเรียบร้อย รอระบบตัดสินสถานะจบบทเรียน")).toBeVisible();
  await expect(page.getByText("เรียนจบแล้ว").first()).toBeVisible();
}

/** แผนการตอบของห้องสอบ — question_text → ข้อความตัวเลือกที่จะคลิก */
export type ExamAnswerPlan = ReadonlyMap<string, string>;

/** โจทย์ + ข้อความตัวเลือกถูก/ผิด ของหนึ่งข้อ (เฉลย id มาจาก DB ฝั่ง harness เท่านั้น) */
export interface ExamQuestionPlan {
  readonly questionId: string;
  readonly questionText: string;
  readonly correctText: string;
  readonly wrongText: string;
}

/**
 * อ่านเฉลย (option id) จาก DB ผ่าน psql โดยตรง — เทียบเท่า knownCorrectAnswers /
 * knownWrongAnswer ของ helpers-d8 (is_correct ไม่เคยเดินทางผ่าน client bundle เพราะ
 * คิวรีนี้รันใน harness เท่านั้น) แล้วแปลงเป็น "ข้อความ" สำหรับคลิกใน UI
 */
export async function loadExamPlan(
  questionIds: readonly string[],
): Promise<ExamQuestionPlan[]> {
  const correctRows = await psqlRows<{ question_id: string; option_id: string }>(`
    select question_id::text, id::text as option_id
    from public.question_options
    where is_correct and question_id in (${questionIds.map((id) => `'${id}'`).join(",")});
  `);
  const wrongRows = await psqlRows<{ question_id: string; option_id: string }>(`
    select question_id::text, id::text as option_id
    from public.question_options
    where not is_correct and question_id in (${questionIds.map((id) => `'${id}'`).join(",")})
    order by sort_order;
  `);
  const correctByQuestion = new Map(correctRows.map((row) => [row.question_id, row.option_id]));
  const wrongByQuestion = new Map<string, string>();
  for (const row of wrongRows) {
    if (wrongByQuestion.has(row.question_id) === false) {
      wrongByQuestion.set(row.question_id, row.option_id);
    }
  }
  const optionRows = await psqlRows<{ id: string; text: string }>(`
    select id::text as id, option_text as text
    from public.question_options
    where id in (${[...correctByQuestion.values(), ...wrongByQuestion.values()]
      .map((id) => `'${id}'`)
      .join(",")});
  `);
  const textById = new Map(optionRows.map((row) => [row.id, row.text]));
  const questionRows = await psqlRows<{ id: string; text: string }>(`
    select id::text as id, question_text as text
    from public.questions
    where id in (${questionIds.map((id) => `'${id}'`).join(",")});
  `);
  const questionTextById = new Map(questionRows.map((row) => [row.id, row.text]));
  return questionIds.map((questionId) => {
    const correctText = textById.get(correctByQuestion.get(questionId) ?? "") ?? "";
    const wrongText = textById.get(wrongByQuestion.get(questionId) ?? "") ?? "";
    if (correctText.length === 0 || wrongText.length === 0) {
      throw new Error(`อ่านเฉลยของโจทย์ ${questionId} จาก DB ไม่ครบ`);
    }
    return {
      questionId,
      questionText: questionTextById.get(questionId) ?? "",
      correctText,
      wrongText,
    };
  });
}

/**
 * ทำข้อสอบหนึ่งรอบผ่าน UI จริง: หน้ากติกา → "เริ่มสอบ" → ห้องสอบ (checkbox ตาม plan
 * ทีละข้อ) → "ส่งข้อสอบ" → ยืนยัน dialog → รอถูกพาไปหน้าผล /my/exams/{attemptId}
 * - ห้องสอบแสดงทีละข้อ (fieldset เดียว) — หาข้อปัจจุบันด้วย "ข้อความโจทย์" บนหน้าจอเสมอ
 *   (ไม่อิงลำดับจาก DB เพราะกติกาอนุญาต shuffle ได้) · answer="wrong" = คลิกตัวเลือกผิดตัวแรก
 */
export async function takeExamViaUi(
  page: Page,
  courseId: string,
  assessmentId: string,
  plan: readonly ExamQuestionPlan[],
  answer: "correct" | "wrong",
): Promise<void> {
  await page.goto(`/courses/${courseId}/exam/${assessmentId}`);
  await page.getByRole("button", { name: "เริ่มสอบ" }).click();
  await page.waitForURL(
    new RegExp(`/courses/${courseId}/exam/${assessmentId}/`),
    { timeout: 20_000 },
  );
  const fieldset = page.locator("fieldset");
  await expect(fieldset).toHaveCount(1);
  for (let step = 0; step < plan.length; step += 1) {
    const entry = plan[step];
    if (entry === undefined) {
      throw new Error(`แผนการตอบขาดข้อที่ ${step + 1}`);
    }
    const current = fieldset.filter({ hasText: entry.questionText });
    await expect(current).toBeVisible();
    const label = answer === "correct" ? entry.correctText : entry.wrongText;
    await current.locator("label").filter({ hasText: label }).locator("input").check();
    if (step < plan.length - 1) {
      await page.getByRole("button", { name: "ข้อถัดไป" }).click();
    }
  }
  await page.getByRole("button", { name: "ส่งข้อสอบ" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "ยืนยันส่งข้อสอบ" }).click();
  await page.waitForURL(/\/my\/exams\//, { timeout: 20_000 });
}

// ─── MFA ของ staff (ธงให้ lead) — BFF บังคับ aal2 กับ staff:* ทุกตัว (src/lib/rbac.ts:
// requiresMfa + ERR-AUTH-004) แต่แอป "ยังไม่มีหน้าจอ MFA" ใด ๆ (grep src/app/e2e/tests → ว่าง;
// session.ts L105: "ยังไม่มี MFA enrollment UI (Wave F)") — session aal2 จึงต้องจัดการฝั่ง
// harness เท่านั้น: ลงทะเบียน TOTP กับ GoTrue ผ่าน REST แล้วเขียน session ลง cookie ด้วย
// @supabase/ssr ตัวเดียวกับแอป (ฟอร์แมต/chunking เดียวกันแน่นอน) — การออกใบบนหน้าจอยังเป็น UI จริง ──

/** โทเค็น session ที่ผ่าน MFA แล้ว (aal2) */
export interface Aal2Session {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** ถอด payload ของ JWT (สำหรับ assert claim `aal` — ไม่ log token) */
function jwtAal(token: string): string {
  const payloadPart = token.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(payloadPart, "base64").toString("utf8")) as {
    aal?: string;
  };
  return payload.aal ?? "";
}

/** TOTP 6 หลัก กรอบเวลา 30 วินาที (RFC 6238 — HMAC-SHA1) จาก secret base32 ของ GoTrue */
function totpNow(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretBase32.replace(/=+$/u, "").toUpperCase()) {
    const index = alphabet.indexOf(ch);
    if (index >= 0) {
      bits += index.toString(2).padStart(5, "0");
    }
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i += 1) {
    key.writeUInt8(Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2), i);
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(Number.isSafeInteger(counter) && counter <= 0xffffffff ? counter : counter % 2 ** 32, 4);
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 2 ** 24 +
    (digest[offset + 1] ?? 0) * 2 ** 16 +
    (digest[offset + 2] ?? 0) * 2 ** 8 +
    (digest[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * ลงทะเบียน TOTP factor ให้ผู้ใช้ GoTrue ฝั่ง harness และยืนยัน challenge ทันที —
 * คืน session ที่ access token มี claim aal=aal2 (assert ใน helper — พลาด = throw พร้อม status)
 */
export async function enrollMfaTotp(email: string): Promise<Aal2Session> {
  const grant = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email, password: TEST_PASSWORD },
  );
  const grantBody = (grant.json ?? {}) as { access_token?: string };
  if (grant.status >= 400 || typeof grantBody.access_token !== "string") {
    throw new Error(`password grant ล้ม (${grant.status}): ${grant.text.slice(0, 200)}`);
  }
  const accessToken = grantBody.access_token;
  // เส้นทาง MFA จริงของ GoTrue (auth-js: POST /factors, /factors/{id}/challenge, /factors/{id}/verify)
  const enroll = await restCall(
    "POST",
    "/auth/v1/factors",
    { token: accessToken },
    { factor_type: "totp", friendly_name: "e2e-d9", issuer: "ltc-e2e" },
  );
  const enrollBody = (enroll.json ?? {}) as {
    id?: string;
    totp?: { secret?: string };
    msg?: string;
  };
  const secret = enrollBody.totp?.secret;
  const factorId = enrollBody.id;
  if (enroll.status >= 400 || typeof secret !== "string" || typeof factorId !== "string") {
    throw new Error(`mfa/enroll ล้ม (${enroll.status}): ${enroll.text.slice(0, 200)}`);
  }
  const code = totpNow(secret);
  const challenge = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/challenge`,
    { token: accessToken },
    {},
  );
  const challengeBody = (challenge.json ?? {}) as { id?: string };
  if (challenge.status >= 400 || typeof challengeBody.id !== "string") {
    throw new Error(`mfa/challenge ล้ม (${challenge.status}): ${challenge.text.slice(0, 200)}`);
  }
  const verify = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/verify`,
    { token: accessToken },
    { challenge_id: challengeBody.id, code },
  );
  const verifyBody = (verify.json ?? {}) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (verify.status >= 400 || typeof verifyBody.access_token !== "string" || typeof verifyBody.refresh_token !== "string") {
    throw new Error(`mfa/verify ล้ม (${verify.status}): ${verify.text.slice(0, 200)}`);
  }
  const aal = jwtAal(verifyBody.access_token);
  if (aal !== "aal2") {
    throw new Error(`access token หลัง mfa/verify ไม่มี claim aal=aal2 (ได้ aal="${aal}")`);
  }
  return { accessToken: verifyBody.access_token, refreshToken: verifyBody.refresh_token };
}

/**
 * ติดตั้ง MutationObserver จับข้อความ `role="status"` ที่ขึ้นต้นด้วย "ออกใบสำเร็จ" ตั้งแต่
 * เฟรมแรกที่ mount (ธง: toast สำเร็จของการออกใบอยู่ "ใน" ConfirmModal ที่ถูก unmount ทันที
 * ที่ router.refresh() เรนเดอร์คิวใหม่ — แถวผู้เรียนหายจากคิว = component ถูกถอดออก =
 * toast หายในหลักสิบ ms; การ assert แบบ poll ปกติอาจพลาดกรอบที่ toast ยังอยู่ แต่
 * MutationObserver callback ทำงาน sync ตอน DOM mutate จึงไม่มีทางพลาด)
 * คืนฟังก์ชันอ่าน "ข้อความทั้งหมดที่เคยจับได้" (คั่นด้วย \n) — ใช้กับ expect.poll
 */
export async function captureIssueSuccessToast(
  page: Page,
): Promise<() => Promise<string>> {
  await page.evaluate(() => {
    const w = window as unknown as { __d9IssueStatusLog?: string[] };
    w.__d9IssueStatusLog = [];
    const log = w.__d9IssueStatusLog;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('p[role="status"]')) {
        const text = el.textContent ?? "";
        if (text.includes("ออกใบสำเร็จ") && log[log.length - 1] !== text) {
          log.push(text);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return async () =>
    page.evaluate(
      () =>
        (window as unknown as { __d9IssueStatusLog?: string[] }).__d9IssueStatusLog
          ?.join("\n") ?? "",
    );
}

/**
 * เขียน session aal2 ลง cookie ของ browser context ด้วย `@supabase/ssr` createServerClient
 * (ตัวเดียวกับแอป — ฟอร์แมต/chunking/base64url ตรงกันแน่นอน)
 * - ชื่อ cookie base ของแอป (sb-<host>-auth-token) **เดาจาก cookie จริงใน context** —
 *   เว็บคอนเทนเนอร์ใช้ SUPABASE_URL=http://kong:8000 (ต่างจาก host ที่อ่าน localhost:8000)
 *   caller จึงต้อง loginViaForm ก่อนเรียกฟังก์ชันนี้ (ให้แอปเขียน cookie จริงออกมาให้เดาชื่อ)
 *   และห้าม loginViaForm ทับหลัง inject (จะกลับเป็น aal1)
 */
export async function injectSession(page: Page, session: Aal2Session): Promise<void> {
  const context = page.context();
  const existing = await context.cookies();
  const authCookie = existing.find((cookie) =>
    /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name),
  );
  const baseName =
    authCookie?.name.replace(/\.\d+$/u, "") ??
    `sb-${new URL(REST_BASE).hostname.split(".")[0]}-auth-token`;
  const client = createServerClient(REST_BASE, ANON_KEY, {
    cookieOptions: { name: baseName },
    cookies: {
      getAll: async () =>
        (await context.cookies()).map((cookie) => ({ name: cookie.name, value: cookie.value })),
      setAll: (cookiesToSet) => {
        context.addCookies(
          cookiesToSet.map(({ name, value, options }) => ({
            name,
            value,
            domain: "localhost",
            path: options?.path ?? "/",
            httpOnly: true,
            sameSite: "Lax" as const,
            ...(options?.maxAge === 0 ? { expires: 0 } : {}),
          })),
        );
      },
    },
  });
  const { error } = await client.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  if (error !== null) {
    throw new Error(`setSession ฝั่ง harness ล้ม: ${error.message}`);
  }
}

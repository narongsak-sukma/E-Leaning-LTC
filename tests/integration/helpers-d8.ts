/**
 * tests/integration/helpers-d8.ts — helper เฉพาะของ suite D-8 (exam flow + certificate path)
 *
 * - seed "สอบเร็ว" 2 รอบบนหลักสูตรเดิมของ seed (course 3 / LTC-103) ผ่าน SQL ตรง
 *   (supabase_admin = service path ตามแบบ suite เดิม) — D-9 (e2e) นำ helper นี้ไปใช้ต่อได้
 *     · FAST-A: time_limit 5 นาที · cooldown 0 · max_attempts 2 · require_course_complete=false
 *     · FAST-B: time_limit 5 นาที · cooldown 0 · max_attempts 1 · require_course_complete=false
 *   ธนาคารข้อสอบแยกของตัวเอง + ข้อ single_choice ทุกข้อ (เฉลย = ตัวเลือก sort_order 1 เสมอ)
 *   — ฝั่ง harness รู้ is_correct ตลอด (อ่านจาก DB ผ่าน psql ไม่ผ่าน client bundle)
 * - id ทุกแถวเป็น uuid ตายตัว → beforeAll ทำซ้ำได้ (ล้างของเก่าก่อน insert) + cleanup FK-ordered
 * - util เสริม: ถอด JWT payload (session_id claim), sha256 hex, ไฟล์ mp4 เล็ก, storage API
 */
import {
  psql,
  psqlRows,
  SERVICE_KEY,
  REST_URL,
} from "./helpers.js";

// ─── id อ้างอิงของ seed หลัก (supabase/seed.sql) ──────────────────────────────

/** course 3 (LTC-103) — published, มีบทเรียน document 1 บท */
export const COURSE3_ID = "44444444-4444-4444-8444-000000000003";
/** ข้อสอบปลายหลักสูตรจริงของ seed (require_course_complete=true, cooldown 1440, max 3) */
export const SEED_EXAM_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
/** บทเรียน document เดียวของ course 3 (record_lesson_progress แล้ว completed ทันที) */
export const COURSE3_LESSON_ID = "66666666-6666-4666-8666-000000000006";
/** profile สาธิต staff:exam ของ seed — ใช้เป็นผู้เปิดใช้งานโจทย์ (guard_question_activation) */
export const STAFF_EXAM_DEMO_ID = "11111111-1111-4111-8111-000000000002";

// ─── id ตายตัวของแถวที่ suite D-8 สร้าง (ล้างซ้ำได้ ไม่ชน seed) ────────────────

export const D8_IDS = {
  fastA: {
    assessment: "cccccccc-cccc-4ccc-8ccc-0000000000d8",
    rules: "dddddddd-dddd-4ddd-8ddd-0000000000d8",
    bank: "eeeeeeee-eeee-4eee-8eee-0000000000d8",
    code: "EXAM-D8-FAST-A",
  },
  fastB: {
    assessment: "cccccccc-cccc-4ccc-8ccc-0000000000d9",
    rules: "dddddddd-dddd-4ddd-8ddd-0000000000d9",
    bank: "eeeeeeee-eeee-4eee-8eee-0000000000d9",
    code: "EXAM-D8-FAST-B",
  },
} as const;

/** bank ของรอบสอบสร้างใหม่ → รายการ id โจทย์ (เฉลยอยู่ที่ตัวเลือก sort_order 1 เสมอ) */
export const D8_BANK_QUESTIONS: Readonly<Record<"fastA" | "fastB", readonly string[]>> = {
  fastA: [
    "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d1",
    "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d2",
    "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d3",
    "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d4",
  ],
  fastB: [
    "f0f0f0f0-f0f0-4f0f-8f0f-0000000000e1",
    "f0f0f0f0-f0f0-4f0f-8f0f-0000000000e2",
    "f0f0f0f0-f0f0-4f0f-8f0f-0000000000e3",
  ],
};

/** ตัวเลือก 4 ตัวต่อข้อ — id ล็อกตามรูป f1f1f1f1-...-000000000<d|e><ข้อที่><ลำดับ> */
function optionId(questionKey: string, optionNo: number): string {
  return `f1f1f1f1-f1f1-4f1f-8f1f-000000000${questionKey}${optionNo}`;
}

interface QuestionSeed {
  readonly id: string;
  readonly text: string;
  readonly correct: string;
  readonly wrongs: readonly [string, string, string];
}

/** โจทย์ 4 ข้อของ FAST-A (1 แต้มต่อข้อ — total_points = 4) */
const QUESTIONS_A: readonly QuestionSeed[] = [
  {
    id: D8_BANK_QUESTIONS.fastA[0] ?? "",
    text: "D8 ข้อ 1: องค์ประกอบของคำฟ้องตามกฎหมายวิธีพิจารณาความแพ่ง ไม่รวมข้อใด",
    correct: "คำร้องขอตั้งผู้จัดการมรดก",
    wrongs: ["ชื่อ-ที่อยู่คู่ความ", "เรื่องที่ฟ้อง", "ข้อความกระชับความและข้อสรุปที่ขอให้ศาลวินิจฉัย"],
  },
  {
    id: D8_BANK_QUESTIONS.fastA[1] ?? "",
    text: "D8 ข้อ 2: การยื่นคำฟ้องต่อศาลชั้นต้น ผู้ฟ้องคดีต้องทำอย่างไร",
    correct: "ยื่นต่อศาลที่มีเขตอำนาจและเสียค่าธรรมเนียมตามแบบที่กฎหมายวางไว้",
    wrongs: ["ยื่นต่อองค์กรอิสระด้านตุลาการ", "ส่งสำเนาให้ทนายความของจำเลยก่อน", "แจ้งจำเลยด้วยวาจาในที่ประชุม"],
  },
  {
    id: D8_BANK_QUESTIONS.fastA[2] ?? "",
    text: "D8 ข้อ 3: หลักฐานเอกสารที่ยื่นฟ้องเป็นภาษาต่างประเทศ ต้องแนบอะไร",
    correct: "คำแปลภาษาไทยที่ทำขึ้นตามกฎหมาย",
    wrongs: ["คำรับรองของผู้ฟ้อง", "สำเนาถ่ายเอกสารเท่านั้น", "ไม่ต้องแนบสิ่งใดเพิ่ม"],
  },
  {
    id: D8_BANK_QUESTIONS.fastA[3] ?? "",
    text: "D8 ข้อ 4: คำสั่งของศาลที่ยังไม่สิ้นสุดคดีเมื่อฝ่ายใดฝ่ายหนึ่งไม่ปฏิบัติ ศาลจะสั่งอย่างไร",
    correct: "สั่งให้ฝ่ายนั้นปฏิบัติภายในกำหนดหรือคิดค่าปรับตามที่เห็นสมควร",
    wrongs: ["ยกฟ้องทันที", "พิพากษาเป็นอันขาดแทนคำสั่งเดิม", "สั่งฟ้องพินาศโดยไม่มีเงื่อนไข"],
  },
];

/** โจทย์ 3 ข้อของ FAST-B */
const QUESTIONS_B: readonly QuestionSeed[] = [
  {
    id: D8_BANK_QUESTIONS.fastB[0] ?? "",
    text: "D8 ข้อ 5: คำให้การของจำเลยต้องยื่นภายในกี่วันนับแต่ได้รับสำเนาคำฟ้อง (อารยะ)",
    correct: "15 วัน",
    wrongs: ["7 วัน", "30 วัน", "60 วัน"],
  },
  {
    id: D8_BANK_QUESTIONS.fastB[1] ?? "",
    text: "D8 ข้อ 6: การนัดพิจารณาคดีครั้งแรก ศาลต้องส่งหมายให้คู่ความล่วงหน้าอย่างน้อยกี่วัน",
    correct: "7 วัน",
    wrongs: ["3 วัน", "15 วัน", "30 วัน"],
  },
  {
    id: D8_BANK_QUESTIONS.fastB[2] ?? "",
    text: "D8 ข้อ 7: ข้อต่อสู้ว่าคู่กรณีไม่มีอำนาจฟ้อง (ข้อยกเรื่อง) ศาลพิจารณาอย่างไร",
    correct: "พิจารณาก่อนปัญหาแก่นคดี เมื่อข้อต่อสู้นั้นฟังขึ้นแล้วจึงว่าตามแก่นคดี",
    wrongs: ["พิจารณาร่วมกับแก่นคดีเสมอ", "พิจารณาหลังปัญหาแก่นคดีเสมอ", "ไม่รับพิจารณาเพราะเป็นข้อต่อสู้สาระสำคัญ"],
  },
];

// ─── seed สอบเร็ว ─────────────────────────────────────────────────────────────

/**
 * สร้าง assessment สอบเร็ว 2 รอบ (A: max_attempts 2 · B: max_attempts 1) บนหลักสูตร course 3
 * + ธนาคารข้อสอบ + โจทย์ single_choice (draft) + ตัวเลือก แล้วเปิดใช้งานโจทย์ในนาม
 * profile สาธิต staff:exam (guard_question_activation) ด้วย shim request.jwt.claims เหมือน seed.sql
 */
export async function seedFastExams(): Promise<void> {
  // ล้างของจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้ — เรียงตาม FK
  await cleanupFastExamRows();
  for (const which of ["fastA", "fastB"] as const) {
    const ids = D8_IDS[which];
    const questions = which === "fastA" ? QUESTIONS_A : QUESTIONS_B;
    const questionCount = questions.length;
    const maxAttempts = which === "fastA" ? 2 : 1;
    await psql(`
      insert into public.assessments
        (id, course_id, code, title, description, is_final, status, published_at) values
        ('${ids.assessment}', '${COURSE3_ID}', '${ids.code}', 'สอบเร็ว D-8 (${which})', null,
         false, 'published', now())
      on conflict (id) do nothing;
    `);
    await psql(`
      insert into public.assessment_rules
        (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
         attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection,
         require_course_complete, proctoring_mode, effective_from) values
        ('${ids.rules}', '${ids.assessment}', 1, 5, ${questionCount}, 70, ${maxAttempts},
         0, false, false, '{"bank_ids":["${ids.bank}"]}'::jsonb, false, 'none', now() - interval '1 day')
      on conflict (id) do nothing;
    `);
    await psql(`
      insert into public.question_banks
        (id, code, name, created_by, course_id, description, is_active) values
        ('${ids.bank}', 'QB-${ids.code}', 'ธนาคารข้อสอบ D-8 ${which}', '${STAFF_EXAM_DEMO_ID}',
         '${COURSE3_ID}', 'seed สอบเร็วของ suite D-8', true)
      on conflict (id) do nothing;
    `);
    await psql(`
      insert into public.questions
        (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
      values ${questions
        .map(
          (q) => `('${q.id}', '${ids.bank}', 'single_choice', 'easy', '${q.text}',
                  'คำอธิบายของ D-8', 1, 'draft', array['d8-integration'], '${STAFF_EXAM_DEMO_ID}', 1)`,
        )
        .join(",\n        ")};
    `);
    await psql(`
      insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
      values ${questions
        .map((q) => {
          const key = q.id.slice(-2); // เช่น "d1"
          return [
            `('${optionId(key, 1)}', '${q.id}', '${q.correct}', true, 1)`,
            `('${optionId(key, 2)}', '${q.id}', '${q.wrongs[0]}', false, 2)`,
            `('${optionId(key, 3)}', '${q.id}', '${q.wrongs[1]}', false, 3)`,
            `('${optionId(key, 4)}', '${q.id}', '${q.wrongs[2]}', false, 4)`,
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
     where id in (${[...D8_BANK_QUESTIONS.fastA, ...D8_BANK_QUESTIONS.fastB].map((id) => `'${id}'`).join(",")});
    commit;
  `);
}

/** ลบแถว seed สอบเร็วทั้งชุด (โจทย์/ตัวเลือก/ธนาคาร/กติกา/รอบสอบ) — เรียงตาม FK */
export async function cleanupFastExamRows(): Promise<void> {
  const allQuestions = [...D8_BANK_QUESTIONS.fastA, ...D8_BANK_QUESTIONS.fastB];
  const allBanks = [D8_IDS.fastA.bank, D8_IDS.fastB.bank];
  const allAssessments = [D8_IDS.fastA.assessment, D8_IDS.fastB.assessment];
  const allRules = [D8_IDS.fastA.rules, D8_IDS.fastB.rules];
  await psql(`
    delete from public.question_options where question_id in (${allQuestions.map((id) => `'${id}'`).join(",")});
    delete from public.questions where bank_id in (${allBanks.map((id) => `'${id}'`).join(",")});
    delete from public.question_banks where id in (${allBanks.map((id) => `'${id}'`).join(",")});
    delete from public.assessment_rules where id in (${allRules.map((id) => `'${id}'`).join(",")});
    delete from public.assessments where id in (${allAssessments.map((id) => `'${id}'`).join(",")});
  `);
}

/**
 * ล้างโลกของ suite D-8 ทั้งชุด (เรียงตาม FK — RESTRICT) ครอบคลุมของค้างจากรอบที่พังกลางทาง:
 * - รอบสอบสอบเร็ว id ตายตัวของ suite (attempts/answers ของรอบนั้น)
 * - ผู้ใช้ทดสอบทุกคนที่ suite เคยสร้าง (email pattern d8-examcert-*) — attempts บนข้อสอบ seed,
 *   ใบประกาศนียบัตร + แถวการตรวจสอบสาธารณะ, lesson_progress, enrollments, roles, profiles, auth.users
 * - event_outbox ที่อ้าง attempt ของ suite (payload->>source_id) และ event ใบประกาศ
 *   ที่อ้าง "เจ้าของใบ" (payload->>user_id — topic certificate.issued/revoked ออกใน TX
 *   เดียวกับ admin_issue_certificate ของ 0034 — source_id ของ event เหล่านี้เป็น
 *   certificate_id ไม่ใช่ attempt id จึงตกหล่นจาก scope เดิม · Wave F D-f nit)
 * NB: audit_logs เป็น append-only ตามดีไซน์ (trigger ห้ามลบทุก role) — ตั้งใจคงไว้
 */
export async function cleanupD8World(): Promise<void> {
  const fastIds = [D8_IDS.fastA.assessment, D8_IDS.fastB.assessment];
  const fastList = fastIds.map((id) => `'${id}'`).join(",");
  const d8Users = `(select id from auth.users where email like 'd8-examcert-%')`;
  const attemptScope = `(select id from public.assessment_attempts
      where assessment_id in (${fastList}) or user_id in ${d8Users})`;
  const d8UserIds = `(select id::text from auth.users where email like 'd8-examcert-%')`;
  await psql(`
    delete from public.event_outbox
     where payload ->> 'source_id' in (select x.id::text from ${attemptScope} x)
        or payload ->> 'user_id' in ${d8UserIds};
    delete from public.attempt_answers where attempt_id in ${attemptScope};
    delete from public.assessment_attempts
     where assessment_id in (${fastList}) or user_id in ${d8Users};
    delete from public.certificate_verifications
     where verify_code in (select c.verify_code from public.certificates c
                            where c.user_id in ${d8Users})
        or verify_code = 'LTC-2099-000000'; -- รหัส not_found ตายตัวที่ suite ใช้ทดสอบ
    delete from public.certificates where user_id in ${d8Users};
    delete from public.lesson_progress
     where enrollment_id in (select id from public.enrollments where user_id in ${d8Users});
    delete from public.enrollments where user_id in ${d8Users};
    delete from public.role_assignments where user_id in ${d8Users};
    delete from public.profiles where id in ${d8Users};
    delete from auth.users where email like 'd8-examcert-%';
  `);
  await cleanupFastExamRows();
}

/**
 * เฉลยของโจทย์ที่ suite สร้าง — อ่านจาก DB โดยตรง (harness path ตามกติกา:
 * is_correct ห้ามเดินทางผ่าน client bundle; tests อ่านผ่าน psql ได้)
 * คืน Map question_id → correct option_id
 */
export async function knownCorrectAnswers(questionIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await psqlRows<{ question_id: string; option_id: string }>(`
    select question_id::text, id::text as option_id
    from public.question_options
    where is_correct and question_id in (${questionIds.map((id) => `'${id}'`).join(",")});
  `);
  return new Map(rows.map((row) => [row.question_id, row.option_id]));
}

/** ตัวเลือก "ผิด" ของแต่ละข้อ (สำหรับเคสตอบผิด) — ตัวแรกที่ is_correct=false */
export async function knownWrongAnswer(questionId: string): Promise<string> {
  const rows = await psqlRows<{ option_id: string }>(`
    select id::text as option_id from public.question_options
    where not is_correct and question_id = '${questionId}'
    order by sort_order limit 1;
  `);
  const id = rows[0]?.option_id;
  if (id === undefined) throw new Error(`ไม่พบตัวเลือกผิดของโจทย์ ${questionId}`);
  return id;
}

// ─── util กลางของ suite D-8 ───────────────────────────────────────────────────

/** ถอด payload ของ access token (session_id claim ที่ GoTrue ฝัง native) */
export function jwtPayload(token: string): { session_id?: string; sub?: string } {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
    session_id?: string;
    sub?: string;
  };
}

/** sha256 hex 64 ตัวพิมพ์เล็ก (รูปเดียวกับ ip_hash/user_agent_hash ที่ BFF สร้าง) */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** ไบต์ mp4 เล็กสุด ๆ (ftyp+free box — placeholder แทนได้ตอน prod) */
export function tinyMp4Bytes(): Buffer {
  return Buffer.from(
    "000000186674797069736f6d0000020069736f6d69736f32617663316d7033410000000866726565",
    "hex",
  );
}

export interface StorageResult {
  readonly status: number;
  readonly text: string;
}

/** เรียก storage API ผ่าน Kong ด้วย service key (upload/delete/GET object) */
export async function storageCall(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Buffer,
): Promise<StorageResult> {
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "video/mp4";
    init.body = new Uint8Array(body);
  }
  const response = await fetch(`${REST_URL}${path}`, init);
  const text = await response.text();
  return { status: response.status, text };
}

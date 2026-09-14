/**
 * schemas/v1/admin-exam — contract ของหลังบ้านฝั่งข้อสอบ (Wave D · D-3 · API-SPECIFICATION §3.8)
 *
 * ครอบ 3 endpoint: GET/POST /admin/assessments · GET/POST /admin/question-banks ·
 * PATCH /admin/question-banks/{id}/questions/{qid}
 *
 * แหล่งคอลัมน์ (อ่านจาก migration จริง — ไม่เดา):
 * - question_banks / questions / question_options / assessments / assessment_rules —
 *   0005_assessment.sql L5-L86
 * - enum question_type/question_difficulty/question_status/assessment_status/proctoring_mode —
 *   0001_extensions.sql L110-L120 (assessment_status = draft/published/closed/archived —
 *   **ไม่มีค่า 'review'** ตาม brief ของ D-3 ที่ต่างจาก enum จริง)
 * - กติกาเข้ม: time_limit_minutes 5-480, question_count > 0, pass_pct 1-100, max_attempts > 0,
 *   attempt_cooldown_minutes >= 0 (0005 L70-L74)
 *
 * สิ่งที่ schema ชุดนี้ **ไม่รับจาก client โดยเด็ดขาด** (BFF กำหนดเอง — server-controlled):
 * - assessments.status → 'draft' เสมอ (RLS asm_insert บังคับ instructor; publish/review เป็น
 *   transition ของ staff:exam — guard_assessment_publish 0010 L671-L686)
 * - questions.status ตอนสร้าง → 'draft' เสมอ (เปิดใช้ = staff:exam — guard_question_activation
 *   0010 L587-L608) และ PATCH ข้อสอบไม่รับ status (schema strict — ห้ามแกะจาก body)
 * - is_correct ของ options ห้ามปรากฏใน **response ฝั่งอ่าน** (GET/PATCH) ทุกกรณี —
 *   QuestionResource/QuestionOptionView ไม่มีฟิลด์นี้; รับเฉพาะ "request ฝั่งผู้แต่ง" (POST/PATCH)
 *
 * NB: mapAdminExamDbError อยู่ไฟล์ schema เพราะ lane D-3 สร้างได้เฉพาะ
 * ไฟล์ที่กำหนด — เป็น helper กลางที่ 3 route ของ lane นี้ใช้ร่วมกัน (ไฟล์เดียว ไม่กระจาย)
 */
import { z } from "zod";
import { AppError } from "../../errors";
import { PageQuery } from "./common";

/* ─── enum ตาม DB จริง (0001_extensions.sql L110-L120) ─── */

export const ADMIN_QUESTION_TYPES = ["single_choice", "multiple_choice", "true_false"] as const;

export const ADMIN_QUESTION_DIFFICULTIES = ["easy", "medium", "hard"] as const;

export const ADMIN_QUESTION_STATUSES = ["draft", "active", "retired"] as const;

export const ADMIN_ASSESSMENT_STATUSES = ["draft", "published", "closed", "archived"] as const;

export const ADMIN_PROCTORING_MODES = ["none", "basic"] as const;

/**
 * โหมดเปิดเฉลยหลังสอบ — enum exam_review_mode (0049 · Wave G P3 D83):
 * after_final_attempt = เปิดเฉลยเมื่อจบโอกาสสอบหรือผ่านแล้ว (default ของคอลัมน์) ·
 * never = ไม่เปิดเฉลยแม้ครบครั้ง/ผ่านแล้ว
 */
export const EXAM_REVIEW_MODES = ["after_final_attempt", "never"] as const;

/* ─── query ของ list endpoints (API-SPECIFICATION §1.2 + §3.8) ─── */

/** query ของ GET /admin/assessments — limit/cursor จาก PageQuery + ฟิลเตอร์ status/courseId */
export const AdminAssessmentsQuery = z
  .object({
    ...PageQuery.shape,
    status: z.enum(ADMIN_ASSESSMENT_STATUSES).optional(),
    courseId: z.uuid().optional(),
    // additive (gate GP3 r3 R3-M1): ชี้แถวเดียว — read-back ของโมดัลกติกา (cache:"no-store")
    id: z.uuid().optional(),
  })
  .strict();

export type AdminAssessmentsQueryParsed = z.infer<typeof AdminAssessmentsQuery>;

/** path/query ของ issue → รายชื่อ field — รูปแบบเดียวกับ schemas/admin-catalog (path ว่าง = "query") */
function adminExamValFields(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0 ? path : "query";
      }),
    ),
  ];
}

/** URLSearchParams → parsed AdminAssessmentsQuery — ผิดรูปแบบทุกกรณี → ERR-VAL-001 + fields */
export function parseAdminAssessmentsQuery(
  searchParams: URLSearchParams,
): AdminAssessmentsQueryParsed {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = AdminAssessmentsQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: adminExamValFields(parsed.error) } });
  }
  return parsed.data;
}

/** parser กลางของ body/params ใน lane นี้ — ไม่ผ่าน zod → ERR-VAL-001 + รายชื่อ field (§2) */
export function parseAdminExam<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: adminExamValFields(parsed.error) } });
  }
  return parsed.data;
}

/* ─── POST /admin/assessments ─── */

/** เวลา ISO 8601 (API-SPECIFICATION §1.1 — ยอมทั้ง Z และ +00:00) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/**
 * ชุดกติกาเริ่มต้นของการสอบ — คอลัมน์จริงของ assessment_rules (0005 L66-L82):
 * version ให้ DB default 1, effective_from จาก client ได้ (default now() ที่ DB)
 * pass_pct **บังคับ** ตอนสร้าง rules เพราะ DB ไม่มี default (0005 L72)
 */
export const AssessmentRuleInput = z
  .object({
    timeLimitMinutes: z.number().int().min(5).max(480).default(60),
    questionCount: z.number().int().min(1).max(1000).default(30),
    passPct: z.number().int().min(1).max(100),
    maxAttempts: z.number().int().min(1).max(100).default(3),
    attemptCooldownMinutes: z.number().int().min(0).max(525600).default(1440),
    shuffleQuestions: z.boolean().default(true),
    shuffleOptions: z.boolean().default(true),
    selection: z.record(z.string(), z.unknown()).optional(),
    requireCourseComplete: z.boolean().default(true),
    proctoringMode: z.enum(ADMIN_PROCTORING_MODES).default("basic"),
    examReviewMode: z.enum(EXAM_REVIEW_MODES).default("after_final_attempt"),
    effectiveFrom: IsoTimestamp.optional(),
  })
  .strict();

export type AssessmentRuleInputParsed = z.infer<typeof AssessmentRuleInput>;

/**
 * body ของ POST /admin/assessments — ไม่มี status (BFF ใส่ 'draft' เสมอ — ห้ามรับจาก body
 * ตามคำสั่ง lane; enum จริง draft/published/closed/archived ไม่มี 'review')
 * code จำเป็นเพราะ assessments.code NOT NULL + UNIQUE(course_id, code) (0005 L53/L62-L63)
 */
export const AssessmentCreateBody = z
  .object({
    courseId: z.uuid(),
    code: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(300),
    description: z.string().max(4000).nullable().optional(),
    isFinal: z.boolean().optional(),
    rules: AssessmentRuleInput.optional(),
  })
  .strict();

export type AssessmentCreateBodyParsed = z.infer<typeof AssessmentCreateBody>;

/* ─── POST /admin/question-banks + PATCH questions ─── */

/**
 * ตัวเลือกฝั่งผู้แต่ง (request เท่านั้น — ไม่เคยอยู่ใน resource ที่ตอบกลับ):
 * id มี = แก้แถวเดิม (UPDATE — question_options **ไม่มี grant DELETE** 0010 L638-L640
 * จึงทำ replace-all ไม่ได้); ไม่มี id = เพิ่มตัวเลือกใหม่
 */
export const QuestionOptionInput = z
  .object({
    id: z.uuid().optional(),
    optionText: z.string().trim().min(1).max(2000),
    isCorrect: z.boolean(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .strict();

export type QuestionOptionInputParsed = z.infer<typeof QuestionOptionInput>;

/** ข้อสอบใหม่ใน POST /admin/question-banks — status ไม่รับจาก client ('draft' เสมอ) */
export const QuestionCreateInput = z
  .object({
    type: z.enum(ADMIN_QUESTION_TYPES),
    difficulty: z.enum(ADMIN_QUESTION_DIFFICULTIES).default("medium"),
    questionText: z.string().trim().min(1).max(8000),
    explanation: z.string().max(4000).nullable().optional(),
    points: z.number().int().min(1).max(100).default(1),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    options: z.array(QuestionOptionInput).min(1).max(10),
  })
  .strict();

export type QuestionCreateInputParsed = z.infer<typeof QuestionCreateInput>;

/** body ของ POST /admin/question-banks — ข้อสอบเริ่มต้น "ถ้ากำหนด" (API-SPECIFICATION §3.8) */
export const QuestionBankCreateBody = z
  .object({
    code: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(300),
    courseId: z.uuid().nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    isActive: z.boolean().optional(),
    questions: z.array(QuestionCreateInput).max(100).optional(),
  })
  .strict();

export type QuestionBankCreateBodyParsed = z.infer<typeof QuestionBankCreateBody>;

/**
 * body ของ PATCH /admin/question-banks/{id}/questions/{qid} — **strict และไม่มี status**
 * (การเปลี่ยน draft→active/retired เป็นสิทธิ์ staff:exam/super_admin ที่ DB guard บังคับ —
 * BFF ไม่รับ status จาก body; ทุก key แปลกปลอมรวมถึง "status" → ERR-VAL-001)
 */
export const QuestionPatchBody = z
  .object({
    type: z.enum(ADMIN_QUESTION_TYPES).optional(),
    difficulty: z.enum(ADMIN_QUESTION_DIFFICULTIES).optional(),
    questionText: z.string().trim().min(1).max(8000).optional(),
    explanation: z.string().max(4000).nullable().optional(),
    points: z.number().int().min(1).max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    options: z.array(QuestionOptionInput).max(10).optional(),
  })
  .strict();

export type QuestionPatchBodyParsed = z.infer<typeof QuestionPatchBody>;

/** path params ของ PATCH — ชื่อ segment ตามโฟลเดอร์ [id]/questions/[qid] */
export const QuestionPatchParams = z
  .object({ bankId: z.uuid(), questionId: z.uuid() })
  .strict();

export type QuestionPatchParamsParsed = z.infer<typeof QuestionPatchParams>;

/* ─── resources (response — camelCase ตาม convention §1.1) ─── */

/** แถว question_options ที่ "เห็นได้" — ไม่มี is_correct เด็ดขาด (DD §3.4 · 0010 L520-L521) */
export const QuestionOptionView = z.object({
  id: z.uuid(),
  optionText: z.string(),
  sortOrder: z.number().int(),
}).strict();

export type QuestionOptionViewParsed = z.infer<typeof QuestionOptionView>;

/**
 * resource ข้อสอบแบบอ่าน — ตัด is_correct ออกจากทุก response (GET ของหลังบ้าน/PATCH)
 * ผู้แต่งเห็น is_correct เฉพาะตอน "ส่ง" request (QuestionOptionInput)
 */
export const QuestionResource = z.object({
  id: z.uuid(),
  bankId: z.uuid(),
  type: z.enum(ADMIN_QUESTION_TYPES),
  difficulty: z.enum(ADMIN_QUESTION_DIFFICULTIES),
  questionText: z.string(),
  explanation: z.string().nullable(),
  points: z.number().int().min(1),
  status: z.enum(ADMIN_QUESTION_STATUSES),
  tags: z.array(z.string()),
  version: z.number().int().min(1),
  createdAt: IsoTimestamp,
  options: z.array(QuestionOptionView),
}).strict();

export type QuestionResourceParsed = z.infer<typeof QuestionResource>;

/**
 * สรุปกติกาของ GET /admin/assessments — แถวกติกาล่าสุดมาจาก **RPC admin_latest_assessment_rules
 * (0051)** ครบทุกคอลัมน์ ไม่ใช่ embed ตารางอีกต่อไป (0050 เปิด column grant selection แล้วพบ
 * ผู้เรียนอ่านทางตรง PostgREST ได้ — gate GP3 r2 R2-M3 → 0051 revoke + RPC คุมบทบาทในตัว)
 */
export const AssessmentRuleSummary = z.object({
  version: z.number().int().min(1),
  passPct: z.number().int().min(1).max(100),
  timeLimitMinutes: z.number().int(),
  questionCount: z.number().int(),
  maxAttempts: z.number().int(),
  cooldownMinutes: z.number().int(),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  requireCourseComplete: z.boolean(),
  selection: z.record(z.string(), z.unknown()),
  proctoringMode: z.enum(ADMIN_PROCTORING_MODES),
  examReviewMode: z.enum(EXAM_REVIEW_MODES),
  effectiveFrom: IsoTimestamp,
}).strict();

export type AssessmentRuleSummaryParsed = z.infer<typeof AssessmentRuleSummary>;

/** resource ของ /admin/assessments — createdBy มาจาก course เจ้าของ (assessments ไม่มีคอลัมน์ created_by — 0005 L50-L61) */
export const AdminAssessmentResource = z.object({
  id: z.uuid(),
  code: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  courseId: z.uuid(),
  isFinal: z.boolean(),
  status: z.enum(ADMIN_ASSESSMENT_STATUSES),
  createdBy: z.uuid().nullable(),
  rules: AssessmentRuleSummary.nullable(),
  createdAt: IsoTimestamp,
}).strict();

export type AdminAssessmentResourceParsed = z.infer<typeof AdminAssessmentResource>;

/** resource ของ /admin/question-banks — questionCount นับฝั่ง DB (embed questions(count)) */
export const QuestionBankResource = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  courseId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  isActive: z.boolean(),
  questionCount: z.number().int().min(0),
  createdAt: IsoTimestamp,
}).strict();

export type QuestionBankResourceParsed = z.infer<typeof QuestionBankResource>;

/** ข้อสอบที่สร้างใหม่ใน POST /admin/question-banks — id อ้างกลับให้ผู้แต่ง (ไม่มี is_correct) */
export const QuestionCreatedRef = z.object({
  id: z.uuid(),
  type: z.enum(ADMIN_QUESTION_TYPES),
  questionText: z.string(),
  points: z.number().int().min(1),
}).strict();

export type QuestionCreatedRefParsed = z.infer<typeof QuestionCreatedRef>;

/**
 * response ของ POST /admin/question-banks — bank + ข้อสอบเริ่มต้นที่สร้างสำเร็จ
 * r5-K1: สืบทอด strict จาก QuestionBankResource (zod extend คง unknown-keys
 * นโยบายของฐาน) — ขาออกทุกชั้นรวม nested ต้อง strict ไม่ strip ฟิลด์แปลกปลอมเงียบ
 */
export const QuestionBankCreateResult = QuestionBankResource.extend({
  questions: z.array(QuestionCreatedRef),
}).strict();

export type QuestionBankCreateResultParsed = z.infer<typeof QuestionBankCreateResult>;

/* ─── แถว DB (snake_case ตามคอลัมน์จริง) + mapper ─── */

/** แถว assessment_rules ที่ BFF merge จาก RPC admin_latest_assessment_rules (0051) เป็นรูป embed เดิม — คอลัมน์ 14 ตัวตาม RPC (เลิก embed ตารางหลัง 0051 revoke selection — R2-M3) */
export interface AssessmentRuleRow {
  readonly version: number;
  readonly pass_pct: number;
  readonly time_limit_minutes: number;
  readonly question_count: number;
  readonly max_attempts: number;
  readonly attempt_cooldown_minutes: number;
  readonly shuffle_questions: boolean;
  readonly shuffle_options: boolean;
  readonly require_course_complete: boolean;
  readonly selection: Record<string, unknown>;
  readonly proctoring_mode: string;
  readonly exam_review_mode: string;
  readonly effective_from: string;
}

/** แถว assessments + embed (PostgREST) — course = เจ้าของหลักสูตร (created_by), rules = version สูงสุด */
export interface AdminAssessmentRow {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly description: string | null;
  readonly course_id: string;
  readonly is_final: boolean;
  readonly status: string;
  readonly created_at: string;
  readonly course: { readonly id: string; readonly created_by: string } | null;
  readonly assessment_rules: readonly AssessmentRuleRow[];
}

/**
 * แถว DB ดิบจาก PostgREST ตรวจก่อน map (0019-r2 F5 — mirror B4 ของฝั่งออก):
 * cast ตรง ๆ เชื่อสัญญา DB มากเกินไป — แถว drift (คอลัมน์เปลี่ยน/embed เพี้ยน/RLS
 * ตัดฟิลด์) ไหลเข้า mapper เป็น undefined/ค่าผิดชนิดแล้วไปตายที่ view ขาออก
 * (หรือผ่านซึมถ้า view กว้างกว่า) — ตรวจที่ขาเข้าเป็นชั้นแรก fail-closed เลย
 * · course เป็น null ได้ตามจริง (!left embed) · rules = array เสมอ — PostgREST to-many
 *   embed คืน [] เมื่อ draft ยังไม่มี rules (พิสูจน์กับ dev stack จริง r10-P2) → null = drift
 */
export const AssessmentRuleRowSchema = z
  .object({
    version: z.number().int().min(1),
    pass_pct: z.number().int().min(1).max(100),
    time_limit_minutes: z.number().int(),
    question_count: z.number().int(),
    max_attempts: z.number().int(),
    attempt_cooldown_minutes: z.number().int(),
    shuffle_questions: z.boolean(),
    shuffle_options: z.boolean(),
    require_course_complete: z.boolean(),
    selection: z.record(z.string(), z.unknown()),
    proctoring_mode: z.enum(ADMIN_PROCTORING_MODES),
    exam_review_mode: z.enum(EXAM_REVIEW_MODES),
    effective_from: IsoTimestamp,
  })
  .strict();

export const AdminAssessmentRowSchema = z
  .object({
    id: z.uuid(),
    code: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable(),
    course_id: z.uuid(),
    is_final: z.boolean(),
    status: z.enum(ADMIN_ASSESSMENT_STATUSES),
    created_at: IsoTimestamp,
    course: z.object({ id: z.uuid(), created_by: z.uuid() }).strict().nullable(),
    assessment_rules: z.array(AssessmentRuleRowSchema),
  })
  .strict();

/** แถว assessments ดิบ → AdminAssessmentRow ที่ผ่านการตรวจแล้ว — drift → ERR-SYS-002 (503 ไม่ leak รายละเอียด) */
export function parseAdminAssessmentRow(row: unknown): AdminAssessmentRow {
  const parsed = AdminAssessmentRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "admin_assessment_row_drift" } });
  }
  return parsed.data;
}

/** map แถว assessments → resource — เลือกกติกา version สูงสุด (handler เรียง version desc + limit 1 — "ล่าสุด" = ฐานที่ RPC ใช้คิด max+1 ต่อ) */
export function toAdminAssessmentResource(row: AdminAssessmentRow): AdminAssessmentResourceParsed {
  const latestRule = row.assessment_rules[0];
  const rules: AssessmentRuleSummaryParsed | null =
    latestRule === undefined
      ? null
      : {
          version: latestRule.version,
          passPct: latestRule.pass_pct,
          timeLimitMinutes: latestRule.time_limit_minutes,
          questionCount: latestRule.question_count,
          maxAttempts: latestRule.max_attempts,
          cooldownMinutes: latestRule.attempt_cooldown_minutes,
          shuffleQuestions: latestRule.shuffle_questions,
          shuffleOptions: latestRule.shuffle_options,
          requireCourseComplete: latestRule.require_course_complete,
          selection: latestRule.selection,
          proctoringMode: latestRule.proctoring_mode as AssessmentRuleSummaryParsed["proctoringMode"],
          examReviewMode: latestRule.exam_review_mode as AssessmentRuleSummaryParsed["examReviewMode"],
          effectiveFrom: latestRule.effective_from,
        };
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    courseId: row.course_id,
    isFinal: row.is_final,
    status: row.status as AdminAssessmentResourceParsed["status"],
    createdBy: row.course?.created_by ?? null,
    rules,
    createdAt: row.created_at,
  };
}

/** แถว question_banks + embed นับข้อ (PostgREST `questions(count)` → [{ count: n }]) */
export interface QuestionBankRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly course_id: string | null;
  readonly category_id: string | null;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly questions: readonly { readonly count: number }[];
}

/** map แถว question_banks → resource — count จาก aggregate row เดียวของ PostgREST
 *  (`questions(count)` คืน [{count:n}] เสมอแม้ n=0 — พิสูจน์กับ dev stack จริง r10-P2) */
export function toQuestionBankResource(row: QuestionBankRow): QuestionBankResourceParsed {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    courseId: row.course_id,
    categoryId: row.category_id,
    isActive: row.is_active,
    // min(1)/max(1) ของ schema การันต์ [0] มีเสมอ — ?? 0 เหลือเพื่อ type (noUncheckedIndexedAccess)
    questionCount: row.questions[0]?.count ?? 0,
    createdAt: row.created_at,
  };
}

/**
 * r4-H2a: แถว question_banks ดิบจาก DB → ตรวจก่อน map (แบบเดียวกับ parseAdminAssessmentRow
 * ของ G3) — drift ของ select/view (คอลัมน์หาย/ชนิดเปลี่ยน/คีย์เกิน) = ERR-SYS-002 503 fail-closed
 */
export const QuestionBankRowSchema = z
  .object({
    id: z.uuid(),
    code: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    course_id: z.uuid().nullable(),
    category_id: z.uuid().nullable(),
    is_active: z.boolean(),
    created_at: IsoTimestamp,
    // r10-P2: aggregate `questions(count)` ของ PostgREST คืน aggregate row เดียวเสมอ —
    // [{count:0}] แม้ธนาคารไม่มีข้อเลย (probe dev stack จริง) → exact-one non-nullable
    // null / [] / 2 แถว = drift 503 ไม่ fabricate 0 จากแถวที่ไม่มี
    questions: z.array(z.object({ count: z.number().int().min(0) }).strict()).min(1).max(1),
  })
  .strict();

export function parseQuestionBankRow(row: unknown): QuestionBankRow {
  const parsed = QuestionBankRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "question_bank_row_drift" } });
  }
  return parsed.data;
}

/** r4-H2a: แถว questions ที่ POST สร้างใหม่ (select id,type,question_text,points) — ตรวจก่อนใช้ id ผูก options */
export const QuestionCreatedRowSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(ADMIN_QUESTION_TYPES),
    question_text: z.string().min(1),
    points: z.number().int().min(1),
  })
  .strict();

export function parseQuestionCreatedRow(row: unknown): {
  id: string;
  type: QuestionCreatedRefParsed["type"];
  question_text: string;
  points: number;
} {
  const parsed = QuestionCreatedRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "question_created_row_drift" } });
  }
  return parsed.data;
}

/**
 * r4-H2b: แถว questions + embed options ดิบ (select ตัด is_correct) → ตรวจก่อน map —
 * drift (เช่น tags null ที่ mapper เดิมอ่าน .filter ตรง ๆ → TypeError 500) = ERR-SYS-002 503
 */
export const QuestionRowSchema = z
  .object({
    id: z.uuid(),
    bank_id: z.uuid(),
    type: z.enum(ADMIN_QUESTION_TYPES),
    difficulty: z.enum(ADMIN_QUESTION_DIFFICULTIES),
    question_text: z.string().min(1),
    explanation: z.string().nullable(),
    points: z.number().int().min(1),
    status: z.enum(ADMIN_QUESTION_STATUSES),
    tags: z.array(z.string()),
    version: z.number().int().min(1),
    created_at: IsoTimestamp,
    // r10-P2: to-many embed คืน array เสมอ ( [] เมื่อไม่มีตัวเลือก) → null = drift ไม่ fabricate []
    question_options: z
      .array(z.object({ id: z.uuid(), option_text: z.string().min(1), sort_order: z.number().int() }).strict()),
  })
  .strict();

export function parseQuestionRow(row: unknown): QuestionRow {
  const parsed = QuestionRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "question_row_drift" } });
  }
  return parsed.data;
}

/** แถว questions + embed options (ไม่มี is_correct ใน select — ตัดตั้งแต่ query) */
export interface QuestionRow {
  readonly id: string;
  readonly bank_id: string;
  readonly type: string;
  readonly difficulty: string;
  readonly question_text: string;
  readonly explanation: string | null;
  readonly points: number;
  readonly status: string;
  readonly tags: readonly string[];
  readonly version: number;
  readonly created_at: string;
  readonly question_options:
    readonly { readonly id: string; readonly option_text: string; readonly sort_order: number }[];
}

/** map แถว questions → resource แบบอ่าน (ไม่มี is_correct เด็ดขาด) */
export function toQuestionResource(row: QuestionRow): QuestionResourceParsed {
  return {
    id: row.id,
    bankId: row.bank_id,
    type: row.type as QuestionResourceParsed["type"],
    difficulty: row.difficulty as QuestionResourceParsed["difficulty"],
    questionText: row.question_text,
    explanation: row.explanation,
    points: row.points,
    status: row.status as QuestionResourceParsed["status"],
    tags: [...row.tags],
    version: row.version,
    createdAt: row.created_at,
    options: row.question_options.map((option) => ({
      id: option.id,
      optionText: option.option_text,
      sortOrder: option.sort_order,
    })),
  };
}

/* ─── Wave G P2 — read surfaces + status toggle (D74/D75/D78 · API-SPECIFICATION §3.8 1.3.0) ─── */

/** body ของ PATCH .../questions/{qid}/status (D75) — strict { status: active|retired } เท่านั้น */
export const QuestionStatusBody = z
  .object({ status: z.enum(["active", "retired"]) })
  .strict();

export type QuestionStatusBodyParsed = z.infer<typeof QuestionStatusBody>;

/** path params ของ status PATCH — รูปแบบเดียวกับ QuestionPatchParams ([id]/questions/[qid]/status) */
export const QuestionStatusParams = z
  .object({ bankId: z.uuid(), questionId: z.uuid() })
  .strict();

export type QuestionStatusParamsParsed = z.infer<typeof QuestionStatusParams>;

/**
 * ตัวเลือกของ EditQuestionResource — เพิ่ม isCorrect จาก QuestionOptionView (D74):
 * เฉลยปรากฏเฉพาะ edit GET — list/PATCH ยังตัด is_correct ตั้งแต่ SELECT เหมือนเดิม
 */
export const EditQuestionOption = z
  .object({
    id: z.uuid(),
    optionText: z.string(),
    sortOrder: z.number().int(),
    isCorrect: z.boolean(),
  })
  .strict();

export type EditQuestionOptionParsed = z.infer<typeof EditQuestionOption>;

/**
 * resource ข้อสอบสำหรับฟอร์มแก้ (GET .../questions/{qid} — D74) — DTO แยกจาก
 * QuestionResource เพื่อไม่ให้เส้นอื่นเริ่มคืนเฉลยโดยอ้อม (list/PATCH ไม่มี isCorrect)
 */
export const EditQuestionResource = z
  .object({
    id: z.uuid(),
    bankId: z.uuid(),
    type: z.enum(ADMIN_QUESTION_TYPES),
    difficulty: z.enum(ADMIN_QUESTION_DIFFICULTIES),
    questionText: z.string(),
    explanation: z.string().nullable(),
    points: z.number().int().min(1),
    status: z.enum(ADMIN_QUESTION_STATUSES),
    tags: z.array(z.string()),
    version: z.number().int().min(1),
    createdAt: IsoTimestamp,
    options: z.array(EditQuestionOption),
  })
  .strict();

export type EditQuestionResourceParsed = z.infer<typeof EditQuestionResource>;

/**
 * แถว questions + embed options "รวม is_correct" (edit GET เท่านั้น — r4-H2a ตรวจขาเข้า
 * ก่อน map แบบเดียวกับ QuestionRowSchema — drift → ERR-SYS-002 503 fail-closed)
 */
export const EditQuestionRowSchema = z
  .object({
    id: z.uuid(),
    bank_id: z.uuid(),
    type: z.enum(ADMIN_QUESTION_TYPES),
    difficulty: z.enum(ADMIN_QUESTION_DIFFICULTIES),
    question_text: z.string().min(1),
    explanation: z.string().nullable(),
    points: z.number().int().min(1),
    status: z.enum(ADMIN_QUESTION_STATUSES),
    tags: z.array(z.string()),
    version: z.number().int().min(1),
    created_at: IsoTimestamp,
    // to-many embed คืน array เสมอ ( [] เมื่อไม่มีตัวเลือก) → null = drift ไม่ fabricate []
    question_options: z.array(
      z
        .object({
          id: z.uuid(),
          option_text: z.string().min(1),
          sort_order: z.number().int(),
          is_correct: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

/** แถว questions + embed options รวม is_correct (หลังผ่านการตรวจ EditQuestionRowSchema) */
export interface EditQuestionRow {
  readonly id: string;
  readonly bank_id: string;
  readonly type: string;
  readonly difficulty: string;
  readonly question_text: string;
  readonly explanation: string | null;
  readonly points: number;
  readonly status: string;
  readonly tags: readonly string[];
  readonly version: number;
  readonly created_at: string;
  readonly question_options: readonly {
    readonly id: string;
    readonly option_text: string;
    readonly sort_order: number;
    readonly is_correct: boolean;
  }[];
}

export function parseEditQuestionRow(row: unknown): EditQuestionRow {
  const parsed = EditQuestionRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "edit_question_row_drift" } });
  }
  return parsed.data;
}

/** map แถว edit → EditQuestionResource (options รวม isCorrect — เส้นเดียวที่คืนเฉลย) */
export function toEditQuestionResource(row: EditQuestionRow): EditQuestionResourceParsed {
  return {
    id: row.id,
    bankId: row.bank_id,
    type: row.type as EditQuestionResourceParsed["type"],
    difficulty: row.difficulty as EditQuestionResourceParsed["difficulty"],
    questionText: row.question_text,
    explanation: row.explanation,
    points: row.points,
    status: row.status as EditQuestionResourceParsed["status"],
    tags: [...row.tags],
    version: row.version,
    createdAt: row.created_at,
    options: row.question_options.map((option) => ({
      id: option.id,
      optionText: option.option_text,
      sortOrder: option.sort_order,
      isCorrect: option.is_correct,
    })),
  };
}

/**
 * แถว jsonb ที่ RPC admin_set_question_status คืน ({question_id, status, version}) —
 * ตรวจขาเข้าก่อน map (drift → ERR-SYS-002 503 ตามแบบ r4-H2a)
 */
export const QuestionStatusRpcRowSchema = z
  .object({
    question_id: z.uuid(),
    status: z.enum(["active", "retired"]),
    version: z.number().int().min(1),
  })
  .strict();

export type QuestionStatusRpcRow = z.infer<typeof QuestionStatusRpcRowSchema>;

export function parseQuestionStatusRpcRow(row: unknown): QuestionStatusRpcRow {
  const parsed = QuestionStatusRpcRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "question_status_rpc_row_drift" } });
  }
  return parsed.data;
}

/** response ของ PATCH .../status — {questionId, status, version} (API-SPECIFICATION แถว 222) */
export const QuestionStatusResult = z
  .object({
    questionId: z.uuid(),
    status: z.enum(["active", "retired"]),
    version: z.number().int().min(1),
  })
  .strict();

export type QuestionStatusResultParsed = z.infer<typeof QuestionStatusResult>;

/** map แถว RPC → response resource (map ตรง ไม่ fabricate ค่า) */
export function toQuestionStatusResult(row: QuestionStatusRpcRow): QuestionStatusResultParsed {
  return { questionId: row.question_id, status: row.status, version: row.version };
}

/* ─── mapping error ฝั่ง DB (insert/update ธรรมดา — ไม่ใช่ RPC) ─── */

/** รูป error ที่ PostgREST คืนกับ insert/update (supabase PostgrestError — เฉพาะฟิลด์ที่ใช้) */
export interface AdminExamDbErrorLike {
  readonly code?: string | null;
}

/**
 * map PostgrestError → error code ทะเบียน (ตามคำสั่ง lane: 42xxx/42501 → RBAC · 22xxx/23xxx/P0001 → VAL)
 * - class 42 (เช่น 42501 insufficient_privilege — RLS WITH CHECK ขวาง) → ERR-RBAC-001 403
 * - class 22/23 (check/unique/FK/ไม่อยู่ใน enum) + P0001 (raise exception ของ trigger guard
 *   validate_option_correctness 0005 L139-L177) → ERR-VAL-001 400
 * - อื่น ๆ → ERR-SYS-002 503 แบบ opaque (ไม่ leak ข้อความ SQL — SDS §6.1)
 */
export function mapAdminExamDbError(error: AdminExamDbErrorLike): AppError {
  const code = typeof error.code === "string" ? error.code : "";
  if (code.startsWith("42")) {
    return new AppError("ERR-RBAC-001", { details: { reason: "rls_check_failed" } });
  }
  if (code.startsWith("22") || code.startsWith("23") || code === "P0001") {
    return new AppError("ERR-VAL-001", { details: { reason: "db_constraint_failed" } });
  }
  return new AppError("ERR-SYS-002", { details: { reason: "admin_exam_db_error" } });
}

/* ─── Wave G P3 — เพิ่มกติกา version ใหม่ (D87 · API-SPECIFICATION §3.8 POST /admin/assessments/{id}/rules) ─── */

/**
 * แถว jsonb ที่ RPC admin_add_assessment_rules (0049) คืน — returning * ของ
 * assessment_rules (0005 L66-L82 + exam_review_mode 0049 · selection NOT NULL ตามคอลัมน์)
 * ตรวจขาเข้าก่อน map (drift → ERR-SYS-002 503 ตามแบบ r4-H2a)
 */
export const AssessmentRuleRpcRowSchema = z
  .object({
    id: z.uuid(),
    assessment_id: z.uuid(),
    version: z.number().int().min(1),
    time_limit_minutes: z.number().int(),
    question_count: z.number().int(),
    pass_pct: z.number().int().min(1).max(100),
    max_attempts: z.number().int(),
    attempt_cooldown_minutes: z.number().int(),
    shuffle_questions: z.boolean(),
    shuffle_options: z.boolean(),
    selection: z.record(z.string(), z.unknown()),
    require_course_complete: z.boolean(),
    proctoring_mode: z.enum(ADMIN_PROCTORING_MODES),
    exam_review_mode: z.enum(EXAM_REVIEW_MODES),
    effective_from: IsoTimestamp,
    created_at: IsoTimestamp,
  })
  .strict();

export type AssessmentRuleRpcRow = z.infer<typeof AssessmentRuleRpcRowSchema>;

/** แถว RPC ดิบ → ผ่านการตรวจแล้ว — drift → ERR-SYS-002 (503 ไม่ leak รายละเอียด) */
export function parseAssessmentRuleRpcRow(row: unknown): AssessmentRuleRpcRow {
  const parsed = AssessmentRuleRpcRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "assessment_rule_rpc_row_drift" } });
  }
  return parsed.data;
}

/** resource ของ POST /admin/assessments/{id}/rules — แถวกติกาที่แทรก (camelCase ตาม convention §1.1) */
export const AssessmentRuleResource = z
  .object({
    id: z.uuid(),
    assessmentId: z.uuid(),
    version: z.number().int().min(1),
    timeLimitMinutes: z.number().int(),
    questionCount: z.number().int(),
    passPct: z.number().int().min(1).max(100),
    maxAttempts: z.number().int(),
    attemptCooldownMinutes: z.number().int(),
    shuffleQuestions: z.boolean(),
    shuffleOptions: z.boolean(),
    selection: z.record(z.string(), z.unknown()),
    requireCourseComplete: z.boolean(),
    proctoringMode: z.enum(ADMIN_PROCTORING_MODES),
    examReviewMode: z.enum(EXAM_REVIEW_MODES),
    effectiveFrom: IsoTimestamp,
    createdAt: IsoTimestamp,
  })
  .strict();

export type AssessmentRuleResourceParsed = z.infer<typeof AssessmentRuleResource>;

/** map แถว RPC → resource — map ตรง ไม่ fabricate ค่า (mapper เดียวใช้ทั้งขา parse และ view ขาออก) */
export function toAssessmentRuleResource(row: AssessmentRuleRpcRow): AssessmentRuleResourceParsed {
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    version: row.version,
    timeLimitMinutes: row.time_limit_minutes,
    questionCount: row.question_count,
    passPct: row.pass_pct,
    maxAttempts: row.max_attempts,
    attemptCooldownMinutes: row.attempt_cooldown_minutes,
    shuffleQuestions: row.shuffle_questions,
    shuffleOptions: row.shuffle_options,
    selection: row.selection,
    requireCourseComplete: row.require_course_complete,
    proctoringMode: row.proctoring_mode,
    examReviewMode: row.exam_review_mode,
    effectiveFrom: row.effective_from,
    createdAt: row.created_at,
  };
}

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

/* ─── query ของ list endpoints (API-SPECIFICATION §1.2 + §3.8) ─── */

/** query ของ GET /admin/assessments — limit/cursor จาก PageQuery + ฟิลเตอร์ status/courseId */
export const AdminAssessmentsQuery = z
  .object({
    ...PageQuery.shape,
    status: z.enum(ADMIN_ASSESSMENT_STATUSES).optional(),
    courseId: z.uuid().optional(),
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
});

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
});

export type QuestionResourceParsed = z.infer<typeof QuestionResource>;

/**
 * สรุปกติกาของ GET /admin/assessments — คอลัมน์ตาม **column grant ของ authenticated**
 * (0010 L711-L714) เท่านั้น: pass_pct/selection ไม่ได้รับ grant ผ่าน user-JWT จึงไม่อยู่ใน
 * response (เส้นทาง lane นี้ใช้ user JWT — ห้าม service_role)
 */
export const AssessmentRuleSummary = z.object({
  version: z.number().int().min(1),
  timeLimitMinutes: z.number().int(),
  questionCount: z.number().int(),
  maxAttempts: z.number().int(),
  cooldownMinutes: z.number().int(),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  proctoringMode: z.enum(ADMIN_PROCTORING_MODES),
  effectiveFrom: IsoTimestamp,
});

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
});

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
});

export type QuestionBankResourceParsed = z.infer<typeof QuestionBankResource>;

/** ข้อสอบที่สร้างใหม่ใน POST /admin/question-banks — id อ้างกลับให้ผู้แต่ง (ไม่มี is_correct) */
export const QuestionCreatedRef = z.object({
  id: z.uuid(),
  type: z.enum(ADMIN_QUESTION_TYPES),
  questionText: z.string(),
  points: z.number().int().min(1),
});

export type QuestionCreatedRefParsed = z.infer<typeof QuestionCreatedRef>;

/** response ของ POST /admin/question-banks — bank + ข้อสอบเริ่มต้นที่สร้างสำเร็จ */
export const QuestionBankCreateResult = QuestionBankResource.extend({
  questions: z.array(QuestionCreatedRef),
});

export type QuestionBankCreateResultParsed = z.infer<typeof QuestionBankCreateResult>;

/* ─── แถว DB (snake_case ตามคอลัมน์จริง) + mapper ─── */

/** แถว assessment_rules ที่ฝังมากับ assessments — เฉพาะคอลัมน์ที่ authenticated ได้ grant (0010 L711-L714) */
export interface AssessmentRuleRow {
  readonly version: number;
  readonly time_limit_minutes: number;
  readonly question_count: number;
  readonly max_attempts: number;
  readonly attempt_cooldown_minutes: number;
  readonly shuffle_questions: boolean;
  readonly shuffle_options: boolean;
  readonly proctoring_mode: string;
  readonly effective_from: string;
}

/** แถว assessments + embed (PostgREST) — course = เจ้าของหลักสูตร (created_by), rules = effective ล่าสุด */
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
  readonly assessment_rules: readonly AssessmentRuleRow[] | null;
}

/** map แถว assessments → resource — เลือกกติกา effective ล่าสุด (effective_from มากสุด — handler เรียงให้) */
export function toAdminAssessmentResource(row: AdminAssessmentRow): AdminAssessmentResourceParsed {
  const latestRule = row.assessment_rules?.[0];
  const rules: AssessmentRuleSummaryParsed | null =
    latestRule === undefined
      ? null
      : {
          version: latestRule.version,
          timeLimitMinutes: latestRule.time_limit_minutes,
          questionCount: latestRule.question_count,
          maxAttempts: latestRule.max_attempts,
          cooldownMinutes: latestRule.attempt_cooldown_minutes,
          shuffleQuestions: latestRule.shuffle_questions,
          shuffleOptions: latestRule.shuffle_options,
          proctoringMode: latestRule.proctoring_mode as AssessmentRuleSummaryParsed["proctoringMode"],
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
  readonly questions: readonly { readonly count: number }[] | null;
}

/** map แถว question_banks → resource — count = 0 เมื่อ embed ว่าง/ถูก RLS กรอง */
export function toQuestionBankResource(row: QuestionBankRow): QuestionBankResourceParsed {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    courseId: row.course_id,
    categoryId: row.category_id,
    isActive: row.is_active,
    questionCount: row.questions?.[0]?.count ?? 0,
    createdAt: row.created_at,
  };
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
    | readonly { readonly id: string; readonly option_text: string; readonly sort_order: number }[]
    | null;
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
    options: (row.question_options ?? []).map((option) => ({
      id: option.id,
      optionText: option.option_text,
      sortOrder: option.sort_order,
    })),
  };
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

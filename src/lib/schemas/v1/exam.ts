/**
 * schemas/v1/exam — zod contract ของ Assessment/Attempt (API-SPECIFICATION §3.5 + §4 #7)
 *
 * - AnswerSaveRequest = §4 #7 ตรงตัวอักษร — คำตอบอย่างเดียว ห้ามมี is_correct/คะแนนจาก client
 *   (grading = server ล้วน ผ่าน RPC save_answer/submit_attempt — 0011_functions.sql)
 * - *Result = contract jsonb ขาเข้าจาก RPC (validate แบบ fail-closed ก่อนใช้)
 * - *View = ขาออก (camelCase) — validate ด้วย zod ก่อนส่งทุกครั้ง (§1-4)
 * - ความปลอดภัยข้อสอบ (D19-B1/D20-B5):
 *   · ระหว่างสอบ BFF ส่งเฉพาะโครงข้อ (questionId/seq/คำตอบของตัวเอง) — โครงสร้างสร้างแบบ
 *     whitelist จึงไม่มีช่องทางรั่ว is_correct/explanation/points_earned/question_snapshot
 *   · เฉลยเปิดฝั่ง DB เท่านั้น (learner_attempt_view เปิดเฉพาะ after_final_attempt —
 *     0009_views.sql) — BFF ส่งตาม view ไม่ filter/เปิดเฉลยเอง
 *   · session binding (D20-B5): p_session_id อ่านจาก claim `session_id` ของ access token
 *     ใน session store เท่านั้น — ห้ามรับจาก request body เด็ดขาด
 */
import { z } from "zod";
import { AppError } from "../../errors";

// ─── path params ───
export const AssessmentIdParams = z.object({ id: z.string().uuid() });
export const AttemptIdParams = z.object({ id: z.string().uuid() });

export type AssessmentIdParamsParsed = z.infer<typeof AssessmentIdParams>;
export type AttemptIdParamsParsed = z.infer<typeof AttemptIdParams>;

// ─── §4 #7 — บันทึกคำตอบสอบทีละข้อ (autosave) ───
// clientSavedAt = เวลานาฬิกา client — ใช้บันทึก/เทียบเท่านั้น เกณฑ์ตัดสินหมดเวลาคือ
// expires_at ฝั่ง RPC save_answer (RPC ไม่รับค่านี้) · ตัวเลือก 1-10 ต่อข้อตาม §4 #7
export const AnswerSaveRequest = z.object({
  questionId: z.string().uuid(),
  choiceIds: z.array(z.string().uuid()).min(1).max(10),
  clientSavedAt: z.iso.datetime({ offset: true }),
});

export type AnswerSaveRequestParsed = z.infer<typeof AnswerSaveRequest>;

// ─── contract jsonb ของ RPC start_attempt (0011_functions.sql — jsonb_build_object):
//     {attempt_id, session_id, expires_at, question_count} (+takeover:true เมื่อ takeover) ───
export const StartAttemptResult = z.object({
  attempt_id: z.string().uuid(),
  session_id: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  question_count: z.number().int().min(1),
  takeover: z.literal(true).optional(),
});

export type StartAttemptResultParsed = z.infer<typeof StartAttemptResult>;

// ─── contract jsonb ของ RPC submit_attempt (0011_functions.sql):
//     ส่งใหม่หลังส่งแล้ว = ผลเดิม + already_submitted:true (ไม่มี correct/question_count) ───
export const SubmitAttemptResult = z.object({
  attempt_id: z.string().uuid(),
  status: z.enum(["passed", "failed"]),
  score_pct: z.number().int().min(0).max(100),
  passed: z.boolean(),
  correct_count: z.number().int().min(0).optional(),
  question_count: z.number().int().min(0).optional(),
  already_submitted: z.literal(true).optional(),
});

export type SubmitAttemptResultParsed = z.infer<typeof SubmitAttemptResult>;

// ─── ขาออก: โครงข้อระหว่างสอบ (ไร้เฉลยทุกทาง — whitelist mapper toExamQuestion) ───
export const AttemptQuestionView = z.object({
  questionId: z.string().uuid(),
  seq: z.number().int().min(1),
  selectedOptionIds: z.array(z.string().uuid()).nullable(),
  answeredAt: z.iso.datetime({ offset: true }).nullable(),
});

export type AttemptQuestionViewParsed = z.infer<typeof AttemptQuestionView>;

// ─── ขาออกของ POST /assessments/{id}/attempts (201 — หน้าต่างสอบ + ชุดข้อไร้เฉลย) ───
export const AttemptStartView = z.object({
  attemptId: z.string().uuid(),
  status: z.literal("in_progress"),
  deadlineAt: z.iso.datetime({ offset: true }),
  serverTime: z.iso.datetime({ offset: true }),
  questionCount: z.number().int().min(1),
  questions: z.array(AttemptQuestionView).min(1),
  takeover: z.literal(true).optional(),
});

export type AttemptStartViewParsed = z.infer<typeof AttemptStartView>;

// ─── ขาออกของ POST /attempts/{id}/submit (200 — ผลตรวจทันที ตาม DCR-6) ───
export const AttemptSubmitView = z.object({
  attemptId: z.string().uuid(),
  status: z.enum(["passed", "failed"]),
  scorePct: z.number().int().min(0).max(100),
  passed: z.boolean(),
  correctCount: z.number().int().min(0).optional(),
  questionCount: z.number().int().min(0).optional(),
  alreadySubmitted: z.literal(true).optional(),
});

export type AttemptSubmitViewParsed = z.infer<typeof AttemptSubmitView>;

// ─── ขาออกของ GET /me/attempts (ประวัติการสอบของตัวเอง — คอลัมน์ assessment_attempts) ───
export const ATTEMPT_STATUSES = [
  "in_progress",
  "submitted",
  "passed",
  "failed",
  "expired",
  "voided",
] as const;

export const MyAttemptView = z.object({
  id: z.string().uuid(),
  assessmentId: z.string().uuid(),
  attemptNo: z.number().int().min(1),
  status: z.enum(ATTEMPT_STATUSES),
  startedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
  scorePct: z.number().int().min(0).max(100).nullable(),
  passed: z.boolean().nullable(),
  questionCount: z.number().int().min(0),
  correctCount: z.number().int().min(0).nullable(),
});

export type MyAttemptViewParsed = z.infer<typeof MyAttemptView>;

// ─── ขาออกของ GET /assessments/{id} — ข้อมูลการสอบ + กติกาเวอร์ชัน effective ล่าสุด ───
// NB: จงใจไม่มี passPct — คอลัมน์ pass_pct ไม่ได้รับ GRANT SELECT ให้ authenticated
// (0010_security.sql L709-713 — "pass_pct/selection อ่านเต็มผ่าน BFF (service_role) เท่านั้น")
// การ select ผ่าน user-JWT จะ error ทันที จึงต้องเว้นไว้ (ธงให้ lead: ต้องมี grant/RPC ใหม่)
export const AssessmentRulesView = z.object({
  version: z.number().int().min(1),
  timeLimitMinutes: z.number().int().min(5).max(480),
  questionCount: z.number().int().min(1),
  maxAttempts: z.number().int().min(1),
  attemptCooldownMinutes: z.number().int().min(0),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  requireCourseComplete: z.boolean(),
  proctoringMode: z.enum(["none", "basic"]),
  effectiveFrom: z.iso.datetime({ offset: true }),
});

export type AssessmentRulesViewParsed = z.infer<typeof AssessmentRulesView>;

export const AssessmentDetailView = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
  code: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  isFinal: z.boolean(),
  status: z.enum(["draft", "published", "closed", "archived"]),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  rules: AssessmentRulesView,
});

export type AssessmentDetailViewParsed = z.infer<typeof AssessmentDetailView>;

// ─── question_snapshot (jsonb ที่ start_attempt เขียนต่อข้อ — 0011_functions.sql):
//     {question_id, version, text, options:[{id,text,is_correct,points}], points} ───
export const AttemptQuestionSnapshot = z.object({
  question_id: z.string().uuid(),
  version: z.number().int().min(1),
  text: z.string().min(1),
  options: z.array(z.object({
    id: z.string().uuid(),
    text: z.string().min(1),
    is_correct: z.boolean(),
    points: z.number().int().min(1),
  })).min(1),
  points: z.number().int().min(1),
});

export type AttemptQuestionSnapshotParsed = z.infer<typeof AttemptQuestionSnapshot>;

// ─── ขาออกของ GET /attempts/{id}/result — ส่งตาม learner_attempt_view เป๊ะ (BFF ไม่
//     filter/เปิดเฉลยเอง) — คอลัมน์เฉลยเป็น null เมื่อ view ยังไม่เปิด (after_final_attempt) ───
export const AttemptResultQuestionView = z.object({
  questionId: z.string().uuid(),
  seq: z.number().int().min(1),
  selectedOptionIds: z.array(z.string().uuid()).nullable(),
  answeredAt: z.iso.datetime({ offset: true }).nullable(),
  isCorrect: z.boolean().nullable(),
  pointsEarned: z.number().int().min(0).nullable(),
  explanation: z.string().nullable(),
  content: z.object({
    version: z.number().int().min(1),
    text: z.string().min(1),
    points: z.number().int().min(1),
    options: z.array(z.object({
      id: z.string().uuid(),
      text: z.string().min(1),
      isCorrect: z.boolean(),
      points: z.number().int().min(1),
    })).min(1),
  }).nullable(),
});

export type AttemptResultQuestionViewParsed = z.infer<typeof AttemptResultQuestionView>;

export const AttemptResultView = z.object({
  attemptId: z.string().uuid(),
  assessmentId: z.string().uuid(),
  attemptNo: z.number().int().min(1),
  status: z.enum(ATTEMPT_STATUSES),
  startedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
  scorePct: z.number().int().min(0).max(100).nullable(),
  passed: z.boolean().nullable(),
  questionCount: z.number().int().min(1),
  questions: z.array(AttemptResultQuestionView).min(1),
});

export type AttemptResultViewParsed = z.infer<typeof AttemptResultView>;

// ─── แถว DB (snake_case) ที่ routes อ่าน ───

/** แถว learner_attempt_view (0009_views.sql L23-77) — คอลัมน์เฉลยเปิดตามเงื่อนไขฝั่ง view */
export interface LearnerAttemptViewRow {
  readonly attempt_id: string;
  readonly user_id: string;
  readonly assessment_id: string;
  readonly attempt_no: number;
  readonly status: string;
  readonly started_at: string;
  readonly expires_at: string;
  readonly submitted_at: string | null;
  readonly score_pct: number | null;
  readonly passed: boolean | null;
  readonly question_id: string;
  readonly seq: number;
  readonly option_order: number[] | null;
  readonly selected_option_ids: string[] | null;
  readonly answered_at: string | null;
  readonly is_correct: boolean | null;
  readonly points_earned: number | null;
  readonly question_snapshot: unknown;
  readonly explanation: string | null;
}

/** แถว assessment_attempts (0005_assessment.sql L90-109) ที่ GET /me/attempts ใช้ */
export interface AttemptHistoryRow {
  readonly id: string;
  readonly assessment_id: string;
  readonly attempt_no: number;
  readonly status: string;
  readonly started_at: string;
  readonly expires_at: string;
  readonly submitted_at: string | null;
  readonly score_pct: number | null;
  readonly passed: boolean | null;
  readonly question_count: number;
  readonly correct_count: number | null;
}

/** แถว assessments (0005_assessment.sql L50-60) ที่ GET /assessments/{id} ใช้ */
export interface AssessmentRow {
  readonly id: string;
  readonly course_id: string;
  readonly code: string;
  readonly title: string;
  readonly description: string | null;
  readonly is_final: boolean;
  readonly status: string;
  readonly published_at: string | null;
}

/**
 * คอลัมน์ assessment_rules ที่ได้รับ GRANT SELECT ให้ authenticated เท่านั้น
 * (0010_security.sql L709-713 — pass_pct/selection ห้าม select ผ่าน user-JWT)
 */
export interface AssessmentRulesRow {
  readonly id: string;
  readonly assessment_id: string;
  readonly version: number;
  readonly time_limit_minutes: number;
  readonly question_count: number;
  readonly max_attempts: number;
  readonly attempt_cooldown_minutes: number;
  readonly shuffle_questions: boolean;
  readonly shuffle_options: boolean;
  readonly require_course_complete: boolean;
  readonly proctoring_mode: string;
  readonly effective_from: string;
}

// ─── mappers — whitelist เสมอ (แถว DB → resource camelCase; ไม่มีการ spread ทั้งแถว) ───

/** โครงข้อระหว่างสอบ — whitelist 4 ฟิลด์เท่านั้น จึงไม่มีทางรั่วเฉลย */
export function toExamQuestion(row: LearnerAttemptViewRow): AttemptQuestionViewParsed {
  return {
    questionId: row.question_id,
    seq: row.seq,
    selectedOptionIds: row.selected_option_ids,
    answeredAt: row.answered_at,
  };
}

/** ประวัติการสอบของตัวเอง (GET /me/attempts) */
export function toMyAttemptResource(row: AttemptHistoryRow): MyAttemptViewParsed {
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    attemptNo: row.attempt_no,
    status: row.status as MyAttemptViewParsed["status"],
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    submittedAt: row.submitted_at,
    scorePct: row.score_pct,
    passed: row.passed,
    questionCount: row.question_count,
    correctCount: row.correct_count,
  };
}

/** ข้อมูลการสอบ + กติกา effective ล่าสุด (GET /assessments/{id}) */
export function toAssessmentDetail(
  assessment: AssessmentRow,
  rules: AssessmentRulesRow,
): AssessmentDetailViewParsed {
  return {
    id: assessment.id,
    courseId: assessment.course_id,
    code: assessment.code,
    title: assessment.title,
    description: assessment.description,
    isFinal: assessment.is_final,
    status: assessment.status as AssessmentDetailViewParsed["status"],
    publishedAt: assessment.published_at,
    rules: {
      version: rules.version,
      timeLimitMinutes: rules.time_limit_minutes,
      questionCount: rules.question_count,
      maxAttempts: rules.max_attempts,
      attemptCooldownMinutes: rules.attempt_cooldown_minutes,
      shuffleQuestions: rules.shuffle_questions,
      shuffleOptions: rules.shuffle_options,
      requireCourseComplete: rules.require_course_complete,
      proctoringMode: rules.proctoring_mode as AssessmentRulesViewParsed["proctoringMode"],
      effectiveFrom: rules.effective_from,
    },
  };
}

/** ผลสอบ + เฉลยตามที่ view เปิด (GET /attempts/{id}/result) — rows เรียงตาม seq แล้ว */
export function toAttemptResultView(
  rows: readonly LearnerAttemptViewRow[],
): AttemptResultViewParsed {
  const first = rows[0];
  if (first === undefined) {
    throw new AppError("ERR-NF-001");
  }
  return {
    attemptId: first.attempt_id,
    assessmentId: first.assessment_id,
    attemptNo: first.attempt_no,
    status: first.status as AttemptResultViewParsed["status"],
    startedAt: first.started_at,
    expiresAt: first.expires_at,
    submittedAt: first.submitted_at,
    scorePct: first.score_pct,
    passed: first.passed,
    questionCount: rows.length,
    questions: rows.map(toAttemptResultQuestion),
  };
}

function toAttemptResultQuestion(
  row: LearnerAttemptViewRow,
): AttemptResultQuestionViewParsed {
  if (row.question_snapshot === null || row.question_snapshot === undefined) {
    // view ยังไม่เปิดเฉลย (after_final_attempt) — ส่งตาม view เป๊ะ ไม่ filter/เปิดเอง
    return {
      questionId: row.question_id,
      seq: row.seq,
      selectedOptionIds: row.selected_option_ids,
      answeredAt: row.answered_at,
      isCorrect: row.is_correct,
      pointsEarned: row.points_earned,
      explanation: row.explanation,
      content: null,
    };
  }
  // snapshot เปิดเมื่อ "ส่งแล้ว + ครบครั้งสุดท้ายตามกติกา" — validate แบบ fail-closed
  const parsed = AttemptQuestionSnapshot.safeParse(row.question_snapshot);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", {
      details: { reason: "question_snapshot_bad_contract" },
    });
  }
  return {
    questionId: row.question_id,
    seq: row.seq,
    selectedOptionIds: row.selected_option_ids,
    answeredAt: row.answered_at,
    isCorrect: row.is_correct,
    pointsEarned: row.points_earned,
    explanation: row.explanation,
    content: {
      version: parsed.data.version,
      text: parsed.data.text,
      points: parsed.data.points,
      options: parsed.data.options.map((o) => ({
        id: o.id,
        text: o.text,
        isCorrect: o.is_correct,
        points: o.points,
      })),
    },
  };
}

/** ผล submit (DCR-6 — synchronous grading) → ขาออก camelCase */
export function toSubmitView(r: SubmitAttemptResultParsed): AttemptSubmitViewParsed {
  return {
    attemptId: r.attempt_id,
    status: r.status,
    scorePct: r.score_pct,
    passed: r.passed,
    ...(r.correct_count !== undefined ? { correctCount: r.correct_count } : {}),
    ...(r.question_count !== undefined ? { questionCount: r.question_count } : {}),
    ...(r.already_submitted !== undefined ? { alreadySubmitted: r.already_submitted } : {}),
  };
}

// ─── session binding (D20-B5) ───
// GoTrue ฝัง claim `session_id` ใน access token ทุกอัน — BFF อ่านจาก session store
// (ไม่ verify signature — token มาจาก store ไม่ใช่ client) แล้วส่งเป็น p_session_id ให้
// RPC save_answer/submit_attempt เทียบกับ claim ปัจจุบันของ PostgREST — ห้ามรับจาก body
export interface SupabaseAuthSessionLike {
  readonly auth: {
    readonly getSession: () => Promise<{
      data: { session: { access_token: string } | null } | null;
      error: unknown;
    }>;
  };
}

/**
 * อ่าน claim `session_id` จาก access token ของ session ปัจจุบัน (payload base64 JSON —
 * ไม่ตรวจ signature) · ไม่มี session → ERR-AUTH-001 · token ผิดรูป → ERR-SYS-001
 * · ไม่มี claim → ERR-AUTH-001 (fail-closed: token ไม่ผูก session ไม่ผ่านการสอบ)
 */
export async function readJwtSessionClaim(client: SupabaseAuthSessionLike): Promise<string> {
  const { data, error } = await client.auth.getSession();
  if (error !== null || data === null || data.session === null) {
    throw new AppError("ERR-AUTH-001");
  }
  const parts = data.session.access_token.split(".");
  if (parts.length !== 3) {
    throw new AppError("ERR-SYS-001", { details: { reason: "access_token_malformed" } });
  }
  const payloadPart = parts[1];
  if (payloadPart === undefined) {
    throw new AppError("ERR-SYS-001", { details: { reason: "access_token_malformed" } });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new AppError("ERR-SYS-001", { details: { reason: "access_token_malformed" } });
  }
  const claim = typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)["session_id"]
    : undefined;
  if (typeof claim !== "string" || claim.length === 0) {
    throw new AppError("ERR-AUTH-001", { details: { reason: "session_claim_missing" } });
  }
  return claim;
}

// ─── parse helpers — ERR-VAL-001 พร้อมรายชื่อ field (แบบเดียวกับ common.ts/progress.ts) ───
function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  fallbackField: string,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : fallbackField;
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return parsed.data;
}

/** path param ของ GET /assessments/{id} และ POST /assessments/{id}/attempts */
export function parseAssessmentIdParams(raw: unknown): AssessmentIdParamsParsed {
  return parseOrThrow(AssessmentIdParams, raw, "id");
}

/** path param ของ /attempts/{id}/* ทุกเส้น */
export function parseAttemptIdParams(raw: unknown): AttemptIdParamsParsed {
  return parseOrThrow(AttemptIdParams, raw, "id");
}

/** body ของ POST /attempts/{id}/answers — §4 #7 (clientSavedAt เทียบเท่านั้น) */
export function parseAnswerSaveBody(raw: unknown): AnswerSaveRequestParsed {
  return parseOrThrow(AnswerSaveRequest, raw, "body");
}

// ─── §4 #8 — ส่งข้อสอบ (DCR-6) ───
// unansweredQuestionIds เป็น telemetry เท่านั้น (grading อ่านจาก attempt_answers
// ฝั่ง RPC ล้วน — BFF ไม่ส่งค่านี้ต่อ) แต่ strict-parse ตาม spec เพื่อปฏิเสธคีย์ที่
// ไม่รู้จัก โดยเฉพาะ session_id ที่แอบแถมมา (D20-B5: session binding จาก JWT claim เท่านั้น)
export const AttemptSubmitRequest = z
  .object({
    unansweredQuestionIds: z.array(z.string().uuid()).max(500).default([]),
  })
  .strict();

export type AttemptSubmitRequestParsed = z.infer<typeof AttemptSubmitRequest>;

/** body ของ POST /attempts/{id}/submit — §4 #8 strict (คีย์แปลกปลอม → ERR-VAL-001) */
export function parseAttemptSubmitBody(raw: unknown): AttemptSubmitRequestParsed {
  return parseOrThrow(AttemptSubmitRequest, raw, "body");
}

/**
 * schemas/v1/report — contract ของ endpoint รายงาน/มอนิเตอร์ (Wave E · D55-6)
 * (API-SPECIFICATION v1.0.4 §3.8 แถว 218-221, 228-229 — endpoint ที่ DCR-6 เลื่อนมา Wave E)
 *
 * - แถว views ขาเข้า (snake_case ตามคอลัมน์จริงของ 0009_views.sql + 0016 — ห้ามเดา อ่านจาก
 *   migration จริง):
 *     v_enrollment_progress  (0009 L169-179 · 0016 แก้การกรอง) = sv/sa เท่านั้น
 *     v_assessment_statistics (0009 L199-219)                  = sv/se/sa
 *     v_credit_balance       (0009 L138-149)                   = sv/sr/sa
 *   ทั้งหมด .strict() — คอลัมน์ drift เพิ่ม/หาย/ชนิดเพี้ยน = fail-closed ERR-SYS-002
 * - resource ขาออก (camelCase สไตล์ repo เดิม) — route ครอบด้วย parseOutgoingView ทุกแถว
 *   (r6-L1) → drift = 503 ไม่ strip เงียบ
 * - query ขาเข้า strict ทุกชุด — ผิดรูป → ERR-VAL-001 (400)
 */
import { z } from "zod";
import { AppError } from "../../errors";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00) — แบบเดียวกับ schemas/v1/certificate */
export const IsoTimestamp = z.iso.datetime({ offset: true });

// ─────────────────────────── แถว views ขาเข้า (0009/0016 ตรงตัวอักษร) ───────────────────────────

/** แถว v_enrollment_progress — 6 คอลัมน์ exact (0009:169-179, 0016 คงชุดคอลัมน์เดิม) */
export const EnrollmentProgressRow = z
  .object({
    enrollment_id: z.string().uuid(),
    user_id: z.string().uuid(),
    course_id: z.string().uuid(),
    lesson_total: z.number().int().min(0),
    lesson_completed: z.number().int().min(0),
    progress_pct: z.number().int().min(0).max(100),
  })
  .strict();

export type EnrollmentProgressRowParsed = z.infer<typeof EnrollmentProgressRow>;

/** แถว v_assessment_statistics — 4 คอลัมน์ exact (0009:199-219) · count bigint → number */
export const AssessmentStatisticsRow = z
  .object({
    assessment_id: z.string().uuid(),
    attempt_total: z.number().int().min(0),
    attempt_passed: z.number().int().min(0),
    pass_rate_pct: z.number().int().min(0).max(100),
  })
  .strict();

export type AssessmentStatisticsRowParsed = z.infer<typeof AssessmentStatisticsRow>;

/** แถว v_credit_balance — 5 คอลัมน์ exact (0009:138-149) · balance = sum(numeric) → number */
export const CreditBalanceRow = z
  .object({
    user_id: z.string().uuid(),
    renewal_cycle_id: z.string().uuid(),
    credit_type: z.string().min(1),
    balance: z.number(),
    last_entry_at: IsoTimestamp.nullable(),
  })
  .strict();

export type CreditBalanceRowParsed = z.infer<typeof CreditBalanceRow>;

// ─────────────────────────── resource ขาออก (camelCase · strict) ───────────────────────────

/** แถวรายงานความคืบหน้า (GET /admin/reports/enrollments · export type=enrollments) */
export const EnrollmentProgressResource = z
  .object({
    enrollmentId: z.string().uuid(),
    userId: z.string().uuid(),
    courseId: z.string().uuid(),
    lessonTotal: z.number().int().min(0),
    lessonCompleted: z.number().int().min(0),
    progressPct: z.number().int().min(0).max(100),
  })
  .strict();

export type EnrollmentProgressResourceParsed = z.infer<typeof EnrollmentProgressResource>;

/** แถวรายงานผลสอบ (GET /admin/reports/assessments · export type=assessments · statistics) */
export const AssessmentStatisticsResource = z
  .object({
    assessmentId: z.string().uuid(),
    attemptTotal: z.number().int().min(0),
    attemptPassed: z.number().int().min(0),
    passRatePct: z.number().int().min(0).max(100),
  })
  .strict();

export type AssessmentStatisticsResourceParsed = z.infer<typeof AssessmentStatisticsResource>;

/** แถวรายงาน credit (GET /admin/reports/credits · export type=credits) */
export const CreditBalanceResource = z
  .object({
    userId: z.string().uuid(),
    renewalCycleId: z.string().uuid(),
    creditType: z.string().min(1),
    balance: z.number(),
    lastEntryAt: IsoTimestamp.nullable(),
  })
  .strict();

export type CreditBalanceResourceParsed = z.infer<typeof CreditBalanceResource>;

// ─────────────────────────── มอนิเตอร์/สถิติผลสอบ (§3.8 แถว 228-229) ───────────────────────────

/** แถวรวมต่อ assessment ของคิวมอนิเตอร์ — นับแบบรวมเท่านั้น ห้ามมี user_id รายคน (PII น้อยสุด) */
export const MonitoringAssessmentRow = z
  .object({
    assessmentId: z.string().uuid(),
    inProgress: z.number().int().min(0),
    overdue: z.number().int().min(0),
  })
  .strict();

export type MonitoringAssessmentRowParsed = z.infer<typeof MonitoringAssessmentRow>;

/** แถวรวมต่อหลักสูตรของคิวมอนิเตอร์ (course_id มาจาก assessments — asm_read ฝั่ง RLS) */
export const MonitoringCourseRow = z
  .object({
    courseId: z.string().uuid(),
    inProgress: z.number().int().min(0),
    overdue: z.number().int().min(0),
  })
  .strict();

export type MonitoringCourseRowParsed = z.infer<typeof MonitoringCourseRow>;

/**
 * ผลมอนิเตอร์คิวสอบ (GET /admin/exams/monitoring) — สถิติรวมทั้งหมด
 * · overdue = in_progress ที่ expires_at < generatedAt ยังไม่ submit (cron 0020 ปิด
 *   ทุก 1 นาที → ตัวเลข "เกินเวลา" เป็นค่าชั่วขณะตามธรรมชาติของระบบ)
 */
export const ExamMonitoringResource = z
  .object({
    generatedAt: IsoTimestamp,
    summary: z
      .object({ inProgressCount: z.number().int().min(0), overdueCount: z.number().int().min(0) })
      .strict(),
    byAssessment: z.array(MonitoringAssessmentRow),
    byCourse: z.array(MonitoringCourseRow),
  })
  .strict();

export type ExamMonitoringResourceParsed = z.infer<typeof ExamMonitoringResource>;

/** แถว lookup ของ assessments (id → course_id — ใช้จัดกลุ่มคิวมอนิเตอร์ตามหลักสูตร) */
export const AssessmentCourseRow = z
  .object({
    id: z.string().uuid(),
    courseId: z.string().uuid(),
  })
  .strict();

/** แถว aggregate ของ PostgREST 12 (count ต่อ assessment_id — คิวมอนิเตอร์ ฝั่ง in_progress) */
export const MonitoringInProgressRow = z
  .object({
    assessmentId: z.string().uuid(),
    inProgress: z.number().int().min(0),
  })
  .strict();

/** แถว aggregate ของ PostgREST 12 (count ต่อ assessment_id — ฝั่งเกินเวลา: expires_at < now) */
export const MonitoringOverdueRow = z
  .object({
    assessmentId: z.string().uuid(),
    overdue: z.number().int().min(0),
  })
  .strict();

/** แถว aggregate ของ PostgREST 12 (avg score_pct ต่อ assessment_id — เฉพาะ attempt ที่ส่งแล้ว) */
export const AvgScoreRow = z
  .object({
    assessmentId: z.string().uuid(),
    /** avg คืน null เมื่อทุกค่าในกลุ่มเป็น null (ไม่ควรเกิดเพราะกรอง submitted_at not null แล้ว) */
    avgScore: z.number().min(0).max(100).nullable(),
  })
  .strict();

export type AvgScoreRowParsed = z.infer<typeof AvgScoreRow>;

/** แถวสถิติผลสอบต่อชุดข้อสอบ (GET /admin/exams/statistics) — view + avg ของ attempt ที่ส่งแล้ว */
export const ExamStatisticsResource = z
  .object({
    assessmentId: z.string().uuid(),
    attemptTotal: z.number().int().min(0),
    attemptPassed: z.number().int().min(0),
    passRatePct: z.number().int().min(0).max(100),
    /** คะแนนเฉลี่ย (avg score_pct ของ attempt ที่ submitted — aggregate ฝั่ง DB) · null = ยังไม่มีใครส่ง */
    avgScorePct: z.number().min(0).max(100).nullable(),
  })
  .strict();

export type ExamStatisticsResourceParsed = z.infer<typeof ExamStatisticsResource>;

// ─────────────────────────── query ขาเข้า (strict — ผิดรูป → ERR-VAL-001) ───────────────────────────

/** limit ของ endpoint รายงาน — cap ตามความเหมาะของ view (default 100 · จำกัดบน 500) */
export const REPORT_DEFAULT_LIMIT = 100;
export const REPORT_MAX_LIMIT = 500;

/** ชิ้น limit กลางของ query รายงาน (coerce จาก query string — แบบเดียวกับ PageQuery) */
export const ReportLimit = z.coerce.number().int().min(1).max(REPORT_MAX_LIMIT).default(REPORT_DEFAULT_LIMIT);

/** query ของ GET /admin/reports/enrollments — courseId กรองได้เพราะ view มี course_id · ไม่มีคอลัมน์เวลา → ไม่รับ from/to */
export const EnrollmentReportQuery = z
  .object({ limit: ReportLimit, courseId: z.string().uuid().optional() })
  .strict();

export type EnrollmentReportQueryParsed = z.infer<typeof EnrollmentReportQuery>;

/** query ของ GET /admin/reports/assessments — view ไม่มี course_id/เวลา → รับ limit เท่านั้น */
export const AssessmentReportQuery = z.object({ limit: ReportLimit }).strict();

export type AssessmentReportQueryParsed = z.infer<typeof AssessmentReportQuery>;

/** query ของ GET /admin/reports/credits — last_entry_at เป็นคอลัมน์เวลาที่ view รองรับ */
export const CreditReportQuery = z
  .object({
    limit: ReportLimit,
    from: IsoTimestamp.optional(),
    to: IsoTimestamp.optional(),
  })
  .strict();

export type CreditReportQueryParsed = z.infer<typeof CreditReportQuery>;

/** format ของ export (§3.8 แถว 221 — text/csv หรือ JSON · default csv) */
export const EXPORT_FORMAT_VALUES = ["csv", "json"] as const;

export const ExportFormat = z.enum(EXPORT_FORMAT_VALUES);

export type ExportFormatValue = (typeof EXPORT_FORMAT_VALUES)[number];

/**
 * แปลง URLSearchParams → parsed ตาม schema — ผิดรูป/คีย์แปลกปลอม → ERR-VAL-001
 * (รูปแบบเดียวกับ parsePageQuery · ใช้ค่าสุดท้ายเมื่อ key ซ้ำ)
 */
export function parseReportQuery<S extends z.ZodType>(
  schema: S,
  searchParams: URLSearchParams,
): z.output<S> {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : "query";
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return parsed.data;
}

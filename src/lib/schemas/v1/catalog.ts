/**
 * schemas/v1/catalog — zod schema ของ query/params แคตตาล็อก (API-SPECIFICATION §3.3)
 *
 * - GET /courses     → CatalogCoursesQuery = PageQuery (§4 #12 — default 20, max 100, strict)
 *                      + ฟิลเตอร์ `category` / `q` ของหน้า catalog (§3.3 "ค้นหา/กรองหลักสูตร")
 *                      — เลือกเฉพาะชุดที่ map ลงคอลัมน์จริงของ DATA-DICTIONARY §3.2
 *                        (course_categories.slug / courses.title_th·title_en·summary)
 * - GET /courses/{id} → CourseIdParams — id = UUID (§1.1 "ID: UUID v4 ทุกตาราง",
 *                      รูปแบบเดียวกับ EnrollParams §4 #4)
 * - GET /courses/{id} ขาออก → CourseExamSummaryView — object `exam` จาก view
 *                      course_exam_summary (CAT-004 AC · DCR-7/PB-17 — API-SPECIFICATION
 *                      v1.0.4 §3.3): คงเดิม 4 ฟิลด์ + `assessmentId` (uuid nullable —
 *                      uuid ของข้อสอบปลายหลักสูตร published+is_final ล่าสุด, null เมื่อ
 *                      หลักสูตรไม่มีข้อสอบ)
 * - parse ไม่ผ่านทุกกรณี → AppError ERR-VAL-001 (400) พร้อมรายชื่อ field (§2)
 *   ในรูปแบบเดียวกับ parsePageQuery (schemas/v1/common)
 */
import { z } from "zod";
import { AppError } from "../../errors";
import { PageQuery } from "./common";

/** query ของ GET /courses — limit/cursor มาจาก PageQuery (default 20, max 100 — §1.2) */
export const CatalogCoursesQuery = z
  .object({
    ...PageQuery.shape,
    /** กรองตาม slug ของหมวด (course_categories.slug — DD §3.2) */
    category: z.string().trim().min(1).max(100).optional(),
    /** ค้นหาอิสระใน title_th / title_en / summary (courses — DD §3.2) */
    q: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type CatalogCoursesQueryParsed = z.infer<typeof CatalogCoursesQuery>;

/** path param ของ GET /courses/{id} — id เป็น UUID (§1.1 / §4 #4) */
export const CourseIdParams = z.object({ id: z.uuid() }).strict();
export type CourseIdParamsParsed = z.infer<typeof CourseIdParams>;

/** รวม path ของ issue เป็นรายชื่อ field — รูปแบบเดียวกับ parsePageQuery (path ว่าง = "query") */
function valErrorFields(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0 ? path : "query";
      }),
    ),
  ];
}

/**
 * URLSearchParams → parsed CatalogCoursesQuery
 * - ค่าที่ผิด (limit ไม่ใช่เลข, key แปลกปลอมโดย .strict(), q ยาว > 120) → ERR-VAL-001 + fields
 * - ใช้ค่าสุดท้ายเมื่อ key ซ้ำ (พฤติกรรม Object.fromEntries — เดียวกับ parsePageQuery)
 */
export function parseCatalogCoursesQuery(searchParams: URLSearchParams): CatalogCoursesQueryParsed {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = CatalogCoursesQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: valErrorFields(parsed.error) } });
  }
  return parsed.data;
}

/**
 * path param {id} → uuid ที่ผ่านการตรวจ — ผิดรูปแบบ → ERR-VAL-001 ระบุ field "id"
 * (คืน string เดิม — uuid ที่ valid ใช้ได้ตรง ๆ กับคอลัมน์ courses.id)
 */
export function parseCourseIdParam(id: string): string {
  const parsed = CourseIdParams.safeParse({ id });
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["id"] } });
  }
  return parsed.data.id;
}

// ─── ขาออกของ GET /courses/{id} — object `exam` (view course_exam_summary · DCR-7/PB-17) ───
// r6-L1/D43 L1: strict — คีย์เกินใน object ขาออก = drift → 503 ไม่ strip เงียบ
// (parseOutgoingView ที่ route เรียก — lib/api/response)
// bounds mirror แหล่งเดียวกัน: questionCount = count(*) ของ questions active (เป็น 0 ได้) ·
// timeLimitMinutes/passScorePct/maxAttempts ← assessment_rules (คอลัมน์เดียวกับ
// AssessmentRulesView — schemas/v1/exam.ts · 0005 constraint 5-480 / 1-100 / >= 1)
export const CourseExamSummaryView = z
  .object({
    questionCount: z.number().int().min(0),
    timeLimitMinutes: z.number().int().min(5).max(480),
    passScorePct: z.number().int().min(1).max(100),
    maxAttempts: z.number().int().min(1),
    /** uuid ของข้อสอบปลายหลักสูตร published+is_final ล่าสุด — null เมื่อหลักสูตรไม่มีข้อสอบ (DCR-7/PB-17) */
    assessmentId: z.string().uuid().nullable(),
  })
  .strict();

export type CourseExamSummaryViewParsed = z.infer<typeof CourseExamSummaryView>;

/**
 * แถวดิบของ view course_exam_summary (snake_case ตรงคอลัมน์จริง — 0021 เพิ่ม
 * assessment_id ท้ายสุด · DCR-7/PB-17) — ตรวจก่อน map (0019-r2 F5 — mirror
 * parseMyCertificateRow): คอลัมน์เกิน/หาย/ค่าผิดชนิดจาก PostgREST ต้องตายที่ขาเข้า
 * ไม่ใช่ไหลผ่าน `as` ลง mapper (mapper to*Of ตัดคอลัมน์แปลกปลอมทิ้งเอง จึงต้องตรวจ
 * ที่แถวดิบเท่านั้นจึงจับ drift ได้)
 */
export const CourseExamSummaryRowSchema = z
  .object({
    question_count: z.number().int().min(0),
    time_limit_minutes: z.number().int().min(5).max(480),
    pass_score_pct: z.number().int().min(1).max(100),
    max_attempts: z.number().int().min(1),
    assessment_id: z.string().uuid().nullable(),
  })
  .strict();

export type CourseExamSummaryRowParsed = z.infer<typeof CourseExamSummaryRowSchema>;

/** แถว course_exam_summary ดิบ → ที่ผ่านการตรวจแล้ว — drift → ERR-SYS-002 (opaque ไม่ leak SQL) */
export function parseCourseExamSummaryRow(row: unknown): CourseExamSummaryRowParsed {
  const parsed = CourseExamSummaryRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "course_exam_summary_row_drift" } });
  }
  return parsed.data;
}

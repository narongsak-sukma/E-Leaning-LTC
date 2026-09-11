/**
 * monitoring — คิวมอนิเตอร์ + สถิติผลสอบ (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 228-229)
 *
 * - อ่าน assessment_attempts ผ่าน **user-JWT client** (RLS attempts_owner_read — 0010:755-760
 *   ยอมให้ staff 4 บทบาทอ่านทุกแถว) · ทุก query เป็น PostgREST 12 aggregate
 *   (`id.count()` / `score_pct.avg()` + group by คอลัมน์ non-aggregate ที่ select ร่วม) —
 *   การนับ/เฉลี่ยเกิดใน SQL ฝั่ง DB ทั้งหมด ไม่ใช่ JS (ข้อ 6 ของภารกิจ)
 * - ห้ามแสดง user_id รายคน — ตอบเป็นสถิติรวมต่อ assessment/course (PII น้อยสุด)
 * - cron 0020 ปิด attempt ที่พ้น expires_at+5 นาที ทุก 1 นาที — ตัวเลข "เกินเวลา" จึงเป็น
 *   ค่าชั่วขณะตามธรรมชาติ (ระบุไว้ใน JSDoc ของ resource)
 */
import "server-only";
import { AppError } from "@/lib/errors";
import {
  AssessmentCourseRow,
  AvgScoreRow,
  MonitoringInProgressRow,
  MonitoringOverdueRow,
  type AvgScoreRowParsed,
  type ExamMonitoringResourceParsed,
  type ExamStatisticsResourceParsed,
  type MonitoringAssessmentRowParsed,
  type MonitoringCourseRowParsed,
} from "@/lib/schemas/v1/report";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { listAssessmentStatistics } from "@/lib/reports/views";

/** error ของ query → ERR-SYS-002 แบบ opaque — ไม่ leak SQL (SDS §6.1) */
function dbFailed(reason: string): AppError {
  return new AppError("ERR-SYS-002", { details: { reason } });
}

/** zod-adapter เดียวกับ views.ts — แถว aggregate drift → ERR-SYS-002 fail-closed */
function parseAggRow<T>(
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown } },
  row: unknown,
  reason: string,
): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw dbFailed(reason);
  }
  return parsed.data;
}

/** บวกรวมค่าที่ SQL aggregate มาแล้วเป็น "ตัวเลขสรุป" — ไม่ใช่การนับแถวดิบใน JS */
function sumBy(rows: readonly { count: number }[], pick: (row: { count: number }) => number): number {
  return rows.reduce((acc, row) => acc + pick(row), 0);
}

/**
 * นับ attempt ที่ in_progress ต่อ assessment_id ด้วย PostgREST 12 aggregate —
 * overdueOnly=true คือ subset ที่ expires_at < now (ยังไม่ submit · status in_progress
 * ครอบ "ยังไม่ส่ง" อยู่แล้ว)
 */
async function countInProgressPerAssessment(overdueOnly: boolean): Promise<Array<{ assessmentId: string; count: number }>> {
  const supabase = await createSupabaseSsrClient();
  let query = supabase
    .from("assessment_attempts")
    .select(
      overdueOnly
        ? "assessmentId:assessment_id,overdue:id.count()"
        : "assessmentId:assessment_id,inProgress:id.count()",
    )
    .eq("status", "in_progress")
    .order("assessment_id", { ascending: true });
  if (overdueOnly) {
    query = query.lt("expires_at", new Date().toISOString());
  }
  const { data, error } = await query;
  if (error !== null) {
    throw dbFailed(overdueOnly ? "attempts_overdue_agg_failed" : "attempts_in_progress_agg_failed");
  }
  // fail-closed ของ container (gate p1-r1 MINOR-3): data:null/object = drift — ห้าม
  // `data ?? []` ตีตกเป็น "ว่าง" เพราะ aggregate ผิดรูปจะกลายเป็นตัวเลข 0 ปลอม
  if (!Array.isArray(data)) {
    throw dbFailed("attempts_agg_container_drift");
  }
  const out: Array<{ assessmentId: string; count: number }> = [];
  for (const row of data) {
    // แยกกิ่ง parse ต่อ schema เพื่อให้ TS เห็นชนิดตรงข้าง (ternary บน schema ทำ union ที่ access ไม่ได้)
    if (overdueOnly) {
      const parsed = parseAggRow(MonitoringOverdueRow, row, "attempts_agg_row_drift");
      out.push({ assessmentId: parsed.assessmentId, count: parsed.overdue });
    } else {
      const parsed = parseAggRow(MonitoringInProgressRow, row, "attempts_agg_row_drift");
      out.push({ assessmentId: parsed.assessmentId, count: parsed.inProgress });
    }
  }
  return out;
}

/** id → course_id ของ assessments ที่สนใจ (RLS asm_read — 0010:643-651 · staff 4 บทบาท) */
async function courseOfAssessments(assessmentIds: readonly string[]): Promise<Map<string, string>> {
  if (assessmentIds.length === 0) {
    return new Map();
  }
  const supabase = await createSupabaseSsrClient();
  const { data, error } = await supabase
    .from("assessments")
    .select("id, courseId:course_id")
    .in("id", [...assessmentIds]);
  if (error !== null) {
    throw dbFailed("assessments_lookup_failed");
  }
  // fail-closed ของ container (gate p1-r1 MINOR-3) — เหตุผลเดียวกับ aggregate ข้างบน
  if (!Array.isArray(data)) {
    throw dbFailed("assessments_lookup_container_drift");
  }
  const map = new Map<string, string>();
  for (const row of data) {
    const parsed = parseAggRow(AssessmentCourseRow, row, "assessments_lookup_row_drift");
    map.set(parsed.id, parsed.courseId);
  }
  return map;
}

/**
 * GET /admin/exams/monitoring — สถิติรวมของคิวสอบ (staff:exam / super_admin)
 * คืน สรุปรวม + แยกตาม assessment_id + แยกตาม course_id (จาก assessments lookup) —
 * assessment ที่ asm_read ไม่คืน course_id จะไม่โผล่ใน byCourse แต่คงอยู่ใน byAssessment
 */
export async function getExamMonitoring(): Promise<ExamMonitoringResourceParsed> {
  const inProgress = await countInProgressPerAssessment(false);
  const overdue = await countInProgressPerAssessment(true);
  const overdueMap = new Map(overdue.map((row) => [row.assessmentId, row.count]));
  const courseMap = await courseOfAssessments(inProgress.map((row) => row.assessmentId));
  const byAssessment: MonitoringAssessmentRowParsed[] = [];
  const byCourseAcc = new Map<string, { inProgress: number; overdue: number }>();
  for (const row of inProgress) {
    const overdueCount = overdueMap.get(row.assessmentId) ?? 0;
    byAssessment.push({ assessmentId: row.assessmentId, inProgress: row.count, overdue: overdueCount });
    const courseId = courseMap.get(row.assessmentId);
    if (courseId === undefined) {
      continue;
    }
    const acc = byCourseAcc.get(courseId) ?? { inProgress: 0, overdue: 0 };
    acc.inProgress += row.count;
    acc.overdue += overdueCount;
    byCourseAcc.set(courseId, acc);
  }
  const byCourse: MonitoringCourseRowParsed[] = [...byCourseAcc.entries()].map(([courseId, acc]) => ({
    courseId,
    inProgress: acc.inProgress,
    overdue: acc.overdue,
  }));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      inProgressCount: sumBy(inProgress, (row) => row.count),
      overdueCount: sumBy(overdue, (row) => row.count),
    },
    byAssessment,
    byCourse,
  };
}

/** avg score_pct ต่อ assessment_id เฉพาะ attempt ที่ส่งแล้ว (submitted_at not null) — SQL aggregate */
async function averageScorePerAssessment(assessmentIds: readonly string[]): Promise<Map<string, number>> {
  if (assessmentIds.length === 0) {
    return new Map();
  }
  const supabase = await createSupabaseSsrClient();
  const { data, error } = await supabase
    .from("assessment_attempts")
    .select("assessmentId:assessment_id,avgScore:score_pct.avg()")
    .not("submitted_at", "is", null)
    .in("assessment_id", [...assessmentIds]);
  if (error !== null) {
    throw dbFailed("avg_score_agg_failed");
  }
  // fail-closed ของ container (gate p1-r1 MINOR-3) — เหตุผลเดียวกับ aggregate ข้างบน
  if (!Array.isArray(data)) {
    throw dbFailed("avg_score_agg_container_drift");
  }
  const map = new Map<string, number>();
  for (const row of data) {
    const parsed: AvgScoreRowParsed = parseAggRow(AvgScoreRow, row, "avg_score_agg_row_drift");
    if (parsed.avgScore !== null) {
      map.set(parsed.assessmentId, parsed.avgScore);
    }
  }
  return map;
}

/**
 * GET /admin/exams/statistics — สถิติต่อชุดข้อสอบ = v_assessment_statistics (attempt/passed/
 * pass_rate — view กรอง sv/se/sa) + avg score_pct ของ attempt ที่ส่งแล้ว (aggregate ฝั่ง DB)
 * ทั้งสองขา aggregate ใน SQL แล้ว การ "map ค่า" ระหว่างสองผล aggregate ไม่ใช่การนับแถวดิบ
 */
export async function getExamStatistics(options: {
  readonly limit: number;
}): Promise<{ rows: ExamStatisticsResourceParsed[]; truncated: boolean }> {
  const view = await listAssessmentStatistics({ limit: options.limit });
  const avgMap = await averageScorePerAssessment(view.rows.map((row) => row.assessmentId));
  const rows = view.rows.map((row) => ({
    assessmentId: row.assessmentId,
    attemptTotal: row.attemptTotal,
    attemptPassed: row.attemptPassed,
    passRatePct: row.passRatePct,
    avgScorePct: avgMap.get(row.assessmentId) ?? null,
  }));
  return { rows, truncated: view.truncated };
}

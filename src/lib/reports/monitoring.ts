/**
 * monitoring — คิวมอนิเตอร์ + สถิติผลสอบ (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 228-229)
 *
 * - อ่าน assessment_attempts ผ่าน **user-JWT client** (RLS attempts_owner_read — 0010:755-760
 *   ยอมให้ staff 4 บทบาทอ่านทุกแถว) · ทุก query เป็น PostgREST 12 aggregate
 *   (`id.count()` / `score_pct.avg()` + group by คอลัมน์ non-aggregate ที่ select ร่วม) —
 *   การนับ/เฉลี่ยเกิดใน SQL ฝั่ง DB ทั้งหมด ไม่ใช่ JS (ข้อ 6 ของภารกิจ)
 *   · ผล group-by อ่านเป็นหน้า 1,000 + lookup แบ่งชุด 200 — เกินนั้นโดน
 *   PGRST_API_MAX_ROWS ตัดเงียบทำ summary ต่ำกว่าความจริง (gate r2 MAJOR)
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

/** ขนาดหน้าของ aggregate — ผล group-by เกิน 1,000 กลุ่มโดน PGRST_API_MAX_ROWS
 *  ตัดเงียบ (ครั้งเดียวไม่มีสัญญาณ) จึงต้องอ่านทุกหน้าตามลำดับ assessment_id
 *  (gate r2 MAJOR — เหมือน readCappedRows ของ views.ts แต่ไม่มี sentinel limit+1) */
const AGG_PAGE_SIZE = 1_000;

/** จำนวน id ต่อชุดของ lookup `.in()` — ชุดละ 200 ทำให้ผลไม่เกินเพดาน 1,000 และ
 *  URL สั้น (~8KB) ไม่ชน header limit ของ gateway (ยืมเพดาน picker cap 200 ของ 0023) */
const LOOKUP_CHUNK = 200;

/** อ่านแถว aggregate ทุกหน้าจนหมดจริง — container/แถว fail-closed แบบเดียวกับ
 *  readCappedRows ของ views.ts (gate p1-r1 MINOR-3) */
async function readAllAggRows<TParsed>(options: {
  readonly schema: {
    safeParse(data: unknown): { success: true; data: TParsed } | { success: false; error: unknown };
  };
  readonly fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  readonly queryFailedReason: string;
  readonly containerDriftReason: string;
  readonly rowDriftReason: string;
}): Promise<TParsed[]> {
  const rows: TParsed[] = [];
  while (true) {
    const from = rows.length;
    const { data, error } = await options.fetchPage(from, from + AGG_PAGE_SIZE - 1);
    if (error !== null) {
      throw dbFailed(options.queryFailedReason);
    }
    if (!Array.isArray(data)) {
      throw dbFailed(options.containerDriftReason);
    }
    for (const row of data) {
      const parsed = options.schema.safeParse(row);
      if (!parsed.success) {
        throw dbFailed(options.rowDriftReason);
      }
      rows.push(parsed.data);
    }
    if (data.length < AGG_PAGE_SIZE) {
      return rows;
    }
  }
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
 * ครอบ "ยังไม่ส่ง" อยู่แล้ว) · อ่านทุกหน้าตามลำดับ assessment_id จนหมดจริง
 * (gate r2 MAJOR: ครั้งเดียวทิ้งกลุ่มที่เกิน 1,000 ให้ summary ต่ำกว่าความจริงเงียบ ๆ)
 */
async function countInProgressPerAssessment(overdueOnly: boolean): Promise<Array<{ assessmentId: string; count: number }>> {
  const supabase = await createSupabaseSsrClient();
  const fetchPage = (from: number, to: number) => {
    let query = supabase
      .from("assessment_attempts")
      .select(
        overdueOnly
          ? "assessmentId:assessment_id,overdue:id.count()"
          : "assessmentId:assessment_id,inProgress:id.count()",
      )
      .eq("status", "in_progress")
      .order("assessment_id", { ascending: true })
      .range(from, to);
    if (overdueOnly) {
      query = query.lt("expires_at", new Date().toISOString());
    }
    return query;
  };
  // แยกกิ่ง schema เพื่อให้ TS เห็นชนิดตรงข้าง (ternary บน schema ทำ union ที่ access ไม่ได้)
  if (overdueOnly) {
    const rows = await readAllAggRows({
      schema: MonitoringOverdueRow,
      fetchPage,
      queryFailedReason: "attempts_overdue_agg_failed",
      containerDriftReason: "attempts_agg_container_drift",
      rowDriftReason: "attempts_agg_row_drift",
    });
    return rows.map((row) => ({ assessmentId: row.assessmentId, count: row.overdue }));
  }
  const rows = await readAllAggRows({
    schema: MonitoringInProgressRow,
    fetchPage,
    queryFailedReason: "attempts_in_progress_agg_failed",
    containerDriftReason: "attempts_agg_container_drift",
    rowDriftReason: "attempts_agg_row_drift",
  });
  return rows.map((row) => ({ assessmentId: row.assessmentId, count: row.inProgress }));
}

/** id → course_id ของ assessments ที่สนใจ (RLS asm_read — 0010:643-651 · staff 4 บทบาท)
 *  · แบ่งชุดละ LOOKUP_CHUNK — ผลต่อชุดไม่โดนเพดาน 1,000 และ URL สั้น (gate r2 MAJOR) */
async function courseOfAssessments(assessmentIds: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (assessmentIds.length === 0) {
    return map;
  }
  const supabase = await createSupabaseSsrClient();
  for (let offset = 0; offset < assessmentIds.length; offset += LOOKUP_CHUNK) {
    const chunk = assessmentIds.slice(offset, offset + LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("assessments")
      .select("id, courseId:course_id")
      .in("id", [...chunk]);
    if (error !== null) {
      throw dbFailed("assessments_lookup_failed");
    }
    // fail-closed ของ container (gate p1-r1 MINOR-3) — เหตุผลเดียวกับ aggregate ข้างบน
    if (!Array.isArray(data)) {
      throw dbFailed("assessments_lookup_container_drift");
    }
    for (const row of data) {
      const parsed = parseAggRow(AssessmentCourseRow, row, "assessments_lookup_row_drift");
      map.set(parsed.id, parsed.courseId);
    }
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

/** avg score_pct ต่อ assessment_id เฉพาะ attempt ที่ส่งแล้ว (submitted_at not null) —
 *  SQL aggregate · แบ่งชุดละ LOOKUP_CHUNK กันเพดาน 1,000 กลุ่ม (gate r2 MAJOR) */
async function averageScorePerAssessment(assessmentIds: readonly string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (assessmentIds.length === 0) {
    return map;
  }
  const supabase = await createSupabaseSsrClient();
  for (let offset = 0; offset < assessmentIds.length; offset += LOOKUP_CHUNK) {
    const chunk = assessmentIds.slice(offset, offset + LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("assessment_attempts")
      .select("assessmentId:assessment_id,avgScore:score_pct.avg()")
      .not("submitted_at", "is", null)
      .in("assessment_id", [...chunk]);
    if (error !== null) {
      throw dbFailed("avg_score_agg_failed");
    }
    // fail-closed ของ container (gate p1-r1 MINOR-3) — เหตุผลเดียวกับ aggregate ข้างบน
    if (!Array.isArray(data)) {
      throw dbFailed("avg_score_agg_container_drift");
    }
    for (const row of data) {
      const parsed: AvgScoreRowParsed = parseAggRow(AvgScoreRow, row, "avg_score_agg_row_drift");
      if (parsed.avgScore !== null) {
        map.set(parsed.assessmentId, parsed.avgScore);
      }
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

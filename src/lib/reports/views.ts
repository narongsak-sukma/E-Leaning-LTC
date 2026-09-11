/**
 * views — อ่าน views รายงานของ 0009/0016 ผ่าน **user-JWT Supabase client** (Wave E · D55-6)
 *
 * ข้อพิสูจน์สิทธิ์ (0009:239-255): ทั้งสาม view ถูก revoke จากทุก role รวม service_role
 * แล้ว grant select เฉพาะ `authenticated` — service client ไม่มีสิทธิ์อ่านและไม่มี JWT
 * claims ให้ has_any_role() ข้างใน view ใช้ (-> 0 แถว/ไม่มีสิทธิ์) จึงต้องอ่านผ่าน
 * createSupabaseSsrClient() (JWT ของผู้ใช้จาก cookie — แบบแผนเดียวกับ route ผู้เรียน
 * เช่น me/enrollments) แล้ว view กรองบทบาทภายในเอง (ชั้นที่สอง) — BFF ตรวจบทบาทแล้วที่
 * route (access.ts) — ห้ามพึ่งชั้นเดียว
 *
 * การแบ่งหน้าแบบ "cap" ตามความเหมาะของ view — ไม่มีคอลัมน์ unique+เวลาครบคู่สำหรับ keyset
 * (v_enrollment_progress ไม่มีคอลัมน์เวลา · v_credit_balance ไม่มีคีย์เดี่ยว) จึง fetch
 * limit+1 แถวเพื่อตัดสิน truncated · ตอบ header x-ltc-truncated เมื่อโดน cap
 */
import "server-only";
import { AppError } from "@/lib/errors";
import {
  AssessmentStatisticsRow,
  CreditBalanceRow,
  EnrollmentProgressRow,
  type AssessmentStatisticsResourceParsed,
  type CreditBalanceResourceParsed,
  type EnrollmentProgressResourceParsed,
} from "@/lib/schemas/v1/report";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** คอลัมน์ exact ของแต่ละ view (select เฉพาะที่ใช้ — SDS §5.2 narrow columns) */
const ENROLLMENT_PROGRESS_SELECT =
  "enrollment_id, user_id, course_id, lesson_total, lesson_completed, progress_pct";
const ASSESSMENT_STATISTICS_SELECT = "assessment_id, attempt_total, attempt_passed, pass_rate_pct";
const CREDIT_BALANCE_SELECT = "user_id, renewal_cycle_id, credit_type, balance, last_entry_at";

/** error ของ query → ERR-SYS-002 แบบ opaque — ไม่ leak SQL (SDS §6.1) */
function dbFailed(reason: string): AppError {
  return new AppError("ERR-SYS-002", { details: { reason } });
}

/**
 * แถว view drift (คอลัมน์/ชนิดเพี้ยนจาก PostgREST) → ERR-SYS-002 — ห้ามปล่อยผ่าน `as`
 * (ขาเข้า fail-closed แบบเดียวกับ MyCertificateRowSchema ของ lib/certificates)
 */
function parseViewRow<T>(
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

/** map แถว v_enrollment_progress → resource camelCase (รับเฉพาะแถวที่ parse ผ่านแล้ว) */
function toEnrollmentProgressResource(row: { enrollment_id: string; user_id: string; course_id: string; lesson_total: number; lesson_completed: number; progress_pct: number }): EnrollmentProgressResourceParsed {
  return {
    enrollmentId: row.enrollment_id,
    userId: row.user_id,
    courseId: row.course_id,
    lessonTotal: row.lesson_total,
    lessonCompleted: row.lesson_completed,
    progressPct: row.progress_pct,
  };
}

/**
 * GET /admin/reports/enrollments — อ่าน v_enrollment_progress (sv/sa เท่านั้น — view กรองเอง)
 * กรอง courseId ได้ (view มี course_id) · view ไม่มีคอลัมน์เวลา → ไม่รับ from/to
 */
export async function listEnrollmentProgress(options: {
  readonly limit: number;
  readonly courseId?: string | undefined;
}): Promise<{ rows: EnrollmentProgressResourceParsed[]; truncated: boolean }> {
  const supabase = await createSupabaseSsrClient();
  let query = supabase
    .from("v_enrollment_progress")
    .select(ENROLLMENT_PROGRESS_SELECT)
    .order("enrollment_id", { ascending: true })
    .limit(options.limit + 1);
  if (options.courseId !== undefined) {
    query = query.eq("course_id", options.courseId);
  }
  const { data, error } = await query;
  if (error !== null) {
    throw dbFailed("v_enrollment_progress_query_failed");
  }
  const fetched = data ?? [];
  const truncated = fetched.length > options.limit;
  const rows = truncated ? fetched.slice(0, options.limit) : fetched;
  return {
    rows: rows.map((row) =>
      toEnrollmentProgressResource(parseViewRow(EnrollmentProgressRow, row, "v_enrollment_progress_row_drift")),
    ),
    truncated,
  };
}

/** map แถว v_assessment_statistics → resource camelCase (รับเฉพาะแถวที่ parse ผ่านแล้ว) */
function toAssessmentStatisticsResource(row: { assessment_id: string; attempt_total: number; attempt_passed: number; pass_rate_pct: number }): AssessmentStatisticsResourceParsed {
  return {
    assessmentId: row.assessment_id,
    attemptTotal: row.attempt_total,
    attemptPassed: row.attempt_passed,
    passRatePct: row.pass_rate_pct,
  };
}

/** GET /admin/reports/assessments — อ่าน v_assessment_statistics (sv/se/sa — view กรองเอง) */
export async function listAssessmentStatistics(options: {
  readonly limit: number;
}): Promise<{ rows: AssessmentStatisticsResourceParsed[]; truncated: boolean }> {
  const supabase = await createSupabaseSsrClient();
  const { data, error } = await supabase
    .from("v_assessment_statistics")
    .select(ASSESSMENT_STATISTICS_SELECT)
    .order("assessment_id", { ascending: true })
    .limit(options.limit + 1);
  if (error !== null) {
    throw dbFailed("v_assessment_statistics_query_failed");
  }
  const fetched = data ?? [];
  const truncated = fetched.length > options.limit;
  const rows = truncated ? fetched.slice(0, options.limit) : fetched;
  return {
    rows: rows.map((row) =>
      toAssessmentStatisticsResource(parseViewRow(AssessmentStatisticsRow, row, "v_assessment_statistics_row_drift")),
    ),
    truncated,
  };
}

/** map แถว v_credit_balance → resource camelCase (รับเฉพาะแถวที่ parse ผ่านแล้ว) */
function toCreditBalanceResource(row: { user_id: string; renewal_cycle_id: string; credit_type: string; balance: number; last_entry_at: string | null }): CreditBalanceResourceParsed {
  return {
    userId: row.user_id,
    renewalCycleId: row.renewal_cycle_id,
    creditType: row.credit_type,
    balance: row.balance,
    lastEntryAt: row.last_entry_at,
  };
}

/**
 * GET /admin/reports/credits — อ่าน v_credit_balance (sv/sr/sa — view กรองเอง)
 * กรอง from/to บน last_entry_at (max(created_at) ต่อกลุ่ม — คอลัมน์เวลาเดียวที่ view มี)
 */
export async function listCreditBalances(options: {
  readonly limit: number;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): Promise<{ rows: CreditBalanceResourceParsed[]; truncated: boolean }> {
  const supabase = await createSupabaseSsrClient();
  let query = supabase
    .from("v_credit_balance")
    .select(CREDIT_BALANCE_SELECT)
    .order("last_entry_at", { ascending: false, nullsFirst: false })
    .order("user_id", { ascending: true })
    .limit(options.limit + 1);
  if (options.from !== undefined) {
    query = query.gte("last_entry_at", options.from);
  }
  if (options.to !== undefined) {
    query = query.lte("last_entry_at", options.to);
  }
  const { data, error } = await query;
  if (error !== null) {
    throw dbFailed("v_credit_balance_query_failed");
  }
  const fetched = data ?? [];
  const truncated = fetched.length > options.limit;
  const rows = truncated ? fetched.slice(0, options.limit) : fetched;
  return {
    rows: rows.map((row) =>
      toCreditBalanceResource(parseViewRow(CreditBalanceRow, row, "v_credit_balance_row_drift")),
    ),
    truncated,
  };
}

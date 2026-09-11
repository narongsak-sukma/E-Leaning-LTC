/**
 * views — อ่าน views รายงานของ 0009/0016 ผ่าน **user-JWT Supabase client** (Wave E · D55-6)
 *
 * ข้อพิสูจน์สิทธิ์ (0009:239-255): ทั้งสาม view ถูก revoke จากทุก role รวม service_role
 * แล้ว grant select เฉพาะ `authenticated` — service client ไม่มีสิทธิ์อ่านและไม่มี JWT
 * claims ให้ has_any_role() ข้างใน view ใช้ (-> 0 แถว/ไม่มีสิทธิ์) จึงต้องอ่านผ่าน
 * createSupabaseSsrClient() (JWT ของผู้ใช้จาก cookie — แบบแผนเดียวกับ route ผู้เรียน
 * เช่น me/enrollments) แล้ว view กรองบทบาทภายในเอง (ชั้นที่สอง) — BFF ตรวจบทบาทแล้ว
 * ที่ route (access.ts) — ห้ามพึ่งชั้นเดียว
 *
 * การแบ่งหน้าแบบ "cap" ตามความเหมาะของ view — ไม่มีคอลัมน์ unique+เวลาครบคู่สำหรับ
 * keyset (v_enrollment_progress ไม่มีคอลัมน์เวลา · v_credit_balance ไม่มีคีย์เดี่ยว)
 * จึงเทียบ limit+1 แถวเพื่อตัดสิน truncated แล้วตอบ header x-ltc-truncated เมื่อโดน cap
 *
 * batch loop (gate p1-r1 MAJOR-2): PGRST_API_MAX_ROWS=1000 (compose §rest · แพลตฟอร์ม
 * Supabase ก็ 1000) ตัดจำนวนแถวต่อ request เงียบ ๆ — request เดียว limit=10,001 ของ
 * export จะได้แค่ 1,000 แถวโดย truncated ยังเป็น false · ต้องอ่านเป็นหน้า 1,000 แถว
 * (range offset) จนครบ limit+1 หรือหมดจริง โดยทุก view สั่ง .order() ที่ deterministic
 * (คีย์หลักของ view + tiebreaker ครบ) ให้ลำดับ offset คงที่ข้ามหน้า
 */
import "server-only";
import { AppError } from "@/lib/errors";
import {
  AssessmentStatisticsRow,
  CreditBalanceRow,
  EnrollmentProgressRow,
  type AssessmentStatisticsRowParsed,
  type AssessmentStatisticsResourceParsed,
  type CreditBalanceRowParsed,
  type CreditBalanceResourceParsed,
  type EnrollmentProgressRowParsed,
  type EnrollmentProgressResourceParsed,
} from "@/lib/schemas/v1/report";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** คอลัมน์ exact ของแต่ละ view (select เฉพาะที่ใช้ — SDS §5.2 narrow columns) */
const ENROLLMENT_PROGRESS_SELECT =
  "enrollment_id, user_id, course_id, lesson_total, lesson_completed, progress_pct";
const ASSESSMENT_STATISTICS_SELECT = "assessment_id, attempt_total, attempt_passed, pass_rate_pct";
const CREDIT_BALANCE_SELECT = "user_id, renewal_cycle_id, credit_type, balance, last_entry_at";

/** ขนาดหน้าสูงสุดต่อ request — ต้องไม่เกิน PGRST_API_MAX_ROWS (1000) เพราะเกินถูกตัด
 *  เงียบ ๆ แล้วคำนวณ truncated ผิด (gate p1-r1 MAJOR-2) */
const VIEW_PAGE_SIZE = 1_000;

/** error ของ query → ERR-SYS-002 แบบ opaque — ไม่ leak SQL (SDS §6.1) */
function dbFailed(reason: string): AppError {
  return new AppError("ERR-SYS-002", { details: { reason } });
}

/** ผลลัพธ์แถวของ reader แบบ cap — truncated = ยังมีข้อมูลเกิน limit จริง */
interface CappedRows<TParsed> {
  readonly rows: readonly TParsed[];
  readonly truncated: boolean;
}

/**
 * อ่าน view แบบ batch จนครบ limit+1 แถว (หลักฐาน truncated) หรือหมดจริง —
 * ปิดช่อง PGRST_API_MAX_ROWS ตัดเงียบ (gate p1-r1 MAJOR-2) · fail-closed สองจุด
 * (gate p1-r1 MINOR-3): container ต้องเป็น array จริง (null/object = drift) และ
 * **ทุกแถวที่ได้รับ** รวมแถว sentinel ตัวที่ limit+1 ต้องผ่าน .strict() ก่อน slice —
 * ห้าม `data ?? []` แล้ว slice ก่อนตรวจเพราะแถว sentinel จะหลุดการตรวจไปเลย
 */
async function readCappedRows<TParsed>(options: {
  readonly limit: number;
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
}): Promise<CappedRows<TParsed>> {
  const rows: TParsed[] = [];
  while (rows.length <= options.limit) {
    // ขอเท่าที่ยังต้องการเท่านั้น (limit เล็ก = หน้าเดียวจบ เหมือนพฤติกรรมเดิม)
    const remaining = options.limit + 1 - rows.length;
    const pageSize = Math.min(VIEW_PAGE_SIZE, remaining);
    const { data, error } = await options.fetchPage(rows.length, rows.length + pageSize - 1);
    if (error !== null) {
      throw dbFailed(options.queryFailedReason);
    }
    if (!Array.isArray(data)) {
      // data:null (ตีตกเป็น "ว่าง") หรือ object = drift ของ container — ห้ามรายงานว่างปลอม
      throw dbFailed(options.containerDriftReason);
    }
    for (const row of data) {
      const parsed = options.schema.safeParse(row);
      if (!parsed.success) {
        throw dbFailed(options.rowDriftReason);
      }
      rows.push(parsed.data);
    }
    if (data.length < pageSize) {
      // ได้น้อยกว่าที่ขอ = หมดจริง — ไม่มีแถวที่ถูกตัด
      return { rows, truncated: false };
    }
  }
  return { rows: rows.slice(0, options.limit), truncated: true };
}

/** map แถว v_enrollment_progress → resource camelCase (รับเฉพาะแถวที่ parse ผ่านแล้ว) */
function toEnrollmentProgressResource(row: EnrollmentProgressRowParsed): EnrollmentProgressResourceParsed {
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
 * กรอง courseId ได้ (view มี course_id) · view ไม่มีคอลัมน์เวลา → ไม่รับ from/to ·
 * เรียงตาม enrollment_id (unique) ให้ลำดับ offset คงที่ข้ามหน้าของ batch loop
 */
export async function listEnrollmentProgress(options: {
  readonly limit: number;
  readonly courseId?: string | undefined;
}): Promise<{ rows: EnrollmentProgressResourceParsed[]; truncated: boolean }> {
  const supabase = await createSupabaseSsrClient();
  const capped = await readCappedRows({
    limit: options.limit,
    schema: EnrollmentProgressRow,
    queryFailedReason: "v_enrollment_progress_query_failed",
    containerDriftReason: "v_enrollment_progress_container_drift",
    rowDriftReason: "v_enrollment_progress_row_drift",
    fetchPage: (from, to) => {
      let query = supabase
        .from("v_enrollment_progress")
        .select(ENROLLMENT_PROGRESS_SELECT)
        .order("enrollment_id", { ascending: true })
        .range(from, to);
      if (options.courseId !== undefined) {
        query = query.eq("course_id", options.courseId);
      }
      return query;
    },
  });
  return {
    rows: capped.rows.map(toEnrollmentProgressResource),
    truncated: capped.truncated,
  };
}

/** map แถว v_assessment_statistics → resource camelCase (รับเฉพาะแถวที่ parse ผ่านแล้ว) */
function toAssessmentStatisticsResource(row: AssessmentStatisticsRowParsed): AssessmentStatisticsResourceParsed {
  return {
    assessmentId: row.assessment_id,
    attemptTotal: row.attempt_total,
    attemptPassed: row.attempt_passed,
    passRatePct: row.pass_rate_pct,
  };
}

/** GET /admin/reports/assessments — อ่าน v_assessment_statistics (sv/se/sa — view กรองเอง)
 *  · เรียงตาม assessment_id (unique) ให้ลำดับ offset คงที่ข้ามหน้าของ batch loop */
export async function listAssessmentStatistics(options: {
  readonly limit: number;
}): Promise<{ rows: AssessmentStatisticsResourceParsed[]; truncated: boolean }> {
  const supabase = await createSupabaseSsrClient();
  const capped = await readCappedRows({
    limit: options.limit,
    schema: AssessmentStatisticsRow,
    queryFailedReason: "v_assessment_statistics_query_failed",
    containerDriftReason: "v_assessment_statistics_container_drift",
    rowDriftReason: "v_assessment_statistics_row_drift",
    fetchPage: (from, to) =>
      supabase
        .from("v_assessment_statistics")
        .select(ASSESSMENT_STATISTICS_SELECT)
        .order("assessment_id", { ascending: true })
        .range(from, to),
  });
  return {
    rows: capped.rows.map(toAssessmentStatisticsResource),
    truncated: capped.truncated,
  };
}

/** map แถว v_credit_balance → resource camelCase (รับเฉพาะแถวที่ parse ผ่านแล้ว) */
function toCreditBalanceResource(row: CreditBalanceRowParsed): CreditBalanceResourceParsed {
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
 * · เรียง last_entry_at desc + user_id + renewal_cycle_id + credit_type (tiebreaker ครบ
 * grain ของ view) ให้ลำดับ offset คงที่ข้ามหน้าของ batch loop
 */
export async function listCreditBalances(options: {
  readonly limit: number;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): Promise<{ rows: CreditBalanceResourceParsed[]; truncated: boolean }> {
  const supabase = await createSupabaseSsrClient();
  const capped = await readCappedRows({
    limit: options.limit,
    schema: CreditBalanceRow,
    queryFailedReason: "v_credit_balance_query_failed",
    containerDriftReason: "v_credit_balance_container_drift",
    rowDriftReason: "v_credit_balance_row_drift",
    fetchPage: (from, to) => {
      let query = supabase
        .from("v_credit_balance")
        .select(CREDIT_BALANCE_SELECT)
        .order("last_entry_at", { ascending: false, nullsFirst: false })
        .order("user_id", { ascending: true })
        .order("renewal_cycle_id", { ascending: true })
        .order("credit_type", { ascending: true })
        .range(from, to);
      if (options.from !== undefined) {
        query = query.gte("last_entry_at", options.from);
      }
      if (options.to !== undefined) {
        query = query.lte("last_entry_at", options.to);
      }
      return query;
    },
  });
  return {
    rows: capped.rows.map(toCreditBalanceResource),
    truncated: capped.truncated,
  };
}

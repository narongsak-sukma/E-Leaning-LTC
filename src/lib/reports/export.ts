/**
 * export — ส่งออกรายงาน CSV/JSON + เขียน report_exports + audit ADMIN_EXPORT
 * (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 221 · DD §3.7)
 *
 * ลำดับใน runExport: อ่านแถวผ่าน user-JWT client (views.ts — cap 10,000 แถว) → สร้าง
 * payload (CSV มี BOM + header ไทย · หรือ JSON) → เขียนแถว report_exports ผ่าน
 * **service client** (grant select,insert,update to service_role — 0010:885; DD §3.7
 * "INSERT service_role ผ่าน BFF") → audit ADMIN_EXPORT ผ่านแบบแผน audit กลาง
 * (append_audit_event RPC)
 *
 * ข้อจำกัดที่พบจาก DB จริง (รายงาน lead แล้ว): ADMIN_EXPORT ยังไม่อยู่ใน allowlist ของ
 * append_audit_event (0019-r2 รับเฉพาะ AUTH_* 12 + PII_ACCESS จาก service_role ·
 * 0008/0019 class ข รับเฉพาะ AUDIT_READ/RATE_LIMIT_HIT/PII_ACCESS) — RPC จะปฏิเสธ
 * (42501) ทุกครั้งจนกว่า DB จะเปิด allowlist (ต้องเปิด DCR migration) · BFF ทำ best-effort
 * เหมือนแบบแผน PII_ACCESS ของ lib/certificates/shared.ts: ปฏิเสธ = WARN + คืน
 * { written:false } ไม่ล้มการ export (จึงต้องเปิด DCR ให้เร็ว)
 */
import "server-only";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { buildCsv } from "@/lib/reports/csv";
import {
  listAssessmentStatistics,
  listCreditBalances,
  listEnrollmentProgress,
} from "@/lib/reports/views";
import {
  ExportFormat,
  IsoTimestamp,
  parseReportQuery,
  type AssessmentStatisticsResourceParsed,
  type CreditBalanceResourceParsed,
  type EnrollmentProgressResourceParsed,
  type ExportFormatValue,
} from "@/lib/schemas/v1/report";
import { REPORT_TYPES, type ReportType } from "@/lib/reports/access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

/** cap แถวของ export — เกินนี้ตอบครบ cap + header x-ltc-truncated: true (§3.8 แถว 221) */
export const EXPORT_ROW_CAP = 10_000;

/** ประเภทรายงานที่ export ได้ — ค่าอื่น → ERR-NF-001 (404) */
export function parseReportTypeParam(raw: string): ReportType {
  const matched = (REPORT_TYPES as readonly string[]).includes(raw);
  if (!matched) {
    throw new AppError("ERR-NF-001");
  }
  return raw as ReportType;
}

/** IsoTimestamp ของ schemas ใช้ร่วมกับ from/to ของ export query (credits) */
const Iso = IsoTimestamp;

/** query ของ export — strict ต่อประเภท: enrollments รับ courseId · credits รับ from/to */
const EXPORT_QUERY_SCHEMAS: Record<ReportType, z.ZodType> = {
  enrollments: z
    .object({ format: ExportFormat.default("csv"), courseId: z.string().uuid().optional() })
    .strict(),
  assessments: z.object({ format: ExportFormat.default("csv") }).strict(),
  credits: z
    .object({ format: ExportFormat.default("csv"), from: Iso.optional(), to: Iso.optional() })
    .strict(),
};

/** query ของ export → { format, filters } — ผิดรูป/คีย์แปลกปลอม → ERR-VAL-001 (400) */
export function parseExportQuery(
  type: ReportType,
  searchParams: URLSearchParams,
): {
  format: ExportFormatValue;
  courseId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
} {
  const parsed = parseReportQuery(EXPORT_QUERY_SCHEMAS[type]!, searchParams) as {
    format: ExportFormatValue;
    courseId?: string;
    from?: string;
    to?: string;
  };
  return parsed;
}

/** header ไทยของ CSV ต่อประเภท (คอลัมน์ตรงกับ resource ของ schemas/v1/report) */
export const EXPORT_CSV_HEADERS: Record<ReportType, readonly string[]> = {
  enrollments: [
    "รหัสการลงทะเบียน",
    "รหัสผู้เรียน",
    "รหัสหลักสูตร",
    "จำนวนบทเรียนทั้งหมด",
    "บทเรียนที่เรียนแล้ว",
    "ความคืบหน้า (%)",
  ],
  assessments: ["รหัสชุดข้อสอบ", "จำนวนครั้งที่สอบ", "จำนวนที่ผ่าน", "อัตราผ่าน (%)"],
  credits: ["รหัสผู้เรียน", "รหัสรอบต่ออายุ", "ประเภทเครดิต", "ยอดคงเหลือ", "รายการล่าสุด"],
};

/** แถว resource → แถว CSV (string[] ยาวเท่า header — mismatch = บั๊กผู้เรียก) */
function exportRowToStrings(
  type: ReportType,
  row:
    | EnrollmentProgressResourceParsed
    | AssessmentStatisticsResourceParsed
    | CreditBalanceResourceParsed,
): string[] {
  switch (type) {
    case "enrollments":
      return [
        (row as EnrollmentProgressResourceParsed).enrollmentId,
        (row as EnrollmentProgressResourceParsed).userId,
        (row as EnrollmentProgressResourceParsed).courseId,
        String((row as EnrollmentProgressResourceParsed).lessonTotal),
        String((row as EnrollmentProgressResourceParsed).lessonCompleted),
        String((row as EnrollmentProgressResourceParsed).progressPct),
      ];
    case "assessments":
      return [
        (row as AssessmentStatisticsResourceParsed).assessmentId,
        String((row as AssessmentStatisticsResourceParsed).attemptTotal),
        String((row as AssessmentStatisticsResourceParsed).attemptPassed),
        String((row as AssessmentStatisticsResourceParsed).passRatePct),
      ];
    case "credits":
      return [
        (row as CreditBalanceResourceParsed).userId,
        (row as CreditBalanceResourceParsed).renewalCycleId,
        (row as CreditBalanceResourceParsed).creditType,
        String((row as CreditBalanceResourceParsed).balance),
        (row as CreditBalanceResourceParsed).lastEntryAt ?? "",
      ];
  }
}

/** ผลของ runExport — route ใช้ประกอบ NextResponse (CSV/JSON ต่าง content-type) */
export interface ExportResult {
  readonly exportId: string;
  readonly contentType: string;
  readonly filename: string;
  readonly body: string;
  readonly rowCount: number;
  readonly truncated: boolean;
}

/** ตัวกรองที่บันทึกใน params ของ report_exports + context ของ audit — uuid/ISO เท่านั้น (ไม่มี PII) */
interface ExportFilters {
  readonly courseId?: string;
  readonly from?: string;
  readonly to?: string;
}

/** ตัวกรอง → ข้อความ canonical สั้น ๆ (ไม่มี PII — uuid/ISO เท่านั้น) สำหรับ context.filters */
export function filtersToContextValue(filters: ExportFilters): string {
  const parts: string[] = [];
  if (filters.courseId !== undefined) parts.push(`courseId=${filters.courseId}`);
  if (filters.from !== undefined) parts.push(`from=${filters.from}`);
  if (filters.to !== undefined) parts.push(`to=${filters.to}`);
  return parts.length > 0 ? parts.join(";") : "-";
}

/**
 * เขียนแถว report_exports ผ่าน service client — DD §3.7 "INSERT service_role ผ่าน BFF" ·
 * status='completed' + completed_at ทันที (v1 ตอบสด ไม่มีไฟล์/async worker) · expires_at=null ·
 * ล้มเหลว = fail-closed 503 (ห้ามส่งข้อมูลออกโดยไม่มีแถวบันทึกการเปิดเผย)
 */
async function writeExportRecord(options: {
  readonly type: ReportType;
  readonly format: ExportFormatValue;
  readonly filters: ExportFilters;
  readonly rowCount: number;
  readonly requestedBy: string;
  readonly requestId: string | null;
}): Promise<string> {
  const service = createSupabaseServiceRoleClient();
  const { data, error } = await service
    .from("report_exports")
    .insert({
      requested_by: options.requestedBy,
      report_type: options.type,
      params: {
        ...(options.filters.courseId !== undefined ? { courseId: options.filters.courseId } : {}),
        ...(options.filters.from !== undefined ? { from: options.filters.from } : {}),
        ...(options.filters.to !== undefined ? { to: options.filters.to } : {}),
      },
      format: options.format,
      status: "completed",
      row_count: options.rowCount,
      completed_at: new Date().toISOString(),
      expires_at: null,
    })
    .select("id")
    .single();
  if (error !== null || data === null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "report_exports_write_failed" } }
    );
  }
  return (data as { id: unknown }).id as string;
}

/**
 * audit ADMIN_EXPORT ผ่านแบบแผน audit กลาง (append_audit_event RPC ทาง service client)
 * — best-effort แบบเดียวกับ PII_ACCESS ของ lib/certificates/shared.ts: DB ปฏิเสธ
 * (เช่น allowlist เปลี่ยน) = WARN tripwire + คืน { written:false } ไม่ล้ม export ·
 * คีย์ context ตาม AUDIT-LOG-DESIGN §3.3 แถว ADMIN_EXPORT: report_type / row_count /
 * filters (ตัวกรองไม่มี PII) · user_id = actor (lead fix 0025: RPC ยกจาก
 * context.user_id แล้ว strip — ไม่ใส่ = แถว audit ไม่มี "ใคร" ผิด 5W §1.2)
 */
export async function auditAdminExport(input: {
  readonly exportId: string;
  readonly reportType: ReportType;
  readonly rowCount: number;
  readonly filters: string;
  readonly requestedBy: string;
  readonly requestId: string | null;
}): Promise<{ written: boolean; reason: string }> {
  const service = createSupabaseServiceRoleClient();
  const { error } = await service.rpc("append_audit_event", {
    p_action: "ADMIN_EXPORT",
    p_entity_type: "report_export",
    p_entity_id: input.exportId,
    p_before: null,
    p_after: null,
    p_context: {
      report_type: input.reportType,
      row_count: String(input.rowCount),
      filters: input.filters,
      // actor ของการส่งออก (5W "ใคร") — RPC ยกขึ้น p_actor_id แล้ว strip ออกจาก
      // context ที่เก็บจริง (แบบเดียวกับ PII_ACCESS ของ certificates/shared)
      user_id: input.requestedBy,
    },
    p_actor_roles: null,
    p_ip_hash: null,
    p_user_agent: null,
    p_request_id: input.requestId,
  });
  if (error === null) {
    return { written: true, reason: "audit_written" };
  }
  const code = (error as { code?: unknown }).code;
  const reason =
    code === "42501" ? "db_allowlist_denies_service_role" : "rpc_error";
  createLogger(getConfig().logLevel).warn("report_export_audit_denied", {
    route: "reports:export",
    user_id: input.requestedBy,
    ...(input.requestId === null ? {} : { request_id: input.requestId }),
  });
  return { written: false, reason };
}

/**
 * ทำ export ครบวงจร: อ่านแถว (cap 10,000) → payload → report_exports → audit ·
 * เรียกได้เฉพาะหลัง route ตรวจบทบาท fail-closed แล้ว (access.ts)
 */
export async function runExport(options: {
  readonly type: ReportType;
  readonly format: ExportFormatValue;
  readonly courseId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly requestedBy: string;
  readonly requestId: string | null;
}): Promise<ExportResult> {
  const filters: ExportFilters = {
    ...(options.courseId !== undefined ? { courseId: options.courseId } : {}),
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
  };
  const read =
    options.type === "enrollments"
      ? await listEnrollmentProgress({ limit: EXPORT_ROW_CAP, courseId: options.courseId })
      : options.type === "assessments"
        ? await listAssessmentStatistics({ limit: EXPORT_ROW_CAP })
        : await listCreditBalances({ limit: EXPORT_ROW_CAP, from: options.from, to: options.to });
  // union ของ 3 array types → normalize เป็น array ของ union เพื่อ .map ได้ตรง ๆ (TS array invariance)
  const rows = read.rows as Array<
    EnrollmentProgressResourceParsed | AssessmentStatisticsResourceParsed | CreditBalanceResourceParsed
  >;
  const rowCount = rows.length;
  const truncated = read.truncated;
  const exportId = await writeExportRecord({
    type: options.type,
    format: options.format,
    filters,
    rowCount,
    requestedBy: options.requestedBy,
    requestId: options.requestId,
  });
  await auditAdminExport({
    exportId,
    reportType: options.type,
    rowCount,
    filters: filtersToContextValue(filters),
    requestedBy: options.requestedBy,
    requestId: options.requestId,
  });
  const dateTag = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date())
    .replaceAll("-", "");
  const filename = `ltc-report-${options.type}-${dateTag}.${options.format}`;
  const body =
    options.format === "csv"
      ? buildCsv(
          EXPORT_CSV_HEADERS[options.type],
          rows.map((row) => exportRowToStrings(options.type, row)),
        )
      : JSON.stringify({
          data: {
            reportType: options.type,
            rowCount,
            truncated,
            rows,
          },
        });
  return {
    exportId,
    contentType:
      options.format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/json; charset=utf-8",
    filename,
    body,
    rowCount,
    truncated,
  };
}

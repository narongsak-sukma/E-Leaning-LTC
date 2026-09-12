/**
 * reports/exams — ชั้นข้อมูลสถิติ/มอนิเตอร์ข้อสอบ (Wave E Phase 5 · lane F · ADM-004)
 *
 * - GET /api/v1/admin/exams/monitoring (ExamMonitoringResource — strict) ·
 *   GET /api/v1/admin/exams/statistics?limit= (ExamStatisticsResource — strict · เพดาน limit 500)
 * - ตรวจ contract fail-closed ด้วย parser เอง — รูปร่างผิด = "server" ทั้งหน้า (แบบแผนเดิม)
 * - 401/403 → "forbidden" · BFF ล่ม/5xx/contract ผิดรูป → "server"
 */
import "server-only";
import { headers } from "next/headers";
import { ApiError, fetchJson } from "@/lib/api/transport";
import { getConfig } from "@/lib/config";
import type { AdminDataErrorKind, AdminResult } from "@/lib/fixtures/admin";

/** ขนาด limit ของสถิติผลสอบ — default 100 เพดาน 500 ตาม route จริง */
export const EXAM_STATISTICS_LIMIT = 100;

/** แถวการมอนิเตอร์ต่อชุดข้อสอบ */
export type ExamMonitoringAssessment = {
  assessmentId: string;
  inProgress: number | null;
  overdue: number | null;
};

/** แถวการมอนิเตอร์ต่อหลักสูตร */
export type ExamMonitoringCourse = {
  courseId: string;
  inProgress: number | null;
  overdue: number | null;
  titleTh: string | null;
};

/** ผล GET /admin/exams/monitoring */
export type ExamMonitoringData = {
  generatedAt: string;
  summary: { inProgressCount: number | null; overdueCount: number | null };
  byAssessment: readonly ExamMonitoringAssessment[];
  byCourse: readonly ExamMonitoringCourse[];
};

/** แถวสถิติผลสอบต่อชุดข้อสอบ */
export type ExamStatisticsRow = {
  assessmentId: string;
  attemptTotal: number | null;
  attemptPassed: number | null;
  passRatePct: number | null;
  avgScorePct: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pure — จำนวนเต็ม ≥0 หรือ null (BFF ใช้ null เมื่อบทบาทไม่มีสิทธิ์ดูตัวเลขนั้น) */
export function nullableCount(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** pure — แถว byAssessment ผ่านรูป (assessmentId บังคับ · จำนวน ≥0) */
export function parseMonitoringAssessment(raw: unknown): ExamMonitoringAssessment | null {
  if (!isRecord(raw)) {
    return null;
  }
  const assessmentId = typeof raw["assessmentId"] === "string" && raw["assessmentId"].length > 0 ? raw["assessmentId"] : null;
  const inProgress = nullableCount(raw["inProgress"]);
  const overdue = nullableCount(raw["overdue"]);
  if (assessmentId === null || inProgress === undefined || overdue === undefined) {
    return null;
  }
  return { assessmentId, inProgress, overdue };
}

/** pure — แถว byCourse ผ่านรูป (courseId บังคับ · ตัวเลข/null) */
export function parseMonitoringCourse(raw: unknown): ExamMonitoringCourse | null {
  if (!isRecord(raw)) {
    return null;
  }
  const courseId = typeof raw["courseId"] === "string" && raw["courseId"].length > 0 ? raw["courseId"] : null;
  const inProgress = nullableCount(raw["inProgress"]);
  const overdue = nullableCount(raw["overdue"]);
  const titleTh = nullableString(raw, "titleTh");
  if (courseId === null || inProgress === undefined || overdue === undefined || titleTh === undefined) {
    return null;
  }
  return { courseId, inProgress, overdue, titleTh };
}

/** pure — แถวสถิติผ่านรูป (assessmentId บังคับ · ตัวเลข/null) */
export function parseStatisticsRow(raw: unknown): ExamStatisticsRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const assessmentId = typeof raw["assessmentId"] === "string" && raw["assessmentId"].length > 0 ? raw["assessmentId"] : null;
  const attemptTotal = nullableCount(raw["attemptTotal"]);
  const attemptPassed = nullableCount(raw["attemptPassed"]);
  const passRatePct = nullablePercent(raw["passRatePct"]);
  const avgScorePct = nullablePercent(raw["avgScorePct"]);
  if (
    assessmentId === null ||
    attemptTotal === undefined ||
    attemptPassed === undefined ||
    passRatePct === undefined ||
    avgScorePct === undefined
  ) {
    return null;
  }
  return { assessmentId, attemptTotal, attemptPassed, passRatePct, avgScorePct };
}

/** pure — ตัวเลขจริง ≥0 หรือ null (เปอร์เซ็นต์อาจทศนิยม เช่น avgScorePct 75.5) */
export function nullablePercent(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** pure — string ที่อนุญาต null — type อื่น = undefined (contract ผิดรูป) */
function nullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** pure — ประกอบ ExamMonitoringData จาก envelope — ผิดรูป = null (fail-closed) */
export function parseExamMonitoring(body: unknown): ExamMonitoringData | null {
  if (!isRecord(body)) {
    return null;
  }
  const payload = body["data"];
  if (!isRecord(payload)) {
    return null;
  }
  const generatedAt = typeof payload["generatedAt"] === "string" && payload["generatedAt"].length > 0 ? payload["generatedAt"] : null;
  const rawSummary = payload["summary"];
  const rawAssessments = payload["byAssessment"];
  const rawCourses = payload["byCourse"];
  if (
    generatedAt === null ||
    !isRecord(rawSummary) ||
    !Array.isArray(rawAssessments) ||
    !Array.isArray(rawCourses)
  ) {
    return null;
  }
  const inProgressCount = nullableCount(rawSummary["inProgressCount"]);
  const overdueCount = nullableCount(rawSummary["overdueCount"]);
  if (inProgressCount === undefined || overdueCount === undefined) {
    return null;
  }
  const byAssessment: ExamMonitoringAssessment[] = [];
  for (const item of rawAssessments) {
    const row = parseMonitoringAssessment(item);
    if (row === null) {
      return null;
    }
    byAssessment.push(row);
  }
  const byCourse: ExamMonitoringCourse[] = [];
  for (const item of rawCourses) {
    const row = parseMonitoringCourse(item);
    if (row === null) {
      return null;
    }
    byCourse.push(row);
  }
  return {
    generatedAt,
    summary: { inProgressCount, overdueCount },
    byAssessment,
    byCourse,
  };
}

/** pure — ประกอบแถวสถิติจาก envelope — ผิดรูป = null (fail-closed) */
export function parseExamStatistics(body: unknown): readonly ExamStatisticsRow[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const items = body["data"];
  if (!Array.isArray(items)) {
    return null;
  }
  const rows: ExamStatisticsRow[] = [];
  for (const item of items) {
    const row = parseStatisticsRow(item);
    if (row === null) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}

/** GET /api/v1/admin/exams/monitoring — มอนิเตอร์ attempt (staff:exam, super_admin) */
export async function getExamMonitoringData(): Promise<AdminResult<ExamMonitoringData>> {
  const headerBag = await headers();
  try {
    const result = await fetchJson(
      "/api/v1/admin/exams/monitoring",
      { method: "GET" },
      {
        origin: getConfig().publicBaseUrl,
        cookieHeader: headerBag.get("cookie") ?? "",
      },
    );
    const parsed = parseExamMonitoring(result.body);
    if (parsed === null) {
      return { ok: false, kind: "server" };
    }
    return { ok: true, data: parsed };
  } catch (error: unknown) {
    const kind: AdminDataErrorKind =
      error instanceof ApiError && (error.status === 401 || error.status === 403)
        ? "forbidden"
        : "server";
    return { ok: false, kind };
  }
}

/** GET /api/v1/admin/exams/statistics — สถิติผลสอบ (staff:exam, staff:viewer, super_admin) */
export async function getExamStatisticsData(): Promise<AdminResult<readonly ExamStatisticsRow[]>> {
  const headerBag = await headers();
  try {
    const result = await fetchJson(
      `/api/v1/admin/exams/statistics?limit=${String(EXAM_STATISTICS_LIMIT)}`,
      { method: "GET" },
      {
        origin: getConfig().publicBaseUrl,
        cookieHeader: headerBag.get("cookie") ?? "",
      },
    );
    const parsed = parseExamStatistics(result.body);
    if (parsed === null) {
      return { ok: false, kind: "server" };
    }
    return { ok: true, data: parsed };
  } catch (error: unknown) {
    const kind: AdminDataErrorKind =
      error instanceof ApiError && (error.status === 401 || error.status === 403)
        ? "forbidden"
        : "server";
    return { ok: false, kind };
  }
}

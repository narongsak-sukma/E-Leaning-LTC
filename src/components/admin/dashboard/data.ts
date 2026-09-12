/**
 * dashboard/data — ชั้นข้อมูลหน้า /admin/dashboard (Wave E Phase 5 · lane F · ADM-001)
 *
 * - เรียก GET /api/v1/admin/dashboard?from&to (API-SPECIFICATION §38 แถว 235 ·
 *   RPC admin_dashboard_stats(p_from, p_to) — D-p5-9) ผ่าน transport กลาง (PB-19)
 *   แบบ server-side absolute-origin (config.publicBaseUrl — กัน SSRF ตาม gate r2) +
 *   ส่งต่อ cookie ของ request เดิม + cache no-store
 * - KPI "แสดงตามสิทธิ์บทบาทที่ถือ" (spec แถว 235) — ทุกค่า number | null
 *   (null = บทบาทนี้ไม่เห็นค่านี้/ยังไม่มีข้อมูล → หน้าแสดง "—" ไม่ตัดสินแทน)
 * - contract ผิดรูป / BFF ล่ม / 5xx → { ok: false, kind: "server" } · 401/403 →
 *   { ok: false, kind: "forbidden" } (fail-closed ตามแบบแผน fixtures/admin.ts)
 */
import "server-only";
import { headers } from "next/headers";
import { ApiError, fetchJson } from "@/lib/api/transport";
import { getConfig } from "@/lib/config";
import type { AdminDataErrorKind, AdminResult } from "@/lib/fixtures/admin";

/** รูปแบบวันที่ของพารามิเตอร์ from/to — YYYY-MM-DD (ค่าจาก input type=date) */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** จำนวนวันย้อนหลังเริ่มต้นของแดชบอร์ด (โจทย์ lane F — default 30 วัน) */
export const DASHBOARD_DEFAULT_DAYS = 30;

/** KPI ของแดชบอร์ด — null = บทบาทนี้ไม่เห็นค่านี้ (แสดง "—") หรือยังไม่มีข้อมูล */
export type DashboardStats = {
  usersNew: number | null;
  usersTotal: number | null;
  enrollmentsNew: number | null;
  examAttempts: number | null;
  examPassed: number | null;
  examPassRatePct: number | null;
  certificatesIssued: number | null;
  creditsIssued: number | null;
};

/** ช่วงวันที่ของหน้า — ค่ารูปแบบ YYYY-MM-DD (URL = state จริง) */
export type DashboardRange = { from: string; to: string };

/** pure — ค่าเป็นวันที่ YYYY-MM-DD จริงหรือไม่ (กัน ?from= ที่ผิดรูปจาก URL) */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || DATE_PATTERN.test(value) === false) {
    return false;
  }
  // Date.parse ปล่อย 2026-02-30 ผ่าน (rollover) — ตรวจ round-trip ให้วัน/เดือนตรงจริง
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
    parsed.getUTCMonth() === Number(value.slice(5, 7)) - 1 &&
    parsed.getUTCDate() === Number(value.slice(8, 10))
  );
}

/** pure — วันที่ YYYY-MM-DD ของ instant ตามเขตเวลาไทย (Asia/Bangkok — I18N-003) */
export function isoDateInBangkok(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** pure — ค่าเริ่มต้นของช่วงวันที่ = 30 วันล่าสุด (from = to − 29 วัน) */
export function defaultDashboardRange(now: Date): DashboardRange {
  const to = isoDateInBangkok(now);
  const fromDate = new Date(now.getTime() - (DASHBOARD_DEFAULT_DAYS - 1) * 86400000);
  return { from: isoDateInBangkok(fromDate), to };
}

/** pure — ช่วงวันที่ถูกต้อง (รูปแบบครบ + from ≤ to) — ผิด = หน้าใช้ช่วงเริ่มต้นแทน */
export function dashboardRangeValid(range: DashboardRange): boolean {
  return (
    isIsoDate(range.from) &&
    isIsoDate(range.to) &&
    Date.parse(`${range.from}T00:00:00Z`) <= Date.parse(`${range.to}T00:00:00Z`)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * อ่านค่า KPI ที่อนุญาตทศนิยม — number | null (type อื่น → undefined) · passRatePct
 * ของ RPC เป็น numeric (เช่น 66.67) ไม่ใช่จำนวนเต็ม — ตรวจแบบ integer จะทิ้ง
 * ทุกค่าจริงที่มีเศษ = drift ปลอม (credits.issued = ผลรวม numeric เช่นกัน)
 */
function nullableNumber(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** อ่าน KPI จำนวนเต็มบังคับ (ตัวนับ) — ผิด type → undefined */
function requiredCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * แตก { data: { …kpi } } ออกจาก envelope §1.1 — ผิดรูป = null (fail-closed)
 *
 * รูปร่างบน wire = jsonb ซ้อนของ RPC admin_dashboard_stats (API-SPEC 1.2.1: "jsonb
 * camelCase ตรง resource ขาออก" — DashboardStatsRpcSchema ของ src/lib/admin/users.ts):
 * { data: { range, users:{new,total}, enrollments:{new}, exams:{attempts,passed,
 * passRatePct}, certificates:{issued}, credits:{issued} } } · เดิม parser คาด flat
 * 8 คีย์ (usersNew ฯลฯ) ที่ BFF ไม่เคยส่ง → parse คืน null ทุกครั้ง = แผง "ระบบล่ม"
 * แม้ BFF ตอบ 200 (e2e-16 t5 จับ) — แก้โดย map จาก jsonb ซ้อนเป็น view model flat
 * ของการ์ด KPI ฝั่งหน้า
 */
export function parseDashboardStats(body: unknown): DashboardStats | null {
  if (!isRecord(body)) {
    return null;
  }
  const data = body["data"];
  if (!isRecord(data)) {
    return null;
  }
  const users = isRecord(data["users"]) ? data["users"] : null;
  const enrollments = isRecord(data["enrollments"]) ? data["enrollments"] : null;
  const exams = isRecord(data["exams"]) ? data["exams"] : null;
  const certificates = isRecord(data["certificates"]) ? data["certificates"] : null;
  const credits = isRecord(data["credits"]) ? data["credits"] : null;
  if (
    users === null ||
    enrollments === null ||
    exams === null ||
    certificates === null ||
    credits === null
  ) {
    return null;
  }
  const usersNew = requiredCount(users, "new");
  const usersTotal = requiredCount(users, "total");
  const enrollmentsNew = requiredCount(enrollments, "new");
  const examAttempts = requiredCount(exams, "attempts");
  const examPassed = requiredCount(exams, "passed");
  const examPassRatePct = nullableNumber(exams, "passRatePct");
  const certificatesIssued = requiredCount(certificates, "issued");
  const creditsIssued = nullableNumber(credits, "issued");
  if (
    usersNew === undefined ||
    usersTotal === undefined ||
    enrollmentsNew === undefined ||
    examAttempts === undefined ||
    examPassed === undefined ||
    examPassRatePct === undefined ||
    certificatesIssued === undefined ||
    creditsIssued === undefined
  ) {
    return null;
  }
  return {
    usersNew,
    usersTotal,
    enrollmentsNew,
    examAttempts,
    examPassed,
    examPassRatePct,
    certificatesIssued,
    creditsIssued,
  };
}

/** GET /api/v1/admin/dashboard — KPI ตามช่วงวันที่ (§3.8 แถว 235 — บทบาทที่มี report:view) */
export async function getAdminDashboard(
  range: DashboardRange,
): Promise<AdminResult<DashboardStats>> {
  const headerBag = await headers();
  const search = new URLSearchParams({ from: range.from, to: range.to });
  try {
    const result = await fetchJson(
      `/api/v1/admin/dashboard?${search.toString()}`,
      { method: "GET" },
      {
        origin: getConfig().publicBaseUrl,
        cookieHeader: headerBag.get("cookie") ?? "",
      },
    );
    const stats = parseDashboardStats(result.body);
    if (stats === null) {
      return { ok: false, kind: "server" };
    }
    return { ok: true, data: stats };
  } catch (error: unknown) {
    const kind: AdminDataErrorKind =
      error instanceof ApiError && (error.status === 401 || error.status === 403)
        ? "forbidden"
        : "server";
    return { ok: false, kind };
  }
}

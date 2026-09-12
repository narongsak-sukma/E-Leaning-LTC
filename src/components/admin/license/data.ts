/**
 * license/data — ชั้นข้อมูลหน้า /admin/license-applications (Wave E Phase 5 · lane F · ADM-003)
 *
 * - เรียก GET /api/v1/admin/license-applications?status&cursor&limit (API-SPECIFICATION §3.8
 *   แถว 228 — keyset + filter สถานะ · audit PII_ACCESS · staff:registrar/super_admin)
 * - ผู้สมัครเป็น PII — แสดงเท่าที่ contract ระบุ · แถวผิดรูป = fail-closed ทั้งหน้า (แบบแผนเดิม)
 * - 401/403 → "forbidden" · BFF ล่ม/5xx/contract ผิดรูป → "server"
 */
import "server-only";
import { headers } from "next/headers";
import { ApiError, fetchJson } from "@/lib/api/transport";
import { getConfig } from "@/lib/config";
import type { AdminDataErrorKind, AdminResult } from "@/lib/fixtures/admin";

/** สถานะคำขอใบอนุญาต (ตรงตาม RPC admin_decide_license_application — 0035) */
export type LicenseStatus = "pending" | "approved" | "rejected";

/** กันค่า ?status= จาก URL ก่อนส่งไปกรองฝั่ง BFF */
export function isLicenseStatus(value: unknown): value is LicenseStatus {
  return value === "pending" || value === "approved" || value === "rejected";
}

/** ตัวเลือกกรองสถานะของหน้า (ข้อความไทย) — "all" = ไม่ส่งพารามิเตอร์ไป BFF */
export const LICENSE_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "ทั้งหมด" },
  { value: "pending", label: "รอตรวจ" },
  { value: "approved", label: "อนุมัติแล้ว" },
  { value: "rejected", label: "ปฏิเสธแล้ว" },
] as const;

/** ขนาดหน้า — default ของ PageQuery (API-SPECIFICATION §4 #12) */
export const LICENSE_PAGE_SIZE = 20;

/** แถวคำขอจาก GET /admin/license-applications (camelCase ตาม convention ของ repo) */
export type AdminLicenseApplicationRow = {
  id: string;
  /** ผู้ขอ — PII ที่ BFF ส่งมาเพื่อให้ registrar ตรวจ */
  displayName: string;
  email: string | null;
  /** เลขที่ใบอนุญาตที่เสนอ (license_no) */
  licenseNo: string;
  status: string;
  submittedAt: string;
  decidedAt: string | null;
  /** เหตุผลการตัดสิน (บังคับตอน reject) — null เมื่อยัง pending/approve ไม่ระบุ */
  reason: string | null;
  /** ลิงก์หลักฐาน (signed URL จาก BFF — bucket license-evidence ส่วนตัว) — null = ไม่มี */
  evidenceUrl: string | null;
};

/** ผลหน้า keyset — รูปร่างเดียวกับ AdminUsersPage */
export type AdminLicenseApplicationsPage = {
  data: readonly AdminLicenseApplicationRow[];
  page: { nextCursor: string | null; hasMore: boolean };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** อ่าน string ที่อนุญาต null — type อื่น = undefined (contract ผิดรูป) */
function nullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** pure — แถวคำขอผ่าน contract → view · ผิดรูป → null (fail-closed) */
export function parseAdminLicenseApplicationRow(raw: unknown): AdminLicenseApplicationRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredString(raw, "id");
  const displayName = requiredString(raw, "displayName");
  const licenseNo = requiredString(raw, "licenseNo");
  const statusValue = raw["status"];
  const status = isLicenseStatus(statusValue) ? statusValue : null;
  const submittedAt = requiredString(raw, "submittedAt");
  const email = nullableString(raw, "email");
  const decidedAt = nullableString(raw, "decidedAt");
  const reason = nullableString(raw, "reason");
  const evidenceUrl = nullableString(raw, "evidenceUrl");
  if (
    id === null ||
    displayName === null ||
    licenseNo === null ||
    status === null ||
    submittedAt === null ||
    email === undefined ||
    decidedAt === undefined ||
    reason === undefined ||
    evidenceUrl === undefined
  ) {
    return null;
  }
  return {
    id,
    displayName,
    licenseNo,
    status,
    submittedAt,
    email,
    decidedAt,
    reason,
    evidenceUrl,
  };
}

/** แตก { data: [...], page: { nextCursor, hasMore } } — ผิดรูป = null (fail-closed) */
export function parseAdminLicenseApplicationsPage(body: unknown): AdminLicenseApplicationsPage | null {
  if (!isRecord(body)) {
    return null;
  }
  const items = body["data"];
  const rawPage = body["page"];
  if (!Array.isArray(items) || !isRecord(rawPage)) {
    return null;
  }
  const data: AdminLicenseApplicationRow[] = [];
  for (const item of items) {
    const row = parseAdminLicenseApplicationRow(item);
    if (row === null) {
      return null;
    }
    data.push(row);
  }
  const nextCursor = nullableString(rawPage, "nextCursor");
  const hasMore = rawPage["hasMore"];
  if (nextCursor === undefined || typeof hasMore !== "boolean") {
    return null;
  }
  return {
    data,
    page: { nextCursor, hasMore },
  };
}

/** GET /api/v1/admin/license-applications — รายการคำขอ (staff:registrar, super_admin) */
export async function getAdminLicenseApplications(query: {
  status?: LicenseStatus | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<AdminResult<AdminLicenseApplicationsPage>> {
  const parameters: Record<string, string> = {};
  if (query.status !== undefined) {
    parameters["status"] = query.status;
  }
  if (query.cursor !== undefined && query.cursor.length > 0) {
    parameters["cursor"] = query.cursor;
  }
  parameters["limit"] = String(query.limit ?? LICENSE_PAGE_SIZE);
  const search = new URLSearchParams(parameters);
  const headerBag = await headers();
  try {
    const result = await fetchJson(
      `/api/v1/admin/license-applications?${search.toString()}`,
      { method: "GET" },
      {
        origin: getConfig().publicBaseUrl,
        cookieHeader: headerBag.get("cookie") ?? "",
      },
    );
    const parsed = parseAdminLicenseApplicationsPage(result.body);
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

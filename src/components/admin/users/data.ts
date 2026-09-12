/**
 * users/data — ชั้นข้อมูลหน้า /admin/users (Wave E Phase 5 · lane F · ADM-002)
 *
 * - เรียก GET /api/v1/admin/users?q&status&cursor&limit (API-SPECIFICATION §3.8 แถว 210 ·
 *   keyset ผ่าน RPC admin_list_users — D-p5-6) ผ่าน transport กลาง (PB-19) แบบ server-side
 *   absolute-origin + ส่งต่อ cookie ของ request เดิม + cache no-store
 * - ข้อมูลผู้ใช้ = PII — BFF เขียน audit PII_ACCESS (fail-closed) อยู่แล้ว · หน้าแสดงเท่าที่
 *   contract ระบุ และแถวผิดรูปจะไม่ถูกแสดง (fail-closed ทั้งหน้า)
 * - 401/403 → "forbidden" · BFF ล่ม/5xx/contract ผิดรูป → "server" (fail-closed แบบแผนเดิม)
 */
import "server-only";
import { headers } from "next/headers";
import { ApiError, fetchJson } from "@/lib/api/transport";
import { getConfig } from "@/lib/config";
import type { AdminDataErrorKind, AdminResult } from "@/lib/fixtures/admin";

/** สถานะบัญชีที่หน้ากรองได้ — mirror ฝั่ง BFF (ban/unban ของ GoTrue คือตัวบังคับจริง) */
export type UserStatus = "active" | "disabled";

/** กันค่า ?status= จาก URL ที่ไม่อยู่ใน enum ก่อนส่งไปกรองฝั่ง BFF */
export function isUserStatus(value: unknown): value is UserStatus {
  return value === "active" || value === "disabled";
}

/** ตัวเลือกกรองสถานะของหน้า (ข้อความไทย) — "all" = ไม่ส่งพารามิเตอร์ไป BFF */
export const USER_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "ทั้งหมด" },
  { value: "active", label: "ใช้งาน" },
  { value: "disabled", label: "ปิดใช้งาน" },
] as const;

/** ขนาดหน้าของรายการผู้ใช้ — default ของ PageQuery (API-SPECIFICATION §4 #12) */
export const ADMIN_USERS_PAGE_SIZE = 20;

/** แถวผู้ใช้จาก GET /admin/users (camelCase ตาม convention resource ของ repo) */
export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string;
  /** สถานะบัญชีตามที่ BFF ส่ง — แสดงตามทะเบียน USER_STATUS_LABEL ค่าแปลกปลอมแสดงเป็นกลาง */
  status: string;
  /** บทบาททั้งหมดที่ถือ (ค่าแปลกปลอมกรองทิ้งตอนแสดง — ตัดสินจริงอยู่ที่ BFF/DB เสมอ) */
  roles: readonly string[];
  createdAt: string;
  /** เหตุผลการปิดใช้งานล่าสุด — null/ขาด = ไม่มี (แสดงเมื่อมี เพื่อให้เจ้าหน้าที่เห็นบริบท) */
  disabledReason: string | null;
};

/** ผลหน้าของ keyset pagination — รูปร่างเดียวกับ AdminCoursesPage */
export type AdminUsersPage = {
  data: readonly AdminUserRow[];
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

/** pure — แถวผู้ใช้ผ่าน contract → view · ผิดรูป → null (fail-closed) */
export function parseAdminUserRow(raw: unknown): AdminUserRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredString(raw, "id");
  const email = requiredString(raw, "email");
  const displayName = requiredString(raw, "displayName");
  const status = requiredString(raw, "status");
  const createdAt = requiredString(raw, "createdAt");
  const rolesRaw = raw["roles"];
  const roles =
    rolesRaw === undefined
      ? []
      : Array.isArray(rolesRaw)
        ? rolesRaw.filter((role): role is string => typeof role === "string")
        : undefined;
  const disabledReason = nullableString(raw, "disabledReason");
  if (
    id === null ||
    email === null ||
    displayName === null ||
    status === null ||
    createdAt === null ||
    roles === undefined ||
    disabledReason === undefined
  ) {
    return null;
  }
  return {
    id,
    email,
    displayName,
    status,
    roles,
    createdAt,
    disabledReason,
  };
}

/** แตก { data: [...], page: { nextCursor, hasMore } } — ผิดรูป = null (fail-closed) */
export function parseAdminUsersPage(body: unknown): AdminUsersPage | null {
  if (!isRecord(body)) {
    return null;
  }
  const items = body["data"];
  const rawPage = body["page"];
  if (!Array.isArray(items) || !isRecord(rawPage)) {
    return null;
  }
  const data: AdminUserRow[] = [];
  for (const item of items) {
    const row = parseAdminUserRow(item);
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

/** GET /api/v1/admin/users — ค้นหา/กรองผู้ใช้ (staff:viewer/registrar, super_admin) */
export async function getAdminUsers(query: {
  q?: string | undefined;
  status?: UserStatus | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<AdminResult<AdminUsersPage>> {
  const parameters: Record<string, string> = {};
  if (query.q !== undefined && query.q.length > 0) {
    parameters["q"] = query.q;
  }
  if (query.status !== undefined) {
    parameters["status"] = query.status;
  }
  if (query.cursor !== undefined && query.cursor.length > 0) {
    parameters["cursor"] = query.cursor;
  }
  parameters["limit"] = String(query.limit ?? ADMIN_USERS_PAGE_SIZE);
  const search = new URLSearchParams(parameters);
  const headerBag = await headers();
  try {
    const result = await fetchJson(
      `/api/v1/admin/users?${search.toString()}`,
      { method: "GET" },
      {
        origin: getConfig().publicBaseUrl,
        cookieHeader: headerBag.get("cookie") ?? "",
      },
    );
    const parsed = parseAdminUsersPage(result.body);
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

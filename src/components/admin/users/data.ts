/**
 * users/data — ชั้นข้อมูลหน้า /admin/users (Wave E Phase 5 · lane F · ADM-002)
 *
 * - เรียก GET /api/v1/admin/users?query&status&cursor&limit (API-SPECIFICATION §3.8 แถว 210 ·
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

/** สถานะบัญชีที่หน้ากรองได้ — mirror enum ของ BFF (active/deleted ตาม p_status ของ RPC) */
export type UserStatus = "active" | "deleted";

/** กันค่า ?status= จาก URL ที่ไม่อยู่ใน enum ก่อนส่งไปกรองฝั่ง BFF */
export function isUserStatus(value: unknown): value is UserStatus {
  return value === "active" || value === "deleted";
}

/** ตัวเลือกกรองสถานะของหน้า (ข้อความไทย) — "all" = ไม่ส่งพารามิเตอร์ไป BFF */
export const USER_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "ทั้งหมด" },
  { value: "active", label: "ใช้งาน" },
  { value: "deleted", label: "ถูกลบแล้ว" },
] as const;

/** ขนาดหน้าของรายการผู้ใช้ — default ของ PageQuery (API-SPECIFICATION §4 #12) */
export const ADMIN_USERS_PAGE_SIZE = 20;

/** แถวผู้ใช้จาก GET /admin/users (camelCase · ตรง AdminUserResource ของ route — strict) */
export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string;
  /** บทบาททั้งหมดที่ถือ (ค่าแปลกปลอมกรองทิ้งตอนแสดง — ตัดสินจริงอยู่ที่ BFF/DB เสมอ) */
  roles: readonly string[];
  /** วันที่ถูกลบ (soft-delete) — null = ยังใช้งาน */
  deletedAt: string | null;
  createdAt: string;
  /** มีใบอนุญาตที่ verified หรือไม่ (จาก GoTrue ผ่าน RPC — 0041) */
  hasVerifiedLicense: boolean;
  /** 0041 (Wave F · D-f-5): แบน GoTrue ยังไม่หมดอายุ (is_banned ของ RPC) */
  isBanned: boolean;
  /**
   * 0041: ค่า banned_until จริงจาก auth.users — null ได้ · **ค่าในอดีต = แบนหมด
   * อายุแล้ว** (isBanned=false) — UI ตีความ "ยังถูกระงับ" จาก isBanned เท่านั้น
   */
  bannedUntil: string | null;
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
  const createdAt = requiredString(raw, "createdAt");
  const deletedAt = nullableString(raw, "deletedAt");
  const bannedUntil = nullableString(raw, "bannedUntil");
  const isBanned = raw["isBanned"];
  const rolesRaw = raw["roles"];
  const roles =
    rolesRaw === undefined
      ? []
      : Array.isArray(rolesRaw)
        ? rolesRaw.filter((role): role is string => typeof role === "string")
        : undefined;
  const hasVerifiedLicense = raw["hasVerifiedLicense"];
  if (
    id === null ||
    email === null ||
    displayName === null ||
    createdAt === null ||
    deletedAt === undefined ||
    bannedUntil === undefined ||
    typeof isBanned !== "boolean" ||
    roles === undefined ||
    typeof hasVerifiedLicense !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    email,
    displayName,
    roles,
    deletedAt,
    createdAt,
    hasVerifiedLicense,
    isBanned,
    bannedUntil,
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
    // wire key ของ route คือ `query` (strict zod — คีย์อื่นถูกปฏิเสธ 400)
    parameters["query"] = query.q;
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

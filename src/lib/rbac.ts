/**
 * rbac — shared kernel ตรวจสิทธิ์ (SDS §2.1, RBAC-DESIGN)
 *
 * หลักการ RBAC §1.2-4: ตรวจที่ระดับ permission ไม่ใช่ชื่อบทบาท —
 * โค้ดเรียก requirePermission("certificate:issue") เท่านั้น ห้าม requireRole(...)
 *
 * **สถานะ: ใช้งานจริง (Wave C — C-1)** — requirePermission ตรวจ session ผ่าน Supabase Auth
 * (ไม่มี session → ERR-AUTH-001) แล้วโหลดบทบาทจาก RPC `my_roles()` ผ่าน user-JWT Supabase client
 * (helper canonical ชุดเดียวกับ RLS policy — RBAC §3.1) และตรวจกับ permission matrix
 * ของ RBAC-DESIGN §2 ที่ประกาศไว้ในไฟล์นี้ (ยืนยันตรง doc ด้วย unit test — D25/O-5)
 *
 * ข้อจำกัดที่ยอมรับ: module นี้ import Supabase แบบ lazy (dynamic import ในฟังก์ชัน)
 * เพื่อให้ส่วน pure (PERMISSIONS/ROLE_PERMISSIONS/hasPermission) ไม่ดึง server-only module
 * — การเชื่อม DB เกิดเฉพาะเมื่อเรียก loadMyRolesFromDb()/loadSessionFromSupabase() ฝั่ง server เท่านั้น
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "./errors";

export const PERMISSIONS = [
  "course:view",
  "course:create",
  "course:update",
  "course:delete",
  "course:publish",
  "lesson:view",
  "lesson:update",
  "enroll:create",
  "question_bank:view",
  "question_bank:create",
  "question_bank:update",
  "question_bank:delete",
  "assessment:view",
  "assessment:create",
  "assessment:update",
  "assessment:approve",
  "attempt:start",
  "attempt:view",
  "attempt:grade_override",
  "certificate:verify",
  "certificate:view",
  "certificate:issue",
  "certificate:revoke",
  "credit_rule:view",
  "credit_rule:create",
  "credit_rule:update",
  "credit_ledger:view",
  "credit_adjustment:create",
  "user:view",
  "user:create",
  "user:update",
  "user:disable",
  "license:verify",
  "role:grant",
  "role:revoke",
  "audit_log:view",
  "audit_log:export",
  "report:view",
  "report:export",
  "notification:view",
  "notification:send",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * บทบาท (RBAC §1.1 / BRIEF §4) — guest ไม่อยู่ในนี้ (ไม่มีบทบาท = guest)
 * ขอบเขตเชิงทรัพยากร (เช่น role:grant ของ staff:registrar ใช้ได้เฉพาะ lawyer,
 * instructor ทำได้เฉพาะของตัวเอง) บังคับซ้ำที่ handler/RLS — Wave C
 */
export const ROLES = [
  "citizen",
  "lawyer",
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
  "super_admin",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * permission matrix สรุปจาก RBAC-DESIGN §2 (baseline 1.0.0)
 * หมายเหตุ: แถวใน matrix ที่ต่างกันด้วยขอบเขต (ตัวเอง/owner/ทุกคน) ใช้ string เดียวกัน —
 * ขอบเขตบังคับที่ handler/RLS; Wave C จะตรวจซ้ำกับ matrix ตอนเชื่อมจริง
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  citizen: [
    "course:view",
    "lesson:view",
    "enroll:create",
    "assessment:view",
    "attempt:start",
    "attempt:view",
    "certificate:verify",
    "certificate:view",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  lawyer: [
    "course:view",
    "lesson:view",
    "enroll:create",
    "assessment:view",
    "attempt:start",
    "attempt:view",
    "certificate:verify",
    "certificate:view",
    "credit_ledger:view",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  instructor: [
    "course:view",
    "course:create",
    "course:update",
    "lesson:view",
    "lesson:update",
    "enroll:create",
    "question_bank:view",
    "question_bank:create",
    "question_bank:update",
    "assessment:view",
    "assessment:create",
    "assessment:update",
    "attempt:start",
    "attempt:view",
    "certificate:verify",
    "certificate:view",
    "credit_ledger:view",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  "staff:viewer": [
    "course:view",
    "lesson:view",
    "question_bank:view",
    "assessment:view",
    "attempt:view",
    "certificate:verify",
    "credit_rule:view",
    "credit_ledger:view",
    "user:view",
    "audit_log:view",
    "report:view",
    "report:export",
    "notification:view",
  ],
  "staff:content": [
    "course:view",
    "course:create",
    "course:update",
    "course:delete",
    "course:publish",
    "lesson:view",
    "lesson:update",
    "certificate:verify",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  "staff:exam": [
    "course:view",
    "lesson:view",
    "question_bank:view",
    "question_bank:create",
    "question_bank:update",
    "question_bank:delete",
    "assessment:view",
    "assessment:create",
    "assessment:update",
    "assessment:approve",
    "attempt:view",
    "attempt:grade_override",
    "certificate:verify",
    "user:view",
    "audit_log:view",
    "report:view",
    "report:export",
    "notification:view",
  ],
  "staff:registrar": [
    "course:view",
    "lesson:view",
    "assessment:view",
    "certificate:verify",
    "certificate:issue",
    "certificate:revoke",
    "credit_rule:view",
    "credit_rule:create",
    "credit_rule:update",
    "credit_ledger:view",
    "credit_adjustment:create",
    "user:view",
    "user:update",
    "license:verify",
    "role:grant",
    "role:revoke",
    "report:view",
    "report:export",
    "notification:view",
    "notification:send",
  ],
  super_admin: [
    "course:view",
    "course:create",
    "course:update",
    "course:delete",
    "course:publish",
    "lesson:view",
    "lesson:update",
    "enroll:create",
    "question_bank:view",
    "question_bank:create",
    "question_bank:update",
    "question_bank:delete",
    "assessment:view",
    "assessment:create",
    "assessment:update",
    "assessment:approve",
    "attempt:start",
    "attempt:view",
    "attempt:grade_override",
    "certificate:verify",
    "certificate:view",
    "certificate:issue",
    "certificate:revoke",
    "credit_rule:view",
    "credit_rule:create",
    "credit_rule:update",
    "credit_ledger:view",
    "credit_adjustment:create",
    "user:view",
    "user:create",
    "user:update",
    "user:disable",
    "license:verify",
    "role:grant",
    "role:revoke",
    "audit_log:view",
    "audit_log:export",
    "report:view",
    "report:export",
    "notification:view",
    "notification:send",
  ],
};

export type MyRolesFetcher = () => Promise<readonly string[]>;

/** ผู้ใช้ที่ผ่านการตรวจ session แล้ว (ข้อมูลเท่าที่ RBAC ต้องใช้ — ไม่มี PII) */
export interface SessionUser {
  readonly userId: string;
}

export type SessionFetcher = () => Promise<SessionUser | null>;

export interface RequirePermissionOptions {
  /**
   * inject บทบาทของผู้ใช้ (สำหรับ unit test) — default จะเรียก `my_roles()` RPC
   * ผ่าน Supabase user client (ดู loadMyRolesFromDb)
   */
  loadMyRoles?: MyRolesFetcher;
  /**
   * inject การตรวจ session (สำหรับ unit test / ให้ชั้น session ของ C-0 แทน default ได้ภายหลัง)
   * — default ตรวจกับ Supabase Auth ผ่าน user client (ดู loadSessionFromSupabase)
   */
  loadSession?: SessionFetcher;
}

export interface RequirePermissionResult {
  readonly allowed: true;
  readonly userId: string;
  readonly roles: readonly string[];
}

/**
 * ตรวจสิทธิ์ระดับ permission (RBAC §1.2-4) — deny = throw AppError("ERR-RBAC-001") → 403
 *
 * ลำดับ: ไม่มี session → ERR-AUTH-001 (401) · มี session แต่ไม่มี permission → ERR-RBAC-001 (403)
 * ขอบเขตเชิงทรัพยากร (owner) บังคับซ้ำที่ handler/RLS (RBAC §1.2-5) — ไม่ใช่หน้าที่ของฟังก์ชันนี้
 */
export async function requirePermission(
  permission: Permission,
  options: RequirePermissionOptions = {},
): Promise<RequirePermissionResult> {
  const loadSession = options.loadSession ?? loadSessionFromSupabase;
  const session = await loadSession();
  if (!session) {
    throw new AppError("ERR-AUTH-001");
  }
  const loadMyRoles = options.loadMyRoles ?? loadMyRolesFromDb;
  const roles = await loadMyRoles();
  if (!hasPermission(roles, permission)) {
    throw new AppError("ERR-RBAC-001", { details: { permission } });
  }
  return { allowed: true, userId: session.userId, roles };
}

/** ตรวจว่าชุดบทบาทครอบ permission (union ของทุกบทบาท — RBAC §1.1-3) */
export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  return roles.some((role) => roleHasPermission(role, permission));
}

function roleHasPermission(role: string, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role as Role];
  return granted?.includes(permission) ?? false;
}

/** สร้าง user-JWT Supabase client — import แบบ lazy เพื่อไม่ให้ส่วน pure ของ module ดึง server-only module */
async function createAuthedClient(): Promise<SupabaseClient> {
  const { createSupabaseSsrClient } = await import("./supabase/ssr");
  return createSupabaseSsrClient();
}

/**
 * ตรวจ session จริงกับ Supabase Auth (SDS §5.5 — server-checked ทุก request)
 * ไม่มี session / token หมดอายุ/ใช้ไม่ได้ → คืน null (ผู้เรียก throw ERR-AUTH-001)
 */
export async function loadSessionFromSupabase(): Promise<SessionUser | null> {
  const supabase = await createAuthedClient();
  const { data } = await supabase.auth.getUser();
  return data.user ? { userId: data.user.id } : null;
}

/**
 * เรียก RPC `my_roles()` ผ่าน user-JWT Supabase client (RBAC §3.1 — helper canonical ชุดเดียวกับ RLS)
 * RPC error / ข้อมูลผิด contract → ERR-SYS-002 (503 — ข้อความจากทะเบียน, ไม่ leak รายละเอียด DB)
 */
export async function loadMyRolesFromDb(): Promise<readonly string[]> {
  const supabase = await createAuthedClient();
  const { data, error } = await supabase.rpc("my_roles");
  if (error) {
    throw new AppError("ERR-SYS-002", { details: { reason: "rpc_my_roles_failed" } });
  }
  if (
    !Array.isArray(data) ||
    !data.every((role): role is string => typeof role === "string")
  ) {
    throw new AppError("ERR-SYS-002", { details: { reason: "rpc_my_roles_bad_contract" } });
  }
  return data;
}

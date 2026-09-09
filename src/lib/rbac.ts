/**
 * rbac — shared kernel ตรวจสิทธิ์ (SDS §2.1, RBAC-DESIGN)
 *
 * หลักการ RBAC §1.2-4: ตรวจที่ระดับ permission ไม่ใช่ชื่อบทบาท —
 * โค้ดเรียก requirePermission("certificate:issue") เท่านั้น ห้าม requireRole(...)
 *
 * **สถานะ: โครง (stub) — Wave C งานต่อ**: ยังไม่เชื่อม DB จริง (ต้องรอ migration/seed จาก worker-b2)
 * requirePermission อ่านบทบาทผ่าน `my_roles()` RPC (helper canonical ชุดเดียวกับ RLS policy — RBAC §3.1)
 * และตรวจกับ permission matrix ของ RBAC-DESIGN §2 ที่ประกาศไว้ในไฟล์นี้
 */
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

export interface RequirePermissionOptions {
  /**
   * inject บทบาทของผู้ใช้ (สำหรับ unit test) — default จะเรียก `my_roles()` RPC
   * ผ่าน Supabase user client ซึ่งยังไม่เชื่อมจริงจนกว่า Wave C (ดู loadMyRolesFromDb)
   */
  loadMyRoles?: MyRolesFetcher;
}

export interface RequirePermissionResult {
  readonly allowed: true;
  readonly roles: readonly string[];
}

/**
 * ตรวจสิทธิ์ระดับ permission (RBAC §1.2-4) — deny = throw AppError("ERR-RBAC-001") → 403
 *
 * **Wave C**: เชื่อม session → my_roles() จริง + บังคับขอบเขต owner (ทำใน handler/RLS คู่กัน)
 */
export async function requirePermission(
  permission: Permission,
  options: RequirePermissionOptions = {},
): Promise<RequirePermissionResult> {
  const loadMyRoles = options.loadMyRoles ?? loadMyRolesFromDb;
  const roles = await loadMyRoles();
  if (hasPermission(roles, permission)) {
    return { allowed: true, roles };
  }
  throw new AppError("ERR-RBAC-001", { details: { permission } });
}

/** ตรวจว่าชุดบทบาทครอบ permission (union ของทุกบทบาท — RBAC §1.1-3) */
export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  return roles.some((role) => roleHasPermission(role, permission));
}

function roleHasPermission(role: string, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role as Role];
  return granted?.includes(permission) ?? false;
}

/**
 * โครงการเชื่อมฐานข้อมูล (Wave C): เรียก `my_roles()` RPC ผ่าน Supabase user client
 * ตอนนี้ปฏิเสธการทำงานแบบชัดเจน — ยังไม่มี migration/session wiring ให้ใช้
 */
async function loadMyRolesFromDb(): Promise<readonly string[]> {
  throw new AppError("ERR-SYS-002", {
    message: "ระบบตรวจสิทธิ์ยังไม่เชื่อมฐานข้อมูล — งานต่อใน Wave C (my_roles() RPC)",
  });
}

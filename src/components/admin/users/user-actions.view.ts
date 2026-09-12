/**
 * user-actions.view — pure helpers ของหน้า /admin/users (Wave E Phase 5 · lane F · ADM-002)
 *
 * แยกออกจาก UserActions.tsx ("use client") เพราะหน้า server /admin/users เรียกใช้
 * helper เหล่านี้ตอน SSR (ป้ายบทบาท/สถานะ/สิทธิ์ของผู้เรียก) — Next.js ห้ามเรียก
 * ฟังก์ชันจากโมดูล client ฝั่ง server ("Attempted to call … from the server but …
 * is on the client" → หน้าล่มทุกคำขอแม้ BFF จะ 200 — e2e-16 t2 จับไว้) โมดูลนี้ไม่มี
 * directive จึง import ได้ทั้ง server component และ client component (แบบแผน
 * license-status.ts ของ lane เดียวกัน)
 */

/** ความยาวขั้นต่ำของเหตุผล (mirror zod ของ BFF — แบบแผน revoke/D-p5-6) */
export const REASON_MIN_LENGTH = 10;

/** pure — เหตุผลผ่านเงื่อนไข — trim แล้วยาว ≥10 (mirror BFF) */
export function reasonValid(reason: string): boolean {
  return reason.trim().length >= REASON_MIN_LENGTH;
}

/**
 * มุมมองสถานะบัญชีสำหรับ badge (ทะเบียนไทย + โทนตาม StatusBadge) — คีย์ตรงสิ่งที่
 * แถว GET /admin/users บอกได้จริง: active/deleted (soft-delete) · สถานะ ban ของ GoTrue
 * ไม่อยู่ในขาออกของ RPC (Wave F จะเพิ่ม) — หน้าจึงไม่แสดงสถานะ "ปิดใช้งาน" ในตาราง
 */
export const USER_STATUS_VIEW: Record<string, { label: string; tone: "success" | "danger" | "neutral" }> = {
  active: { label: "ใช้งาน", tone: "success" },
  deleted: { label: "ถูกลบแล้ว", tone: "danger" },
};

/** pure — สถานะที่ไม่รู้จักแสดงเป็นกลาง ไม่ตัดสินแทน (ค่าจริงมาจาก BFF) */
export function userStatusViewOf(status: string): { label: string; tone: "success" | "danger" | "neutral" } {
  const known = USER_STATUS_VIEW[status];
  return known ?? { label: status, tone: "neutral" };
}

/** pure — คีย์สถานะของแถวจาก deletedAt (null = active · มีค่า = deleted) */
export function userStatusKeyOf(deletedAt: string | null): "active" | "deleted" {
  return deletedAt === null ? "active" : "deleted";
}

/** ป้ายบทบาทไทย (จากทะเบียน ROLES ของ src/lib/rbac.ts) */
export const ROLE_LABEL_TH: Record<string, string> = {
  citizen: "ประชาชน",
  lawyer: "ทนายความ",
  instructor: "ผู้สอน",
  "staff:viewer": "เจ้าหน้าที่ (ดูข้อมูล)",
  "staff:content": "เจ้าหน้าที่ (เนื้อหา)",
  "staff:exam": "เจ้าหน้าที่ (สอบ)",
  "staff:registrar": "เจ้าหน้าที่ (ทะเบียน)",
  super_admin: "ผู้ดูแลระบบสูงสุด",
};

/** pure — บทบาทที่ไม่อยู่ในทะเบียนแสดงรหัสเดิม (ไม่เดาความหมาย) */
export function roleLabelOf(role: string): string {
  return ROLE_LABEL_TH[role] ?? role;
}

/** ชุดบทบาทที่มอบได้ผ่าน endpoint (super_admin ห้ามผ่าน endpoint — bootstrap เท่านั้น) */
export const GRANTABLE_ROLES = [
  "lawyer",
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
] as const;

/** pure — ตัวเลือกบทบาทต่อผู้เรียก (spec แถว 214: registrar มอบได้เฉพาะ lawyer) */
export function roleOptionsForCaller(roles: readonly string[]): readonly string[] {
  if (roles.includes("super_admin")) {
    return GRANTABLE_ROLES;
  }
  if (roles.includes("staff:registrar")) {
    return ["lawyer"];
  }
  return [];
}

/** pure — มีสิทธิ์ปิด/เปิดใช้งานบัญชี (spec แถว 212) */
export function canDisableUser(roles: readonly string[]): boolean {
  return roles.includes("super_admin") || roles.includes("staff:registrar");
}

/** pure — มีสิทธิ์มอบ/ถอดบทบาท (spec แถว 214-215) */
export function canManageRoles(roles: readonly string[]): boolean {
  return roles.includes("super_admin") || roles.includes("staff:registrar");
}

/** pure — บอดี้ของ PATCH ปิดใช้งาน (API-SPEC 1.2.3 §3.7 แถว 212: {is_active:false, reason}) */
export function buildDisableBody(reason: string): { is_active: false; reason: string } {
  return { is_active: false, reason: reason.trim() };
}

/** pure — บอดี้ของ PATCH เปิดใช้งาน (ไม่มี reason — BFF ไม่เรียกใช้ตอน enable) */
export function buildEnableBody(): { is_active: true } {
  return { is_active: true };
}

/** pure — บอดี้ของ POST มอบบทบาท */
export function buildGrantRoleBody(role: string, reason: string): { role: string; reason: string } {
  return { role, reason: reason.trim() };
}

/** pure — บอดี้ของ DELETE ถอดบทบาท (route บังคับ body {role, reason 10-500}) */
export function buildRevokeRoleBody(role: string, reason: string): { role: string; reason: string } {
  return { role, reason: reason.trim() };
}

/** pure — path ของ DELETE ถอดบทบาท (role/reason อยู่ใน body ตามสัญญา route) */
export function roleRevokePath(userId: string): string {
  return `/api/v1/admin/users/${encodeURIComponent(userId)}/roles`;
}

/** pure — path ของ PATCH/POST ต่อผู้ใช้ (กัน id ว่าง/มีตัวอักษรควบคุม) */
export function userActionPath(userId: string): string {
  return `/api/v1/admin/users/${encodeURIComponent(userId)}`;
}

/** uuid แบบง่าย — กันส่ง id มั่ว ๆ ขึ้น BFF (BFF ยังตรวจซ้ำเสมอ) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pure — id รูปแบบ uuid หรือไม่ */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** ฟอร์มสร้างบัญชีเจ้าหน้าที่ (mirror POST /admin/users — super_admin) */
export type CreateStaffFormState = {
  email: string;
  displayName: string;
  role: string;
  reason: string;
};

/** ค่าเริ่มต้นของฟอร์มสร้างบัญชี */
export const CREATE_STAFF_FORM_DEFAULTS: CreateStaffFormState = {
  email: "",
  displayName: "",
  role: "",
  reason: "",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** pure — ตรวจฟอร์มสร้างบัญชี — คืนข้อความไทยต่อช่อง ({} = ผ่านทั้งหมด) */
export function validateCreateStaffForm(
  form: CreateStaffFormState,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (EMAIL_PATTERN.test(form.email.trim()) === false) {
    errors["email"] = "รูปแบบอีเมลไม่ถูกต้อง";
  }
  const name = form.displayName.trim();
  if (name.length < 1 || name.length > 120) {
    errors["displayName"] = "ชื่อ-นามสกุลต้องยาว 1-120 ตัวอักษร";
  }
  if (form.role.length === 0) {
    errors["role"] = "เลือกบทบาทเริ่มต้นของบัญชี";
  }
  if (reasonValid(form.reason) === false) {
    errors["reason"] = "ระบุเหตุผลให้ยาวอย่างน้อย 10 ตัวอักษร";
  }
  return errors;
}

/** pure — บอดี้ของ POST สร้างบัญชี (camelCase เป๊ะ — reason บังคับตามสัญญา route) */
export function buildCreateStaffBody(form: CreateStaffFormState):
  | { ok: true; body: { email: string; displayName: string; role: string; reason: string } }
  | { ok: false } {
  const errors = validateCreateStaffForm(form);
  if (Object.keys(errors).length > 0) {
    return { ok: false };
  }
  return {
    ok: true,
    body: {
      email: form.email.trim(),
      displayName: form.displayName.trim(),
      role: form.role,
      reason: form.reason.trim(),
    },
  };
}

/** pure — มีสิทธิ์สร้างบัญชีเจ้าหน้าที่ (POST /admin/users — super_admin เท่านั้น · spec แถว 211) */
export function canCreateStaffUser(roles: readonly string[]): boolean {
  return roles.includes("super_admin");
}

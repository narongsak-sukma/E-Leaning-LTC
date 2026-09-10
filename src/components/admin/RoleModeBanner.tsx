import type { Role } from "@/lib/rbac";
import { ADMIN_STAFF_ROLES } from "@/lib/fixtures/admin";

/**
 * แบนเนอร์บทบาทของหน้าจอหลังบ้าน — รับบทบาทจริงจาก session (C-8 Phase 1)
 * - staff:viewer → "โหมดดูอย่างเดียว" ทุกหน้า (RBAC §1.1: ห้ามแก้ข้อมูล)
 * - บทบาทอื่น → แจ้งชื่อบทบาทภาษาไทย (ไม่มีข้อความ "fixture" อีกต่อไป)
 */

/** ชื่อบทบาทภาษาไทย — ครอบทุกบทบาทในทะเบียน RBAC (src/lib/rbac.ts) */
export const ADMIN_ROLE_LABEL_TH: Record<Role, string> = {
  citizen: "สมาชิกทั่วไป",
  lawyer: "ทนายความ",
  instructor: "ผู้สอน",
  "staff:viewer": "เจ้าหน้าที่ฝ่ายรายงาน",
  "staff:content": "เจ้าหน้าที่ดูแลเนื้อหา",
  "staff:exam": "เจ้าหน้าที่สอบและประเมิน",
  "staff:registrar": "เจ้าหน้าที่ทะเบียนและใบอนุญาต",
  super_admin: "ผู้ดูแลระบบสูงสุด",
};

/** บทบาทหลักที่ใช้แสดงผล — เลือกบทบาทหลังบ้านตัวแรกตามลำดับ ADMIN_STAFF_ROLES */
export function adminPrimaryRole(roles: readonly Role[]): Role {
  const staffRole = roles.find((role) => ADMIN_STAFF_ROLES.includes(role));
  return staffRole ?? roles[0] ?? "citizen";
}

/** บทบาทที่มีสิทธิ์เขียน (เผยแพร่/จัดการหมวด) — RBAC §2.1 + API-SPECIFICATION §3.8 */
export function adminCanWrite(role: Role): boolean {
  return role === "staff:content" || role === "super_admin";
}

export function RoleModeBanner({ role }: { role: Role }) {
  if (role === "staff:viewer") {
    return (
      <div
        role="note"
        className="mb-4 rounded-[14px] border border-warning-600/30 bg-warning-50 px-4 py-3 text-sm leading-relaxed text-warning-600"
      >
        <strong className="font-heading font-semibold">โหมดดูอย่างเดียว (staff:viewer)</strong>
        {" — "}บัญชีนี้ดูข้อมูลได้อย่างเดียว ไม่มีสิทธิ์เผยแพร่หลักสูตรหรือจัดการหมวดหลักสูตร
        (RBAC §2 · API-SPECIFICATION §3.8)
      </div>
    );
  }
  return (
    <div
      role="note"
      className="mb-4 rounded-[14px] border border-brand-600/30 bg-brand-50 px-4 py-3 text-sm leading-relaxed text-brand-700"
    >
      <strong className="font-heading font-semibold">
        บทบาท: {ADMIN_ROLE_LABEL_TH[role] ?? role} ({role})
      </strong>
      {" — "}การแก้ไขเนื้อหา (authoring CRUD) ยังไม่เปิดใน Wave C — ปุ่มจัดการจะเปิดในเฟสถัดไป
    </div>
  );
}

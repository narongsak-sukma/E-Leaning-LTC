import type { Role } from "@/lib/rbac";

/**
 * แบนเนอร์แสดงบทบาท/โหมดของหน้าจอ — ควบคุมจาก props (Phase 1 จะส่งบทบาทจริงจาก session)
 * - staff:viewer → แสดง "โหมดดูอย่างเดียว (staff:viewer)" ชัดเจนทุกหน้า (RBAC §1.1: ห้ามแก้ข้อมูล)
 * - staff:content → แจ้งว่าข้อมูลเป็น fixture และปุ่มจัดการยังไม่เชื่อมต่อ API
 */

const ROLE_LABEL: Partial<Record<Role, string>> = {
  "staff:viewer": "เจ้าหน้าที่ฝ่ายรายงาน",
  "staff:content": "เจ้าหน้าที่ดูแลเนื้อหา",
  super_admin: "ผู้ดูแลระบบสูงสุด",
};

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
        บทบาท: {ROLE_LABEL[role] ?? role} ({role})
      </strong>
      {" — "}ข้อมูลทั้งหมดบนหน้าจอนี้เป็นข้อมูลจำลอง (fixture) ยังไม่เชื่อมต่อ API จริง
      ปุ่มเผยแพร่/จัดการหมวดจะเชื่อมต่อในเฟสถัดไป
    </div>
  );
}

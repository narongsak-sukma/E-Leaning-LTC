/**
 * access — ตารางบทบาท fail-closed ของ endpoint รายงาน/มอนิเตอร์ (Wave E · D55-6)
 *
 * requirePermission ตรวจระดับ permission แล้ว ยังต้อง "ตรวจบทบาทซ้ำชั้นที่สอง" ตาม
 * ขอบเขต report:view/export ของ RBAC §2.4 (D12-23): se ได้เฉพาะ report ผลสอบ ·
 * sr ได้เฉพาะ report credit · sv/sa ได้ทุกชนิด — ห้ามพึ่งชั้นเดียว (BFF + view/RLS กรอง
 * อีกชั้นภายใน view เองด้วย has_any_role() อ่าน JWT claims)
 *
 * ที่มาบทบาท: API-SPECIFICATION v1.0.4 §3.8 แถว 218-221, 228-229 (ตรงตัวอักษร)
 */
import { AppError } from "@/lib/errors";
import type { Role } from "@/lib/rbac";

/** ประเภทรายงานที่ v1 ให้บริการ — ค่าอื่น = ไม่มี resource → ERR-NF-001 (404) */
export const REPORT_TYPES = ["enrollments", "assessments", "credits"] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/** บทบาทที่ดูรายงาน/ส่งออกได้ ตามประเภท (D12-23 — ตรงตาราง API-SPEC §3.8) */
export const REPORT_ROLE_SCOPES: Record<ReportType, readonly Role[]> = {
  enrollments: ["staff:viewer", "super_admin"],
  assessments: ["staff:exam", "staff:viewer", "super_admin"],
  credits: ["staff:registrar", "staff:viewer", "super_admin"],
};

/** GET /admin/exams/monitoring — staff:exam / super_admin เท่านั้น */
export const MONITORING_ROLE_SCOPE: readonly Role[] = ["staff:exam", "super_admin"];

/** GET /admin/exams/statistics — เขตเดียวกับ v_assessment_statistics (sv/se/sa) */
export const STATISTICS_ROLE_SCOPE: readonly Role[] = [
  "staff:exam",
  "staff:viewer",
  /**
   * หมายเหตุ SoD: staff:registrar ไม่อยู่ในเขตของ statistics (และ assessments) —
   * RLS ฝั่ง DB ปล่อยเกินมา (asm_read รวม sr · attempts_owner_read รวม sr) แต่
   * BFF ต้องเข้มกว่า DB เสมอ (ห้ามเข้มน้อยกว่า)
   */
  "super_admin",
];

/**
 * ตรวจบทบาทซ้ำชั้นที่สอง — ชุดบทบาทของผู้ใช้ต้องตัดกับเขตที่อนุญาตอย่างน้อย 1 บทบาท
 * ไม่ผ่าน → ERR-RBAC-001 (403) พร้อม permission ที่ถูกปฏิเสธ (แบบเดียวกับ requirePermission)
 */
export function assertRoleScope(
  roles: readonly string[],
  allowed: readonly Role[],
  permission: "report:view" | "report:export" | "attempt:view",
): void {
  if (!roles.some((role) => (allowed as readonly string[]).includes(role))) {
    throw new AppError("ERR-RBAC-001", { details: { permission } });
  }
}

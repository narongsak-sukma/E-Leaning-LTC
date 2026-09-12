/**
 * license-status — pure mapping สถานะคำขอใบอนุญาต → ป้ายไทย/โทนสี
 *
 * แยกออกจาก LicenseDecisionActions.tsx ("use client") เพราะหน้า server
 * /admin/license-applications เรียกใช้ตอน SSR แถวตาราง — Next.js ห้ามเรียก
 * ฟังก์ชันจากโมดูล client ฝั่ง server ("Attempted to call licenseStatusViewOf()
 * from the server but licenseStatusViewOf is on the client" → หน้าล่มทุกคำขอ
 * แม้ BFF จะ 200 — e2e-15 t4 จับไว้) โมดูลนี้ไม่มี directive จึง import ได้ทั้ง
 * server component และ client component
 */

/** มุมมองสถานะคำขอสำหรับ badge (ทะเบียนไทย + โทนตาม StatusBadge) */
export const LICENSE_STATUS_VIEW: Record<string, { label: string; tone: "success" | "danger" | "neutral" }> = {
  pending: { label: "รอตรวจ", tone: "neutral" },
  approved: { label: "อนุมัติแล้ว", tone: "success" },
  rejected: { label: "ปฏิเสธแล้ว", tone: "danger" },
};

/** pure — สถานะที่ไม่รู้จักแสดงเป็นกลาง (ไม่เดา — ตัดสินจริงที่ BFF) */
export function licenseStatusViewOf(status: string): { label: string; tone: "success" | "danger" | "neutral" } {
  const known = LICENSE_STATUS_VIEW[status];
  return known ?? { label: status, tone: "neutral" };
}

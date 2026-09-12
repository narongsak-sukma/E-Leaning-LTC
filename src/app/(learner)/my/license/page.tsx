/**
 * หน้า "ใบอนุญาตว่าความของฉัน" (/my/license) — Wave E Phase 5 · IDENT-002/005 (D-p5-4) · lane E
 *
 * - RSC shell — โครงหน้า (h1 + คำอธิบายไทย) · สถานะโหลด/บันทึกฝั่ง client ผ่าน
 *   LicenseStatusCard (GET/PUT /api/v1/me/license — D-p5-4)
 * - BFF ยังไม่ deploy = แผง error ไทยจาก LicenseStatusCard (ไม่ crash ไม่แสดง stack)
 */
import type { Metadata } from "next";

import { LicenseStatusCard } from "@/components/learner/license/license-status-card";

export const metadata: Metadata = {
  title: "ใบอนุญาตว่าความของฉัน — ระบบฝึกอบรมออนไลน์",
  description:
    "ดูสถานะใบอนุญาตว่าความและคำขอล่าสุดของท่าน พร้อมยื่นคำขอใหม่ได้เมื่อไม่มีคำขอรอการตรวจสอบอยู่",
};

export default function MyLicensePage() {
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">ใบอนุญาตว่าความของฉัน</h1>
      <p className="mt-1 text-sm text-ink-600">
        ใบอนุญาตว่าความที่ผูกกับบัญชีของท่าน และสถานะคำขอล่าสุด — เมื่อเจ้าหน้าที่อนุมัติ
        ระบบจะมอบบทบาททนายความและแจ้งผ่านการแจ้งเตือนพร้อมอีเมล
      </p>
      <LicenseStatusCard />
    </div>
  );
}

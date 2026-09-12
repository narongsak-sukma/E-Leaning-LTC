/**
 * หน้า "ตั้งค่าการแจ้งเตือน" (/my/notification-settings) — Wave E Phase 4 · NTF-005 (lane D)
 *
 * - RSC shell — โครงหน้า (h1 + คำอธิบายไทย) · ตาราง toggle โหลด/บันทึกฝั่ง client ผ่าน
 *   NotificationSettingsForm (ค่าจริงจาก GET · บันทึก PATCH เฉพาะที่เปลี่ยน)
 * - BFF ยังไม่ deploy = แผง error ไทยจาก NotificationSettingsForm (ไม่ crash ไม่แสดง stack)
 */
import type { Metadata } from "next";

import { NotificationSettingsForm } from "@/components/learner/notifications/notification-settings-form";

export const metadata: Metadata = {
  title: "ตั้งค่าการแจ้งเตือน — ระบบฝึกอบรมออนไลน์",
  description:
    "เลือกได้ว่าจะรับการแจ้งเตือนแต่ละประเภททางใด ทั้งในระบบและทางอีเมล ตามความเหมาะสมของท่าน",
};

export default function MyNotificationSettingsPage() {
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">ตั้งค่าการแจ้งเตือน</h1>
      <p className="mt-1 text-sm text-ink-600">
        เลือกช่องทางการแจ้งเตือนแต่ละประเภท ทั้งในระบบและทางอีเมล — ค่าที่บันทึกมีผลทันที
        สำหรับการแจ้งเตือนที่เกิดขึ้นถัดจากนี้
      </p>
      <NotificationSettingsForm />
    </div>
  );
}

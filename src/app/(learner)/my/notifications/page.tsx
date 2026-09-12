/**
 * หน้า "การแจ้งเตือน" (/my/notifications) — Wave E Phase 4 · NTF-001 (lane D)
 *
 * - RSC shell — โครงหน้า (h1 + คำอธิบายไทย) · รายการโหลดฝั่ง client ผ่าน NotificationsInbox
 *   (ปุ่มอ่านแล้ว/โหลดเพิ่มต้องจัดการ state ท้องถิ่น — แบบเดียวกับ client component อื่นของ repo)
 * - BFF ยังไม่ deploy = แผง error ไทยจาก NotificationsInbox (ไม่ crash ไม่แสดง stack)
 */
import type { Metadata } from "next";
import Link from "next/link";

import { NotificationsInbox } from "@/components/learner/notifications/notifications-inbox";

export const metadata: Metadata = {
  title: "การแจ้งเตือน — ระบบฝึกอบรมออนไลน์",
  description:
    "รวมการแจ้งเตือนของท่าน ทั้งผลสอบ ใบประกาศนียบัตร หน่วยกิตสะสม และรอบต่ออายุใบอนุญาตว่าความ",
};

export default function MyNotificationsPage() {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-ink-900">การแจ้งเตือน</h1>
          <p className="mt-1 text-sm text-ink-600">
            รวมการแจ้งเตือนของท่าน ทั้งผลสอบ ใบประกาศนียบัตร หน่วยกิตสะสม และรอบต่ออายุ
          </p>
        </div>
        <Link
          href="/my/notification-settings"
          className="rounded-[10px] border border-brand-600 bg-white px-4 py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          ตั้งค่าการแจ้งเตือน
        </Link>
      </div>
      <NotificationsInbox />
    </div>
  );
}

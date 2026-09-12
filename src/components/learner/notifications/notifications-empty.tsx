/**
 * NotificationsEmpty — empty state ของกล่องแจ้งเตือน (NTF-001 · lane D)
 *
 * ข้อความไทยสุภาพ + แนะนำที่มาของการแจ้งเตือน (ผลสอบ/ใบประกาศฯ/หน่วยกิต/รอบต่ออายุ) —
 * แบบแผนแผงขาวขอบ mist-200 shadow-card เดียวกับหน้าอื่นของ repo
 */
import Link from "next/link";

export function NotificationsEmpty() {
  return (
    <section
      aria-labelledby="notif-empty-heading"
      data-testid="notif-empty"
      className="mt-4 rounded-[14px] border border-mist-200 bg-white p-10 text-center shadow-card"
    >
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mist-100">
        <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false} className="text-ink-400">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span className="sr-only">ยังไม่มีการแจ้งเตือน</span>
      </div>
      <h2 id="notif-empty-heading" className="mt-4 font-heading text-lg font-bold text-ink-900">
        ยังไม่มีการแจ้งเตือน
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-600">
        การแจ้งเตือนจะแสดงที่นี่เมื่อมีผลสอบของท่าน ใบประกาศนียบัตร หน่วยกิตสะสม
        หรือการเตือนรอบต่ออายุ — ท่านไม่ต้องทำอะไร ระบบจะแจ้งเองโดยอัตโนมัติ
      </p>
      <p className="mt-3 text-xs text-ink-400">
        จัดการช่องทางการแจ้งได้ที่หน้า{" "}
        <Link href="/my/notification-settings" className="font-semibold text-brand-700 hover:underline">
          ตั้งค่าการแจ้งเตือน
        </Link>
      </p>
    </section>
  );
}

/**
 * Learner Shell — layout ของ route group (learner) (DESIGN-SYSTEM §6.2)
 * topbar องค์กร (brand-900) · header ขาว + เมนูผู้เรียน · skip link · footer
 * ออกจากระบบ → POST /api/v1/auth/logout แล้วไป /login (C-0) — ไม่มี Supabase ฝั่ง browser (D26/SDS §5.1)
 */
import type { Metadata } from "next";
import Link from "next/link";

import { NotificationBell } from "@/components/learner/notifications/notification-bell";
import { LogoutButton } from "@/components/learner/logout-button";

export const metadata: Metadata = {
  title: "ระบบฝึกอบรมออนไลน์ — สภาทนายความแห่งประเทศไทย",
  description: "หลักสูตรฝึกอบรมออนไลน์สำหรับทนายความ สภาทนายความแห่งประเทศไทย",
};

export default function LearnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-mist-50 font-sans">
      <a
        href="#learner-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[8px] focus:bg-brand-700 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        ข้ามไปยังเนื้อหาหลัก
        <span className="sr-only"> (กด Tab เพื่อใช้งาน)</span>
      </a>
      <div className="bg-brand-900 px-4 py-2 text-center text-xs text-brand-100">
        สภาทนายความแห่งประเทศไทย · โทร 0 2351 1128
      </div>
      <header className="sticky top-0 z-40 border-b border-mist-200 bg-white shadow-card">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link
            href="/my/courses"
            className="font-heading text-base font-bold text-brand-700 hover:text-brand-800"
          >
            ระบบฝึกอบรมออนไลน์
          </Link>
          <nav aria-label="เมนูผู้เรียน" className="flex items-center gap-2">
            <Link
              href="/my/courses"
              className="rounded-[8px] px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"
            >
              หลักสูตรของฉัน
            </Link>
            <NotificationBell />
            <LogoutButton className="rounded-[8px] px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50" />
          </nav>
  </div>
      </header>
      <main id="learner-main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
      <footer className="bg-brand-900 px-4 py-3 text-center text-xs text-brand-200">
        สภาทนายความแห่งประเทศไทย — ระบบฝึกอบรมออนไลน์
      </footer>
    </div>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { RoleModeBanner } from "@/components/admin/RoleModeBanner";
import { adminFixtureStaff } from "@/lib/fixtures/admin";

/**
 * Admin Shell — DESIGN-SYSTEM §6.3 (หน้า 08 หลังบ้านเจ้าหน้าที่)
 * - topbar brand-900 + sidebar brand-900 กว้าง 260px ตั้งแต่ lg + footer ผู้ใช้/สิทธิ์/ออกจากระบบ
 * - ทุกหน้าในกลุ่ม (admin) แสดงแบนเนอร์บทบาท (Phase 1 จะส่งบทบาทจาก session จริงแทน fixture)
 * - responsive: เดสก์ท็อปเป็นหลัก (≥768px) ต่ำกว่า lg แถบเมนูเรียงแนวนอนเลื่อนได้
 */

export const metadata: Metadata = {
  title: "หลังบ้านจัดการเนื้อหา · ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
  description:
    "พื้นที่ทำงานของเจ้าหน้าที่สภาทนายความฯ สำหรับดูแลหลักสูตรและหมวดหลักสูตร (โครงหน้าจอ ข้อมูลจำลอง)",
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-mist-50">
      <a href="#admin-main" className="skip-link">
        ข้ามไปยังเนื้อหาหลัก
      </a>
      <header className="bg-brand-900 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 lg:px-6">
          <div>
            <p className="text-xs text-brand-200">
              สภาทนายความแห่งประเทศไทย · ระบบฝึกอบรมออนไลน์
            </p>
            <p className="font-heading text-base font-semibold sm:text-lg">
              หลังบ้านจัดการเนื้อหา
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="rounded-full bg-gold-50 px-2.5 py-0.5 text-xs font-semibold text-gold-700">
              MFA ✓ (จำลอง)
            </span>
            <span className="hidden rounded-full border border-mist-100/40 px-2.5 py-0.5 text-xs text-mist-50 sm:inline">
              {adminFixtureStaff.name}
            </span>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:py-6 lg:flex-row lg:gap-6 lg:px-6">
        <AdminSidebar />
        <main id="admin-main" className="min-w-0 flex-1">
          <RoleModeBanner role={adminFixtureStaff.role} />
          {children}
        </main>
      </div>
      <footer className="bg-brand-900 text-mist-200">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-xs sm:text-sm lg:px-6">
          <p>
            ผู้ใช้: {adminFixtureStaff.name} · สิทธิ์: {adminFixtureStaff.role} (จำลอง)
          </p>
          <button
            type="button"
            disabled
            title="ยังไม่เชื่อมต่อ API — เชื่อมต่อในเฟสถัดไป (งาน C-0 Auth/Session)"
            className="rounded-[10px] border border-mist-100/40 px-[18px] py-2 font-heading text-sm font-semibold text-mist-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:opacity-60"
          >
            ออกจากระบบ (ยังไม่เชื่อมต่อ)
          </button>
        </div>
      </footer>
    </div>
  );
}

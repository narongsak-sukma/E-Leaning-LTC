/**
 * Admin Shell — DESIGN-SYSTEM §6.3 (หน้า 08 หลังบ้านเจ้าหน้าที่)
 * - topbar brand-900 + sidebar brand-900 กว้าง 260px ตั้งแต่ lg + footer ผู้ใช้/สิทธิ์/ออกจากระบบ
 * - C-8 Phase 1: อ่าน session จริงจาก GET /api/v1/me (ผ่านชั้นข้อมูล src/lib/fixtures/admin.ts)
 *   · ไม่มี session หรือไม่มีบทบาทเจ้าหน้าที่ → redirect /login
 *   · BFF ล่ม/5xx → แสดงแผง "ระบบขัดข้อง" (fail-closed ไม่ปล่อย children ผ่าน)
 * - ทุกหน้าในกลุ่ม (admin) แสดงแบนเนอร์บทบาทจาก session จริง
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { getAdminStaffSession, hasAdminStaffRole } from "@/lib/fixtures/admin";
import {
  ADMIN_ROLE_LABEL_TH,
  RoleModeBanner,
  adminPrimaryRole,
} from "@/components/admin/RoleModeBanner";

export const metadata: Metadata = {
  title: "หลังบ้านจัดการเนื้อหา · ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
  description:
    "พื้นที่ทำงานของเจ้าหน้าที่สภาทนายความฯ สำหรับดูแลหลักสูตรและหมวดหลักสูตร (เชื่อม session จริงแล้ว)",
};

/** แผง "ระบบขัดข้อง" เมื่อติดต่อ GET /api/v1/me ไม่ได้ — fail-closed ไม่แสดง children */
function AdminSessionErrorPanel() {
  return (
    <div
      role="alert"
      className="mx-auto mt-16 max-w-xl rounded-[14px] border border-mist-200 bg-white p-10 text-center shadow-card"
    >
      <p className="font-heading text-base font-semibold text-ink-900">
        ขออภัย ติดต่อระบบหลังบ้านไม่ได้ในขณะนี้
      </p>
      <p className="mt-1 text-sm leading-relaxed text-ink-500">
        อาจเป็นการขัดข้องชั่วคราว โปรดลองอีกครั้งในอีกสักครู่ หากยังไม่หายให้แจ้งผู้ดูแลระบบ
      </p>
      <Link
        href="/login"
        className="mt-4 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
      >
        ไปหน้าเข้าสู่ระบบ
      </Link>
    </div>
  );
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getAdminStaffSession();
  if (!session.ok) {
    return <AdminSessionErrorPanel />;
  }
  const staff = session.staff;
  if (staff === null || !hasAdminStaffRole(staff.roles)) {
    // ไม่มี session / ไม่ใช่เจ้าหน้าที่ → ออกจากหลังบ้านทันที (fail-closed)
    redirect("/login");
  }
  const primaryRole = adminPrimaryRole(staff.roles);
  const mfaBadge =
    staff.mfaVerified === true ? (
      <span className="rounded-full bg-gold-50 px-2.5 py-0.5 text-xs font-semibold text-gold-700">
        ยืนยัน MFA แล้ว
      </span>
    ) : staff.mfaVerified === false ? (
      <span className="rounded-full bg-warning-50 px-2.5 py-0.5 text-xs font-semibold text-warning-600">
        ยังไม่ยืนยัน MFA
      </span>
    ) : null;
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
            {mfaBadge}
            <span className="hidden rounded-full border border-mist-100/40 px-2.5 py-0.5 text-xs text-mist-50 sm:inline">
              {staff.name}
            </span>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:py-6 lg:flex-row lg:gap-6 lg:px-6">
        <AdminSidebar />
        <main id="admin-main" className="min-w-0 flex-1">
          <RoleModeBanner role={primaryRole} />
          {children}
        </main>
      </div>
      <footer className="bg-brand-900 text-mist-200">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-xs sm:text-sm lg:px-6">
          <p>
            ผู้ใช้: {staff.name} · บทบาท: {ADMIN_ROLE_LABEL_TH[primaryRole]} ({primaryRole})
          </p>
          <button
            type="button"
            disabled
            title="การออกจากระบบยังไม่เชื่อมต่อ POST /api/v1/auth/logout ในเฟสนี้ (lane c5)"
            className="rounded-[10px] border border-mist-100/40 px-[18px] py-2 font-heading text-sm font-semibold text-mist-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:opacity-60"
          >
            ออกจากระบบ (ยังไม่เชื่อมต่อ)
          </button>
        </div>
      </footer>
    </div>
  );
}

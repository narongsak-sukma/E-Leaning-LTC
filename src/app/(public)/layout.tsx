/**
 * Public Shell — DS §6.1 (topbar brand-900 + header sticky 72px + footer)
 * ใช้กับหน้าสาธารณะทั้งหมดที่อยู่ใน route group (public)
 * Mobile menu ใช้ <details> (คีย์บอร์ดใช้งานได้ ไม่ต้องมี client JS ใน skeleton นี้)
 */

import Link from "next/link";
import type { ReactNode } from "react";

const NAV_ITEMS = [
  { href: "/", label: "หน้าแรก" },
  { href: "/courses", label: "หลักสูตรทั้งหมด" },
  { href: "/verify", label: "ตรวจสอบประกาศนียบัตร" },
  { href: "/help", label: "ช่วยเหลือ" },
] as const;

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-mist-50">
      <a className="skip-link" href="#main">
        ข้ามไปยังเนื้อหาหลัก
      </a>

      {/* topbar — ซ่อนบน mobile (DS §6.1) */}
      <div className="bg-brand-900 text-center text-xs text-mist-100 sm:text-sm">
        <div className="mx-auto max-w-7xl px-4 py-1.5">
          สภาทนายความแห่งประเทศไทย · โทร 0 2351 1128
        </div>
      </div>

      <header className="sticky top-0 z-40 border-b border-mist-200 bg-white shadow-card">
        <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between gap-4 px-4">
          <Link className="flex items-center gap-2" href="/">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-800 font-heading text-lg font-bold text-gold-300"
            >
              ส
            </span>
            <span className="font-heading text-base font-semibold text-brand-900 sm:text-lg">
              ระบบอีเลิร์นนิ่ง
              <span className="block text-xs font-medium text-ink-500">
                สภาทนายความแห่งประเทศไทย
              </span>
            </span>
          </Link>

          <nav aria-label="เมนูหลัก" className="hidden md:block">
            <ul className="flex items-center gap-6 text-sm font-medium text-ink-600">
              {NAV_ITEMS.map((item) => (
                <li key={item.href}>
                  <Link className="hover:text-brand-700 hover:underline" href={item.href}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <Link
              className="rounded-[10px] px-4 py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
              href="/login"
            >
              เข้าสู่ระบบ
            </Link>
            <Link
              className="rounded-[10px] bg-brand-600 px-4 py-2 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
              href="/register"
            >
              สมัครสมาชิก
            </Link>
          </div>

          {/* เมนูบน mobile — details/summary (ไม่ใช้ JS) */}
          <details className="relative md:hidden">
            <summary
              className="flex h-10 w-10 list-none items-center justify-center rounded-[10px] border border-mist-300 text-ink-700 [&::-webkit-details-marker]:hidden"
              aria-label="เปิดเมนูหลัก"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 6h16" />
                <path d="M4 12h16" />
                <path d="M4 18h16" />
              </svg>
            </summary>
            <div className="absolute right-0 top-12 w-64 rounded-[14px] border border-mist-200 bg-white p-4 shadow-pop">
              <nav aria-label="เมนูหลักบนมือถือ">
                <ul className="flex flex-col gap-1 text-sm font-medium text-ink-700">
                  {NAV_ITEMS.map((item) => (
                    <li key={item.href}>
                      <Link className="block rounded-[10px] px-3 py-2 hover:bg-brand-50" href={item.href}>
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="mt-3 flex flex-col gap-2 border-t border-mist-200 pt-3">
                <Link
                  className="rounded-[10px] border-[1.5px] border-brand-600 px-4 py-2 text-center font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
                  href="/login"
                >
                  เข้าสู่ระบบ
                </Link>
                <Link
                  className="rounded-[10px] bg-brand-600 px-4 py-2 text-center font-heading text-sm font-semibold text-white hover:bg-brand-700"
                  href="/register"
                >
                  สมัครสมาชิก
                </Link>
              </div>
            </div>
          </details>
        </div>
      </header>

      <main className="flex-1" id="main">
        {children}
      </main>

      <footer className="bg-brand-900 text-mist-200">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="font-heading text-base font-semibold text-mist-50">
              ระบบอีเลิร์นนิ่ง สภาทนายความแห่งประเทศไทย
            </p>
            <p className="mt-2 text-xs leading-relaxed sm:text-sm">
              หลักสูตรออนไลน์ การสอบรับประกาศนียบัตร และธนาคารหน่วยกิต
              เพื่อการฝึกอบรมทนายความอย่างเป็นทางการ
            </p>
          </div>
          <div>
            <p className="font-heading text-sm font-semibold text-mist-50">ติดต่อสอบถาม</p>
            <ul className="mt-2 space-y-1 text-xs sm:text-sm">
              <li>โทร 0 2351 1128 (จันทร์–ศุกร์ 8:30–16:30 น.)</li>
              <li>สำนักงานสภาทนายความแห่งประเทศไทย กรุงเทพมหานคร</li>
            </ul>
          </div>
          <div>
            <p className="font-heading text-sm font-semibold text-mist-50">ลิงก์ที่เกี่ยวข้อง</p>
            <ul className="mt-2 space-y-1 text-xs sm:text-sm">
              <li>
                <Link className="hover:text-gold-300 hover:underline" href="/courses">
                  หลักสูตรทั้งหมด
                </Link>
              </li>
              <li>
                <Link className="hover:text-gold-300 hover:underline" href="/verify">
                  ตรวจสอบประกาศนียบัตร
                </Link>
              </li>
              <li>
                <Link className="hover:text-gold-300 hover:underline" href="/login">
                  เข้าสู่ระบบ
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-brand-800">
          <div className="mx-auto max-w-7xl px-4 py-4 text-xs">
            สงวนลิขสิทธิ์ พ.ศ. 2569 สภาทนายความแห่งประเทศไทย · ระบบอยู่ระหว่างการพัฒนา (Wave C)
          </div>
        </div>
      </footer>
    </div>
  );
}

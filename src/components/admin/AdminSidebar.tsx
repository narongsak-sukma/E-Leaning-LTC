"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const READY_ITEMS = [
  { href: "/admin/courses", label: "หลักสูตร" },
  { href: "/admin/categories", label: "หมวดหลักสูตร" },
] as const;

const SOON_ITEMS = [
  "แดชบอร์ด",
  "ผู้ใช้และบทบาท",
  "ข้อสอบและการประเมิน",
  "ประกาศนียบัตร",
  "หน่วยกิต (Credit Bank)",
  "บันทึกการตรวจสอบ",
] as const;

function BookIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" strokeLinejoin="round" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" strokeLinejoin="round" />
      <path d="M9 7h7M9 11h5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" strokeLinejoin="round" />
      <path d="M3 13h18" />
    </svg>
  );
}

export function AdminSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav aria-label="เมนูหลังบ้าน" className="lg:w-[260px] lg:shrink-0">
      <div className="flex gap-1 overflow-x-auto rounded-[14px] bg-brand-900 p-2 lg:flex-col lg:overflow-visible lg:p-3">
        <p className="hidden px-3 pb-2 pt-1 text-xs font-semibold text-brand-200 lg:block">
          จัดการเนื้อหา
        </p>
        {READY_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) ? "page" : undefined}
            className={`flex items-center gap-2 whitespace-nowrap rounded-[10px] px-3 py-2.5 text-sm font-semibold ${
              isActive(item.href)
                ? "bg-brand-600 text-white shadow-[inset_3px_0_0_0_var(--color-gold-300)]"
                : "text-brand-200 hover:bg-brand-800"
            }`}
          >
            {item.href === "/admin/courses" ? <BookIcon /> : <FolderIcon />}
            {item.label}
          </Link>
        ))}
      </div>
      <div className="mt-2 flex gap-1 overflow-x-auto rounded-[14px] bg-brand-900 p-2 lg:mt-3 lg:flex-col lg:overflow-visible lg:p-3">
        <p className="hidden px-3 pb-2 pt-1 text-xs font-semibold text-brand-200 lg:block">
          เมนูอื่น — เร็ว ๆ นี้
        </p>
        {SOON_ITEMS.map((label) => (
          <span
            key={label}
            aria-disabled="true"
            title="เชื่อมต่อในเฟสถัดไป"
            className="flex items-center gap-2 whitespace-nowrap rounded-[10px] px-3 py-2.5 text-sm text-brand-200"
          >
            {label}
          </span>
        ))}
      </div>
    </nav>
  );
}

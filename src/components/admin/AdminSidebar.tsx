"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const READY_ITEMS = [
  { href: "/admin/courses", label: "หลักสูตร", icon: "book" },
  { href: "/admin/categories", label: "หมวดหลักสูตร", icon: "folder" },
  { href: "/admin/assessments", label: "ข้อสอบและการประเมิน", icon: "clipboard" },
  { href: "/admin/question-banks", label: "คลังข้อสอบ", icon: "stack" },
  { href: "/admin/certificates", label: "ประกาศนียบัตร", icon: "award" },
  { href: "/admin/credit-rules", label: "กฎหน่วยกิต", icon: "sliders" },
  { href: "/admin/credits", label: "หน่วยกิต (Credit Bank)", icon: "coins" },
] as const;

const SOON_ITEMS = [
  "แดชบอร์ด",
  "ผู้ใช้และบทบาท",
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

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" strokeLinejoin="round" />
      <path d="M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1H9V4Z" strokeLinejoin="round" />
      <path d="M9 11h6M9 15h4" strokeLinecap="round" />
    </svg>
  );
}

function StackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d="M12 3l9 5-9 5-9-5 9-5Z" strokeLinejoin="round" />
      <path d="M3 13l9 5 9-5" strokeLinejoin="round" />
    </svg>
  );
}

function AwardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <circle cx="12" cy="9" r="5.5" strokeLinejoin="round" />
      <path d="M8.5 13.5L7 21l5-2.5L17 21l-1.5-7.5" strokeLinejoin="round" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2.2" strokeLinejoin="round" />
      <circle cx="8" cy="17" r="2.2" strokeLinejoin="round" />
    </svg>
  );
}

function CoinsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <ellipse cx="12" cy="6" rx="7" ry="3" strokeLinejoin="round" />
      <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" strokeLinejoin="round" />
      <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  book: BookIcon,
  folder: FolderIcon,
  clipboard: ClipboardIcon,
  stack: StackIcon,
  award: AwardIcon,
  sliders: SlidersIcon,
  coins: CoinsIcon,
} as const;

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
        {READY_ITEMS.map((item) => {
          const Icon = ICONS[item.icon];
          return (
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
              <Icon />
              {item.label}
            </Link>
          );
        })}
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

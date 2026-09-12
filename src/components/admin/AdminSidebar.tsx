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
  { href: "/admin/dashboard", label: "แดชบอร์ด", icon: "grid" },
  { href: "/admin/users", label: "ผู้ใช้และบทบาท", icon: "users" },
  { href: "/admin/license-applications", label: "คำขอใบอนุญาต", icon: "id-card" },
  { href: "/admin/audit", label: "บันทึกการตรวจสอบ", icon: "shield" },
  { href: "/admin/reports", label: "รายงาน", icon: "chart" },
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

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" strokeLinejoin="round" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" strokeLinejoin="round" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" strokeLinejoin="round" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" strokeLinejoin="round" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5S13.9 16 14.5 19" strokeLinecap="round" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 4.8" strokeLinecap="round" />
      <path d="M17.5 14.8c1.6.7 2.6 2 3 4.2" strokeLinecap="round" />
    </svg>
  );
}

function IdCardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" strokeLinejoin="round" />
      <circle cx="8.5" cy="11" r="1.8" />
      <path d="M6 16c.4-1.3 1.4-2 2.5-2s2.1.7 2.5 2" strokeLinecap="round" />
      <path d="M14 9.5h4M14 13h4" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d="M12 3l7 2.5V11c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V5.5L12 3Z" strokeLinejoin="round" />
      <path d="M9.5 11.5l1.8 1.8 3.4-3.6" strokeLinecap="round" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d="M4 4v15a1 1 0 0 0 1 1h15" strokeLinecap="round" />
      <path d="M8.5 15.5v-4M12.5 15.5v-7M16.5 15.5v-2.5" strokeLinecap="round" />
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
  grid: GridIcon,
  users: UsersIcon,
  "id-card": IdCardIcon,
  shield: ShieldIcon,
  chart: ChartIcon,
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
    </nav>
  );
}

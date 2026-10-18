"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Award,
  FileBadge,
  Scale,
  ClipboardCheck,
  UserCircle,
  LogOut,
  Lock,
  Bell,
  Compass,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { LtcEmblem, ROLE_LABELS_TH } from "./LtcEmblem";

export interface LearnerContextUser {
  id: string;
  displayName: string;
  email: string;
  phone: string | null;
}

const LEARNER_NAV_ITEMS = [
  {
    href: "/my/courses",
    label: "แดชบอร์ด & หลักสูตรของฉัน",
    icon: BookOpen,
  },
  {
    href: "/my/credits",
    label: "สมุดสะสมหน่วยกิต (Credit Bank)",
    icon: Award,
  },
  {
    href: "/my/certificates",
    label: "ประกาศนียบัตรดิจิทัล",
    icon: FileBadge,
  },
  {
    href: "/my/license",
    label: "ใบอนุญาตว่าความ (ทล.)",
    icon: Scale,
  },
  {
    href: "/my/attempts",
    label: "ประวัติการสอบวัดผล",
    icon: ClipboardCheck,
  },
  {
    href: "/my/profile",
    label: "ข้อมูลส่วนตัว & PDPA",
    icon: UserCircle,
  },
];

export function LearnerShell({
  user,
  roles,
  verifiedLicense,
  netCredits = 0,
  requiredCredits = 12,
  unreadCount = 0,
  onSwitchPersona,
  children,
}: {
  user: LearnerContextUser | null;
  roles: string[];
  verifiedLicense: { licenseNo: string; status: string; expiresOn: string | null } | null;
  netCredits?: number;
  requiredCredits?: number;
  unreadCount?: number;
  onSwitchPersona?: (userId: string) => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      {/* Top Bar */}
      <header className="sticky top-0 z-40 bg-[#0b1f3a] text-white border-b border-white/10">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <Link href="/" className="flex items-center gap-3">
              <LtcEmblem size={38} variant="gold" />
              <div>
                <div className="text-sm font-bold text-white leading-tight">
                  พอร์ทัลผู้เรียน · สภาทนายความ
                </div>
                <div className="text-[11px] text-[#e2b857]">
                  FRONTOFFICE LEARNER PORTAL
                </div>
              </div>
            </Link>
          </div>

          {/* Center Quick Persona Switcher for Seamless Testing */}
          <div className="hidden lg:flex items-center gap-2 bg-white/10 px-3 py-1.5 rounded-xl border border-white/15 text-xs">
            <span className="text-slate-300">สลับผู้เรียนทดสอบ:</span>
            <button
              type="button"
              onClick={() => onSwitchPersona?.("u-lawyer-001")}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer ${
                user?.id === "u-lawyer-001"
                  ? "bg-[#c89b3c] text-[#0b1f3a] font-bold"
                  : "text-white hover:bg-white/10"
              }`}
            >
              ทนายความ (ธนกร · ทล. 25891)
            </button>
            <button
              type="button"
              onClick={() => onSwitchPersona?.("u-citizen-001")}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer ${
                user?.id === "u-citizen-001"
                  ? "bg-[#c89b3c] text-[#0b1f3a] font-bold"
                  : "text-white hover:bg-white/10"
              }`}
            >
              ประชาชน (ปิยะพร · รอตรวจใบอนุญาต)
            </button>
            <span className="text-white/20">|</span>
            <Link
              href="/backoffice/login"
              className="inline-flex items-center gap-1 text-[#e2b857] hover:underline font-semibold"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>สลับไปพอร์ทัลเจ้าหน้าที่ (Backoffice)</span>
            </Link>
          </div>

          {/* Right User Profile & Actions */}
          <div className="flex items-center gap-3 shrink-0">
            <Link
              href="/courses"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white transition-colors"
            >
              <Compass className="w-3.5 h-3.5 text-[#e2b857]" />
              <span>ค้นหาหลักสูตรเพิ่ม</span>
            </Link>

            {user && (
              <div className="flex items-center gap-2.5 pl-2 border-l border-white/15">
                <div className="text-right hidden sm:block">
                  <div className="text-xs font-bold text-white">
                    {user.displayName}
                  </div>
                  <div className="text-[11px] text-[#e2b857]">
                    {verifiedLicense
                      ? `ทนายความ ทล. ${verifiedLicense.licenseNo}`
                      : "ผู้เรียนทั่วไป (Citizen)"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  aria-label="ออกจากระบบผู้เรียน"
                  className="p-2 rounded-lg bg-white/10 hover:bg-red-500/20 text-slate-200 hover:text-red-200 transition-colors cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Two-Column Workspace */}
      <div className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Sidebar Navigation */}
        <aside className="lg:col-span-3 space-y-4">
          {/* Learner Identity & License Badge Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-[#0b1f3a] text-[#e2b857] font-bold flex items-center justify-center text-base shrink-0">
                {user?.displayName?.slice(0, 1) || "ผ"}
              </div>
              <div className="min-w-0">
                <div className="font-bold text-sm text-[#0b1f3a] truncate">
                  {user?.displayName || "กำลังโหลด..."}
                </div>
                <div className="text-xs text-slate-500 truncate">
                  {user?.email}
                </div>
              </div>
            </div>

            {verifiedLicense ? (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs space-y-1">
                <div className="flex items-center justify-between font-bold text-emerald-900">
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                    <span>ทนายความที่ยืนยันแล้ว</span>
                  </span>
                  <span className="font-mono">ทล. {verifiedLicense.licenseNo}</span>
                </div>
                <div className="text-emerald-800 flex items-center justify-between">
                  <span>หน่วยกิตสะสมปี 2569:</span>
                  <span className="font-mono font-bold tabular-nums">
                    {netCredits} / {requiredCredits} หน่วย
                  </span>
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs space-y-1.5">
                <div className="flex items-center gap-1.5 font-bold text-amber-900">
                  <Clock className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                  <span>สิทธิ์ผู้เรียนทั่วไป (Citizen)</span>
                </div>
                <p className="text-amber-800 leading-relaxed">
                  หากคุณเป็นทนายความ สามารถยื่นผูกเลขใบอนุญาตเพื่อสะสมหน่วยกิต CPE ได้
                </p>
                <Link
                  href="/my/license"
                  className="inline-block font-bold text-[#0b1f3a] underline"
                >
                  ตรวจสอบสถานะใบอนุญาต →
                </Link>
              </div>
            )}

            {/* Navigation Menu */}
            <nav aria-label="เมนูพื้นที่ผู้เรียน" className="space-y-1 pt-2 border-t border-slate-100">
              {LEARNER_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active =
                  pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
                      active
                        ? "bg-[#0b1f3a] text-white"
                        : "text-slate-600 hover:bg-slate-100 hover:text-[#0b1f3a]"
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        active ? "text-[#e2b857]" : "text-slate-400"
                      }`}
                    />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="lg:col-span-9 min-w-0">{children}</main>
      </div>
    </div>
  );
}

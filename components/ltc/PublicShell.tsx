"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ShieldCheck,
  LogIn,
  Lock,
  GraduationCap,
  Award,
  BookOpen,
  UserCheck,
  ChevronRight,
  LogOut,
} from "lucide-react";
import { LtcEmblem, ROLE_LABELS_TH } from "./LtcEmblem";

interface AuthOverview {
  authenticated: boolean;
  session: {
    portal: "frontoffice" | "backoffice";
    aal: "aal1" | "aal2";
    user: {
      id: string;
      displayName: string;
      email: string;
    };
    roles: string[];
    verifiedLicense: { licenseNo: string } | null;
    netCredits: number;
  } | null;
}

export function PublicHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [auth, setAuth] = useState<AuthOverview | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/auth")
      .then((r) => r.json())
      .then((data) => {
        if (active) setAuth(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [pathname]);

  async function handleLogout() {
    await fetch("/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    setAuth({ authenticated: false, session: null });
    router.refresh();
  }

  const isStaffOrInstructor = auth?.session?.roles.some(
    (r) => r === "instructor" || r.startsWith("staff:"),
  );

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200">
      {/* Institutional Top Utility Ribbon */}
      <div className="bg-[#0b1f3a] text-slate-200 text-xs border-b border-white/10">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 h-9 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 truncate">
            <span className="text-[#e2b857] font-medium whitespace-nowrap">
              สภาทนายความ ในพระบรมราชูปถัมภ์
            </span>
            <span aria-hidden="true" className="text-slate-500">
              ·
            </span>
            <span className="text-slate-300 hidden sm:inline truncate">
              ระบบพัฒนาวิชาชีพทนายความต่อเนื่อง (CPE Credit Bank) และบริการความรู้กฎหมายแก่ประชาชน
            </span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <Link
              href="/verify"
              className="hover:text-[#e2b857] transition-colors whitespace-nowrap"
            >
              ตรวจสอบใบประกาศนียบัตร
            </Link>
            <span aria-hidden="true" className="text-slate-600">
              |
            </span>
            <Link
              href="/backoffice/login"
              className="inline-flex items-center gap-1.5 text-[#e2b857] hover:text-amber-300 font-medium transition-colors whitespace-nowrap"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>สำหรับเจ้าหน้าที่ / วิทยากร (Backoffice)</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Main 3-Zone Navigation Bar */}
      <div className="max-w-[1320px] mx-auto px-4 sm:px-6 h-18 flex items-center justify-between gap-8">
        {/* Zone 1: Brand Wordmark */}
        <Link
          href="/"
          className="flex items-center gap-3 whitespace-nowrap shrink-0 group"
        >
          <LtcEmblem size={42} variant="navy" />
          <div>
            <div className="text-base font-bold text-[#0b1f3a] tracking-tight group-hover:text-[#1a4373] transition-colors">
              สภาทนายความ ในพระบรมราชูปถัมภ์
            </div>
            <div className="text-xs text-slate-500">
              LAWYERS COUNCIL OF THAILAND · E-LEARNING
            </div>
          </div>
        </Link>

        {/* Zone 2: Primary Navigation Links */}
        <nav
          aria-label="เมนูหลัก"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
        >
          <Link
            href="/"
            className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
              pathname === "/"
                ? "text-[#0b1f3a] font-semibold border-b-2 border-[#c89b3c]"
                : "hover:text-[#0b1f3a]"
            }`}
          >
            หน้าแรก
          </Link>
          <Link
            href="/courses"
            className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
              pathname.startsWith("/courses")
                ? "text-[#0b1f3a] font-semibold border-b-2 border-[#c89b3c]"
                : "hover:text-[#0b1f3a]"
            }`}
          >
            หลักสูตรทั้งหมด
          </Link>
          <Link
            href="/courses?audience=lawyer_only"
            className="py-1 hover:text-[#0b1f3a] transition-colors whitespace-nowrap shrink-0"
          >
            หน่วยกิตทนายความ (CPE)
          </Link>
          <Link
            href="/verify"
            className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
              pathname.startsWith("/verify")
                ? "text-[#0b1f3a] font-semibold border-b-2 border-[#c89b3c]"
                : "hover:text-[#0b1f3a]"
            }`}
          >
            ตรวจสอบใบประกาศ
          </Link>
        </nav>

        {/* Zone 3: Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          {auth?.authenticated && auth.session ? (
            <div className="flex items-center gap-2.5">
              {isStaffOrInstructor ? (
                <Link
                  href="/admin/dashboard"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-[#0b1f3a] text-[#e2b857] hover:bg-[#132f54] transition-colors whitespace-nowrap"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>แดชบอร์ดบริหารจัดการ (Backoffice)</span>
                </Link>
              ) : (
                <Link
                  href="/my/courses"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-[#0b1f3a] text-white hover:bg-[#132f54] transition-colors whitespace-nowrap"
                >
                  <GraduationCap className="w-4 h-4 text-[#e2b857]" />
                  <span>พื้นที่ผู้เรียน ({auth.session.user.displayName})</span>
                </Link>
              )}
              <button
                type="button"
                onClick={handleLogout}
                aria-label="ออกจากระบบ"
                className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:text-red-700 hover:bg-red-50 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2.5">
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-[#0b1f3a] border border-slate-300 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="w-4 h-4" />
                <span>เข้าสู่ระบบผู้เรียน</span>
              </Link>
              <Link
                href="/register"
                className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[#0b1f3a] text-white hover:bg-[#132f54] transition-colors whitespace-nowrap shrink-0"
              >
                <span>สมัครเรียนฟรี</span>
                <ChevronRight className="w-4 h-4 text-[#e2b857]" />
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="bg-[#0b1f3a] text-slate-300 border-t border-white/10">
      <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 pb-10 border-b border-white/10">
          <div className="md:col-span-5 space-y-3">
            <div className="flex items-center gap-3">
              <LtcEmblem size={40} variant="gold" />
              <div>
                <div className="font-bold text-white text-base">
                  สภาทนายความ ในพระบรมราชูปถัมภ์
                </div>
                <div className="text-xs text-[#e2b857]">
                  LAWYERS COUNCIL OF THAILAND UNDER THE ROYAL PATRONAGE
                </div>
              </div>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed max-w-md">
              249 ถนนพหลโยธิน แขวงอนุสาวรีย์ เขตบางเขน กรุงเทพมหานคร 10220 ·
              สถาบันพัฒนาวิชาชีพทนายความ และระบบคลังหน่วยกิตดิจิทัล (Credit Bank)
            </p>
            <div className="text-xs text-slate-400">
              โทรศัพท์ 02-522-7124 ถึง 27 · อีเมล elearning@lawyerscouncil.or.th
            </div>
          </div>

          <div className="md:col-span-3 space-y-2.5">
            <div className="text-xs font-semibold text-[#e2b857] tracking-wider uppercase">
              สำหรับผู้เรียน (Frontoffice)
            </div>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/courses" className="hover:text-white transition-colors">
                  ค้นหาหลักสูตรทั้งหมด
                </Link>
              </li>
              <li>
                <Link href="/login" className="hover:text-white transition-colors">
                  เข้าสู่ระบบผู้เรียน / ทนายความ
                </Link>
              </li>
              <li>
                <Link href="/register" className="hover:text-white transition-colors">
                  ลงทะเบียนสมาชิกใหม่
                </Link>
              </li>
              <li>
                <Link href="/verify" className="hover:text-white transition-colors">
                  ตรวจสอบความถูกต้องใบประกาศนียบัตร
                </Link>
              </li>
            </ul>
          </div>

          <div className="md:col-span-4 space-y-2.5">
            <div className="text-xs font-semibold text-[#e2b857] tracking-wider uppercase">
              สำหรับบุคลากรและผู้บริหาร (Backoffice)
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              พอร์ทัลแยกเฉพาะสำหรับนายทะเบียน (Registrar) ผู้ดูแลหลักสูตร (Course Admin)
              วิทยากร (Instructor) ผู้ตรวจสอบ (Auditor) และผู้ดูแลระบบสูงสุด (Super Admin)
              พร้อมระบบยืนยันตัวตนสองชั้น (MFA Step-up AAL2)
            </p>
            <div className="pt-1">
              <Link
                href="/backoffice/login"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-white/10 text-[#e2b857] border border-[#c89b3c]/40 hover:bg-white/15 transition-colors"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>เข้าสู่ระบบบริหารจัดการ (Backoffice Login)</span>
              </Link>
            </div>
          </div>
        </div>

        <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-400">
          <div>
            © 2569 สภาทนายความ ในพระบรมราชูปถัมภ์ · สงวนลิขสิทธิ์ตามกฎหมาย ·
            คุ้มครองข้อมูลส่วนบุคคลตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 (PDPA)
          </div>
          <div className="flex items-center gap-4">
            <span>BFF API-Only Architecture</span>
            <span>·</span>
            <span>RBAC + MFA AAL2 Enforced</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

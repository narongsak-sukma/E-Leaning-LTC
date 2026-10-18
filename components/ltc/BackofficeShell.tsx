"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  BookOpen,
  HelpCircle,
  Scale,
  FileBadge,
  Award,
  Users,
  FileSpreadsheet,
  LogOut,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { LtcEmblem, ROLE_LABELS_TH } from "./LtcEmblem";

export function useBackofficeData() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/v1/backoffice?autoDemo=1");
    if (res.ok) {
      setData(await res.json());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mutate(payload: Record<string, any>, successMessage: string) {
    setFeedback(null);
    const res = await fetch("/api/v1/backoffice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!res.ok) {
      setFeedback({
        type: "error",
        message: `${result?.error?.code || "ERROR"}: ${
          result?.error?.message || "ไม่มีสิทธิ์ดำเนินการ"
        }`,
      });
      return false;
    }
    setFeedback({ type: "success", message: successMessage });
    await load();
    return true;
  }

  return { data, loading, feedback, setFeedback, reload: load, mutate };
}

export const BACKOFFICE_NAV_ITEMS = [
  {
    href: "/admin/dashboard",
    label: "ภาพรวมระบบ (Dashboard)",
    icon: LayoutDashboard,
    group: "การจัดการหลัก",
  },
  {
    href: "/admin/courses",
    label: "จัดการหลักสูตร (Courses)",
    icon: BookOpen,
    group: "การจัดการหลัก",
    badgeKey: "pendingCourses" as const,
  },
  {
    href: "/admin/question-bank",
    label: "คลังข้อสอบ & เกณฑ์สอบ",
    icon: HelpCircle,
    group: "การจัดการหลัก",
  },
  {
    href: "/admin/licenses",
    label: "ตรวจใบอนุญาตทนายความ",
    icon: Scale,
    group: "งานนายทะเบียน",
    badgeKey: "pendingLicenses" as const,
  },
  {
    href: "/admin/certificates",
    label: "ทะเบียนใบประกาศนียบัตร",
    icon: FileBadge,
    group: "งานนายทะเบียน",
  },
  {
    href: "/admin/credits",
    label: "เกณฑ์ & บัญชีหน่วยกิต (CPE)",
    icon: Award,
    group: "งานนายทะเบียน",
  },
  {
    href: "/admin/users",
    label: "ผู้ใช้งาน & สิทธิ์ RBAC",
    icon: Users,
    group: "ผู้ดูแลและตรวจสอบ",
  },
  {
    href: "/admin/reports",
    label: "รายงาน & Audit Log",
    icon: FileSpreadsheet,
    group: "ผู้ดูแลและตรวจสอบ",
  },
];

export function BackofficeShell({
  title,
  subtitle,
  data,
  onRefresh,
  children,
}: {
  title: string;
  subtitle?: string;
  data: any;
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [otpInput, setOtpInput] = useState("123456");
  const [verifyingMfa, setVerifyingMfa] = useState(false);

  const session = data?.session;
  const pendingCourses = data?.kpis?.pendingCourseReviewCount ?? 0;
  const pendingLicenses = data?.kpis?.pendingLicenseCount ?? 0;

  async function handleSwitchStaffPersona(userId: string) {
    await fetch("/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "switch_demo",
        userId,
        portal: "backoffice",
        autoVerifyMfa: true,
      }),
    });
    await onRefresh();
  }

  async function handleStepUpMfa(e: React.FormEvent) {
    e.preventDefault();
    setVerifyingMfa(true);
    try {
      const res = await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify_mfa",
          otpCode: otpInput,
        }),
      });
      if (res.ok) {
        await onRefresh();
      }
    } finally {
      setVerifyingMfa(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/backoffice/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex bg-[#f7f8fa] text-slate-900">
      {/* Left Fixed Institutional Navy Sidebar (08-admin-dashboard.html aligned) */}
      <aside className="w-[268px] bg-[#0b1f3a] text-slate-200 flex flex-col justify-between shrink-0 border-r border-white/10">
        <div>
          <div className="p-5 border-b border-white/10 flex items-center gap-3">
            <LtcEmblem size={40} variant="gold" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-white truncate">
                ระบบบริหารจัดการ
              </div>
              <div className="text-[11px] text-[#e2b857] font-semibold tracking-wider">
                LTC BACKOFFICE PORTAL
              </div>
            </div>
          </div>

          <nav aria-label="เมนูบริหารจัดการหลังบ้าน" className="p-3 space-y-1">
            {BACKOFFICE_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              const badgeVal =
                item.badgeKey === "pendingCourses"
                  ? pendingCourses
                  : item.badgeKey === "pendingLicenses"
                    ? pendingLicenses
                    : 0;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
                    active
                      ? "bg-[#1a4373] text-white border border-[#c89b3c]/40"
                      : "text-slate-300 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        active ? "text-[#e2b857]" : "text-slate-400"
                      }`}
                    />
                    <span className="truncate">{item.label}</span>
                  </div>
                  {badgeVal > 0 && (
                    <span className="px-2 py-0.5 rounded-md bg-[#c89b3c] text-[#0b1f3a] font-mono text-[11px] font-bold">
                      {badgeVal}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom Sidebar User & Frontoffice Link */}
        <div className="p-4 border-t border-white/10 space-y-3 bg-[#071529]">
          {session && (
            <div className="space-y-1">
              <div className="text-xs font-bold text-white truncate">
                {session.user?.displayName}
              </div>
              <div className="text-[11px] text-[#e2b857] truncate">
                {(session.roles || [])
                  .map((r: string) => ROLE_LABELS_TH[r] || r)
                  .join(", ")}
              </div>
              <div className="text-[11px] font-mono text-emerald-400">
                SESSION LEVEL: {String(session.aal || "aal2").toUpperCase()}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Link
              href="/"
              className="flex-1 py-2 px-3 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium text-white text-center inline-flex items-center justify-center gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5 text-[#e2b857]" />
              <span>หน้าเว็บผู้เรียน</span>
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              aria-label="ออกจากระบบหลังบ้าน"
              className="p-2 rounded-lg bg-white/10 hover:bg-red-500/20 text-slate-300 hover:text-red-200 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Right Main Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Utility & Role Switcher Header */}
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30">
          <div>
            <h1 className="text-lg font-bold text-[#0b1f3a]">{title}</h1>
            {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          </div>

          {/* Interactive Staff Role Switcher for Testing RBAC Matrix */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500 font-medium">
              ทดสอบสลับบทบาทเจ้าหน้าที่ (RBAC):
            </span>
            {[
              { id: "u-superadmin-001", label: "Super Admin" },
              { id: "u-registrar-001", label: "Registrar (นายทะเบียน)" },
              { id: "u-content-001", label: "Content Staff" },
              { id: "u-exam-001", label: "Exam Staff" },
              { id: "u-instructor-001", label: "Instructor (ผู้สอน)" },
              { id: "u-viewer-001", label: "Viewer" },
            ].map((p) => {
              const active = session?.user?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSwitchStaffPersona(p.id)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                    active
                      ? "bg-[#0b1f3a] text-[#e2b857]"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </header>

        {/* MFA Step-Up Banner if session is still AAL1 */}
        {session?.requiresMfaStepUp && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-xs text-amber-950">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                <strong>MFA Step-Up Required (ERR-AUTH-004):</strong>{" "}
                ขณะนี้เซสชันของคุณอยู่ที่ระดับ <code className="font-mono">aal1</code>{" "}
                กรุณายืนยันรหัส OTP 6 หลักเพื่อยกระดับเป็น{" "}
                <code className="font-mono font-bold">aal2</code> สำหรับการอนุมัติและแก้ไขข้อมูล
              </span>
            </div>
            <form onSubmit={handleStepUpMfa} className="flex items-center gap-2">
              <input
                type="text"
                maxLength={6}
                value={otpInput}
                onChange={(e) => setOtpInput(e.target.value)}
                className="w-28 px-2.5 py-1 rounded-lg border border-amber-300 bg-white font-mono text-xs"
              />
              <button
                type="submit"
                disabled={verifyingMfa}
                className="px-3 py-1 rounded-lg bg-[#0b1f3a] text-[#e2b857] text-xs font-bold cursor-pointer"
              >
                ยืนยัน AAL2
              </button>
            </form>
          </div>
        )}

        <main className="flex-1 p-6 max-w-[1400px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

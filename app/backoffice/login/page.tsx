"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ShieldCheck,
  Lock,
  KeyRound,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Terminal,
  UserCog,
  FileCheck2,
  BookOpenCheck,
  Eye,
} from "lucide-react";
import { LtcEmblem, ROLE_LABELS_TH } from "@/components/ltc/LtcEmblem";

function BackofficeLoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get("next") || "/admin/dashboard";

  const [step, setStep] = useState<"credentials" | "mfa">("credentials");
  const [identifier, setIdentifier] = useState("admin@ltc.or.th");
  const [password, setPassword] = useState("Admin@2569");
  const [otpCode, setOtpCode] = useState("123456");
  const [mfaHint, setMfaHint] = useState<string>("123456");
  const [loggedUser, setLoggedUser] = useState<{
    displayName: string;
    email: string;
    roles: string[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleCredentialsSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          portal: "backoffice",
          identifier,
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(
          data?.error?.message || "ไม่สามารถเข้าสู่ระบบบริหารจัดการได้",
        );
        setLoading(false);
        return;
      }

      setLoggedUser({
        displayName: data.user?.displayName || identifier,
        email: data.user?.email || identifier,
        roles: data.roles || [],
      });
      if (data.mfaHintCode) {
        setMfaHint(data.mfaHintCode);
        setOtpCode(data.mfaHintCode);
      }

      // Privileged roles require MFA Step-up (AAL2) per RBAC-DELEGATION-MATRIX §5
      if (data.requiresMfaStepUp) {
        setStep("mfa");
        setLoading(false);
      } else {
        router.push(nextUrl);
        router.refresh();
      }
    } catch {
      setErrorMsg("เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์");
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify_mfa",
          otpCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data?.error?.message || "รหัส OTP ไม่ถูกต้อง");
        setLoading(false);
        return;
      }
      router.push(nextUrl);
      router.refresh();
    } catch {
      setErrorMsg("เกิดข้อผิดพลาดในการยืนยัน MFA");
      setLoading(false);
    }
  }

  async function handleQuickStaffSelect(
    emailInput: string,
    passInput: string,
    otpInput: string,
  ) {
    setIdentifier(emailInput);
    setPassword(passInput);
    setOtpCode(otpInput);
    setMfaHint(otpInput);
    setErrorMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          portal: "backoffice",
          identifier: emailInput,
          password: passInput,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data?.error?.message || "เข้าสู่ระบบไม่สำเร็จ");
        setLoading(false);
        return;
      }
      setLoggedUser({
        displayName: data.user?.displayName || emailInput,
        email: data.user?.email || emailInput,
        roles: data.roles || [],
      });
      setStep("mfa");
      setLoading(false);
    } catch {
      setErrorMsg("เกิดข้อผิดพลาดในการเชื่อมต่อ");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#071529] text-slate-100 flex flex-col justify-between p-4 sm:p-8">
      {/* Top Bar */}
      <div className="max-w-[1180px] w-full mx-auto flex items-center justify-between py-2">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 hover:text-[#e2b857] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>กลับสู่หน้าหลักผู้เรียน (Frontoffice Portal)</span>
        </Link>
        <div className="text-xs text-slate-400 font-mono">
          SECURITY POLICY: RBAC + AAL2 MFA STEP-UP ENFORCED
        </div>
      </div>

      {/* Main Split Card */}
      <div className="max-w-[1140px] w-full mx-auto my-6 grid grid-cols-1 lg:grid-cols-12 rounded-2xl overflow-hidden border border-white/15 bg-[#0b1f3a] shadow-2xl">
        {/* Left Authority Info Column */}
        <div className="lg:col-span-5 p-8 sm:p-10 bg-gradient-to-b from-[#0b1f3a] to-[#071529] border-b lg:border-b-0 lg:border-r border-white/10 flex flex-col justify-between">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 text-xs font-bold tracking-wider uppercase text-[#e2b857]">
              <ShieldCheck className="w-4 h-4" />
              <span>BACKOFFICE · MANAGEMENT PORTAL</span>
            </div>

            <div className="flex items-center gap-3.5">
              <LtcEmblem size={52} variant="gold" />
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">
                  ระบบบริหารจัดการกลาง
                </h1>
                <p className="text-xs text-[#e2b857]">
                  สภาทนายความ ในพระบรมราชูปถัมภ์ · ฝ่ายทะเบียนและวิชาการ
                </p>
              </div>
            </div>

            <p className="text-sm text-slate-300 leading-relaxed">
              พอร์ทัลควบคุมสำหรับบุคลากรภายในและวิทยากร เชื่อมต่อฐานข้อมูลกลางเดียวกับฝั่งผู้เรียน
              ผ่านเลเยอร์ API ที่ตรวจสอบสิทธิ์ตามเมทริกซ์ RBAC และการยืนยันตัวตนสองชั้น
              (MFA Step-up AAL2) ทุกคำสั่งแก้ไขข้อมูลสำคัญจะถูกบันทึกใน Audit Log แบบแก้ไขย้อนหลังไม่ได้
            </p>

            <div className="space-y-3 pt-3 border-t border-white/10 text-xs text-slate-300">
              <div className="font-semibold text-[#e2b857]">
                สิทธิ์การเข้าถึงตามบทบาท (Role-Based Access Control):
              </div>
              <div className="flex items-start gap-2.5">
                <UserCog className="w-4 h-4 text-[#e2b857] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-white">Super Admin:</span>{" "}
                  จัดการผู้ใช้ มอบ/เพิกถอนบทบาท ตั้งค่า Feature Flags และดูแลทุกระบบ
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <FileCheck2 className="w-4 h-4 text-[#e2b857] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-white">Registrar (นายทะเบียน):</span>{" "}
                  ตรวจสอบ/อนุมัติใบอนุญาตทนายความ ออกหรือเพิกถอนใบประกาศ และปรับปรุงบัญชีหน่วยกิต
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <BookOpenCheck className="w-4 h-4 text-[#e2b857] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-white">
                    Course Admin & Instructor:
                  </span>{" "}
                  สร้างหลักสูตร จัดการคลังข้อสอบ และอนุมัติเผยแพร่หลักสูตรขึ้นหน้าเว็บผู้เรียน
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <Eye className="w-4 h-4 text-[#e2b857] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-white">Auditor (ผู้ตรวจสอบ):</span>{" "}
                  ตรวจสอบรายงานและบันทึกเหตุการณ์สำคัญ (Audit Log) แบบอ่านอย่างเดียว
                </div>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-white/10 text-xs text-slate-400">
            หากต้องการเข้าเรียนหรือดูหน่วยกิตในฐานะผู้เรียน กรุณาใช้{" "}
            <Link href="/login" className="text-[#e2b857] underline">
              พอร์ทัลผู้เรียน (Frontoffice Login)
            </Link>
          </div>
        </div>

        {/* Right Authentication & MFA Form Column */}
        <div className="lg:col-span-7 p-8 sm:p-10 bg-white text-slate-900 flex flex-col justify-between">
          <div>
            {/* Step Indicator */}
            <div className="flex items-center gap-3 mb-6 text-xs font-semibold">
              <span
                className={`px-3 py-1 rounded-md ${
                  step === "credentials"
                    ? "bg-[#0b1f3a] text-[#e2b857]"
                    : "bg-emerald-50 text-emerald-800"
                }`}
              >
                1. ยืนยันรหัสเจ้าหน้าที่ (AAL1)
              </span>
              <span className="text-slate-300">→</span>
              <span
                className={`px-3 py-1 rounded-md ${
                  step === "mfa"
                    ? "bg-[#0b1f3a] text-[#e2b857]"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                2. ยืนยันรหัสความปลอดภัยสองชั้น (MFA Step-up AAL2)
              </span>
            </div>

            {errorMsg && (
              <div
                role="alert"
                className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm flex items-start gap-3"
              >
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>{errorMsg}</div>
              </div>
            )}

            {step === "credentials" ? (
              <form onSubmit={handleCredentialsSubmit} className="space-y-5">
                <div>
                  <h2 className="text-xl font-bold text-[#0b1f3a]">
                    เข้าสู่ระบบบริหารจัดการ (Backoffice Login)
                  </h2>
                  <p className="text-sm text-slate-500 mt-1">
                    เฉพาะบุคลากรสภาทนายความและวิทยากรที่ได้รับมอบหมายสิทธิ์เท่านั้น
                    (บัญชีผู้เรียนทั่วไปจะถูกปฏิเสธด้วยรหัส 403 Forbidden)
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="bo-email"
                    className="block text-sm font-semibold text-slate-800"
                  >
                    อีเมลเจ้าหน้าที่ / วิทยากร
                  </label>
                  <input
                    id="bo-email"
                    type="email"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="admin@ltc.or.th"
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0b1f3a]"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="bo-password"
                    className="block text-sm font-semibold text-slate-800"
                  >
                    รหัสผ่าน (Password)
                  </label>
                  <input
                    id="bo-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="กรอกรหัสผ่านเจ้าหน้าที่"
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0b1f3a]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-5 rounded-xl bg-[#0b1f3a] text-[#e2b857] font-semibold text-sm hover:bg-[#132f54] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Lock className="w-4 h-4" />
                  <span>
                    {loading
                      ? "กำลังตรวจสอบสิทธิ์เจ้าหน้าที่..."
                      : "ดำเนินการต่อสู่การยืนยันตัวตนสองชั้น (MFA Step-up)"}
                  </span>
                </button>

                {/* Quick Role Personas for Testing Backoffice RBAC */}
                <div className="pt-5 border-t border-slate-200">
                  <div className="text-xs font-semibold text-slate-500 mb-3">
                    เลือกบทบาทเจ้าหน้าที่เพื่อทดสอบระบบ (Backoffice Demo Accounts):
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() =>
                        handleQuickStaffSelect(
                          "admin@ltc.or.th",
                          "Admin@2569",
                          "123456",
                        )
                      }
                      className="p-3 rounded-xl border border-slate-200 hover:border-[#0b1f3a] hover:bg-slate-50 text-left transition-all cursor-pointer"
                    >
                      <div className="text-xs font-bold text-[#0b1f3a]">
                        Super Admin (ผู้ดูแลระบบสูงสุด)
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        ดร.เกรียงไกร พิทักษ์ธรรม · สิทธิ์ครบทุกเมนู + จัดการบทบาท
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleQuickStaffSelect(
                          "registrar@ltc.or.th",
                          "Registrar@2569",
                          "256900",
                        )
                      }
                      className="p-3 rounded-xl border border-slate-200 hover:border-[#0b1f3a] hover:bg-slate-50 text-left transition-all cursor-pointer"
                    >
                      <div className="text-xs font-bold text-[#0b1f3a]">
                        Registrar (นายทะเบียนสภาทนายความ)
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        คุณสมหญิง ศรีวิไล · ตรวจใบอนุญาต / ใบประกาศ / หน่วยกิต
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleQuickStaffSelect(
                          "content@ltc.or.th",
                          "Content@2569",
                          "123456",
                        )
                      }
                      className="p-3 rounded-xl border border-slate-200 hover:border-[#0b1f3a] hover:bg-slate-50 text-left transition-all cursor-pointer"
                    >
                      <div className="text-xs font-bold text-[#0b1f3a]">
                        Content Staff (เจ้าหน้าที่ฝ่ายเนื้อหาหลักสูตร)
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        คุณกนกวรรณ พัฒนากุล · อนุมัติเผยแพร่หลักสูตร / จัดการบทเรียน
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleQuickStaffSelect(
                          "instructor@ltc.or.th",
                          "Instructor@2569",
                          "123456",
                        )
                      }
                      className="p-3 rounded-xl border border-slate-200 hover:border-[#0b1f3a] hover:bg-slate-50 text-left transition-all cursor-pointer"
                    >
                      <div className="text-xs font-bold text-[#0b1f3a]">
                        Instructor (วิทยากรผู้สอน)
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        ศ.ดร.สมชาย นิติศาสตร์ · สร้างเนื้อหาและข้อสอบหลักสูตรตนเอง
                      </div>
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <form onSubmit={handleMfaSubmit} className="space-y-5">
                <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                  <div className="text-xs text-emerald-900">
                    <div className="font-bold">
                      ตรวจสอบรหัสผ่านสำเร็จ: {loggedUser?.displayName} (
                      {loggedUser?.email})
                    </div>
                    <div className="mt-0.5">
                      บทบาทที่ได้รับมอบหมาย:{" "}
                      {loggedUser?.roles
                        .map((r) => ROLE_LABELS_TH[r] || r)
                        .join(", ")}
                    </div>
                  </div>
                </div>

                <div>
                  <h2 className="text-xl font-bold text-[#0b1f3a]">
                    ยืนยันตัวตนสองชั้น (MFA Step-Up AAL2)
                  </h2>
                  <p className="text-sm text-slate-600 mt-1">
                    ตามมาตรฐานความปลอดภัยของสภาทนายความ (RBAC-DELEGATION-MATRIX §5)
                    บัญชีเจ้าหน้าที่และวิทยากรต้องยกระดับเซสชันเป็น{" "}
                    <code className="font-mono font-bold text-[#0b1f3a]">aal2</code>{" "}
                    ก่อนเข้าจัดการข้อมูล
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="mfa-otp"
                      className="block text-sm font-semibold text-slate-800"
                    >
                      รหัส OTP 6 หลัก (TOTP Authenticator)
                    </label>
                    <span className="text-xs text-[#7a5b14] font-semibold">
                      รหัสทดสอบสำหรับบัญชีนี้:{" "}
                      <code className="font-mono bg-amber-100 px-1.5 py-0.5 rounded">
                        {mfaHint}
                      </code>
                    </span>
                  </div>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="mfa-otp"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value)}
                      placeholder="123456"
                      className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 text-lg font-mono tracking-widest text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0b1f3a]"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setStep("credentials")}
                    className="py-3 px-4 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    เปลี่ยนบัญชี
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 py-3 px-5 rounded-xl bg-[#0b1f3a] text-[#e2b857] font-semibold text-sm hover:bg-[#132f54] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span>
                      {loading
                        ? "กำลังยกระดับเซสชัน AAL2..."
                        : "ยืนยันรหัส OTP และเข้าสู่ระบบบริหารจัดการ"}
                    </span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-[1180px] w-full mx-auto text-center text-xs text-slate-500">
        © 2569 สภาทนายความ ในพระบรมราชูปถัมภ์ · ระบบบริหารจัดการอีเลิร์นนิ่งและทะเบียนหน่วยกิต
      </div>
    </div>
  );
}

export default function BackofficeLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#071529] text-sm text-slate-300">
          กำลังโหลดพอร์ทัลเจ้าหน้าที่...
        </div>
      }
    >
      <BackofficeLoginContent />
    </Suspense>
  );
}

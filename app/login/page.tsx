"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ShieldCheck,
  Lock,
  Mail,
  UserCheck,
  Award,
  BookOpen,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Scale,
} from "lucide-react";
import { LtcEmblem } from "@/components/ltc/LtcEmblem";
import { PublicHeader, PublicFooter } from "@/components/ltc/PublicShell";

function FrontofficeAuthContent({
  defaultTab = "login",
}: {
  defaultTab?: "login" | "register";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get("next") || "/my/courses";

  const [tab, setTab] = useState<"login" | "register">(defaultTab);
  const [identifier, setIdentifier] = useState("lawyer@ltc.or.th");
  const [password, setPassword] = useState("Lawyer@2569");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Registration state
  const [regFirstName, setRegFirstName] = useState("");
  const [regLastName, setRegLastName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regTrack, setRegTrack] = useState<"citizen" | "lawyer">("lawyer");
  const [regLicenseNo, setRegLicenseNo] = useState("");
  const [regPdpa, setRegPdpa] = useState(true);

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          portal: "frontoffice",
          identifier,
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(
          data?.error?.message || "ไม่สามารถเข้าสู่ระบบได้ กรุณาตรวจสอบข้อมูล",
        );
        setLoading(false);
        return;
      }
      router.push(nextUrl);
      router.refresh();
    } catch {
      setErrorMsg("เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์");
      setLoading(false);
    }
  }

  async function handleQuickPersonaLogin(emailInput: string, passInput: string) {
    setIdentifier(emailInput);
    setPassword(passInput);
    setErrorMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          portal: "frontoffice",
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
      router.push(nextUrl);
      router.refresh();
    } catch {
      setErrorMsg("เกิดข้อผิดพลาดในการเชื่อมต่อ");
      setLoading(false);
    }
  }

  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register",
          firstName: regFirstName,
          lastName: regLastName,
          email: regEmail,
          phone: regPhone,
          password: regPassword,
          roleTrack: regTrack,
          licenseNo: regLicenseNo,
          pdpaAccepted: regPdpa,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(
          data?.error?.message || "ไม่สามารถสมัครสมาชิกได้ กรุณาตรวจสอบข้อมูล",
        );
        setLoading(false);
        return;
      }
      router.push("/my/courses");
      router.refresh();
    } catch {
      setErrorMsg("เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      <PublicHeader />

      <main className="flex-1 py-10 px-4 sm:px-6">
        <div className="max-w-[1160px] mx-auto grid grid-cols-1 lg:grid-cols-12 rounded-2xl overflow-hidden border border-slate-200 bg-white shadow-lg">
          {/* Left Institutional Showcase Panel */}
          <div className="lg:col-span-5 bg-gradient-to-br from-[#0b1f3a] via-[#132f54] to-[#1a4373] text-white p-8 sm:p-10 flex flex-col justify-between relative overflow-hidden">
            <div className="space-y-6 relative z-10">
              <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-[#e2b857]">
                <Scale className="w-4 h-4" />
                <span>FRONTOFFICE · พอร์ทัลสำหรับผู้เรียนและทนายความ</span>
              </div>

              <div className="flex items-center gap-3.5">
                <LtcEmblem size={52} variant="gold" />
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                    สภาทนายความ ในพระบรมราชูปถัมภ์
                  </h1>
                  <p className="text-xs text-[#e2b857]">
                    สถาบันพัฒนาวิชาชีพทนายความ และระบบคลังหน่วยกิตดิจิทัล
                  </p>
                </div>
              </div>

              <p className="text-sm text-slate-200 leading-relaxed">
                ยกระดับมาตรฐานวิชาชีพทนายความไทยด้วยหลักสูตรออนไลน์มาตรฐานสภาทนายความ
                เรียนจบ สอบผ่านวัดผลปลายหลักสูตร รับใบประกาศนียบัตรดิจิทัลและสะสมหน่วยกิต
                CPE อัตโนมัติทันที
              </p>

              <div className="space-y-4 pt-2 border-t border-white/15">
                <div className="flex items-start gap-3">
                  <Award className="w-5 h-5 text-[#e2b857] shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-white">
                      สมุดสะสมหน่วยกิต (Credit Bank) อัตโนมัติ
                    </div>
                    <div className="text-xs text-slate-300 leading-relaxed">
                      คำนวณหน่วยกิตสุทธิจากบัญชีแยกประเภท (Immutable Credit Ledger)
                      พร้อมแจ้งเตือนสถานะรอบปี พ.ศ. 2569
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <ShieldCheck className="w-5 h-5 text-[#e2b857] shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-white">
                      ตรวจสอบใบอนุญาตว่าความกับนายทะเบียนโดยตรง
                    </div>
                    <div className="text-xs text-slate-300 leading-relaxed">
                      ยื่นผูกเลขใบอนุญาตทนายความเพื่อปลดล็อกหลักสูตรเฉพาะทนายความและสะสมหน่วยกิตต่อเนื่อง
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-[#e2b857] shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-white">
                      เปิดกว้างสำหรับประชาชนทั่วไป (Citizen Track)
                    </div>
                    <div className="text-xs text-slate-300 leading-relaxed">
                      ประชาชนและนักศึกษากฎหมายสามารถสมัครเรียนหลักสูตรความรู้กฎหมายทั่วไปและรับใบประกาศได้ฟรี
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom link to Backoffice Management Portal */}
            <div className="mt-8 pt-6 border-t border-white/15 relative z-10">
              <div className="text-xs text-slate-300 mb-2">
                คุณเป็นเจ้าหน้าที่สภาทนายความ นายทะเบียน หรือวิทยากรใช่หรือไม่?
              </div>
              <Link
                href="/backoffice/login"
                className="inline-flex items-center gap-2 text-xs font-semibold text-[#e2b857] hover:text-amber-300 transition-colors"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>เข้าสู่ระบบบริหารจัดการหลังบ้าน (Backoffice Management Portal)</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>

          {/* Right Form Column */}
          <div className="lg:col-span-7 p-8 sm:p-10 flex flex-col justify-between">
            <div>
              {/* Segmented Tab Switcher */}
              <div
                role="tablist"
                aria-label="เลือกรูปแบบการเข้าใช้งาน"
                className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl mb-6"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "login"}
                  onClick={() => {
                    setTab("login");
                    setErrorMsg(null);
                  }}
                  className={`py-2.5 px-4 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${
                    tab === "login"
                      ? "bg-white text-[#0b1f3a] shadow-sm"
                      : "text-slate-600 hover:text-[#0b1f3a]"
                  }`}
                >
                  เข้าสู่ระบบผู้เรียน (Login)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "register"}
                  onClick={() => {
                    setTab("register");
                    setErrorMsg(null);
                  }}
                  className={`py-2.5 px-4 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${
                    tab === "register"
                      ? "bg-white text-[#0b1f3a] shadow-sm"
                      : "text-slate-600 hover:text-[#0b1f3a]"
                  }`}
                >
                  ลงทะเบียนสมาชิกใหม่ (Register)
                </button>
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

              {tab === "login" ? (
                <form onSubmit={handleLoginSubmit} className="space-y-5">
                  <div>
                    <h2 className="text-xl font-bold text-[#0b1f3a]">
                      เข้าสู่ระบบสำหรับผู้เรียนและทนายความ
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">
                      สามารถใช้อีเมลที่ลงทะเบียน หรือเลขที่ใบอนุญาตว่าความ (เช่น{" "}
                      <span className="font-mono font-semibold text-slate-700">
                        25891
                      </span>
                      ) เพื่อเข้าสู่ระบบ
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="login-identifier"
                      className="block text-sm font-semibold text-slate-800"
                    >
                      อีเมล หรือ เลขที่ใบอนุญาตทนายความ
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="login-identifier"
                        type="text"
                        required
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        placeholder="เช่น lawyer@ltc.or.th หรือ 25891"
                        className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1a4373] focus:border-[#1a4373]"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="login-password"
                        className="block text-sm font-semibold text-slate-800"
                      >
                        รหัสผ่าน (Password)
                      </label>
                      <span className="text-xs text-slate-500">
                        รหัสผ่านเริ่มต้นสำหรับทดสอบ: <code className="font-mono">Lawyer@2569</code>
                      </span>
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="login-password"
                        type="password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="กรอกรหัสผ่านของคุณ"
                        className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1a4373] focus:border-[#1a4373]"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-5 rounded-xl bg-[#0b1f3a] text-white font-semibold text-sm hover:bg-[#132f54] transition-colors flex items-center justify-center gap-2 disabled:opacity-60 cursor-pointer"
                  >
                    <span>
                      {loading ? "กำลังตรวจสอบสิทธิ์..." : "เข้าสู่ระบบผู้เรียน (Frontoffice)"}
                    </span>
                    <ArrowRight className="w-4 h-4 text-[#e2b857]" />
                  </button>

                  {/* Quick-Fill Demo Learner Personas */}
                  <div className="pt-5 border-t border-slate-200">
                    <div className="text-xs font-semibold text-slate-500 mb-3">
                      บัญชีผู้เรียนตัวอย่างสำหรับทดสอบระบบ (คลิกเพื่อเข้าสู่ระบบทันที):
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickPersonaLogin("lawyer@ltc.or.th", "Lawyer@2569")
                        }
                        className="p-3 rounded-xl border border-slate-200 hover:border-[#c89b3c] hover:bg-amber-50/40 text-left transition-all cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-[#0b1f3a]">
                            ทนายความ (Verified Lawyer)
                          </span>
                          <span className="text-[11px] font-mono text-[#7a5b14]">
                            ทล. 25891
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 mt-0.5">
                          ธนกร วัฒนกุล · 8/12 หน่วยกิต · 2 ใบประกาศ
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          handleQuickPersonaLogin("citizen@ltc.or.th", "Citizen@2569")
                        }
                        className="p-3 rounded-xl border border-slate-200 hover:border-[#1a4373] hover:bg-slate-50 text-left transition-all cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-[#0b1f3a]">
                            ประชาชนทั่วไป (Citizen)
                          </span>
                          <span className="text-[11px] text-amber-700 font-medium">
                            รอตรวจใบอนุญาต
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 mt-0.5">
                          ปิยะพร แสงทอง · ยื่นคำขอ ทล. 39812
                        </div>
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleRegisterSubmit} className="space-y-4">
                  <div>
                    <h2 className="text-xl font-bold text-[#0b1f3a]">
                      สมัครสมาชิกใหม่ (ผู้เรียน / ทนายความ)
                    </h2>
                    <p className="text-sm text-slate-500 mt-0.5">
                      บัญชีใหม่จะได้รับสิทธิ์พื้นฐานประชาชนทั่วไป (Citizen) ทันที
                      และสามารถส่งคำขอผูกเลขใบอนุญาตทนายความเพื่อให้นายทะเบียนอนุมัติได้
                    </p>
                  </div>

                  {/* Role Track Selection */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setRegTrack("lawyer")}
                      className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                        regTrack === "lawyer"
                          ? "border-[#0b1f3a] bg-[#f0f6fc]"
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm font-bold text-[#0b1f3a]">
                        <UserCheck className="w-4 h-4 text-[#c89b3c]" />
                        <span>ทนายความ (ยื่นเลขใบอนุญาต)</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">
                        ต้องการสะสมหน่วยกิต CPE และเรียนหลักสูตรเฉพาะทนายความ
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setRegTrack("citizen")}
                      className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                        regTrack === "citizen"
                          ? "border-[#0b1f3a] bg-[#f0f6fc]"
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm font-bold text-[#0b1f3a]">
                        <CheckCircle2 className="w-4 h-4 text-[#1a4373]" />
                        <span>ประชาชนทั่วไป / นักศึกษา</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">
                        ต้องการศึกษาหลักสูตรกฎหมายทั่วไปและรับใบประกาศนียบัตร
                      </p>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="reg-firstname"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        ชื่อจริง (ไม่ต้องระบุคำนำหน้า)
                      </label>
                      <input
                        id="reg-firstname"
                        type="text"
                        required
                        value={regFirstName}
                        onChange={(e) => setRegFirstName(e.target.value)}
                        placeholder="เช่น กิตติพงศ์"
                        className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="reg-lastname"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        นามสกุล
                      </label>
                      <input
                        id="reg-lastname"
                        type="text"
                        required
                        value={regLastName}
                        onChange={(e) => setRegLastName(e.target.value)}
                        placeholder="เช่น รัตนากร"
                        className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="reg-email"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        อีเมล (Email)
                      </label>
                      <input
                        id="reg-email"
                        type="email"
                        required
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="name@example.com"
                        className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="reg-phone"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        เบอร์โทรศัพท์มือถือ
                      </label>
                      <input
                        id="reg-phone"
                        type="tel"
                        value={regPhone}
                        onChange={(e) => setRegPhone(e.target.value)}
                        placeholder="08X-XXX-XXXX"
                        className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                      />
                    </div>
                  </div>

                  {regTrack === "lawyer" && (
                    <div>
                      <label
                        htmlFor="reg-license"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        เลขที่ใบอนุญาตให้เป็นทนายความ (4–7 หลัก)
                      </label>
                      <input
                        id="reg-license"
                        type="text"
                        required
                        value={regLicenseNo}
                        onChange={(e) => setRegLicenseNo(e.target.value)}
                        placeholder="เช่น 48219"
                        className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm font-mono"
                      />
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="reg-password"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      ตั้งรหัสผ่าน (อย่างน้อย 8 ตัวอักษร)
                    </label>
                    <input
                      id="reg-password"
                      type="password"
                      required
                      minLength={8}
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="อย่างน้อย 8 ตัวอักษร"
                      className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                    />
                  </div>

                  <label className="flex items-start gap-2.5 text-xs text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={regPdpa}
                      onChange={(e) => setRegPdpa(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300"
                    />
                    <span>
                      ข้าพเจ้ายอมรับเงื่อนไขการใช้งานและนโยบายคุ้มครองข้อมูลส่วนบุคคล (PDPA)
                      ของสภาทนายความ ในพระบรมราชูปถัมภ์
                    </span>
                  </label>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-5 rounded-xl bg-[#0b1f3a] text-white font-semibold text-sm hover:bg-[#132f54] transition-colors flex items-center justify-center gap-2 disabled:opacity-60 cursor-pointer"
                  >
                    <span>
                      {loading ? "กำลังสร้างบัญชี..." : "ยืนยันการสมัครสมาชิก"}
                    </span>
                    <ArrowRight className="w-4 h-4 text-[#e2b857]" />
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}

export default function FrontofficeLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#f7f8fa] text-sm text-slate-500">
          กำลังโหลดหน้าเข้าสู่ระบบ...
        </div>
      }
    >
      <FrontofficeAuthContent defaultTab="login" />
    </Suspense>
  );
}

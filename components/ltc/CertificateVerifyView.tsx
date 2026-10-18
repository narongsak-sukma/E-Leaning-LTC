"use client";

import React, { useEffect, useState } from "react";
import {
  ShieldCheck,
  Search,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Lock,
  Award,
} from "lucide-react";
import { LtcEmblem, formatThaiDate } from "@/components/ltc/LtcEmblem";
import { PublicHeader, PublicFooter } from "@/components/ltc/PublicShell";

interface VerifiedCertData {
  verificationCode: string;
  status: "valid" | "revoked" | "superseded";
  recipientName: string;
  courseTitle: string;
  issuedAt: string;
  creditsAwarded: number;
  revokedAt: string | null;
  revokedReason: string | null;
  issuer: string;
}

export function CertificateVerifyView({
  initialCode = "LTC-2026-483920",
}: {
  initialCode?: string;
}) {
  const [codeInput, setCodeInput] = useState(initialCode);
  const [cert, setCert] = useState<VerifiedCertData | null>(null);
  const [errorInfo, setErrorInfo] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  async function verifyCode(targetCode: string) {
    const clean = targetCode.trim().toUpperCase();
    if (!clean) return;
    setLoading(true);
    setErrorInfo(null);
    try {
      const res = await fetch(`/api/v1/verify/${encodeURIComponent(clean)}`);
      const data = await res.json();
      if (!res.ok || !data.found) {
        setCert(null);
        setErrorInfo({
          code: data?.error?.code || "ERR-CERT-001",
          message:
            data?.error?.message ||
            "ไม่พบข้อมูลใบประกาศนียบัตรรหัสนี้ในสารบบสภาทนายความ",
        });
      } else {
        setCert(data.certificate);
      }
    } catch {
      setErrorInfo({
        code: "ERR-SYS-001",
        message: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ตรวจสอบได้",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialCode) {
      verifyCode(initialCode);
    }
  }, [initialCode]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    verifyCode(codeInput);
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      <PublicHeader />

      <main className="flex-1 max-w-[980px] w-full mx-auto px-4 sm:px-6 py-10 space-y-8">
        {/* Search Box Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
                PUBLIC CERTIFICATE VERIFICATION · ระบบตรวจสอบใบประกาศนียบัตร
              </div>
              <h1 className="text-2xl font-bold text-[#0b1f3a] mt-1">
                ตรวจสอบความถูกต้องของประกาศนียบัตรดิจิทัล
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                ระบุรหัสตรวจสอบ 15 หลัก (รูปแบบ{" "}
                <code className="font-mono font-bold text-[#0b1f3a]">
                  LTC-YYYY-XXXXXX
                </code>
                ) เพื่อตรวจสอบสถานะจากฐานข้อมูลทะเบียนกลางสภาทนายความ
              </p>
            </div>
            <LtcEmblem size={48} variant="navy" />
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex flex-col sm:flex-row gap-3"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="รหัสตรวจสอบใบประกาศนียบัตร"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="เช่น LTC-2026-483920"
                className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0b1f3a]"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-3 rounded-xl bg-[#0b1f3a] text-[#e2b857] font-semibold text-sm hover:bg-[#132f54] transition-colors cursor-pointer"
            >
              {loading ? "กำลังตรวจสอบ..." : "ตรวจสอบรหัส"}
            </button>
          </form>

          {/* Sample Quick Switchers (Valid / Revoked / Invalid) */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 text-xs">
            <span className="text-slate-500 font-medium">
              ทดสอบรหัสตัวอย่าง:
            </span>
            <button
              type="button"
              onClick={() => {
                setCodeInput("LTC-2026-483920");
                verifyCode("LTC-2026-483920");
              }}
              className="px-3 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono font-semibold hover:bg-emerald-100 cursor-pointer"
            >
              LTC-2026-483920 (สถานะปกติ Valid)
            </button>
            <button
              type="button"
              onClick={() => {
                setCodeInput("LTC-2025-990112");
                verifyCode("LTC-2025-990112");
              }}
              className="px-3 py-1 rounded-lg bg-red-50 text-red-800 border border-red-200 font-mono font-semibold hover:bg-red-100 cursor-pointer"
            >
              LTC-2025-990112 (ถูกเพิกถอน Revoked)
            </button>
            <button
              type="button"
              onClick={() => {
                setCodeInput("LTC-2026-000000");
                verifyCode("LTC-2026-000000");
              }}
              className="px-3 py-1 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 font-mono font-semibold hover:bg-slate-200 cursor-pointer"
            >
              LTC-2026-000000 (ไม่พบข้อมูล)
            </button>
          </div>
        </div>

        {/* Verification Result Card */}
        {errorInfo && (
          <div
            role="alert"
            className="bg-white rounded-2xl border-2 border-amber-300 p-6 sm:p-8 shadow-sm flex items-start gap-4"
          >
            <AlertTriangle className="w-7 h-7 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1.5">
              <div className="text-xs font-mono font-bold text-amber-800">
                {errorInfo.code}
              </div>
              <h2 className="text-lg font-bold text-slate-900">
                ไม่พบข้อมูลประกาศนียบัตรในสารบบ
              </h2>
              <p className="text-sm text-slate-600">{errorInfo.message}</p>
            </div>
          </div>
        )}

        {cert && (
          <div
            className={`bg-white rounded-2xl border-2 p-6 sm:p-10 shadow-sm space-y-6 ${
              cert.status === "valid"
                ? "border-[#c89b3c]"
                : "border-red-300 bg-red-50/20"
            }`}
          >
            {/* Status Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-200">
              <div className="flex items-center gap-3.5">
                {cert.status === "valid" ? (
                  <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-7 h-7" />
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                    <XCircle className="w-7 h-7" />
                  </div>
                )}
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    ผลการตรวจสอบจากสารบบกลางสภาทนายความ
                  </div>
                  <h2
                    className={`text-xl font-bold ${
                      cert.status === "valid"
                        ? "text-emerald-800"
                        : "text-red-800"
                    }`}
                  >
                    {cert.status === "valid"
                      ? "ใบประกาศนียบัตรฉบับนี้มีสถานะถูกต้องและมีผลบังคับใช้ (VALID)"
                      : "ใบประกาศนียบัตรฉบับนี้ถูกเพิกถอนแล้ว (REVOKED)"}
                  </h2>
                </div>
              </div>
              <div className="text-left sm:text-right">
                <div className="text-xs text-slate-500">รหัสตรวจสอบ</div>
                <div className="font-mono text-base font-bold text-[#0b1f3a]">
                  {cert.verificationCode}
                </div>
              </div>
            </div>

            {cert.status === "revoked" && (
              <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 space-y-1">
                <div className="font-bold">
                  สาเหตุการเพิกถอน: {cert.revokedReason || "เพิกถอนตามคำสั่งนายทะเบียน"}
                </div>
                {cert.revokedAt && (
                  <div>วันที่เพิกถอน: {formatThaiDate(cert.revokedAt)}</div>
                )}
              </div>
            )}

            {/* Official Certificate Preview Body */}
            <div className="rounded-xl border border-[#c89b3c]/40 bg-gradient-to-b from-[#fcfaf5] to-white p-6 sm:p-8 space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <LtcEmblem size={44} variant="navy" />
                  <div>
                    <div className="text-sm font-bold text-[#0b1f3a]">
                      {cert.issuer}
                    </div>
                    <div className="text-xs text-slate-500">
                      LAWYERS COUNCIL OF THAILAND UNDER THE ROYAL PATRONAGE
                    </div>
                  </div>
                </div>
                <Award className="w-8 h-8 text-[#c89b3c]" />
              </div>

              <div className="space-y-2 py-2">
                <div className="text-xs text-slate-500">
                  ขอมอบประกาศนียบัตรฉบับนี้เพื่อแสดงว่า
                </div>
                <div className="text-2xl font-bold text-[#0b1f3a]">
                  {cert.recipientName}
                </div>
                <div className="text-xs text-slate-500 pt-1">
                  ได้ผ่านการอบรมและสอบวัดผลตามเกณฑ์มาตรฐานในหลักสูตร
                </div>
                <div className="text-lg font-bold text-[#1a4373]">
                  {cert.courseTitle}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-200/80 text-xs">
                <div>
                  <div className="text-slate-500">วันที่ออกใบประกาศนียบัตร</div>
                  <div className="font-semibold text-slate-900 mt-0.5">
                    {formatThaiDate(cert.issuedAt)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">หน่วยกิตการศึกษาต่อเนื่อง (CPE)</div>
                  <div className="font-semibold font-mono text-[#7a5b14] mt-0.5">
                    {cert.creditsAwarded > 0
                      ? `${cert.creditsAwarded} หน่วยกิต`
                      : "หลักสูตรทั่วไป"}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">สถานะในทะเบียน</div>
                  <div
                    className={`font-semibold mt-0.5 ${
                      cert.status === "valid"
                        ? "text-emerald-700"
                        : "text-red-700"
                    }`}
                  >
                    {cert.status === "valid" ? "ปกติ (Valid)" : "เพิกถอนแล้ว (Revoked)"}
                  </div>
                </div>
              </div>
            </div>

            {/* PDPA Minimal Disclosure Notice */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-start gap-3 text-xs text-slate-600">
              <Lock className="w-4 h-4 text-[#0b1f3a] shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-slate-800">
                  มาตรการคุ้มครองข้อมูลส่วนบุคคล (PDPA Minimal Disclosure):
                </span>{" "}
                หน้าตรวจสอบสาธารณะแสดงเฉพาะชื่อผู้ได้รับ หลักสูตร วันที่ออก และสถานะใบประกาศเท่านั้น
                โดยไม่เปิดเผยเลขประจำตัวประชาชน อีเมล เบอร์โทรศัพท์ หรือเลขที่ใบอนุญาตว่าความ
              </div>
            </div>
          </div>
        )}
      </main>

      <PublicFooter />
    </div>
  );
}

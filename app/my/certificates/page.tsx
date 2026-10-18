"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FileBadge, ExternalLink, Printer, CheckCircle2 } from "lucide-react";
import { LearnerShell } from "@/components/ltc/LearnerShell";
import { LtcEmblem, formatThaiDate } from "@/components/ltc/LtcEmblem";

export default function LearnerCertificatesPage() {
  const [data, setData] = useState<any>(null);
  const [selectedCert, setSelectedCert] = useState<any>(null);

  const loadData = useCallback(async () => {
    const res = await fetch("/api/v1/learner");
    if (res.status === 401) {
      await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "switch_demo",
          userId: "u-lawyer-001",
          portal: "frontoffice",
        }),
      });
      const retry = await fetch("/api/v1/learner");
      if (retry.ok) {
        const d = await retry.json();
        setData(d);
        if (d.certificates?.length > 0) setSelectedCert(d.certificates[0]);
      }
    } else if (res.ok) {
      const d = await res.json();
      setData(d);
      if (d.certificates?.length > 0) setSelectedCert(d.certificates[0]);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSwitchPersona(userId: string) {
    await fetch("/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "switch_demo",
        userId,
        portal: "frontoffice",
      }),
    });
    await loadData();
  }

  return (
    <LearnerShell
      user={data?.user ?? null}
      roles={data?.roles ?? []}
      verifiedLicense={data?.verifiedLicense ?? null}
      netCredits={data?.creditMeter?.netCredits ?? 0}
      requiredCredits={data?.creditMeter?.requiredCredits ?? 12}
      onSwitchPersona={handleSwitchPersona}
    >
      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <div className="text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
            DIGITAL CERTIFICATES · ประกาศนียบัตรอิเล็กทรอนิกส์ของฉัน
          </div>
          <h1 className="text-2xl font-bold text-[#0b1f3a] mt-1">
            ประกาศนียบัตรที่ได้รับ ({data?.certificates?.length ?? 0} ฉบับ)
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            คลิกเลือกใบประกาศเพื่อดูตัวอย่างฉบับทางการ พิมพ์เอกสาร หรือเปิดลิงก์ตรวจสอบสาธารณะ
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
            {(data?.certificates || []).map((cert: any) => (
              <div
                key={cert.id}
                onClick={() => setSelectedCert(cert)}
                className={`p-5 rounded-xl border text-left transition-all cursor-pointer ${
                  selectedCert?.id === cert.id
                    ? "border-[#0b1f3a] bg-[#f0f6fc]"
                    : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-bold text-[#0b1f3a]">
                    {cert.verificationCode}
                  </span>
                  <span className="text-emerald-700 font-semibold">
                    ✓ มีผลบังคับใช้ (Valid)
                  </span>
                </div>
                <div className="text-base font-bold text-[#0b1f3a] mt-1.5">
                  {cert.courseTitleTh}
                </div>
                <div className="flex items-center justify-between text-xs text-slate-500 mt-3 pt-3 border-t border-slate-200/70">
                  <span>ออกเมื่อ {formatThaiDate(cert.issuedAt)}</span>
                  <span className="font-mono font-bold text-[#7a5b14]">
                    +{cert.creditsAwarded} หน่วยกิต CPE
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Official Certificate Preview Frame */}
        {selectedCert && (
          <div className="bg-white rounded-2xl border-2 border-[#c89b3c] p-8 sm:p-12 shadow-md space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
              <div className="text-xs font-mono text-slate-500">
                VERIFICATION CODE:{" "}
                <strong className="text-[#0b1f3a]">
                  {selectedCert.verificationCode}
                </strong>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>พิมพ์ / บันทึก PDF</span>
                </button>
                <Link
                  href={`/verify/${selectedCert.verificationCode}`}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54]"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-[#e2b857]" />
                  <span>เปิดหน้าตรวจสอบสาธารณะ</span>
                </Link>
              </div>
            </div>

            <div className="text-center space-y-3 py-6">
              <div className="flex justify-center mb-2">
                <LtcEmblem size={64} variant="gold" />
              </div>
              <div className="text-sm font-bold text-[#7a5b14] tracking-widest uppercase">
                สภาทนายความ ในพระบรมราชูปถัมภ์
              </div>
              <div className="text-xs text-slate-500">
                ขอมอบประกาศนียบัตรฉบับนี้เพื่อแสดงว่า
              </div>
              <div className="text-2xl sm:text-3xl font-bold text-[#0b1f3a] py-1">
                {selectedCert.recipientName}
              </div>
              <div className="text-sm text-slate-600">
                ได้ผ่านการฝึกอบรมและสอบวัดผลสำเร็จตามหลักสูตรของสถาบันพัฒนาวิชาชีพทนายความ
              </div>
              <div className="text-xl font-bold text-[#1a4373]">
                หลักสูตร “{selectedCert.courseTitleTh}”
              </div>
              <div className="text-xs text-slate-500 pt-2">
                ให้ไว้ ณ วันที่ {formatThaiDate(selectedCert.issuedAt)} ·
                รับรองหน่วยกิตการพัฒนาวิชาชีพทนายความต่อเนื่องจำนวน{" "}
                <strong className="text-[#0b1f3a]">
                  {selectedCert.creditsAwarded} หน่วยกิต
                </strong>
              </div>
            </div>
          </div>
        )}
      </div>
    </LearnerShell>
  );
}

"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Scale,
  CheckCircle2,
  Clock,
  XCircle,
  Send,
  AlertCircle,
} from "lucide-react";
import { LearnerShell } from "@/components/ltc/LearnerShell";
import { formatThaiDateTime } from "@/components/ltc/LtcEmblem";

export default function LearnerLicensePage() {
  const [data, setData] = useState<any>(null);
  const [licenseNo, setLicenseNo] = useState("");
  const [evidenceNote, setEvidenceNote] = useState(
    "สำเนาบัตรประจำตัวทนายความ สภาทนายความ ในพระบรมราชูปถัมภ์",
  );
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    const res = await fetch("/api/v1/learner");
    if (res.status === 401) {
      await fetch("/api/v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "switch_demo",
          userId: "u-citizen-001",
          portal: "frontoffice",
        }),
      });
      const retry = await fetch("/api/v1/learner");
      if (retry.ok) setData(await retry.json());
    } else if (res.ok) {
      setData(await res.json());
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
    setFeedback(null);
    await loadData();
  }

  async function handleSubmitLicense(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/learner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply_license",
          licenseNo,
          evidenceNote,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setFeedback({
          type: "error",
          message: result?.error?.message || "ไม่สามารถส่งคำขอได้",
        });
      } else {
        setFeedback({
          type: "success",
          message: `ส่งคำขอผูกเลขใบอนุญาต ทล. ${licenseNo} เข้าสู่คิวนายทะเบียน (Backoffice) เรียบร้อยแล้ว`,
        });
        setLicenseNo("");
        await loadData();
      }
    } finally {
      setSubmitting(false);
    }
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
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-6">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
              LAWYER LICENSE VERIFICATION · ข้อมูลใบอนุญาตให้เป็นทนายความ
            </div>
            <h1 className="text-2xl font-bold text-[#0b1f3a] mt-1">
              สถานะใบอนุญาตว่าความและการยื่นคำขอรับรองสิทธิ์
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              คำขอที่ยื่นจากหน้านี้จะถูกส่งไปยังคิวนายทะเบียนสภาทนายความในระบบหลังบ้าน
              (Backoffice: <code className="font-mono">/admin/licenses</code>)
              เมื่อนายทะเบียนอนุมัติ ระบบจะมอบบทบาท{" "}
              <code className="font-mono font-bold">lawyer</code> แบบ Atomic ทันที
            </p>
          </div>

          {data?.verifiedLicense ? (
            <div className="p-6 rounded-2xl bg-emerald-50 border border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3.5">
                <CheckCircle2 className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" />
                <div>
                  <div className="text-base font-bold text-emerald-950">
                    ยืนยันใบอนุญาตว่าความแล้ว: ทล.{" "}
                    <span className="font-mono">
                      {data.verifiedLicense.licenseNo}
                    </span>
                  </div>
                  <div className="text-xs text-emerald-800 mt-1">
                    คุณได้รับสิทธิ์เข้าเรียนหลักสูตรเฉพาะทนายความทุกหลักสูตร
                    และเปิดใช้งานสมุดสะสมหน่วยกิต (CPE Credit Bank) เรียบร้อยแล้ว
                  </div>
                </div>
              </div>
              <span className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-bold self-start">
                VERIFIED LAWYER
              </span>
            </div>
          ) : (
            <form
              onSubmit={handleSubmitLicense}
              className="p-6 rounded-2xl bg-[#f7f8fa] border border-slate-200 space-y-4"
            >
              <div className="text-base font-bold text-[#0b1f3a]">
                ยื่นคำขอผูกเลขที่ใบอนุญาตว่าความ (สำหรับผู้เรียนที่ยังไม่ได้รับรองสิทธิ์ทนายความ)
              </div>

              {feedback && (
                <div
                  role="alert"
                  className={`p-4 rounded-xl text-xs font-medium flex items-start gap-2.5 ${
                    feedback.type === "success"
                      ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
                      : "bg-red-50 border border-red-200 text-red-900"
                  }`}
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{feedback.message}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="lic-number-input"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    เลขที่ใบอนุญาตว่าความ (ตัวเลข 4–7 หลัก)
                  </label>
                  <input
                    id="lic-number-input"
                    type="text"
                    required
                    value={licenseNo}
                    onChange={(e) => setLicenseNo(e.target.value)}
                    placeholder="เช่น 45892"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-slate-300 text-sm font-mono"
                  />
                </div>
                <div>
                  <label
                    htmlFor="lic-evidence-input"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    เอกสาร/ข้อมูลอ้างอิงประกอบการตรวจสอบ
                  </label>
                  <input
                    id="lic-evidence-input"
                    type="text"
                    required
                    value={evidenceNote}
                    onChange={(e) => setEvidenceNote(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-slate-300 text-sm"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54] transition-colors inline-flex items-center gap-2 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5 text-[#e2b857]" />
                <span>
                  {submitting
                    ? "กำลังส่งคำขอ..."
                    : "ส่งคำขอให้นายทะเบียนสภาทนายความตรวจสอบ"}
                </span>
              </button>
            </form>
          )}

          {/* Application History */}
          <div className="space-y-3 pt-2">
            <h2 className="text-sm font-bold text-[#0b1f3a]">
              ประวัติคำขอผูกเลขที่ใบอนุญาตของคุณ
            </h2>
            {!data?.licenseApplications ||
            data.licenseApplications.length === 0 ? (
              <div className="text-xs text-slate-500">
                ไม่มีประวัติคำขอผูกเลขใบอนุญาต
              </div>
            ) : (
              <div className="space-y-2.5">
                {data.licenseApplications.map((app: any) => (
                  <div
                    key={app.id}
                    className="p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="font-bold text-slate-900">
                        เลขที่ใบอนุญาตที่ยื่น: ทล.{" "}
                        <span className="font-mono">{app.licenseNo}</span>
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        {app.evidenceNote} · ยื่นเมื่อ{" "}
                        {formatThaiDateTime(app.submittedAt)}
                      </div>
                      {app.rejectedReason && (
                        <div className="text-red-700 font-medium mt-1">
                          เหตุผลที่ปฏิเสธ: {app.rejectedReason}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 font-semibold">
                      {app.status === "approved" ? (
                        <span className="text-emerald-700">
                          ● อนุมัติแล้ว (Approved)
                        </span>
                      ) : app.status === "pending" ? (
                        <span className="text-amber-700">
                          ● รอนายทะเบียนตรวจสอบ (Pending)
                        </span>
                      ) : (
                        <span className="text-red-700">
                          ● ไม่ผ่านการอนุมัติ (Rejected)
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </LearnerShell>
  );
}

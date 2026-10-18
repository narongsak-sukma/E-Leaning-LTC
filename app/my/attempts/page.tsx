"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCheck, CheckCircle2, XCircle, Eye } from "lucide-react";
import { LearnerShell } from "@/components/ltc/LearnerShell";
import { formatThaiDateTime } from "@/components/ltc/LtcEmblem";

export default function LearnerAttemptsPage() {
  const [data, setData] = useState<any>(null);

  const loadData = useCallback(async () => {
    const res = await fetch("/api/v1/learner");
    if (res.ok) setData(await res.json());
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
      <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
            ASSESSMENT ATTEMPTS · ประวัติการสอบวัดผลปลายหลักสูตร
          </div>
          <h1 className="text-2xl font-bold text-[#0b1f3a] mt-1">
            ผลการสอบวัดผลของคุณ ({data?.attempts?.length ?? 0} ครั้ง)
          </h1>
        </div>

        <div className="space-y-3">
          {(data?.attempts || []).map((att: any) => (
            <div
              key={att.id}
              className="p-5 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono font-bold text-[#0b1f3a]">
                    {att.code}
                  </span>
                  <span>·</span>
                  <span>ครั้งที่ {att.attemptNo}</span>
                  <span>·</span>
                  <span>{formatThaiDateTime(att.submittedAt || att.startedAt)}</span>
                </div>
                <div className="text-base font-bold text-[#0b1f3a]">
                  {att.courseTitleTh}
                </div>
                <div className="text-xs text-slate-600">
                  คะแนนที่ได้:{" "}
                  <strong className="font-mono tabular-nums text-slate-900">
                    {att.scorePct ?? 0}%
                  </strong>{" "}
                  (เกณฑ์ผ่าน {att.passPctSnapshot}%) · นโยบายการเฉลย:{" "}
                  <code className="font-mono">{att.reviewMode}</code>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span
                  className={`text-xs font-bold ${
                    att.status === "passed"
                      ? "text-emerald-700"
                      : att.status === "failed"
                        ? "text-red-700"
                        : "text-amber-700"
                  }`}
                >
                  {att.status === "passed"
                    ? "✓ สอบผ่านเกณฑ์"
                    : att.status === "failed"
                      ? "✕ ไม่ผ่านเกณฑ์"
                      : "กำลังทำข้อสอบ"}
                </span>

                <Link
                  href={`/courses/${att.courseId}/exam?attemptId=${att.id}`}
                  className="px-3.5 py-2 rounded-lg bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54]"
                >
                  ดูผลสอบรายโมดูล / เฉลย
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </LearnerShell>
  );
}

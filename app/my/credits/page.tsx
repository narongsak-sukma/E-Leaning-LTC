"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Award, CheckCircle2, ArrowUpRight, ShieldCheck } from "lucide-react";
import { LearnerShell } from "@/components/ltc/LearnerShell";
import { formatThaiDateTime } from "@/components/ltc/LtcEmblem";

export default function LearnerCreditBankPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
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
      if (retry.ok) setData(await retry.json());
    } else if (res.ok) {
      setData(await res.json());
    }
    setLoading(false);
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
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-5">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
                CPE CREDIT BANK · สมุดสะสมหน่วยกิตการพัฒนาวิชาชีพทนายความต่อเนื่อง
              </div>
              <h1 className="text-2xl font-bold text-[#0b1f3a] mt-1">
                สรุปหน่วยกิตประจำรอบปี พ.ศ.{" "}
                {data?.creditCycle?.cycleYearBuddhist ?? 2569}
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                คำนวณยอดสุทธิจากบัญชีแยกประเภทหน่วยกิต (Immutable Credit Ledger:{" "}
                <code className="font-mono">accrual + adjustment - reversal</code>)
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold font-mono tabular-nums text-[#0b1f3a]">
                {data?.creditMeter?.netCredits ?? 0} /{" "}
                {data?.creditMeter?.requiredCredits ?? 12}
              </div>
              <div className="text-xs text-slate-500">
                หน่วยกิตสะสมสุทธิ ({data?.creditMeter?.percentage ?? 0}%)
              </div>
            </div>
          </div>

          {/* Progress Meter */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-slate-700">
                สถานะรอบสะสมหน่วยกิต:{" "}
                <span className="text-emerald-700">
                  {data?.creditMeter?.labelTh ?? "อยู่ในเกณฑ์ปกติ"}
                </span>
              </span>
              <span className="text-slate-500 font-mono tabular-nums">
                เหลือเวลาอีก {data?.creditMeter?.daysRemaining ?? 120} วัน (สิ้นสุด
                31 ธ.ค. 2569)
              </span>
            </div>
            <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-[#c89b3c] rounded-full transition-all"
                style={{ width: `${data?.creditMeter?.percentage ?? 0}%` }}
              />
            </div>
          </div>
        </div>

        {/* Immutable Credit Ledger Table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-[#0b1f3a]">
                รายการเดินบัญชีหน่วยกิต (Immutable Credit Ledger)
              </h2>
              <p className="text-xs text-slate-500">
                ทุกรายการบันทึกแบบ Append-only พร้อมเชื่อมโยงรหัสใบประกาศนียบัตรและผู้ดำเนินการ
              </p>
            </div>
          </div>

          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">
              กำลังโหลดบัญชีหน่วยกิต...
            </div>
          ) : !data?.creditLedger || data.creditLedger.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              ยังไม่มีรายการสะสมหน่วยกิตในรอบปีนี้
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                    <th className="py-3 px-4 font-semibold">วัน-เวลาที่บันทึก</th>
                    <th className="py-3 px-4 font-semibold">ประเภทรายการ</th>
                    <th className="py-3 px-4 font-semibold">
                      หลักสูตร / รายละเอียดอ้างอิง
                    </th>
                    <th className="py-3 px-4 font-semibold text-right">
                      หน่วยกิต (Delta)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.creditLedger.map((row: any) => (
                    <tr key={row.id} className="hover:bg-slate-50/80">
                      <td className="py-3.5 px-4 text-xs text-slate-500 font-mono whitespace-nowrap">
                        {formatThaiDateTime(row.createdAt)}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-semibold whitespace-nowrap">
                        {row.entryType === "accrual" ? (
                          <span className="text-emerald-700">
                            ● สะสมจากสอบผ่าน (Accrual)
                          </span>
                        ) : row.entryType === "adjustment" ? (
                          <span className="text-blue-700">
                            ▲ ปรับปรุงเพิ่มโดยนายทะเบียน (Adjustment)
                          </span>
                        ) : (
                          <span className="text-red-700">
                            ▼ หักคืนหน่วยกิต (Reversal)
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900">
                          {row.courseTitleTh || "รายการปรับปรุงหน่วยกิต"}
                        </div>
                        <div className="text-xs text-slate-500">{row.reason}</div>
                      </td>
                      <td
                        className={`py-3.5 px-4 text-right font-mono font-bold tabular-nums ${
                          row.creditsDelta >= 0
                            ? "text-emerald-700"
                            : "text-red-700"
                        }`}
                      >
                        {row.creditsDelta >= 0
                          ? `+${row.creditsDelta.toFixed(2)}`
                          : row.creditsDelta.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </LearnerShell>
  );
}

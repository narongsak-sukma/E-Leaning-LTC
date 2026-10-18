"use client";

import React, { useState } from "react";
import { Award } from "lucide-react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";
import { formatThaiDateTime } from "@/components/ltc/LtcEmblem";

export default function AdminCreditsPage() {
  const { data, feedback, reload, mutate } = useBackofficeData();

  const [targetUserId, setTargetUserId] = useState("u-lawyer-001");
  const [creditsDelta, setCreditsDelta] = useState(2);
  const [reason, setReason] = useState(
    "เทียบโอนหน่วยกิตจากการสัมมนาวิชาการสภาทนายความภาค 1",
  );

  async function handleAdjustSubmit(e: React.FormEvent) {
    e.preventDefault();
    await mutate(
      {
        action: "adjust_credit",
        userId: targetUserId,
        creditsDelta,
        reason,
      },
      `บันทึกปรับปรุงหน่วยกิต (${creditsDelta > 0 ? `+${creditsDelta}` : creditsDelta} CPE) ลงใน Immutable Credit Ledger เรียบร้อยแล้ว`,
    );
  }

  return (
    <BackofficeShell
      title="เกณฑ์หน่วยกิตและบัญชีแยกประเภทหน่วยกิต (CPE Credit Rules & Immutable Ledger)"
      subtitle="ปรับปรุงหน่วยกิตทนายความแบบ Append-only (Adjustment / Reversal) โดยทุกการเปลี่ยนแปลงจะแสดงบนสมุดสะสมหน่วยกิตของผู้เรียนทันที"
      data={data}
      onRefresh={reload}
    >
      <div className="space-y-6">
        {feedback && (
          <div
            role="alert"
            className={`p-4 rounded-xl text-xs font-semibold border ${
              feedback.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : "bg-red-50 border-red-200 text-red-900"
            }`}
          >
            {feedback.message}
          </div>
        )}

        {/* Credit Ledger Adjustment Form */}
        <form
          onSubmit={handleAdjustSubmit}
          className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
        >
          <h2 className="text-base font-bold text-[#0b1f3a]">
            ปรับปรุงหน่วยกิตทนายความโดยนายทะเบียน (P-CREDIT-LEDGER-ADJUST)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                เลือกทนายความ
              </label>
              <select
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs"
              >
                {(data?.users || []).map((u: any) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} (ยอดปัจจุบัน: {u.netCredits} CPE)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                จำนวนหน่วยกิต (+เพิ่ม / -หักคืน)
              </label>
              <input
                type="number"
                step="0.5"
                required
                value={creditsDelta}
                onChange={(e) => setCreditsDelta(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                เหตุผลประกอบใน Audit Log
              </label>
              <input
                type="text"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs"
              />
            </div>
            <button
              type="submit"
              className="py-2.5 px-4 rounded-xl bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] cursor-pointer"
            >
              บันทึกรายการหน่วยกิต
            </button>
          </div>
        </form>

        {/* Immutable Credit Ledger Table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200">
            <h2 className="text-base font-bold text-[#0b1f3a]">
              สมุดบัญชีแยกประเภทหน่วยกิตกลาง (Master Credit Ledger)
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                  <th className="py-3.5 px-4 font-semibold">วัน-เวลา</th>
                  <th className="py-3.5 px-4 font-semibold">ทนายความ</th>
                  <th className="py-3.5 px-4 font-semibold">ประเภท</th>
                  <th className="py-3.5 px-4 font-semibold">
                    รายละเอียด / เหตุผล
                  </th>
                  <th className="py-3.5 px-4 font-semibold text-right">
                    หน่วยกิต
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data?.creditLedger || []).map((row: any) => (
                  <tr key={row.id} className="hover:bg-slate-50/80">
                    <td className="py-3.5 px-4 text-xs font-mono text-slate-500 whitespace-nowrap">
                      {formatThaiDateTime(row.createdAt)}
                    </td>
                    <td className="py-3.5 px-4 text-xs font-bold text-[#0b1f3a] whitespace-nowrap">
                      {row.userName}{" "}
                      {row.userLicenseNo && `(ทล. ${row.userLicenseNo})`}
                    </td>
                    <td className="py-3.5 px-4 text-xs font-semibold whitespace-nowrap">
                      {row.entryType}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-600">
                      <div className="font-semibold text-slate-900">
                        {row.courseTitleTh}
                      </div>
                      <div>{row.reason}</div>
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
        </div>
      </div>
    </BackofficeShell>
  );
}

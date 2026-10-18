"use client";

import React, { useState } from "react";
import { Download, Search } from "lucide-react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";
import { formatThaiDateTime } from "@/components/ltc/LtcEmblem";

export default function AdminReportsAndAuditPage() {
  const { data, reload } = useBackofficeData();
  const [search, setSearch] = useState("");

  const logs = (data?.auditLogs || []).filter((l: any) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      l.eventType.toLowerCase().includes(q) ||
      l.actorName.toLowerCase().includes(q) ||
      l.summaryTh.toLowerCase().includes(q) ||
      l.targetId.toLowerCase().includes(q)
    );
  });

  function handleExportCsv() {
    const headers = [
      "id",
      "eventType",
      "actorName",
      "actorRole",
      "targetTable",
      "targetId",
      "summaryTh",
      "ipHash",
      "createdAt",
    ];
    const rows = logs.map((l: any) =>
      headers
        .map((h) => `"${String(l[h] ?? "").replace(/"/g, '""')}"`)
        .join(","),
    );
    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ltc-audit-logs-2569.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <BackofficeShell
      title="รายงานสถิติและบันทึกการตรวจสอบความปลอดภัย (Reports & Immutable Audit Log)"
      subtitle="ตรวจสอบประวัติการดำเนินการทั้งหมดในระบบแบบ Append-only พร้อมส่งออกรายงาน CSV สำหรับผู้ตรวจสอบ (Auditor)"
      data={data}
      onRefresh={reload}
    >
      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="relative flex-1 min-w-[260px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              aria-label="ค้นหา Audit Log"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาตามประเภทเหตุการณ์ ชื่อผู้ดำเนินการ หรือรหัสเป้าหมาย..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-xs"
            />
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            className="px-4 py-2 rounded-xl bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] inline-flex items-center gap-2 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>ส่งออกรายงาน Audit Log (Download CSV)</span>
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                  <th className="py-3.5 px-4 font-semibold">วัน-เวลา</th>
                  <th className="py-3.5 px-4 font-semibold">Event Type</th>
                  <th className="py-3.5 px-4 font-semibold">ผู้ดำเนินการ / บทบาท</th>
                  <th className="py-3.5 px-4 font-semibold">รายละเอียด</th>
                  <th className="py-3.5 px-4 font-semibold">IP Hash (PDPA)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((log: any) => (
                  <tr key={log.id} className="hover:bg-slate-50/80 text-xs">
                    <td className="py-3.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                      {formatThaiDateTime(log.createdAt)}
                    </td>
                    <td className="py-3.5 px-4 font-mono font-bold text-[#0b1f3a] whitespace-nowrap">
                      {log.eventType}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="font-bold text-slate-900">
                        {log.actorName}
                      </div>
                      <div className="font-mono text-slate-500">
                        {log.actorRole}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-700">
                      {log.summaryTh}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-400 whitespace-nowrap">
                      {log.ipHash}
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

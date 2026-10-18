"use client";

import React, { useState } from "react";
import { CheckCircle2, XCircle, Scale } from "lucide-react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";
import { formatThaiDateTime } from "@/components/ltc/LtcEmblem";

export default function AdminLicensesPage() {
  const { data, feedback, reload, mutate } = useBackofficeData();
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});

  const applications = data?.licenseApplications || [];

  return (
    <BackofficeShell
      title="ตรวจสอบและอนุมัติใบอนุญาตว่าความ (Registrar License Verification)"
      subtitle="งานนายทะเบียนสภาทนายความ: การอนุมัติจะผูกใบอนุญาตและมอบบทบาททนายความ (lawyer) พร้อมเปิดสมุดสะสมหน่วยกิตแบบ Atomic"
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

        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200">
            <h2 className="text-base font-bold text-[#0b1f3a]">
              รายการคำขอผูกเลขที่ใบอนุญาตว่าความทั้งหมด ({applications.length})
            </h2>
          </div>

          <div className="divide-y divide-slate-100">
            {applications.map((app: any) => (
              <div
                key={app.id}
                className="p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-bold text-[#0b1f3a] bg-slate-100 px-2.5 py-0.5 rounded">
                      ทล. {app.licenseNo}
                    </span>
                    <span className="font-bold text-slate-900">
                      {app.applicantName} ({app.applicantEmail})
                    </span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500">
                      ยื่นเมื่อ {formatThaiDateTime(app.submittedAt)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-600">
                    หลักฐานประกอบ: {app.evidenceNote}
                  </div>
                  {app.rejectedReason && (
                    <div className="text-xs text-red-700 font-semibold">
                      เหตุผลที่ปฏิเสธ: {app.rejectedReason}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  {app.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          mutate(
                            {
                              action: "approve_license",
                              applicationId: app.id,
                            },
                            `อนุมัติใบอนุญาต ทล. ${app.licenseNo} ของ ${app.applicantName} และมอบบทบาท lawyer สำเร็จ`,
                          )
                        }
                        className="px-4 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800 cursor-pointer"
                      >
                        ✓ อนุมัติ & มอบสิทธิ์ทนายความ (Atomic)
                      </button>

                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={rejectReason[app.id] ?? ""}
                          onChange={(e) =>
                            setRejectReason((prev) => ({
                              ...prev,
                              [app.id]: e.target.value,
                            }))
                          }
                          placeholder="ระบุเหตุผลหากปฏิเสธ..."
                          className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs w-44"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            mutate(
                              {
                                action: "reject_license",
                                applicationId: app.id,
                                reason:
                                  rejectReason[app.id] ||
                                  "ข้อมูลเลขที่ใบอนุญาตไม่ตรงกับสารบบนายทะเบียน",
                              },
                              `ปฏิเสธคำขอใบอนุญาต ทล. ${app.licenseNo} เรียบร้อยแล้ว`,
                            )
                          }
                          className="px-3 py-2 rounded-xl border border-red-300 text-red-700 text-xs font-semibold hover:bg-red-50 cursor-pointer"
                        >
                          ปฏิเสธคำขอ
                        </button>
                      </div>
                    </>
                  ) : app.status === "approved" ? (
                    <span className="text-xs font-bold text-emerald-700">
                      ✓ อนุมัติแล้ว ({app.deciderName || "นายทะเบียน"})
                    </span>
                  ) : (
                    <span className="text-xs font-bold text-red-700">
                      ✕ ปฏิเสธแล้ว
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </BackofficeShell>
  );
}

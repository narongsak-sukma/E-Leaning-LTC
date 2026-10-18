"use client";

import React, { useState } from "react";
import Link from "next/link";
import { FileBadge, ExternalLink, Plus, XCircle } from "lucide-react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";
import { formatThaiDate } from "@/components/ltc/LtcEmblem";

export default function AdminCertificatesPage() {
  const { data, feedback, reload, mutate } = useBackofficeData();
  const [selectedUserId, setSelectedUserId] = useState("u-lawyer-001");
  const [selectedCourseId, setSelectedCourseId] = useState("crs-104");
  const [revokeReason, setRevokeReason] = useState<Record<string, string>>({});

  const certificates = data?.certificates || [];
  const users = data?.users || [];
  const courses = (data?.courses || []).filter(
    (c: any) => c.status === "published",
  );

  async function handleManualIssue(e: React.FormEvent) {
    e.preventDefault();
    await mutate(
      {
        action: "issue_certificate",
        userId: selectedUserId,
        courseId: selectedCourseId,
      },
      "ออกประกาศนียบัตรแบบ Manual และบันทึก Audit Log เรียบร้อยแล้ว",
    );
  }

  return (
    <BackofficeShell
      title="ทะเบียนประกาศนียบัตรดิจิทัลและการเพิกถอน (Certificate Registry)"
      subtitle="ตรวจสอบรายการประกาศนียบัตรทั้งหมด ออกใบประกาศแบบ Manual และเพิกถอนพร้อมหักคืนหน่วยกิตอัตโนมัติ"
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

        {/* Manual Issue Form */}
        <form
          onSubmit={handleManualIssue}
          className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
        >
          <h2 className="text-base font-bold text-[#0b1f3a]">
            ออกประกาศนียบัตรโดยนายทะเบียน (Manual Certificate Issuance · P-CERT-ISSUE-MANUAL)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                เลือกผู้เรียน / ทนายความ
              </label>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs"
              >
                {users.map((u: any) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} ({u.email})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                เลือกหลักสูตรที่ผ่านการอบรม
              </label>
              <select
                value={selectedCourseId}
                onChange={(e) => setSelectedCourseId(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs"
              >
                {courses.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.titleTh} ({c.credits} CPE)
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="py-2.5 px-5 rounded-xl bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] cursor-pointer"
            >
              ออกใบประกาศนียบัตรดิจิทัล
            </button>
          </div>
        </form>

        {/* Certificates Registry Table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                  <th className="py-3.5 px-4 font-semibold">รหัสตรวจสอบ</th>
                  <th className="py-3.5 px-4 font-semibold">
                    ผู้รับประกาศนียบัตร / หลักสูตร
                  </th>
                  <th className="py-3.5 px-4 font-semibold">วันที่ออก</th>
                  <th className="py-3.5 px-4 font-semibold text-right">
                    หน่วยกิต
                  </th>
                  <th className="py-3.5 px-4 font-semibold">สถานะ</th>
                  <th className="py-3.5 px-4 font-semibold text-right">
                    การจัดการ
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {certificates.map((cert: any) => (
                  <tr key={cert.id} className="hover:bg-slate-50/80">
                    <td className="py-4 px-4 font-mono font-bold text-[#0b1f3a] whitespace-nowrap">
                      {cert.verificationCode}
                    </td>
                    <td className="py-4 px-4">
                      <div className="font-bold text-slate-900">
                        {cert.recipientName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {cert.courseTitleTh}
                      </div>
                      {cert.revokedReason && (
                        <div className="text-xs text-red-700 font-medium mt-0.5">
                          เหตุผลที่เพิกถอน: {cert.revokedReason}
                        </div>
                      )}
                    </td>
                    <td className="py-4 px-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatThaiDate(cert.issuedAt)} ({cert.issueMode})
                    </td>
                    <td className="py-4 px-4 text-right font-mono font-bold text-[#7a5b14] tabular-nums">
                      {cert.creditsAwarded} CPE
                    </td>
                    <td className="py-4 px-4 text-xs font-bold whitespace-nowrap">
                      {cert.status === "valid" ? (
                        <span className="text-emerald-700">● ถูกต้อง (Valid)</span>
                      ) : (
                        <span className="text-red-700">
                          ● ถูกเพิกถอน (Revoked)
                        </span>
                      )}
                    </td>
                    <td className="py-4 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <Link
                          href={`/verify/${cert.verificationCode}`}
                          className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>ตรวจสอบ</span>
                        </Link>
                        {cert.status === "valid" && (
                          <div className="inline-flex items-center gap-1">
                            <input
                              type="text"
                              value={revokeReason[cert.id] ?? ""}
                              onChange={(e) =>
                                setRevokeReason((prev) => ({
                                  ...prev,
                                  [cert.id]: e.target.value,
                                }))
                              }
                              placeholder="เหตุผลเพิกถอน..."
                              className="px-2.5 py-1 rounded-lg border border-slate-300 text-xs w-32"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                mutate(
                                  {
                                    action: "revoke_certificate",
                                    certificateId: cert.id,
                                    reason:
                                      revokeReason[cert.id] ||
                                      "เพิกถอนตามคำสั่งนายทะเบียนสภาทนายความ",
                                  },
                                  `เพิกถอนใบประกาศ ${cert.verificationCode} และหักคืนหน่วยกิตเรียบร้อยแล้ว`,
                                )
                              }
                              className="px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 text-xs font-semibold hover:bg-red-50 cursor-pointer"
                            >
                              เพิกถอน
                            </button>
                          </div>
                        )}
                      </div>
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

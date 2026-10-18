"use client";

import React, { useState } from "react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";
import { ROLE_LABELS_TH } from "@/components/ltc/LtcEmblem";

const ASSIGNABLE_ROLES = [
  "citizen",
  "lawyer",
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
  "super_admin",
];

export default function AdminUsersPage() {
  const { data, feedback, reload, mutate } = useBackofficeData();
  const [selectedRoleByUser, setSelectedRoleByUser] = useState<
    Record<string, string>
  >({});

  const users = data?.users || [];

  return (
    <BackofficeShell
      title="จัดการบัญชีผู้ใช้งานและสิทธิ์ตามบทบาท (Users & RBAC Role Delegation)"
      subtitle="ควบคุมสิทธิ์แบบ Multi-Role (Citizen, Lawyer, Instructor, Viewer, Content, Exam, Registrar, Super Admin) พร้อมป้องกันการลบ Super Admin คนสุดท้าย"
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
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                  <th className="py-3.5 px-4 font-semibold">ชื่อ-นามสกุล / อีเมล</th>
                  <th className="py-3.5 px-4 font-semibold">ใบอนุญาต / หน่วยกิต</th>
                  <th className="py-3.5 px-4 font-semibold">
                    บทบาทที่ถือครอง (Active Roles)
                  </th>
                  <th className="py-3.5 px-4 font-semibold text-right">
                    มอบบทบาทเพิ่ม (Grant Role · role:grant)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u: any) => {
                  const chosenRole =
                    selectedRoleByUser[u.id] || "staff:content";
                  return (
                    <tr key={u.id} className="hover:bg-slate-50/80">
                      <td className="py-4 px-4">
                        <div className="font-bold text-[#0b1f3a]">
                          {u.displayName}
                        </div>
                        <div className="text-xs text-slate-500">{u.email}</div>
                      </td>
                      <td className="py-4 px-4 text-xs">
                        {u.licenseNo ? (
                          <span className="font-mono font-bold text-emerald-800">
                            ทล. {u.licenseNo}
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                        <div className="text-slate-500 font-mono">
                          หน่วยกิต: {u.netCredits} CPE
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(u.roles || []).map((r: string) => (
                            <span
                              key={r}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 text-xs font-mono text-slate-800"
                            >
                              <span>{r}</span>
                              {r !== "citizen" && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    mutate(
                                      {
                                        action: "revoke_role",
                                        userId: u.id,
                                        role: r,
                                        reason: "เพิกถอนบทบาทโดยผู้ดูแลระบบ",
                                      },
                                      `เพิกถอนบทบาท ${r} ของ ${u.displayName} เรียบร้อยแล้ว`,
                                    )
                                  }
                                  className="text-red-600 hover:text-red-800 font-bold cursor-pointer"
                                  aria-label={`เพิกถอนบทบาท ${r} ของ ${u.displayName}`}
                                >
                                  ×
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-4 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <select
                            aria-label={`เลือกบทบาทสำหรับ ${u.displayName}`}
                            value={chosenRole}
                            onChange={(e) =>
                              setSelectedRoleByUser((prev) => ({
                                ...prev,
                                [u.id]: e.target.value,
                              }))
                            }
                            className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
                          >
                            {ASSIGNABLE_ROLES.map((roleKey) => (
                              <option key={roleKey} value={roleKey}>
                                {roleKey} ({ROLE_LABELS_TH[roleKey] || roleKey})
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              mutate(
                                {
                                  action: "grant_role",
                                  userId: u.id,
                                  role: chosenRole,
                                  reason: "มอบหมายบทบาทเพิ่มเติมโดยผู้ดูแลระบบ",
                                },
                                `มอบบทบาท ${chosenRole} ให้แก่ ${u.displayName} สำเร็จ`,
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] cursor-pointer"
                          >
                            + มอบสิทธิ์
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </BackofficeShell>
  );
}

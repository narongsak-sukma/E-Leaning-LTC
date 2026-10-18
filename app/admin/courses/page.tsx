"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Plus,
  CheckCircle2,
  Send,
  Archive,
  ExternalLink,
  XCircle,
} from "lucide-react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";

export default function AdminCoursesPage() {
  const { data, feedback, reload, mutate } = useBackofficeData();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);

  // Create Course Form State
  const [code, setCode] = useState("LTC-205");
  const [titleTh, setTitleTh] = useState("");
  const [categoryId, setCategoryId] = useState("cat-civil");
  const [audience, setAudience] = useState<"all" | "lawyer_only">("lawyer_only");
  const [credits, setCredits] = useState(3);
  const [durationMinutes, setDurationMinutes] = useState(120);
  const [descriptionTh, setDescriptionTh] = useState("");

  const courses = (data?.courses || []).filter((c: any) =>
    statusFilter === "all" ? true : c.status === statusFilter,
  );

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await mutate(
      {
        action: "create_course",
        code,
        titleTh,
        categoryId,
        audience,
        credits,
        durationMinutes,
        descriptionTh,
      },
      `สร้างหลักสูตรใหม่ ${code} '${titleTh}' ในสถานะฉบับร่าง (draft) เรียบร้อยแล้ว`,
    );
    if (ok) {
      setShowCreate(false);
      setTitleTh("");
      setDescriptionTh("");
    }
  }

  return (
    <BackofficeShell
      title="จัดการหลักสูตรและการอนุมัติเผยแพร่ (Course Lifecycle Management)"
      subtitle="ควบคุมวงจรชีวิตหลักสูตร: ฉบับร่าง (Draft) → รออนุมัติ (Pending Review) → เผยแพร่บนหน้าเว็บผู้เรียน (Published)"
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

        {/* Toolbar */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { key: "all", label: "ทั้งหมด" },
              { key: "published", label: "เผยแพร่แล้ว (Published)" },
              { key: "pending_review", label: "รออนุมัติ (Pending Review)" },
              { key: "draft", label: "ฉบับร่าง (Draft)" },
              { key: "rejected", label: "ส่งคืนแก้ไข (Rejected)" },
              { key: "archived", label: "เก็บเข้าคลัง (Archived)" },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusFilter(tab.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  statusFilter === tab.key
                    ? "bg-[#0b1f3a] text-[#e2b857]"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 rounded-xl bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>สร้างหลักสูตรใหม่ (Create Course)</span>
          </button>
        </div>

        {/* Create Course Form Drawer */}
        {showCreate && (
          <form
            onSubmit={handleCreateSubmit}
            className="bg-white rounded-2xl border-2 border-[#0b1f3a] p-6 space-y-4"
          >
            <h2 className="text-base font-bold text-[#0b1f3a]">
              สร้างหลักสูตรใหม่ (สิทธิ์ P-COURSE-CREATE-OWN: Instructor / Course Admin / Super Admin)
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label
                  htmlFor="crs-code"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  รหัสหลักสูตร
                </label>
                <input
                  id="crs-code"
                  type="text"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm font-mono uppercase"
                />
              </div>
              <div className="sm:col-span-2">
                <label
                  htmlFor="crs-title"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  ชื่อหลักสูตรภาษาไทย
                </label>
                <input
                  id="crs-title"
                  type="text"
                  required
                  value={titleTh}
                  onChange={(e) => setTitleTh(e.target.value)}
                  placeholder="เช่น กฎหมายแรงงานและการระงับข้อพิพาทแรงงาน"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label
                  htmlFor="crs-cat"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  หมวดหมู่หลักสูตร
                </label>
                <select
                  id="crs-cat"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                >
                  {(data?.categories || []).map((cat: any) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.nameTh}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="crs-aud"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  กลุ่มผู้มีสิทธิ์เรียน
                </label>
                <select
                  id="crs-aud"
                  value={audience}
                  onChange={(e) =>
                    setAudience(
                      e.target.value === "lawyer_only" ? "lawyer_only" : "all",
                    )
                  }
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                >
                  <option value="lawyer_only">เฉพาะทนายความ (CPE)</option>
                  <option value="all">ประชาชนทั่วไป และ ทนายความ</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="crs-credits"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  หน่วยกิต CPE
                </label>
                <input
                  id="crs-credits"
                  type="number"
                  step="0.5"
                  min="0"
                  max="12"
                  value={credits}
                  onChange={(e) => setCredits(Number(e.target.value))}
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm font-mono"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="crs-desc"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                คำอธิบายหลักสูตรย่อ
              </label>
              <input
                id="crs-desc"
                type="text"
                value={descriptionTh}
                onChange={(e) => setDescriptionTh(e.target.value)}
                placeholder="อธิบายขอบเขตเนื้อหาและวัตถุประสงค์ของหลักสูตร"
                className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold cursor-pointer"
              >
                บันทึกสร้างหลักสูตร
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-600 cursor-pointer"
              >
                ยกเลิก
              </button>
            </div>
          </form>
        )}

        {/* Courses Table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                  <th className="py-3.5 px-4 font-semibold">รหัสวิชา</th>
                  <th className="py-3.5 px-4 font-semibold">ชื่อหลักสูตร / ผู้สอน</th>
                  <th className="py-3.5 px-4 font-semibold">กลุ่มผู้เรียน</th>
                  <th className="py-3.5 px-4 font-semibold text-right">
                    หน่วยกิต
                  </th>
                  <th className="py-3.5 px-4 font-semibold">สถานะ</th>
                  <th className="py-3.5 px-4 font-semibold text-right">
                    การจัดการ (Workflow Actions)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {courses.map((c: any) => (
                  <tr key={c.id} className="hover:bg-slate-50/80">
                    <td className="py-4 px-4 font-mono font-bold text-[#0b1f3a] whitespace-nowrap">
                      {c.code}
                    </td>
                    <td className="py-4 px-4">
                      <div className="font-bold text-slate-900">{c.titleTh}</div>
                      <div className="text-xs text-slate-500">
                        {c.categoryNameTh} · วิทยากร: {c.instructorName} ·{" "}
                        {c.lessonCount} บทเรียน
                      </div>
                    </td>
                    <td className="py-4 px-4 text-xs whitespace-nowrap">
                      {c.audience === "lawyer_only"
                        ? "เฉพาะทนายความ"
                        : "ประชาชนทั่วไป / ทนายความ"}
                    </td>
                    <td className="py-4 px-4 text-right font-mono font-bold text-[#7a5b14] tabular-nums">
                      {c.credits} CPE
                    </td>
                    <td className="py-4 px-4 text-xs font-semibold whitespace-nowrap">
                      {c.status === "published" ? (
                        <span className="text-emerald-700">
                          ● เผยแพร่แล้ว (Published)
                        </span>
                      ) : c.status === "pending_review" ? (
                        <span className="text-amber-700">
                          ● รออนุมัติ (Pending Review)
                        </span>
                      ) : c.status === "draft" ? (
                        <span className="text-slate-600">● ฉบับร่าง (Draft)</span>
                      ) : c.status === "rejected" ? (
                        <span className="text-red-700">
                          ● ส่งคืนแก้ไข (Rejected)
                        </span>
                      ) : (
                        <span className="text-slate-400">
                          ● เก็บเข้าคลัง (Archived)
                        </span>
                      )}
                    </td>
                    <td className="py-4 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {(c.status === "draft" || c.status === "rejected") && (
                          <button
                            type="button"
                            onClick={() =>
                              mutate(
                                {
                                  action: "submit_course_review",
                                  courseId: c.id,
                                },
                                `ส่งหลักสูตร ${c.code} เข้าคิวรออนุมัติเรียบร้อยแล้ว`,
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-[#1a4373] text-white text-xs font-semibold hover:bg-[#0b1f3a] cursor-pointer"
                          >
                            ส่งตรวจอนุมัติ
                          </button>
                        )}

                        {c.status === "pending_review" && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                mutate(
                                  {
                                    action: "approve_course",
                                    courseId: c.id,
                                  },
                                  `อนุมัติและเผยแพร่หลักสูตร ${c.code} สู่หน้าเว็บผู้เรียนเรียบร้อยแล้ว`,
                                )
                              }
                              className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
                            >
                              ✓ อนุมัติเผยแพร่
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                mutate(
                                  {
                                    action: "reject_course",
                                    courseId: c.id,
                                    reason: "ส่งคืนเพื่อปรับปรุงรายละเอียดข้อสอบ",
                                  },
                                  `ส่งคืนหลักสูตร ${c.code} เรียบร้อยแล้ว`,
                                )
                              }
                              className="px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 text-xs font-semibold hover:bg-red-50 cursor-pointer"
                            >
                              ส่งคืน
                            </button>
                          </>
                        )}

                        {c.status === "published" && (
                          <>
                            <Link
                              href={`/courses/${c.id}`}
                              className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>ดูหน้าผู้เรียน</span>
                            </Link>
                            <button
                              type="button"
                              onClick={() =>
                                mutate(
                                  {
                                    action: "archive_course",
                                    courseId: c.id,
                                  },
                                  `เก็บเข้าคลังหลักสูตร ${c.code} เรียบร้อยแล้ว`,
                                )
                              }
                              className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 text-xs hover:text-red-700 cursor-pointer"
                            >
                              Archive
                            </button>
                          </>
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

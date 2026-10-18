"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Users,
  BookOpen,
  FileBadge,
  Award,
  CheckCircle2,
  XCircle,
  Scale,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  RotateCcw,
} from "lucide-react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";
import { formatThaiDateTime } from "@/components/ltc/LtcEmblem";

export default function AdminDashboardPage() {
  const { data, loading, feedback, reload, mutate } = useBackofficeData();

  const pendingCourses = (data?.courses || []).filter(
    (c: any) => c.status === "pending_review",
  );
  const pendingLicenses = (data?.licenseApplications || []).filter(
    (a: any) => a.status === "pending",
  );

  return (
    <BackofficeShell
      title="ภาพรวมระบบบริหารจัดการ (Management Dashboard)"
      subtitle="ศูนย์ควบคุมหลักสูตร การสอบวัดผล ทะเบียนใบอนุญาตทนายความ และสมุดสะสมหน่วยกิต (CPE Credit Bank)"
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

        {/* 4 KPI Summary Cards (08-admin-dashboard.html aligned) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-medium text-slate-500">
              ผู้เรียนสะสมทั้งหมด / ทนายความยืนยันแล้ว
            </div>
            <div className="text-2xl font-bold text-[#0b1f3a] font-mono tabular-nums mt-1">
              {(data?.kpis?.totalLearners ?? 38427).toLocaleString()} คน
            </div>
            <div className="text-xs text-emerald-700 font-medium mt-1">
              ทนายความยืนยันสิทธิ์แล้ว{" "}
              {(data?.kpis?.verifiedLawyersCount ?? 14282).toLocaleString()} คน
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-medium text-slate-500">
              หลักสูตรที่เปิดสอน (Published)
            </div>
            <div className="text-2xl font-bold text-[#0b1f3a] font-mono tabular-nums mt-1">
              {data?.kpis?.publishedCoursesCount ?? 6} หลักสูตร
            </div>
            <div className="text-xs text-amber-700 font-semibold mt-1">
              รออนุมัติเผยแพร่ {data?.kpis?.pendingCourseReviewCount ?? 0}{" "}
              หลักสูตร
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-medium text-slate-500">
              ประกาศนียบัตรที่มีผลบังคับใช้
            </div>
            <div className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
              {(data?.kpis?.validCertificateCount ?? 19684).toLocaleString()} ฉบับ
            </div>
            <div className="text-xs text-slate-500 mt-1">
              อัตราการสอบผ่านเฉลี่ย {data?.kpis?.examPassRatePct ?? 84.6}%
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-medium text-slate-500">
              คำขอตรวจใบอนุญาตทนายความ (Registrar Queue)
            </div>
            <div className="text-2xl font-bold text-[#7a5b14] font-mono tabular-nums mt-1">
              {data?.kpis?.pendingLicenseCount ?? 0} รายการรอตรวจ
            </div>
            <div className="text-xs text-slate-500 mt-1">
              หน่วยกิตสะสมรวมในระบบ +{data?.kpis?.totalCreditsAccrued ?? 12} CPE
            </div>
          </div>
        </div>

        {/* Two-Column Action Queue: Course Approvals + License Verification */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Course Review Queue */}
          <div className="lg:col-span-6 bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-bold text-[#0b1f3a]">
                  คิวหลักสูตรรออนุมัติเผยแพร่ ({pendingCourses.length})
                </h2>
                <p className="text-xs text-slate-500">
                  เมื่ออนุมัติแล้ว หลักสูตรจะปรากฏบนหน้าแคตตาล็อกผู้เรียน (Frontoffice) ทันที
                </p>
              </div>
              <Link
                href="/admin/courses"
                className="text-xs font-semibold text-[#1a4373] hover:underline"
              >
                จัดการทั้งหมด →
              </Link>
            </div>

            {pendingCourses.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                ไม่มีหลักสูตรค้างรออนุมัติในขณะนี้
              </div>
            ) : (
              <div className="space-y-3">
                {pendingCourses.map((crs: any) => (
                  <div
                    key={crs.id}
                    className="p-4 rounded-xl border border-slate-200 space-y-3"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono font-bold text-[#0b1f3a]">
                        {crs.code} · +{crs.credits} CPE
                      </span>
                      <span className="text-amber-700 font-semibold">
                        ● รอตรวจอนุมัติ (pending_review)
                      </span>
                    </div>
                    <div className="text-sm font-bold text-[#0b1f3a]">
                      {crs.titleTh}
                    </div>
                    <div className="text-xs text-slate-500">
                      ผู้สอน: {crs.instructorName} · หมวด {crs.categoryNameTh}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() =>
                          mutate(
                            { action: "approve_course", courseId: crs.id },
                            `อนุมัติและเผยแพร่หลักสูตร ${crs.code} สู่พอร์ทัลผู้เรียนเรียบร้อยแล้ว`,
                          )
                        }
                        className="px-3.5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer inline-flex items-center gap-1.5"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>อนุมัติและเผยแพร่ (Approve & Publish)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          mutate(
                            {
                              action: "reject_course",
                              courseId: crs.id,
                              reason: "กรุณาเพิ่มกรณีศึกษาคำพิพากษาศาลฎีกาเพิ่มเติม",
                            },
                            `ส่งคืนหลักสูตร ${crs.code} ให้ผู้สอนแก้ไขแล้ว`,
                          )
                        }
                        className="px-3.5 py-2 rounded-lg border border-red-200 text-red-700 text-xs font-semibold hover:bg-red-50 cursor-pointer"
                      >
                        ส่งคืนแก้ไข
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Registrar License Verification Queue */}
          <div className="lg:col-span-6 bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-bold text-[#0b1f3a]">
                  คิวตรวจสอบใบอนุญาตทนายความ ({pendingLicenses.length})
                </h2>
                <p className="text-xs text-slate-500">
                  การอนุมัติจะผูกใบอนุญาตและมอบบทบาท{" "}
                  <code className="font-mono font-bold">lawyer</code> แบบ Atomic
                </p>
              </div>
              <Link
                href="/admin/licenses"
                className="text-xs font-semibold text-[#1a4373] hover:underline"
              >
                ดูคิวทั้งหมด →
              </Link>
            </div>

            {pendingLicenses.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                ไม่มีคำขอใบอนุญาตทนายความค้างรอตรวจสอบ
              </div>
            ) : (
              <div className="space-y-3">
                {pendingLicenses.map((app: any) => (
                  <div
                    key={app.id}
                    className="p-4 rounded-xl border border-slate-200 space-y-3"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-[#0b1f3a]">
                        ผู้ยื่นคำขอ: {app.applicantName} ({app.applicantEmail})
                      </span>
                      <span className="font-mono font-bold text-[#7a5b14]">
                        ทล. {app.licenseNo}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">
                      หลักฐานอ้างอิง: {app.evidenceNote}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() =>
                          mutate(
                            {
                              action: "approve_license",
                              applicationId: app.id,
                            },
                            `อนุมัติใบอนุญาต ทล. ${app.licenseNo} และมอบบทบาททนายความให้ ${app.applicantName} สำเร็จ`,
                          )
                        }
                        className="px-3.5 py-2 rounded-lg bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] cursor-pointer inline-flex items-center gap-1.5"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>อนุมัติใบอนุญาต & มอบสิทธิ์ทนายความ</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          mutate(
                            {
                              action: "reject_license",
                              applicationId: app.id,
                              reason: "เลขใบอนุญาตไม่ตรงกับชื่อ-นามสกุลในทะเบียนสภาทนายความ",
                            },
                            `ปฏิเสธคำขอใบอนุญาต ทล. ${app.licenseNo} เรียบร้อยแล้ว`,
                          )
                        }
                        className="px-3.5 py-2 rounded-lg border border-red-200 text-red-700 text-xs font-semibold hover:bg-red-50 cursor-pointer"
                      >
                        ปฏิเสธคำขอ
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* System Feature Flags & Recent Immutable Audit Log */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-bold text-[#0b1f3a]">
              การตั้งค่าระบบอัตโนมัติ (System Feature Flags)
            </h2>
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-900">
                    cert_auto_issue
                  </div>
                  <div className="text-[11px] text-slate-500">
                    ออกใบประกาศและสะสมหน่วยกิตอัตโนมัติเมื่อสอบผ่าน
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    mutate(
                      {
                        action: "toggle_feature_flag",
                        flagKey: "cert_auto_issue",
                        enabled: !data?.featureFlags?.cert_auto_issue,
                      },
                      "อัปเดตสถานะ Feature Flag cert_auto_issue เรียบร้อยแล้ว",
                    )
                  }
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${
                    data?.featureFlags?.cert_auto_issue !== false
                      ? "bg-emerald-700 text-white"
                      : "bg-slate-300 text-slate-800"
                  }`}
                >
                  {data?.featureFlags?.cert_auto_issue !== false
                    ? "เปิดใช้งาน (ON)"
                    : "ปิดใช้งาน (OFF)"}
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() =>
                  mutate(
                    { action: "reset_demo_db" },
                    "รีเซ็ตข้อมูลฐานข้อมูลกลับสู่ค่าเริ่มต้น (Initial Seed) เรียบร้อยแล้ว",
                  )
                }
                className="w-full py-2.5 px-4 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>รีเซ็ตฐานข้อมูลทดสอบ (Reset Seed Data)</span>
              </button>
            </div>
          </div>

          <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-bold text-[#0b1f3a]">
                  บันทึกเหตุการณ์ความปลอดภัยล่าสุด (Immutable Security Audit Log)
                </h2>
                <p className="text-xs text-slate-500">
                  บันทึกทุกการกระทำจากทั้งพอร์ทัลผู้เรียน (Frontoffice) และพอร์ทัลบริหารจัดการ (Backoffice)
                </p>
              </div>
              <Link
                href="/admin/reports"
                className="text-xs font-semibold text-[#1a4373] hover:underline"
              >
                ดู Audit Log ทั้งหมด →
              </Link>
            </div>

            <div className="space-y-2.5">
              {(data?.auditLogs || []).slice(0, 5).map((log: any) => (
                <div
                  key={log.id}
                  className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[#0b1f3a]">
                        {log.eventType}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="font-medium text-slate-700">
                        {log.actorName} ({log.actorRole})
                      </span>
                    </div>
                    <div className="text-slate-600">{log.summaryTh}</div>
                  </div>
                  <div className="font-mono text-[11px] text-slate-400 shrink-0">
                    {formatThaiDateTime(log.createdAt)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </BackofficeShell>
  );
}

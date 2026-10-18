"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Award,
  FileBadge,
  PlayCircle,
  CheckCircle2,
  ClipboardCheck,
  ArrowRight,
  Compass,
  Clock,
  Scale,
} from "lucide-react";
import { LearnerShell } from "@/components/ltc/LearnerShell";
import { formatThaiDate } from "@/components/ltc/LtcEmblem";

interface LearnerDashboardData {
  user: {
    id: string;
    displayName: string;
    email: string;
    phone: string | null;
  };
  roles: string[];
  verifiedLicense: {
    licenseNo: string;
    status: string;
    expiresOn: string | null;
  } | null;
  enrollments: {
    id: string;
    courseId: string;
    status: string;
    progressPct: number;
    completedLessonCount: number;
    totalLessonCount: number;
    completedRequiredCount: number;
    totalRequiredCount: number;
    canStartExam: boolean;
    nextLessonId: string | null;
    nextLessonTitle: string | null;
    passedExam: boolean;
    certificateCode: string | null;
    course: {
      id: string;
      code: string;
      titleTh: string;
      categoryNameTh: string;
      audience: "all" | "lawyer_only";
      credits: number;
      durationMinutes: number;
      instructorName: string;
    } | null;
    assessment: {
      id: string;
      title: string;
      passScorePct: number;
      attemptsUsed: number;
      maxAttempts: number;
    } | null;
  }[];
  creditMeter: {
    state: "normal" | "near_due" | "overdue" | "complete";
    percentage: number;
    remainingCredits: number;
    labelTh: string;
    netCredits: number;
    requiredCredits: number;
    daysRemaining: number;
  };
  certificates: {
    id: string;
    verificationCode: string;
    courseTitleTh: string;
    creditsAwarded: number;
    issuedAt: string;
    status: string;
  }[];
}

export default function LearnerCoursesDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<LearnerDashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/learner");
      if (res.status === 401) {
        // Auto sign-in demo lawyer if visiting /my/courses directly so the dashboard works out-of-the-box
        const autoRes = await fetch("/api/v1/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "switch_demo",
            userId: "u-lawyer-001",
            portal: "frontoffice",
          }),
        });
        if (autoRes.ok) {
          const retry = await fetch("/api/v1/learner");
          if (retry.ok) {
            setData(await retry.json());
            setLoading(false);
            return;
          }
        }
        router.push("/login?next=/my/courses");
        return;
      }
      if (res.ok) {
        setData(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

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

  const completedCoursesCount =
    data?.enrollments.filter((e) => e.passedExam || e.status === "completed")
      .length ?? 0;
  const activeCoursesCount =
    data?.enrollments.filter((e) => !e.passedExam && e.status === "active")
      .length ?? 0;

  return (
    <LearnerShell
      user={data?.user ?? null}
      roles={data?.roles ?? []}
      verifiedLicense={data?.verifiedLicense ?? null}
      netCredits={data?.creditMeter.netCredits ?? 0}
      requiredCredits={data?.creditMeter.requiredCredits ?? 12}
      onSwitchPersona={handleSwitchPersona}
    >
      <div className="space-y-6">
        {/* Welcome & Credit Bank Meter Banner (07-learner-dashboard.html aligned) */}
        <div className="bg-gradient-to-br from-[#0b1f3a] via-[#132f54] to-[#1a4373] text-white rounded-2xl p-6 sm:p-8 border border-[#c89b3c]/30">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
            <div className="lg:col-span-7 space-y-2">
              <div className="text-xs font-semibold text-[#e2b857] uppercase tracking-wider">
                LEARNER WORKSPACE · พื้นที่การเรียนรู้ส่วนบุคคล
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold">
                สวัสดีคุณ {data?.user.displayName || "ผู้เรียน"}
              </h1>
              <p className="text-sm text-slate-200 leading-relaxed">
                ติดตามความคืบหน้าการเรียนบทเรียนออนไลน์ เข้าสอบวัดผลปลายหลักสูตร
                และตรวจสอบสมุดสะสมหน่วยกิตทนายความ (CPE Credit Bank) จากฐานข้อมูลกลาง
              </p>
            </div>

            {/* CPE Credit Bank Meter Widget */}
            <div className="lg:col-span-5 bg-white/10 backdrop-blur-md rounded-xl p-5 border border-white/15 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#e2b857]">
                  สมุดสะสมหน่วยกิต (รอบปี พ.ศ. 2569)
                </span>
                <span className="font-mono text-emerald-300">
                  ● {data?.creditMeter.labelTh || "อยู่ในเกณฑ์ปกติ"}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono tabular-nums text-white">
                  {data?.creditMeter.netCredits ?? 0} /{" "}
                  {data?.creditMeter.requiredCredits ?? 12}{" "}
                  <span className="text-sm font-normal text-slate-300">
                    หน่วยกิต CPE
                  </span>
                </span>
                <span className="text-xs font-mono text-[#e2b857]">
                  {data?.creditMeter.percentage ?? 0}%
                </span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full bg-[#e2b857] rounded-full transition-all"
                  style={{ width: `${data?.creditMeter.percentage ?? 0}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-slate-300 pt-1">
                <span>
                  ยังขาดอีก {data?.creditMeter.remainingCredits ?? 4} หน่วยกิต
                </span>
                <Link
                  href="/my/credits"
                  className="text-[#e2b857] font-semibold hover:underline"
                >
                  ดูบัญชีหน่วยกิต →
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* 4 Summary Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs text-slate-500 font-medium">
              หลักสูตรที่ลงทะเบียนทั้งหมด
            </div>
            <div className="text-2xl font-bold text-[#0b1f3a] font-mono tabular-nums mt-1">
              {data?.enrollments.length ?? 0} หลักสูตร
            </div>
            <div className="text-xs text-slate-500 mt-1">
              กำลังเรียน {activeCoursesCount} · สำเร็จแล้ว {completedCoursesCount}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs text-slate-500 font-medium">
              หน่วยกิต CPE สุทธิ (ปี 2569)
            </div>
            <div className="text-2xl font-bold text-[#7a5b14] font-mono tabular-nums mt-1">
              {data?.creditMeter.netCredits ?? 0} หน่วย
            </div>
            <div className="text-xs text-slate-500 mt-1">
              เป้าหมายประจำปี {data?.creditMeter.requiredCredits ?? 12} หน่วยกิต
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs text-slate-500 font-medium">
              ใบประกาศนียบัตรที่ได้รับ
            </div>
            <div className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
              {data?.certificates.filter((c) => c.status === "valid").length ??
                0}{" "}
              ฉบับ
            </div>
            <div className="text-xs text-slate-500 mt-1">
              พร้อมรหัสตรวจสอบ LTC-2026
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs text-slate-500 font-medium">
              สถานะใบอนุญาตทนายความ
            </div>
            <div className="text-lg font-bold text-[#0b1f3a] font-mono mt-1">
              {data?.verifiedLicense
                ? `ทล. ${data.verifiedLicense.licenseNo}`
                : "ยังไม่ผูกใบอนุญาต"}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {data?.verifiedLicense
                ? "ยืนยันโดยนายทะเบียนแล้ว"
                : "สามารถยื่นคำขอได้ที่เมนูใบอนุญาต"}
            </div>
          </div>
        </div>

        {/* Enrolled Courses List */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <h2 className="text-lg font-bold text-[#0b1f3a]">
                หลักสูตรที่ลงทะเบียนเรียน ({data?.enrollments.length ?? 0})
              </h2>
              <p className="text-xs text-slate-500">
                ศึกษาบทเรียนบังคับให้ครบ 100% เพื่อเข้าสอบวัดผลปลายหลักสูตรและรับใบประกาศนียบัตร
              </p>
            </div>
            <Link
              href="/courses"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54] transition-colors self-start"
            >
              <Compass className="w-3.5 h-3.5 text-[#e2b857]" />
              <span>ลงทะเบียนหลักสูตรเพิ่ม</span>
            </Link>
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-slate-500">
              กำลังโหลดรายการหลักสูตรของคุณ...
            </div>
          ) : !data || data.enrollments.length === 0 ? (
            <div className="py-10 text-center space-y-3">
              <BookOpen className="w-10 h-10 text-slate-400 mx-auto" />
              <div className="text-sm font-bold text-slate-800">
                คุณยังไม่ได้ลงทะเบียนหลักสูตรใด
              </div>
              <Link
                href="/courses"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold"
              >
                <span>เลือกดูหลักสูตรในแคตตาล็อก</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {data.enrollments.map((enr) => {
                if (!enr.course) return null;
                return (
                  <div
                    key={enr.id}
                    className="p-5 rounded-xl border border-slate-200 hover:border-[#1a4373] transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-5"
                  >
                    <div className="space-y-2 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono font-bold text-[#0b1f3a]">
                          {enr.course.code}
                        </span>
                        <span>·</span>
                        <span>{enr.course.categoryNameTh}</span>
                        <span>·</span>
                        <span className="font-mono font-semibold text-[#7a5b14]">
                          +{enr.course.credits} หน่วยกิต CPE
                        </span>
                        {enr.passedExam && (
                          <>
                            <span>·</span>
                            <span className="text-emerald-700 font-bold inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>สอบผ่านปลายหลักสูตรแล้ว</span>
                            </span>
                          </>
                        )}
                      </div>

                      <h3 className="text-base font-bold text-[#0b1f3a]">
                        {enr.course.titleTh}
                      </h3>

                      {/* Progress Bar */}
                      <div className="max-w-xl space-y-1.5 pt-1">
                        <div className="flex items-center justify-between text-xs text-slate-600">
                          <span>
                            ความคืบหน้าบทเรียนบังคับ:{" "}
                            <strong className="font-mono tabular-nums">
                              {enr.completedRequiredCount}/{enr.totalRequiredCount}
                            </strong>{" "}
                            บทเรียน ({enr.progressPct}%)
                          </span>
                          {enr.nextLessonTitle && !enr.passedExam && (
                            <span className="text-slate-500 truncate max-w-[240px]">
                              บทถัดไป: {enr.nextLessonTitle}
                            </span>
                          )}
                        </div>
                        <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              enr.progressPct >= 100
                                ? "bg-emerald-600"
                                : "bg-[#1a4373]"
                            }`}
                            style={{ width: `${enr.progressPct}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                      <Link
                        href={`/courses/${enr.course.id}/learn`}
                        className="px-4 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54] transition-colors inline-flex items-center gap-1.5"
                      >
                        <PlayCircle className="w-4 h-4 text-[#e2b857]" />
                        <span>
                          {enr.progressPct >= 100
                            ? "ทบทวนบทเรียน"
                            : "เข้าเรียนต่อ"}
                        </span>
                      </Link>

                      {enr.canStartExam && !enr.passedExam && (
                        <Link
                          href={`/courses/${enr.course.id}/exam`}
                          className="px-4 py-2.5 rounded-xl bg-[#c89b3c] text-[#0b1f3a] text-xs font-bold hover:bg-[#e2b857] transition-colors inline-flex items-center gap-1.5"
                        >
                          <ClipboardCheck className="w-4 h-4" />
                          <span>เข้าสอบวัดผลปลายหลักสูตร</span>
                        </Link>
                      )}

                      {enr.certificateCode && (
                        <Link
                          href={`/verify/${enr.certificateCode}`}
                          className="px-3.5 py-2.5 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-900 text-xs font-semibold hover:bg-emerald-100 transition-colors inline-flex items-center gap-1.5"
                        >
                          <FileBadge className="w-4 h-4 text-emerald-700" />
                          <span className="font-mono">{enr.certificateCode}</span>
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </LearnerShell>
  );
}

"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  BookOpen,
  Clock,
  Award,
  CheckCircle2,
  PlayCircle,
  FileText,
  HelpCircle,
  ShieldCheck,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
  UserCheck,
} from "lucide-react";
import { PublicHeader, PublicFooter } from "@/components/ltc/PublicShell";

interface CourseDetailResponse {
  course: {
    id: string;
    code: string;
    slug: string;
    titleTh: string;
    titleEn: string;
    subtitleTh: string;
    descriptionTh: string;
    categoryNameTh: string;
    audience: "all" | "lawyer_only";
    credits: number;
    durationMinutes: number;
    instructorName: string;
    instructorRole: string;
    rating: number;
    enrolledCount: number;
    objectives: string[];
  };
  modules: {
    id: string;
    titleTh: string;
    durationMinutes: number;
    lessons: {
      id: string;
      type: "video" | "document" | "quiz";
      titleTh: string;
      durationSec: number;
      isRequired: boolean;
      summaryTh: string;
    }[];
  }[];
  assessment: {
    id: string;
    title: string;
    questionCount: number;
    passScorePct: number;
    timeLimitMin: number;
    maxAttempts: number;
  } | null;
  enrollment: {
    id: string;
    status: string;
  } | null;
  completedLessonIds: string[];
}

export default function CourseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const courseId = params?.id || "crs-101";

  const [data, setData] = useState<CourseDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/catalog?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((res) => {
        if (!active) return;
        if (res.course) {
          setData(res);
        } else {
          setErrorMsg(res?.error?.message || "ไม่พบหลักสูตรที่ระบุ");
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setErrorMsg("ไม่สามารถโหลดข้อมูลหลักสูตรได้");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [courseId]);

  async function handleEnrollOrStart() {
    if (!data) return;
    setErrorMsg(null);

    if (data.enrollment) {
      router.push(`/courses/${data.course.id}/learn`);
      return;
    }

    setEnrolling(true);
    try {
      const res = await fetch("/api/v1/learner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enroll",
          courseId: data.course.id,
        }),
      });
      const result = await res.json();
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/courses/${data.course.id}`)}`);
        return;
      }
      if (!res.ok) {
        setErrorMsg(
          result?.error?.message || "ไม่สามารถลงทะเบียนเรียนได้",
        );
        setEnrolling(false);
        return;
      }
      router.push(`/courses/${data.course.id}/learn`);
    } catch {
      setErrorMsg("เกิดข้อผิดพลาดในการเชื่อมต่อ");
      setEnrolling(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      <PublicHeader />

      <main className="flex-1">
        {loading ? (
          <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-16 text-center text-sm text-slate-500">
            กำลังโหลดรายละเอียดหลักสูตร...
          </div>
        ) : !data ? (
          <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-16 text-center space-y-4">
            <div className="text-lg font-bold text-slate-800">
              {errorMsg || "ไม่พบหลักสูตร"}
            </div>
            <Link
              href="/courses"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0b1f3a] text-white text-sm font-semibold"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>กลับไปหน้ารวมหลักสูตร</span>
            </Link>
          </div>
        ) : (
          <>
            {/* Course Header Banner (03-course-detail.html aligned) */}
            <section className="bg-gradient-to-br from-[#0b1f3a] via-[#132f54] to-[#1a4373] text-white border-b border-[#c89b3c]/30">
              <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-10 lg:py-12">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                  <div className="lg:col-span-8 space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                      <Link href="/courses" className="hover:text-[#e2b857]">
                        หลักสูตรทั้งหมด
                      </Link>
                      <span>/</span>
                      <span>{data.course.categoryNameTh}</span>
                      <span>/</span>
                      <span className="font-mono text-[#e2b857] font-semibold">
                        {data.course.code}
                      </span>
                    </div>

                    <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold leading-tight">
                      {data.course.titleTh}
                    </h1>
                    <p className="text-sm text-[#e2b857] font-medium">
                      {data.course.titleEn}
                    </p>
                    <p className="text-sm sm:text-base text-slate-200 leading-relaxed max-w-3xl">
                      {data.course.descriptionTh}
                    </p>

                    <div className="pt-2 flex flex-wrap items-center gap-4 text-xs text-slate-200">
                      <span>
                        วิทยากร:{" "}
                        <strong className="text-white">
                          {data.course.instructorName}
                        </strong>{" "}
                        ({data.course.instructorRole})
                      </span>
                      <span>·</span>
                      <span className="font-mono tabular-nums">
                        ผู้ลงทะเบียน {data.course.enrolledCount.toLocaleString()} คน
                      </span>
                      <span>·</span>
                      <span className="font-mono tabular-nums text-[#e2b857] font-semibold">
                        หน่วยกิต CPE {data.course.credits} หน่วย
                      </span>
                    </div>
                  </div>

                  {/* Right Action & Enrollment Card */}
                  <div className="lg:col-span-4 bg-white text-slate-900 rounded-2xl p-6 shadow-xl border border-slate-200 space-y-5">
                    <div className="flex items-baseline justify-between border-b border-slate-100 pb-4">
                      <div>
                        <div className="text-xs font-semibold text-slate-500">
                          ค่าธรรมเนียมการอบรม
                        </div>
                        <div className="text-2xl font-bold text-[#0b1f3a] mt-0.5">
                          ไม่เสียค่าใช้จ่าย (สวัสดิการวิชาการ)
                        </div>
                      </div>
                      <span className="text-sm font-mono font-bold text-[#7a5b14]">
                        +{data.course.credits} CPE
                      </span>
                    </div>

                    {errorMsg && (
                      <div
                        role="alert"
                        className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2.5"
                      >
                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                        <div className="space-y-1.5">
                          <div>{errorMsg}</div>
                          <Link
                            href="/my/license"
                            className="inline-block font-semibold text-[#0b1f3a] underline"
                          >
                            ไปที่เมนูยื่นผูกเลขใบอนุญาตทนายความ →
                          </Link>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2.5 text-xs text-slate-600">
                      <div className="flex items-center justify-between">
                        <span>กลุ่มผู้มีสิทธิ์เรียน:</span>
                        <span className="font-semibold text-slate-900">
                          {data.course.audience === "lawyer_only"
                            ? "เฉพาะทนายความ (Verified License)"
                            : "ประชาชนทั่วไป และ ทนายความ"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>จำนวนบทเรียนบังคับ:</span>
                        <span className="font-mono font-semibold text-slate-900">
                          {data.modules.reduce(
                            (acc, m) => acc + m.lessons.length,
                            0,
                          )}{" "}
                          บทเรียน ({Math.round(data.course.durationMinutes / 60)} ชม.)
                        </span>
                      </div>
                      {data.assessment && (
                        <div className="flex items-center justify-between">
                          <span>เกณฑ์สอบผ่านปลายหลักสูตร:</span>
                          <span className="font-mono font-semibold text-emerald-700">
                            {data.assessment.passScorePct}% (สอบได้สูงสุด{" "}
                            {data.assessment.maxAttempts} ครั้ง)
                          </span>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={enrolling}
                      onClick={handleEnrollOrStart}
                      className="w-full py-3.5 px-5 rounded-xl bg-[#0b1f3a] text-white font-semibold text-sm hover:bg-[#132f54] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <span>
                        {enrolling
                          ? "กำลังลงทะเบียน..."
                          : data.enrollment
                            ? "เข้าสู่ห้องเรียนออนไลน์ (Continue Learning)"
                            : "ลงทะเบียนเรียนและเข้าสู่บทเรียนทันที"}
                      </span>
                      <ArrowRight className="w-4 h-4 text-[#e2b857]" />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Course Objectives & Syllabus */}
            <section className="max-w-[1320px] mx-auto px-4 sm:px-6 py-10 grid grid-cols-1 lg:grid-cols-12 gap-8">
              <div className="lg:col-span-8 space-y-8">
                {/* Objectives */}
                <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
                  <h2 className="text-lg font-bold text-[#0b1f3a]">
                    วัตถุประสงค์การเรียนรู้ประจำหลักสูตร
                  </h2>
                  <ul className="space-y-2.5">
                    {data.course.objectives.map((obj, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2.5 text-sm text-slate-700"
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-1" />
                        <span>{obj}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Syllabus Modules */}
                <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-[#0b1f3a]">
                      โครงสร้างหลักสูตรและบทเรียน ({data.modules.length} โมดูล)
                    </h2>
                    <span className="text-xs text-slate-500">
                      เรียนครบทุกบทเรียนบังคับเพื่อปลดล็อกการสอบปลายหลักสูตร
                    </span>
                  </div>

                  <div className="space-y-4">
                    {data.modules.map((mod) => (
                      <div
                        key={mod.id}
                        className="rounded-xl border border-slate-200 overflow-hidden"
                      >
                        <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                          <div className="font-bold text-sm text-[#0b1f3a]">
                            {mod.titleTh}
                          </div>
                          <span className="text-xs font-mono text-slate-500">
                            {mod.lessons.length} บทเรียน · {mod.durationMinutes} นาที
                          </span>
                        </div>
                        <div className="divide-y divide-slate-100">
                          {mod.lessons.map((les) => {
                            const isDone = data.completedLessonIds.includes(
                              les.id,
                            );
                            return (
                              <div
                                key={les.id}
                                className="px-4 py-3 flex items-center justify-between gap-4 text-sm"
                              >
                                <div className="flex items-center gap-3">
                                  {les.type === "video" ? (
                                    <PlayCircle className="w-4 h-4 text-[#1a4373] shrink-0" />
                                  ) : les.type === "document" ? (
                                    <FileText className="w-4 h-4 text-[#7a5b14] shrink-0" />
                                  ) : (
                                    <HelpCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                                  )}
                                  <div>
                                    <div className="font-medium text-slate-900">
                                      {les.titleTh}
                                    </div>
                                    <div className="text-xs text-slate-500">
                                      {les.summaryTh}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 shrink-0 text-xs">
                                  {isDone && (
                                    <span className="text-emerald-700 font-semibold">
                                      ✓ เรียนจบแล้ว
                                    </span>
                                  )}
                                  <span className="font-mono text-slate-400">
                                    {Math.max(1, Math.round(les.durationSec / 60))}{" "}
                                    นาที
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right Column Assessment & Certificate Info */}
              <div className="lg:col-span-4 space-y-6">
                {data.assessment && (
                  <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-bold text-[#0b1f3a]">
                      <Award className="w-5 h-5 text-[#c89b3c]" />
                      <span>การสอบวัดผลปลายหลักสูตร</span>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      เมื่อผู้เรียนศึกษาบทเรียนบังคับครบ 100% ระบบจะเปิดให้เข้าสอบวัดผลปลายหลักสูตร{" "}
                      <strong>{data.assessment.title}</strong> จำนวน{" "}
                      {data.assessment.questionCount} ข้อ เวลา{" "}
                      {data.assessment.timeLimitMin} นาที
                    </p>
                    <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 space-y-1">
                      <div>
                        · เกณฑ์คะแนนผ่าน:{" "}
                        <strong className="text-slate-800">
                          {data.assessment.passScorePct}%
                        </strong>
                      </div>
                      <div>
                        · ออกใบประกาศนียบัตรดิจิทัลพร้อมรหัสตรวจสอบอัตโนมัติ
                      </div>
                      <div>
                        · บันทึกหน่วยกิต CPE เข้าสมุดสะสมหน่วยกิตทนายความทันที
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>

      <PublicFooter />
    </div>
  );
}

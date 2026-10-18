"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  PlayCircle,
  PauseCircle,
  FileText,
  HelpCircle,
  CheckCircle2,
  ClipboardCheck,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Award,
} from "lucide-react";
import { LtcEmblem } from "@/components/ltc/LtcEmblem";

export default function CourseLessonPlayerPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const courseId = params?.id || "crs-101";

  const [workspace, setWorkspace] = useState<any>(null);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [quizChecked, setQuizChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    let res = await fetch(
      `/api/v1/learner?courseId=${encodeURIComponent(courseId)}`,
    );
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
      res = await fetch(
        `/api/v1/learner?courseId=${encodeURIComponent(courseId)}`,
      );
    }
    if (res.ok) {
      const data = await res.json();
      const ws = data.activeCourseWorkspace;
      setWorkspace(ws);
      if (ws && ws.modules?.length > 0) {
        const allLessons = ws.modules.flatMap((m: any) => m.lessons);
        const completedSet = new Set(
          (ws.progressRows || [])
            .filter((p: any) => p.completedAt !== null)
            .map((p: any) => p.lessonId),
        );
        const firstIncomplete =
          allLessons.find((l: any) => !completedSet.has(l.id)) || allLessons[0];
        setActiveLessonId((prev) => prev || firstIncomplete?.id || null);
      }
    }
    setLoading(false);
  }, [courseId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  if (loading || !workspace) {
    return (
      <div className="min-h-screen bg-[#0b1f3a] text-white flex items-center justify-center text-sm">
        กำลังเข้าสู่ห้องเรียนออนไลน์ สภาทนายความ...
      </div>
    );
  }

  const allLessons: any[] = workspace.modules.flatMap((m: any) => m.lessons);
  const completedIds = new Set(
    (workspace.progressRows || [])
      .filter((p: any) => p.completedAt !== null)
      .map((p: any) => p.lessonId),
  );
  const activeLesson =
    allLessons.find((l) => l.id === activeLessonId) || allLessons[0];
  const activeIdx = allLessons.findIndex((l) => l.id === activeLesson?.id);

  const requiredLessons = allLessons.filter((l) => l.isRequired);
  const completedReqCount = requiredLessons.filter((l) =>
    completedIds.has(l.id),
  ).length;
  const progressPct =
    requiredLessons.length > 0
      ? Math.round((completedReqCount / requiredLessons.length) * 100)
      : 100;
  const canTakeExam = completedReqCount >= requiredLessons.length;

  async function handleCompleteAndAdvance() {
    if (!activeLesson) return;
    setSaving(true);
    try {
      await fetch("/api/v1/learner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete_lesson",
          courseId: workspace.course.id,
          lessonId: activeLesson.id,
        }),
      });
      await loadWorkspace();
      if (activeIdx + 1 < allLessons.length) {
        setActiveLessonId(allLessons[activeIdx + 1].id);
        setQuizChecked(false);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      {/* Dark Classroom Top Bar (04-lesson-player.html aligned) */}
      <header className="bg-[#0b1f3a] text-white border-b border-white/10 sticky top-0 z-40">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/my/courses"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-200 shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>กลับแดชบอร์ด</span>
            </Link>
            <div className="min-w-0">
              <div className="text-xs font-mono text-[#e2b857]">
                {workspace.course.code} · +{workspace.course.credits} หน่วยกิต CPE
              </div>
              <h1 className="text-sm font-bold text-white truncate">
                {workspace.course.titleTh}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="hidden md:flex items-center gap-3">
              <div className="text-xs text-slate-300 font-mono tabular-nums">
                ความคืบหน้า {completedReqCount}/{requiredLessons.length} บทเรียน ({progressPct}%)
              </div>
              <div className="w-32 h-2 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full bg-[#e2b857] rounded-full transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            <Link
              href={`/courses/${workspace.course.id}/exam`}
              className={`px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 transition-colors ${
                canTakeExam
                  ? "bg-[#c89b3c] text-[#0b1f3a] hover:bg-[#e2b857]"
                  : "bg-white/10 text-slate-300 hover:bg-white/20"
              }`}
            >
              <ClipboardCheck className="w-4 h-4" />
              <span>
                {canTakeExam
                  ? "เข้าสอบปลายหลักสูตร"
                  : "สอบปลายหลักสูตร (ต้องเรียนครบก่อน)"}
              </span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Split Classroom */}
      <div className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Lesson Stage (8 cols) */}
        <main className="lg:col-span-8 space-y-6">
          {activeLesson && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
              {/* Video / Document / Quiz Stage */}
              {activeLesson.type === "video" && (
                <div className="bg-[#071529] text-white p-6 sm:p-10 space-y-6">
                  <div className="flex items-center justify-between text-xs text-[#e2b857] font-mono">
                    <span>VIDEO LECTURE · บทเรียนวิดีทัศน์</span>
                    <span>
                      ความยาว {Math.round(activeLesson.durationSec / 60)} นาที
                    </span>
                  </div>

                  <div className="py-6 space-y-3">
                    <h2 className="text-xl sm:text-2xl font-bold text-white">
                      {activeLesson.titleTh}
                    </h2>
                    <p className="text-sm text-slate-300 leading-relaxed">
                      {activeLesson.summaryTh}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-white/10">
                    <button
                      type="button"
                      onClick={() => setIsPlaying(!isPlaying)}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#c89b3c] text-[#0b1f3a] text-xs font-bold hover:bg-[#e2b857] cursor-pointer"
                    >
                      {isPlaying ? (
                        <>
                          <PauseCircle className="w-4 h-4" />
                          <span>หยุดชั่วคราว (กำลังเล่นวิดีทัศน์ 1.0x)</span>
                        </>
                      ) : (
                        <>
                          <PlayCircle className="w-4 h-4" />
                          <span>เล่นวิดีทัศน์บรรยาย</span>
                        </>
                      )}
                    </button>
                    <span className="text-xs text-slate-400">
                      วิทยากร: {workspace.course.instructorName}
                    </span>
                  </div>
                </div>
              )}

              {activeLesson.type === "document" && (
                <div className="p-6 sm:p-8 space-y-6 bg-white">
                  <div className="border-b border-slate-200 pb-4">
                    <div className="text-xs font-bold text-[#7a5b14] uppercase tracking-wider">
                      LEGAL DOCUMENT & CASE STUDY · เอกสารประกอบการเรียนและคำพิพากษาศาลฎีกา
                    </div>
                    <h2 className="text-xl font-bold text-[#0b1f3a] mt-1">
                      {activeLesson.titleTh}
                    </h2>
                  </div>

                  <div className="space-y-4">
                    {(activeLesson.documentSections || []).map(
                      (sec: any, idx: number) => (
                        <div
                          key={idx}
                          className="p-5 rounded-xl bg-[#f7f8fa] border border-slate-200 space-y-2"
                        >
                          <h3 className="text-base font-bold text-[#0b1f3a]">
                            {sec.heading}
                          </h3>
                          <p className="text-sm text-slate-700 leading-relaxed">
                            {sec.body}
                          </p>
                          {sec.legalCitation && (
                            <div className="text-xs font-mono text-[#7a5b14] pt-1">
                              อ้างอิง: {sec.legalCitation}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}

              {activeLesson.type === "quiz" && (
                <div className="p-6 sm:p-8 space-y-6 bg-white">
                  <div className="border-b border-slate-200 pb-4">
                    <div className="text-xs font-bold text-emerald-700 uppercase tracking-wider">
                      KNOWLEDGE CHECK · แบบฝึกหัดทบทวนความเข้าใจท้ายโมดูล
                    </div>
                    <h2 className="text-xl font-bold text-[#0b1f3a] mt-1">
                      {activeLesson.titleTh}
                    </h2>
                  </div>

                  <div className="space-y-5">
                    {(activeLesson.quizQuestions || []).map(
                      (q: any, qIdx: number) => (
                        <div
                          key={q.id}
                          className="p-5 rounded-xl bg-[#f7f8fa] border border-slate-200 space-y-3"
                        >
                          <div className="text-sm font-bold text-[#0b1f3a]">
                            ข้อที่ {qIdx + 1}: {q.questionText}
                          </div>
                          <div className="space-y-2">
                            {q.options.map((opt: any) => {
                              const chosen = quizAnswers[q.id] === opt.id;
                              return (
                                <label
                                  key={opt.id}
                                  className={`flex items-center gap-3 p-3 rounded-xl border text-xs cursor-pointer ${
                                    chosen
                                      ? "border-[#0b1f3a] bg-[#f0f6fc] font-semibold"
                                      : "border-slate-200 bg-white"
                                  }`}
                                >
                                  <input
                                    type="radio"
                                    name={q.id}
                                    checked={chosen}
                                    onChange={() =>
                                      setQuizAnswers((prev) => ({
                                        ...prev,
                                        [q.id]: opt.id,
                                      }))
                                    }
                                  />
                                  <span>{opt.text}</span>
                                </label>
                              );
                            })}
                          </div>
                          {quizChecked && (
                            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
                              <strong>คำอธิบายข้อกฎหมาย:</strong> {q.explanation}
                            </div>
                          )}
                        </div>
                      ),
                    )}

                    <button
                      type="button"
                      onClick={() => setQuizChecked(true)}
                      className="px-4 py-2 rounded-xl border border-[#0b1f3a] text-[#0b1f3a] text-xs font-bold hover:bg-slate-50 cursor-pointer"
                    >
                      ตรวจคำตอบและดูคำอธิบายข้อกฎหมาย
                    </button>
                  </div>
                </div>
              )}

              {/* Key Points & Transcript + Complete Lesson Footer */}
              <div className="p-6 space-y-5 border-t border-slate-200">
                {activeLesson.videoKeyPoints?.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-bold text-[#0b1f3a]">
                      สาระสำคัญประจำบทเรียน (Key Legal Takeaways)
                    </h3>
                    <ul className="space-y-1.5 text-xs text-slate-700">
                      {activeLesson.videoKeyPoints.map(
                        (pt: string, idx: number) => (
                          <li key={idx} className="flex items-start gap-2">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                            <span>{pt}</span>
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}

                <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  <div className="text-xs text-slate-500">
                    {completedIds.has(activeLesson.id) ? (
                      <span className="text-emerald-700 font-bold inline-flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>บันทึกการเรียนจบบทเรียนนี้แล้ว</span>
                      </span>
                    ) : (
                      <span>กดปุ่มด้านขวาเพื่อบันทึกความคืบหน้าและปลดล็อกบทถัดไป</span>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleCompleteAndAdvance}
                    className="px-5 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4 text-[#e2b857]" />
                    <span>
                      {saving
                        ? "กำลังบันทึกความคืบหน้า..."
                        : completedIds.has(activeLesson.id)
                          ? "ไปบทเรียนถัดไป"
                          : "บันทึกเรียนจบบทเรียนนี้และไปบทถัดไป"}
                    </span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* Right Syllabus Outline Sidebar (4 cols) */}
        <aside className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="text-sm font-bold text-[#0b1f3a]">
                สารบัญบทเรียน ({completedReqCount}/{requiredLessons.length})
              </div>
              <span className="text-xs font-mono font-bold text-[#7a5b14]">
                {progressPct}%
              </span>
            </div>

            <div className="divide-y divide-slate-100">
              {workspace.modules.map((mod: any) => (
                <div key={mod.id} className="p-3 space-y-1.5">
                  <div className="text-xs font-bold text-slate-500 px-2">
                    {mod.titleTh}
                  </div>
                  {mod.lessons.map((les: any) => {
                    const isDone = completedIds.has(les.id);
                    const isCurrent = activeLesson?.id === les.id;
                    return (
                      <button
                        key={les.id}
                        type="button"
                        onClick={() => {
                          setActiveLessonId(les.id);
                          setQuizChecked(false);
                        }}
                        className={`w-full p-2.5 rounded-xl text-left text-xs flex items-start justify-between gap-2 transition-colors cursor-pointer ${
                          isCurrent
                            ? "bg-[#0b1f3a] text-white font-semibold"
                            : "hover:bg-slate-100 text-slate-700"
                        }`}
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          {isDone ? (
                            <CheckCircle2
                              className={`w-4 h-4 shrink-0 mt-0.5 ${
                                isCurrent
                                  ? "text-[#e2b857]"
                                  : "text-emerald-600"
                              }`}
                            />
                          ) : les.type === "video" ? (
                            <PlayCircle className="w-4 h-4 shrink-0 mt-0.5 opacity-70" />
                          ) : les.type === "document" ? (
                            <FileText className="w-4 h-4 shrink-0 mt-0.5 opacity-70" />
                          ) : (
                            <HelpCircle className="w-4 h-4 shrink-0 mt-0.5 opacity-70" />
                          )}
                          <span className="line-clamp-2">{les.titleTh}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="p-4 bg-[#f0f6fc] border-t border-slate-200 space-y-2">
              <div className="text-xs font-bold text-[#0b1f3a]">
                การสอบวัดผลปลายหลักสูตร
              </div>
              <p className="text-[11px] text-slate-600">
                เกณฑ์ผ่าน {workspace.assessment?.passScorePct ?? 70}% · รับหน่วยกิต
                CPE +{workspace.course.credits} หน่วย
              </p>
              <Link
                href={`/courses/${workspace.course.id}/exam`}
                className="w-full py-2.5 px-4 rounded-xl bg-[#0b1f3a] text-[#e2b857] text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-[#132f54]"
              >
                <ClipboardCheck className="w-4 h-4" />
                <span>ไปที่หน้าห้องสอบปลายหลักสูตร</span>
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

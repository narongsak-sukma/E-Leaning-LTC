"use client";

import React, { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ClipboardCheck,
  Clock,
  Flag,
  CheckCircle2,
  XCircle,
  Award,
  FileBadge,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
} from "lucide-react";

function CourseExamContent() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const courseId = params?.id || "crs-101";
  const queryAttemptId = searchParams.get("attemptId");

  const [detail, setDetail] = useState<any>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadOrStartExam = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      // Ensure logged in and inspect existing attempts for this course
      const checkRes = await fetch("/api/v1/learner");
      const learnerData = checkRes.ok ? await checkRes.json() : null;

      let targetAttemptId = queryAttemptId;

      if (!targetAttemptId && learnerData?.attempts) {
        const existingForCourse = (learnerData.attempts || []).find(
          (a: any) =>
            a.courseId === courseId &&
            (a.status === "in_progress" || a.status === "passed"),
        );
        if (existingForCourse) {
          targetAttemptId = existingForCourse.id;
        }
      }

      if (!targetAttemptId) {
        // Try starting or resuming an exam attempt
        const startRes = await fetch("/api/v1/learner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start_exam",
            courseId,
          }),
        });
        const startData = await startRes.json();
        if (!startRes.ok) {
          const fallbackAttempt = (learnerData?.attempts || []).find(
            (a: any) => a.courseId === courseId,
          );
          if (fallbackAttempt) {
            targetAttemptId = fallbackAttempt.id;
          } else {
            setErrorMsg(
              startData?.error?.message ||
                "ยังไม่สามารถเริ่มสอบได้ กรุณาเรียนบทเรียนบังคับให้ครบก่อน",
            );
            setLoading(false);
            return;
          }
        } else {
          targetAttemptId = startData.attempt.id;
        }
      }

      if (targetAttemptId) {
        const attRes = await fetch(
          `/api/v1/learner?attemptId=${encodeURIComponent(targetAttemptId)}`,
        );
        const attData = await attRes.json();
        if (attData.activeAttemptDetail) {
          setDetail(attData.activeAttemptDetail);
          setAnswers(attData.activeAttemptDetail.attempt.answers || {});
          setFlagged(
            attData.activeAttemptDetail.attempt.flaggedQuestionIds || [],
          );
        }
      }
    } finally {
      setLoading(false);
    }
  }, [courseId, queryAttemptId]);

  useEffect(() => {
    loadOrStartExam();
  }, [loadOrStartExam]);

  async function handleSelectOption(questionId: string, optionId: string) {
    const nextAnswers = { ...answers, [questionId]: optionId };
    setAnswers(nextAnswers);
    if (detail?.attempt?.status === "in_progress") {
      await fetch("/api/v1/learner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_exam_answer",
          attemptId: detail.attempt.id,
          answers: nextAnswers,
          flaggedQuestionIds: flagged,
        }),
      });
    }
  }

  async function handleToggleFlag(questionId: string) {
    const nextFlags = flagged.includes(questionId)
      ? flagged.filter((id) => id !== questionId)
      : [...flagged, questionId];
    setFlagged(nextFlags);
    if (detail?.attempt?.status === "in_progress") {
      await fetch("/api/v1/learner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_exam_answer",
          attemptId: detail.attempt.id,
          answers,
          flaggedQuestionIds: nextFlags,
        }),
      });
    }
  }

  async function handleSubmitExam() {
    if (!detail?.attempt) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/learner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit_exam",
          attemptId: detail.attempt.id,
          answers,
          flaggedQuestionIds: flagged,
        }),
      });
      if (res.ok) {
        const refreshed = await fetch(
          `/api/v1/learner?attemptId=${encodeURIComponent(detail.attempt.id)}`,
        );
        const refData = await refreshed.json();
        if (refData.activeAttemptDetail) {
          setDetail(refData.activeAttemptDetail);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center text-sm text-slate-600">
        กำลังเตรียมห้องสอบวัดผลปลายหลักสูตร...
      </div>
    );
  }

  if (errorMsg || !detail) {
    return (
      <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center p-4">
        <div className="max-w-lg w-full bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-amber-600 mx-auto" />
          <h1 className="text-lg font-bold text-[#0b1f3a]">
            ยังไม่ผ่านเกณฑ์เข้าสอบวัดผลปลายหลักสูตร
          </h1>
          <p className="text-sm text-slate-600">{errorMsg}</p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Link
              href={`/courses/${courseId}/learn`}
              className="px-5 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold"
            >
              กลับไปเรียนบทเรียนบังคับให้ครบ
            </Link>
            <Link
              href="/my/courses"
              className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700"
            >
              กลับแดชบอร์ด
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { attempt, course, assessment, questions, reviewPolicy } = detail;
  const isGraded = attempt.status !== "in_progress";
  const currentQuestion = questions[currentIndex] || questions[0];

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      {/* Exam Top Bar */}
      <header className="bg-[#0b1f3a] text-white border-b border-white/10 sticky top-0 z-40">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              href={`/courses/${courseId}/learn`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-200"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>กลับห้องเรียน</span>
            </Link>
            <div>
              <div className="text-xs font-mono text-[#e2b857]">
                {attempt.code} · ครั้งที่ {attempt.attemptNo}/
                {assessment?.maxAttempts ?? 3}
              </div>
              <h1 className="text-sm font-bold text-white truncate">
                {assessment?.title || "การสอบวัดผลปลายหลักสูตร"}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {!isGraded ? (
              <>
                <div className="text-xs font-mono bg-white/10 px-3 py-1.5 rounded-lg text-[#e2b857]">
                  ตอบแล้ว {Object.keys(answers).length}/{questions.length} ข้อ
                </div>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleSubmitExam}
                  className="px-4 py-2 rounded-xl bg-[#c89b3c] text-[#0b1f3a] text-xs font-bold hover:bg-[#e2b857] cursor-pointer"
                >
                  {submitting
                    ? "กำลังตรวจให้คะแนน..."
                    : "ส่งกระดาษคำตอบ (Submit Exam)"}
                </button>
              </>
            ) : (
              <Link
                href="/my/certificates"
                className="px-4 py-2 rounded-xl bg-[#c89b3c] text-[#0b1f3a] text-xs font-bold hover:bg-[#e2b857]"
              >
                ดูใบประกาศนียบัตร & หน่วยกิต CPE
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1320px] w-full mx-auto px-4 sm:px-6 py-8">
        {isGraded ? (
          /* GRADED RESULT & MODULE BREAKDOWN VIEW (06-exam-result.html aligned) */
          <div className="space-y-8">
            <div className="bg-white rounded-2xl border-2 border-[#c89b3c] p-6 sm:p-8 shadow-sm">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
                <div className="lg:col-span-8 space-y-3">
                  <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
                    {attempt.status === "passed" ? (
                      <span className="text-emerald-700 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>สอบผ่านตามเกณฑ์มาตรฐานสภาทนายความ (PASSED)</span>
                      </span>
                    ) : (
                      <span className="text-red-700 flex items-center gap-1.5">
                        <XCircle className="w-4 h-4" />
                        <span>ยังไม่ผ่านเกณฑ์คะแนนขั้นต่ำ (FAILED)</span>
                      </span>
                    )}
                  </div>

                  <h2 className="text-2xl sm:text-3xl font-bold text-[#0b1f3a]">
                    ผลคะแนนสอบ: {attempt.scorePct}% ({attempt.earnedPoints}/
                    {attempt.totalPoints} คะแนน)
                  </h2>

                  <p className="text-sm text-slate-600">
                    หลักสูตร <strong>{course?.titleTh}</strong> · เกณฑ์ผ่านขั้นต่ำ{" "}
                    {attempt.passPctSnapshot}% · นโยบายการเฉลย:{" "}
                    <code className="font-mono font-semibold">
                      {assessment?.reviewMode}
                    </code>
                  </p>

                  <div className="flex flex-wrap items-center gap-3 pt-2">
                    <Link
                      href="/my/certificates"
                      className="px-4 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54] inline-flex items-center gap-2"
                    >
                      <FileBadge className="w-4 h-4 text-[#e2b857]" />
                      <span>ดูใบประกาศนียบัตรดิจิทัล</span>
                    </Link>
                    <Link
                      href="/my/credits"
                      className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 inline-flex items-center gap-2"
                    >
                      <Award className="w-4 h-4 text-[#7a5b14]" />
                      <span>ตรวจสอบสมุดสะสมหน่วยกิต (+{course?.credits} CPE)</span>
                    </Link>
                  </div>
                </div>

                {/* Module Breakdown Summary */}
                <div className="lg:col-span-4 bg-slate-50 rounded-xl p-5 border border-slate-200 space-y-3">
                  <div className="text-xs font-bold text-[#0b1f3a]">
                    ผลคะแนนแยกตามโมดูล (Module Breakdown)
                  </div>
                  {(attempt.moduleBreakdown || []).map(
                    (mb: any, idx: number) => (
                      <div key={idx} className="space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-700 truncate">
                            {mb.moduleTitle}
                          </span>
                          <span className="font-mono font-bold text-slate-900">
                            {mb.percent}%
                          </span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden">
                          <div
                            className="h-full bg-[#1a4373] rounded-full"
                            style={{ width: `${mb.percent}%` }}
                          />
                        </div>
                      </div>
                    ),
                  )}
                </div>
              </div>
            </div>

            {/* Answer & Legal Explanation Review */}
            {(reviewPolicy?.allowed || reviewPolicy?.canReview) && (
              <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
                <h3 className="text-lg font-bold text-[#0b1f3a]">
                  ทบทวนคำตอบและคำอธิบายข้อกฎหมายรายข้อ ({questions.length} ข้อ)
                </h3>
                <div className="space-y-4">
                  {questions.map((q: any, idx: number) => {
                    const userChoiceId = attempt.answers?.[q.id];
                    return (
                      <div
                        key={q.id}
                        className="p-5 rounded-xl border border-slate-200 space-y-3"
                      >
                        <div className="flex items-center justify-between text-xs text-slate-500">
                          <span className="font-semibold text-[#0b1f3a]">
                            ข้อที่ {idx + 1} · {q.moduleTitle}
                          </span>
                          <span className="font-mono">{q.points} คะแนน</span>
                        </div>
                        <div className="text-sm font-bold text-slate-900">
                          {q.questionText}
                        </div>
                        <div className="space-y-2">
                          {q.options.map((opt: any) => {
                            const isSelected = userChoiceId === opt.id;
                            const isCorrect = opt.isCorrect === true;
                            return (
                              <div
                                key={opt.id}
                                className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-2 ${
                                  isCorrect
                                    ? "bg-emerald-50 border-emerald-300 text-emerald-950 font-semibold"
                                    : isSelected
                                      ? "bg-red-50 border-red-300 text-red-950"
                                      : "bg-slate-50 border-slate-200 text-slate-700"
                                }`}
                              >
                                <span>{opt.text}</span>
                                <span className="font-semibold inline-flex items-center gap-1 shrink-0">
                                  {isCorrect ? (
                                    <>
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                                      <span>คำตอบที่ถูกต้อง</span>
                                    </>
                                  ) : isSelected ? (
                                    <>
                                      <XCircle className="w-3.5 h-3.5 text-red-700" />
                                      <span>คำตอบที่คุณเลือก</span>
                                    </>
                                  ) : null}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        {q.explanation && (
                          <div className="p-3.5 rounded-xl bg-[#f0f6fc] border border-[#dce9f6] text-xs text-slate-800">
                            <strong className="text-[#0b1f3a]">
                              คำอธิบายข้อกฎหมาย:
                            </strong>{" "}
                            {q.explanation}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ACTIVE EXAM RUNNER VIEW (05-exam.html aligned) */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Question Card (8 cols) */}
            <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-6">
              {currentQuestion && (
                <>
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <div>
                      <span className="text-xs font-bold text-[#7a5b14]">
                        ข้อที่ {currentIndex + 1} จาก {questions.length} ·{" "}
                        {currentQuestion.moduleTitle}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleFlag(currentQuestion.id)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                        flagged.includes(currentQuestion.id)
                          ? "bg-amber-50 border-amber-300 text-amber-800"
                          : "border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <Flag className="w-3.5 h-3.5" />
                      <span>
                        {flagged.includes(currentQuestion.id)
                          ? "ติดธงทบทวนแล้ว"
                          : "ติดธงไว้ทบทวน"}
                      </span>
                    </button>
                  </div>

                  <div className="text-base sm:text-lg font-bold text-[#0b1f3a] leading-relaxed">
                    {currentQuestion.questionText}
                  </div>

                  <div className="space-y-3">
                    {currentQuestion.options.map((opt: any, oIdx: number) => {
                      const selected = answers[currentQuestion.id] === opt.id;
                      const thaiLetters = ["ก", "ข", "ค", "ง"];
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() =>
                            handleSelectOption(currentQuestion.id, opt.id)
                          }
                          className={`w-full p-4 rounded-xl border text-left text-sm flex items-start gap-3 transition-all cursor-pointer ${
                            selected
                              ? "border-[#0b1f3a] bg-[#f0f6fc] font-semibold text-[#0b1f3a]"
                              : "border-slate-200 hover:border-slate-300 text-slate-800"
                          }`}
                        >
                          <span
                            className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                              selected
                                ? "bg-[#0b1f3a] text-[#e2b857]"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {thaiLetters[oIdx] || oIdx + 1}
                          </span>
                          <span>{opt.text}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="pt-6 border-t border-slate-100 flex items-center justify-between">
                    <button
                      type="button"
                      disabled={currentIndex === 0}
                      onClick={() =>
                        setCurrentIndex((i) => Math.max(0, i - 1))
                      }
                      className="px-4 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 disabled:opacity-40 cursor-pointer"
                    >
                      ← ข้อก่อนหน้า
                    </button>

                    {currentIndex + 1 < questions.length ? (
                      <button
                        type="button"
                        onClick={() =>
                          setCurrentIndex((i) =>
                            Math.min(questions.length - 1, i + 1),
                          )
                        }
                        className="px-5 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold cursor-pointer"
                      >
                        ข้อถัดไป →
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={handleSubmitExam}
                        className="px-5 py-2.5 rounded-xl bg-[#c89b3c] text-[#0b1f3a] text-xs font-bold cursor-pointer"
                      >
                        ส่งกระดาษคำตอบและประมวลผลคะแนน
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Right Question Palette (4 cols) */}
            <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
              <div className="text-sm font-bold text-[#0b1f3a]">
                แผนผังข้อสอบ ({Object.keys(answers).length}/{questions.length}{" "}
                ข้อ)
              </div>
              <div className="grid grid-cols-5 gap-2">
                {questions.map((q: any, idx: number) => {
                  const isAnswered = Boolean(answers[q.id]);
                  const isFlag = flagged.includes(q.id);
                  const isCurrent = idx === currentIndex;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setCurrentIndex(idx)}
                      className={`h-10 rounded-xl font-mono text-xs font-bold border transition-all cursor-pointer ${
                        isCurrent
                          ? "ring-2 ring-[#0b1f3a] border-[#0b1f3a] bg-[#0b1f3a] text-[#e2b857]"
                          : isFlag
                            ? "bg-amber-50 border-amber-300 text-amber-800"
                            : isAnswered
                              ? "bg-emerald-50 border-emerald-300 text-emerald-800"
                              : "bg-slate-50 border-slate-200 text-slate-600"
                      }`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                disabled={submitting}
                onClick={handleSubmitExam}
                className="w-full py-3 px-4 rounded-xl bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] cursor-pointer"
              >
                {submitting
                  ? "กำลังตรวจกระดาษคำตอบ..."
                  : "ยืนยันส่งข้อสอบปลายหลักสูตร"}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function CourseExamPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#f7f8fa] text-sm text-slate-500">
          กำลังโหลดระบบสอบวัดผล...
        </div>
      }
    >
      <CourseExamContent />
    </Suspense>
  );
}

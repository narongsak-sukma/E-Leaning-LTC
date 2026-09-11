/**
 * ExamRoom — ห้องสอบ (Client Component) ตาม DESIGN-SYSTEM §7.1 + ธง lead
 *
 * - เปิดจากแคชชุดข้อในหน่วยความจำ (exam-paper-cache) เท่านั้น — ถ้าไม่พบ (reload
 *   กลางสอบ) = fail-closed แสดงแผง "กรุณาติดต่อเจ้าหน้าที่" ไม่พยายามเปิดชุดข้อคืนเอง
 *   ในทางใดทางหนึ่ง (ธง D37-6 ค) - state คำตอบอยู่ในหน้า (in-page) ห้าม localStorage/
 *   sessionStorage ทุกชนิด (ธง D37-6 ก)
 * - นาฬิกา: คำนวณจาก deadlineAt + offset ที่จับตอนรับ response ของ server เท่านั้น
 *   นาฬิกา client ใช้วัดช่วงเวลาที่ผ่านไปเท่านั้น (ธง lead: timer จาก server เท่านั้น)
 * - autosave ต่อข้อผ่าน exam-answers (ทันทีครั้งแรก + ห่างขั้นต่ำ 10 วิ/ข้อ) และ
 *   flush ทุกข้อก่อนกดส่ง
 * - ส่งข้อสอบ: flushAll → submitAttempt (Idempotency-Key ต่อ mount) → เคลียร์แคชชุดข้อ
 *   → ไปหน้าผลสอบ — คะแนน/ผ่าน-ไม่ผ่านไม่ parse ที่ client (ธง lead ข้อ 4)
 * - ไม่มีเฉลยในไฟล์นี้ทุกทาง (ธง lead ข้อ 3)
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  createExamAnswerSaver,
  type ExamAnswerItemSnapshot,
  type ExamAnswerSaver,
  type ExamAnswerSnapshot,
} from "@/lib/exam/exam-answers";
import {
  saveAttemptAnswer,
  submitAttempt,
  ExamApiError,
  type ExamPaperSession,
} from "@/lib/exam/exam-api";
import { clearExamPaper, readExamPaper } from "@/lib/exam/exam-paper-cache";
import {
  clampRemainingMs,
  examTimerTone,
  formatExamClock,
  formatSavedAtTime,
  remainingMsOf,
  type ExamTimerTone,
} from "@/lib/exam/exam-timer";

/** สถานะห้องสอบ - checking = SSR/ก่อนอ่านแคช (server กับ client เรนเดอร์เหมือนกัน) */
type RoomPhase =
  | { kind: "checking" }
  | { kind: "no_paper"; reason: "missing" | "invalid_time" }
  | { kind: "ready" }
  | { kind: "submitting" }
  | {
      kind: "submit_failed";
      title: string;
      message: string;
      canRetry: boolean;
    }
  | { kind: "leaving" };

/** uuid v4 สำหรับ Idempotency-Key (มี fallback สำหรับ context ที่ไม่มี randomUUID) */
function createIdempotencyKey(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const rand = Math.trunc(Math.random() * 16);
    const value = ch === "x" ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** ป้ายข้อความไทยของโทนนาฬิกา (A11y - ไม่สื่อสารด้วยสีอย่างเดียว) */
const TIMER_TONE_LABEL: Record<ExamTimerTone, string> = {
  normal: "",
  warning: "เหลือเวลาไม่ถึง 15 นาที",
  danger: "เหลือเวลาไม่ถึง 5 นาที",
};

/** สร้าง snapshot คำตอบเริ่มต้นจากชุดข้อ (คำตอบ seed จาก server เฉพาะ takeover) */
function initialSnapshotOf(
  questions: readonly {
    readonly questionId: string;
    readonly selectedOptionIds: readonly string[] | null;
  }[],
): Record<string, ExamAnswerItemSnapshot> {
  const snapshot: Record<string, ExamAnswerItemSnapshot> = {};
  for (const question of questions) {
    snapshot[question.questionId] = {
      choiceIds: question.selectedOptionIds ?? [],
      saving: false,
      error: false,
      savedAt: null,
    };
  }
  return snapshot;
}


export function ExamRoom({
  attemptId,
}: {
  readonly attemptId: string;
}) {
  const router = useRouter();
  // hydration-safe: SSR และ render แรกของ client เรนเดอร์ "checking" เหมือนกันเสมอ
  const [phase, setPhase] = useState<RoomPhase>({ kind: "checking" });
  const [session, setSession] = useState<ExamPaperSession | null>(null);
  const [answers, setAnswers] = useState<ExamAnswerSnapshot>({});
  const [currentIdx, setCurrentIdx] = useState(0);
  const [flags, setFlags] = useState<Readonly<Record<string, boolean>>>({});
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [idempotencyKey] = useState<string>(() => createIdempotencyKey());
  const saverRef = useRef<ExamAnswerSaver | null>(null);
  const offsetRef = useRef(0);
  const answersRef = useRef<ExamAnswerSnapshot>({});
  // หมดเวลา = remaining ≤ 0 (ตัดสินจริงเป็นฝั่ง server เสมอ - overlay เป็นแค่การแจ้งเตือน)
  const timeup = remainingMs !== null && remainingMs <= 0;

  // เปิดห้องสอบจากแคชในหน่วยความจำเท่านั้น - ไม่พบ = fail-closed (ธง D37-6)
  useEffect(() => {
    const entry = readExamPaper(attemptId);
    if (entry === null) {
      setPhase({ kind: "no_paper", reason: "missing" });
      return;
    }
    const anchor = remainingMsOf(entry.session.deadlineAt, entry.serverOffsetMs, Date.now());
    if (anchor === null) {
      setPhase({ kind: "no_paper", reason: "invalid_time" });
      return;
    }
    offsetRef.current = entry.serverOffsetMs;
    const initial = initialSnapshotOf(entry.session.questions);
    const initialChoices: Record<string, readonly string[]> = {};
    for (const question of entry.session.questions) {
      initialChoices[question.questionId] = question.selectedOptionIds ?? [];
    }
    const saver = createExamAnswerSaver(initialChoices, {
      now: () => Date.now(),
      save: (questionId, choiceIds) => saveAttemptAnswer(attemptId, questionId, choiceIds),
      onStateChange: (snapshot) => {
        answersRef.current = snapshot;
        setAnswers(snapshot);
      },
    });
    saverRef.current = saver;
    setSession(entry.session);
    setAnswers(initial);
    answersRef.current = initial;
    setRemainingMs(clampRemainingMs(anchor));
    setPhase({ kind: "ready" });
    return () => {
      saver.dispose();
      saverRef.current = null;
    };
  }, [attemptId]);

  // นาฬิกาถอยหลังจากคู่ deadlineAt + offset ของ server (ธง lead: timer จาก server เท่านั้น)
  useEffect(() => {
    if (session === null) {
      return;
    }
    const deadlineAt = session.deadlineAt;
    const tick = (): void => {
      const remaining = remainingMsOf(deadlineAt, offsetRef.current, Date.now());
      if (remaining === null) {
        setPhase((prev) =>
          prev.kind === "ready" || prev.kind === "submitting"
            ? { kind: "no_paper", reason: "invalid_time" }
            : prev,
        );
        return;
      }
      setRemainingMs(clampRemainingMs(remaining));
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [session]);

  // ธง D37-6 (ข): เตือนก่อนออกจากหน้าระหว่างสอบ (beforeunload)
  useEffect(() => {
    if (phase.kind !== "ready" && phase.kind !== "submitting") {
      return;
    }
    if (timeup === true) {
      return;
    }
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [phase.kind, timeup]);

  // Escape ปิด dialog ยืนยันส่ง
  useEffect(() => {
    if (dialogOpen === false) {
      return;
    }
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setDialogOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [dialogOpen]);

  // ส่งข้อสอบ: flush autosave ทุกข้อ → submit (Idempotency-Key ต่อ mount) → เคลียร์แคช → ไปหน้าผล
  const handleSubmit = async (): Promise<void> => {
    if (session === null || phase.kind === "submitting" || phase.kind === "leaving") {
      return;
    }
    setDialogOpen(false);
    setPhase({ kind: "submitting" });
    const saver = saverRef.current;
    if (saver !== null) {
      await saver.flushAll();
    }
    const snapshot = answersRef.current;
    const unansweredQuestionIds = session.questions
      .filter((question) => (snapshot[question.questionId]?.choiceIds.length ?? 0) === 0)
      .map((question) => question.questionId);
    try {
      await submitAttempt(session.attemptId, unansweredQuestionIds, idempotencyKey);
    } catch (error: unknown) {
      if (error instanceof ExamApiError && error.code === "ERR-ASM-005") {
        // ถูกส่งไปแล้วก่อนหน้า (เช่น retry หลัง network fail) - ถือว่าสำเร็จ ไปหน้าผลต่อ
      } else if (error instanceof ExamApiError && error.code === "ERR-ASM-004") {
        setPhase({
          kind: "submit_failed",
          title: "หมดเวลาสอบแล้ว",
          message:
            "หมดเวลาสอบตามที่ระบบกำหนด ระบบจะสรุปผลการสอบครั้งนี้เป็นการสอบที่ไม่ผ่านเงื่อนไขเวลา " +
            "กรุณาติดต่อเจ้าหน้าที่สภาทนายความแห่งประเทศไทย โทร 0 2351 1128 หากต้องการขอความช่วยเหลือ",
          canRetry: false,
        });
        return;
      } else {
        setPhase({
          kind: "submit_failed",
          title: "ส่งข้อสอบไม่สำเร็จ",
          message:
            "ส่งข้อสอบไม่สำเร็จ คำตอบที่บันทึกไว้ยังอยู่ครบถ้วน กรุณาลองส่งอีกครั้ง " +
            "หากลองแล้วยังไม่สำเร็จ อย่าปิดหน้านี้ ให้ติดต่อเจ้าหน้าที่ โทร 0 2351 1128",
          canRetry: true,
        });
        return;
      }
    }
    clearExamPaper(session.attemptId);
    setPhase({ kind: "leaving" });
    router.replace(`/my/exams/${session.attemptId}`);
  };

  const questions = session?.questions ?? [];
  const currentQuestion = questions[currentIdx] ?? null;
  const answeredCount = questions.filter(
    (question) => (answers[question.questionId]?.choiceIds.length ?? 0) > 0,
  ).length;
  const unsentErrorCount = Object.values(answers).filter((item) => item.error).length;
  const anySaving = Object.values(answers).some((item) => item.saving);
  const lastSavedAtIso = Object.values(answers)
    .map((item) => item.savedAt)
    .filter((iso): iso is string => iso !== null)
    .sort()
    .at(-1) ?? null;
  const timerTone = examTimerTone(remainingMs ?? Number.MAX_SAFE_INTEGER);
  const timerLabel = TIMER_TONE_LABEL[timerTone];

  if (phase.kind === "checking") {
    return (
      <p className="rounded-[14px] border border-mist-200 bg-white p-8 text-center text-sm text-ink-500 shadow-card">
        กำลังตรวจสอบสถานะการสอบ...
      </p>
    );
  }

  if (phase.kind === "no_paper") {
    return (
      <section
        className="rounded-[14px] border border-danger-100 bg-white p-8 shadow-card"
        role="alert"
      >
        <h2 className="font-heading text-lg font-bold text-danger-600">
          ระบบไม่สามารถเปิดชุดข้อสอบได้
        </h2>
        <p className="mt-3 text-sm text-ink-700">
          {phase.reason === "missing"
            ? "ระบบไม่พบชุดข้อสอบในหน้านี้ มักเกิดจากการรีเฟรชหรือปิดหน้าเว็บระหว่างสอบ "
            : "ระบบได้รับข้อมูลเวลาสอบที่ไม่ถูกต้อง "}
          ตามกติกา ระบบไม่สามารถเปิดชุดข้อสอบคืนให้ได้ด้วยตัวเอง
        </p>
        <p className="mt-3 text-sm text-ink-700">
          กรุณาติดต่อเจ้าหน้าที่สภาทนายความแห่งประเทศไทย โทร 0 2351 1128
          (จันทร์-ศุกร์ 8:30-16:30 น.) เพื่อขอความช่วยเหลือ
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/my/exams"
            className="rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-mist-50"
          >
            ไปที่ประวัติการสอบ
          </Link>
        </div>
      </section>
    );
  }

  if (phase.kind === "submit_failed") {
    return (
      <section className="rounded-[14px] border border-danger-100 bg-white p-8 shadow-card" role="alert">
        <h2 className="font-heading text-lg font-bold text-danger-600">{phase.title}</h2>
        <p className="mt-3 text-sm text-ink-700">{phase.message}</p>
        {phase.canRetry ? (
          <button
            type="button"
            onClick={() => {
              void handleSubmit();
            }}
            className="mt-6 rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
          >
            ลองส่งอีกครั้ง
          </button>
        ) : (
          <Link
            href="/my/exams"
            className="mt-6 inline-flex rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-mist-50"
          >
            ไปที่ประวัติการสอบ
          </Link>
        )}
      </section>
    );
  }


  if (phase.kind === "leaving") {
    return (
      <p className="rounded-[14px] border border-mist-200 bg-white p-8 text-center text-sm text-ink-500 shadow-card">
        ส่งข้อสอบสำเร็จ กำลังพาไปหน้าผลสอบ...
      </p>
    );
  }

  const timerColorClass =
    timerTone === "danger"
      ? "text-danger-600"
      : timerTone === "warning"
        ? "text-warning-600"
        : "text-ink-900";
  const dialogBackdropClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) {
      setDialogOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* sticky timer + autosave status bar (DS 7.1) */}
      <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-mist-200 bg-white/95 px-4 py-3 shadow-card backdrop-blur">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">เวลาที่เหลือ</p>
          <p className={"font-heading text-3xl font-bold tabular-nums " + timerColorClass}>
            {remainingMs === null ? "--:--:--" : formatExamClock(remainingMs)}
          </p>
          {timerLabel !== "" ? (
            <p className="text-sm font-semibold" role="status">{timerLabel}</p>
          ) : null}
        </div>
        <div className="text-right">
          {anySaving ? (
            <p className="text-sm font-semibold text-brand-600" role="status">
              กำลังบันทึกคำตอบ...
            </p>
          ) : unsentErrorCount > 0 ? (
            <p className="text-sm font-semibold text-danger-600" role="alert">
              บันทึกอัตโนมัติไม่สำเร็จ ระบบจะลองใหม่เมื่อแก้คำตอบหรือกดส่ง
            </p>
          ) : lastSavedAtIso !== null ? (
            <p className="text-sm text-ink-500" role="status">
              บันทึกล่าสุด {formatSavedAtTime(lastSavedAtIso) ?? "--:--:--"}
            </p>
          ) : (
            <p className="text-sm text-ink-500">ยังไม่มีการบันทึก</p>
          )}
          <p className="mt-1 text-xs text-ink-500">
            ตอบแล้ว {answeredCount} จาก {questions.length} ข้อ
            {unsentErrorCount > 0 ? " · มีข้อที่บันทึกไม่สำเร็จ" : ""}
          </p>
        </div>
      </div>

      {/* takeover banner (server-sanctioned continuation, ASM-011) */}
      {session?.takeover === true ? (
        <p className="rounded-[10px] bg-warning-50 p-4 text-sm font-semibold text-warning-600" role="status">
          ระบบอนุญาตให้สอบต่อจากครั้งก่อน (ยืนยันจากเซิร์ฟเวอร์) - คำตอบที่บันทึกไว้ถูกเรียกคืนแล้ว
        </p>
      ) : null}

      {/* question grid navigation (DS 7.1) */}
      <nav aria-label="นำทางข้อสอบ" className="rounded-[14px] border border-mist-200 bg-white p-4 shadow-card">
        <ol className="flex flex-wrap gap-2">
          {questions.map((question, index) => {
            const answered = (answers[question.questionId]?.choiceIds.length ?? 0) > 0;
            const flagged = flags[question.questionId] === true;
            const isCurrent = index === currentIdx;
            const navClass =
              "relative h-10 w-10 rounded-[10px] text-sm font-semibold transition-colors " +
              (answered ? "bg-brand-600 text-white " : "border border-mist-300 bg-white text-ink-700 ") +
              (isCurrent ? "ring-2 ring-brand-500 ring-offset-2 " : "") +
              "hover:bg-brand-100 hover:text-ink-900";
            return (
              <li key={question.questionId}>
                <button
                  type="button"
                  aria-label={"ไปที่ข้อ " + question.seq + (answered ? " (ตอบแล้ว)" : " (ยังไม่ตอบ)") + (flagged ? " (ทำเครื่องหมาย)" : "")}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => {
                    setCurrentIdx(index);
                  }}
                  className={navClass}
                >
                  {question.seq}
                  {flagged ? (
                    <span aria-hidden="true" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-warning-600" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* current question card */}
      {currentQuestion === null ? null : (
        <fieldset className="rounded-[14px] border border-mist-200 bg-white p-6 shadow-card">
          <legend className="px-1 font-heading text-base font-semibold text-ink-900">
            ข้อ {currentQuestion.seq} จาก {questions.length}
          </legend>
          <p className="whitespace-pre-line text-base text-ink-900">{currentQuestion.content.text}</p>
          <div className="mt-4 space-y-2">
            {currentQuestion.content.options.map((option) => {
              const checked = (answers[currentQuestion.questionId]?.choiceIds ?? []).includes(option.id);
              const optionClass =
                "flex items-start gap-3 rounded-[10px] border p-3 text-sm text-ink-700 " +
                (checked ? "border-brand-600 bg-brand-50" : "border-mist-200 bg-white hover:bg-mist-50");
              return (
                <label key={option.id} className={optionClass}>
                  <input
                    type="checkbox"
                    className="mt-1 accent-brand-600"
                    checked={checked}
                    disabled={phase.kind === "submitting" || timeup}
                    onChange={() => {
                      saverRef.current?.toggle(currentQuestion.questionId, option.id);
                    }}
                  />
                  <span>{option.text}</span>
                </label>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              aria-pressed={flags[currentQuestion.questionId] === true}
              onClick={() => {
                setFlags((prev) => ({
                  ...prev,
                  [currentQuestion.questionId]: prev[currentQuestion.questionId] !== true,
                }));
              }}
              className={
                "rounded-[10px] border px-4 py-2 text-sm font-semibold " +
                (flags[currentQuestion.questionId] === true
                  ? "border-warning-600 bg-warning-50 text-warning-600"
                  : "border-mist-300 bg-white text-ink-700 hover:bg-mist-50")
              }
            >
              {flags[currentQuestion.questionId] === true ? "ยกเลิกทำเครื่องหมาย" : "ทำเครื่องหมายไว้ทบทวน"}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setCurrentIdx((prev) => Math.max(0, prev - 1));
                }}
                disabled={currentIdx === 0}
                className="rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ข้อก่อนหน้า
              </button>
              <button
                type="button"
                onClick={() => {
                  setCurrentIdx((prev) => Math.min(questions.length - 1, prev + 1));
                }}
                disabled={currentIdx >= questions.length - 1}
                className="rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ข้อถัดไป
              </button>
            </div>
          </div>
        </fieldset>
      )}

      {/* submit button */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => {
            setDialogOpen(true);
          }}
          disabled={phase.kind === "submitting"}
          className="rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
        >
          {phase.kind === "submitting" ? "กำลังส่งข้อสอบ..." : "ส่งข้อสอบ"}
        </button>
        <p className="text-xs text-ink-500">
          ส่งแล้วแก้ไขไม่ได้ - ระบบจะบันทึกคำตอบที่ยังไม่ได้บันทึกให้อัตโนมัติก่อนส่ง
        </p>
      </div>

      {/* confirm dialog */}
      {dialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/60 p-4"
          onClick={dialogBackdropClick}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="exam-submit-dialog-title"
            className="w-full max-w-md rounded-[14px] bg-white p-6 shadow-pop"
          >
            <h2 id="exam-submit-dialog-title" className="font-heading text-lg font-bold text-ink-900">
              ยืนยันการส่งข้อสอบ
            </h2>
            <p className="mt-3 text-sm text-ink-700">
              ตอบแล้ว {answeredCount} จาก {questions.length} ข้อ ยังไม่ตอบ {questions.length - answeredCount} ข้อ
            </p>
            {unsentErrorCount > 0 ? (
              <p className="mt-2 text-sm font-semibold text-danger-600">
                มีข้อที่บันทึกล่าสุดไม่สำเร็จ {unsentErrorCount} ข้อ ระบบจะพยายามบันทึกใหม่ก่อนส่ง
              </p>
            ) : null}
            <p className="mt-2 text-sm font-semibold text-danger-600">ส่งแล้วแก้ไขไม่ได้</p>
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setDialogOpen(false);
                }}
                className="rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleSubmit();
                }}
                className="rounded-[10px] bg-brand-600 px-6 py-2 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
              >
                ยืนยันส่งข้อสอบ
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* time-up overlay: server is the authority (grace handled server-side) */}
      {timeup && phase.kind === "ready" ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/60 p-4">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="exam-timeup-title"
            className="w-full max-w-md rounded-[14px] border border-danger-100 bg-white p-6 shadow-pop"
          >
            <h2 id="exam-timeup-title" className="font-heading text-lg font-bold text-danger-600">
              หมดเวลาสอบแล้ว
            </h2>
            <p className="mt-3 text-sm text-ink-700">
              หมดเวลาสอบตามที่ระบบกำหนด ระบบหยุดรับคำตอบเพิ่มแล้ว กรุณากดปุ่มด้านล่างเพื่อสรุปผลการสอบ
            </p>
            <p className="mt-2 text-sm text-ink-500">
              ระบบตัดสินหมดเวลาจากเวลาของระบบฝั่งเซิร์ฟเวอร์เสมอ ไม่ใช่เวลาบนเครื่องของท่าน
            </p>
            <button
              type="button"
              onClick={() => {
                void handleSubmit();
              }}
              className="mt-5 rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
            >
              ส่งข้อสอบตอนนี้
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

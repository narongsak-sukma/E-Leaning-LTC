/**
 * QuizPanel — ฟอร์มแบบทดสอบ (API §3.4 POST /lessons/{id}/quiz/submit body { answers })
 * Phase 0: มี quizId → ตรวจด้วย fixtureSubmitQuiz (ผล/คะแนนจาก fixture)
 * quizId null → POST ตามสัญญา (ยัง 404 จนถึง Phase 1) · Phase 1 สลับด้วย prop submitQuiz · ห้ามส่ง `completed` (D12-1)
 */
"use client";

import { useMemo, useState } from "react";

import {
  fixtureSubmitQuiz,
  lessonQuizSubmitUrl,
  type QuizQuestionView,
  type QuizSubmitRequest,
  type QuizSubmitResponse,
  type SubmitQuizFn,
} from "@/lib/fixtures/learning";

import { QuizResult } from "./quiz-result";

type QuizStatus = "editing" | "sending" | "result";

export function QuizPanel({
  lessonId,
  title,
  questions,
  passPct,
  bestScorePct,
  quizId,
  submitQuiz,
}: {
  lessonId: string;
  title: string;
  questions: readonly QuizQuestionView[];
  passPct: number;
  bestScorePct: number | null;
  quizId: string | null;
  submitQuiz?: SubmitQuizFn;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<QuizStatus>("editing");
  const [result, setResult] = useState<QuizSubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const incomplete = useMemo(
    () => questions.filter((question) => (answers[question.id] ?? []).length === 0),
    [answers, questions],
  );

  const handleSubmit = async () => {
    if (incomplete.length > 0) {
      setError("กรุณาเลือกคำตอบให้ครบทุกข้อ");
      return;
    }
    const body: QuizSubmitRequest = {
      answers: questions.map((question) => ({
        questionId: question.id,
        choiceIds: answers[question.id] ?? [],
      })),
    };
    setStatus("sending");
    setError(null);
    try {
      const payload = submitQuiz
        ? await submitQuiz(body)
        : quizId !== null
          ? await Promise.resolve(fixtureSubmitQuiz(quizId, body))
          : await fetch(lessonQuizSubmitUrl(lessonId), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }).then((response) => {
              if (!response.ok) {
                throw new Error(`quiz ${response.status}`);
              }
              return response.json() as Promise<QuizSubmitResponse>;
            });
      setResult(payload);
      setStatus("result");
    } catch {
      setError("ส่งคำตอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      setStatus("editing");
    }
  };

  return (
    <div>
      <h3 className="font-heading text-lg font-bold text-ink-900">{title}</h3>
      <p className="mt-1 text-sm text-ink-600">
        ผ่านเกณฑ์ {passPct}% · ใช้คะแนนสูงสุดตลอดช่วง
        {bestScorePct !== null ? ` · คะแนนสูงสุดที่เคยได้ ${bestScorePct}%` : ""}
      </p>
      {status === "result" && result ? (
        <div className="mt-4">
          <QuizResult
            result={result}
            questions={questions}
            answers={answers}
            onRetry={() => {
              setStatus("editing");
            }}
          />
        </div>
      ) : (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          {error ? (
            <p
              role="alert"
              className="rounded-[10px] bg-danger-50 px-4 py-3 text-sm font-semibold text-danger-600"
            >
              {error}
            </p>
          ) : null}
          {!error && incomplete.length > 0 && incomplete.length < questions.length ? (
            <p className="text-sm text-ink-500">ยังเลือกคำตอบไม่ครบ (เหลือ {incomplete.length} ข้อ)</p>
          ) : null}
          {questions.map((question) => {
            const picked = answers[question.id] ?? [];
            return (
              <fieldset
                key={question.id}
                className="rounded-[14px] border border-mist-200 bg-white p-4 shadow-card"
              >
                <legend className="px-1 font-heading text-base font-semibold text-ink-900">
                  {question.prompt}
                </legend>
                <div className="mt-1 space-y-2">
                  {question.choices.map((choice) => (
                    <label key={choice.id} className="flex items-start gap-2 text-sm text-ink-700">
                      <input
                        type="checkbox"
                        name={question.id}
                        value={choice.id}
                        checked={picked.includes(choice.id)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...picked, choice.id]
                            : picked.filter((id) => id !== choice.id);
                          setAnswers({ ...answers, [question.id]: next });
                        }}
                        className="mt-1 accent-brand-600"
                      />
                      <span>{choice.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
          <button
            type="submit"
            disabled={status === "sending"}
            className="rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
          >
            {status === "sending" ? "กำลังส่งคำตอบ..." : "ส่งคำตอบ"}
          </button>
        </form>
      )}
    </div>
  );
}

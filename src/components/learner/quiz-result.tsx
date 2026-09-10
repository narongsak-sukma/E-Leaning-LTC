/**
 * QuizResult — มุมมองผลหลังส่งแบบทดสอบ (200 คะแนน + เฉลย ตาม API §3.4)
 * ข้อที่ตอบผิดขึ้นก่อนเพื่อทบทวน · รูปแบบ ID-join ตามสัญญาจริง (label จาก questions)
 */
"use client";

import {
  type QuizQuestionView,
  type QuizSubmitResponse,
} from "@/lib/fixtures/learning";

export function QuizResult({
  result,
  questions,
  answers,
  onRetry,
}: {
  result: QuizSubmitResponse;
  questions: readonly QuizQuestionView[];
  answers: Record<string, string[]>;
  onRetry: () => void;
}) {
  const orderedResults = [...result.results].sort(
    (a, b) => Number(a.isCorrect) - Number(b.isCorrect),
  );
  return (
    <div className="space-y-4">
      <div className="rounded-[14px] border border-mist-200 bg-white p-5 shadow-card">
        <p className="font-heading text-2xl font-bold tabular-nums text-ink-900">
          ได้คะแนน {result.scorePct}%{" "}
          <span className={result.passed ? "text-success-600" : "text-danger-600"}>
            ({result.passed ? "ผ่านเกณฑ์" : "ยังไม่ผ่านเกณฑ์"})
          </span>
        </p>
        <p className="mt-1 text-sm text-ink-600">
          ตอบถูก {result.results.filter((item) => item.isCorrect).length} จาก {result.results.length} ข้อ
        </p>
      </div>
      <ol className="space-y-4">
        {orderedResults.map((item) => {
          const question = questions.find((q) => q.id === item.questionId);
          const picked = answers[item.questionId] ?? [];
          return (
            <li key={item.questionId} className="rounded-[14px] border border-mist-200 bg-white p-4 shadow-card">
              <h4 className="font-heading text-base font-semibold text-ink-900">
                {question ? question.prompt : item.questionId}
                {!item.isCorrect ? (
                  <span className="ml-2 text-sm font-semibold text-danger-600">(ตอบผิด)</span>
                ) : null}
              </h4>
              <ul className="mt-2 space-y-1 text-sm">
                {(question?.choices ?? []).map((choice) => {
                  const isCorrect = item.correctChoiceIds.includes(choice.id);
                  const wasPicked = picked.includes(choice.id);
                  if (isCorrect) {
                    return (
                      <li key={choice.id} className="font-semibold text-success-600">
                        ✓ {choice.label} — คำตอบที่ถูกต้อง
                        {wasPicked ? " (คุณเลือกข้อนี้)" : ""}
                      </li>
                    );
                  }
                  if (wasPicked) {
                    return (
                      <li key={choice.id} className="text-danger-600">
                        ✗ {choice.label} — คำตอบที่คุณเลือก
                      </li>
                    );
                  }
                  return null;
                })}
              </ul>
              <p className="mt-2 text-sm text-ink-600">
                คำอธิบาย: {item.explanation ?? "—"}
              </p>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-[10px] border border-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
      >
        ทำซ้ำอีกครั้ง
      </button>
    </div>
  );
}

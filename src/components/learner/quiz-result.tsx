/**
 * QuizResult — ผลหลังส่งแบบทดสอบ (POST /lessons/{id}/quiz/submit 200)
 *
 * - contract จริงของ BFF (QuizSubmitView — src/lib/schemas/v1/progress): { attemptId, scorePct,
 *   passed } — server ตรวจผ่าน RPC record_quiz_attempt (grading server ล้วน) และไม่ส่งเฉลยรายข้อ
 *   กลับมา จึงแสดงได้เฉพาะคะแนน + ผ่าน/ไม่ผ่าน (เฉลยไม่เคยอยู่ฝั่ง client แม้หลังส่ง — DCR-5/D28)
 * - "ทำซ้ำอีกครั้ง" = กลับไปแก้คำตอบ (สถานะผ่านใช้คะแนนสูงสุดตลอดช่วง — progress_pass_score_policy)
 */
"use client";

import { type QuizSubmitResult } from "@/lib/fixtures/learning";

export function QuizResult({
  result,
  passPct,
  onRetry,
}: {
  result: QuizSubmitResult;
  passPct: number;
  onRetry: () => void;
}) {
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
          เกณฑ์ผ่าน {passPct}% · ระบบตรวจคำตอบจากเซิร์ฟเวอร์ และบันทึกคะแนนสูงสุดตลอดช่วงให้อัตโนมัติ
        </p>
      </div>
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

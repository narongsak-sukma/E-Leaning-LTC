/**
 * หน้าผลสอบ (/my/exams/[attemptId]) — ธง lead ข้อ 4
 *
 * - แสดงผล "ตามที่ BFF (GET /attempts/{id}/result) ตอบเป๊ะ" เท่านั้น - ห้ามเดาฝั่ง client
 * - content === null (view ยังไม่เปิดเฉลย: after_final_attempt) = แสดงว่า "ยังไม่เปิดเฉลย
 *   ตามกติกา" โดยไม่แสดง isCorrect/points/explanation ทั้งหมด (เป็น null จาก BFF อยู่แล้ว
 *   UI ไม่แต่งเอง) - เมื่อเปิดเฉลยแล้ว จึงแสดงเฉลย + คะแนนรายข้อตาม response
 */
import type { Metadata } from "next";
import Link from "next/link";

import {
  formatThaiDateTime,
  loadAttemptResult,
  type ExamPageError,
} from "@/lib/exam/exam.server";

export const metadata: Metadata = {
  title: "ผลการสอบ — ระบบฝึกอบรมออนไลน์",
  description: "ผลการสอบและเฉลยตามที่ระบบบันทึก",
};

function ResultErrorPanel({ kind }: { kind: ExamPageError["kind"] }): React.ReactElement {
  if (kind === "unauthenticated") {
    return (
      <div
        className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
        role="alert"
      >
        <p className="font-heading text-base font-semibold text-ink-900">กรุณาเข้าสู่ระบบ</p>
        <p className="mt-1 text-sm text-ink-600">ท่านยังไม่ได้เข้าสู่ระบบ</p>
        <Link
          href="/login"
          className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-2 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
        >
          เข้าสู่ระบบ
        </Link>
      </div>
    );
  }
  if (kind === "not_found") {
    return (
      <div
        className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
        role="alert"
      >
        <p className="font-heading text-base font-semibold text-ink-900">ไม่พบผลการสอบ</p>
        <p className="mt-1 text-sm text-ink-600">
          ไม่พบผลการสอบนี้ หรือท่านไม่มีสิทธิ์เข้าถึง
        </p>
        <Link
          href="/my/exams"
          className="mt-4 inline-flex rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-mist-50"
        >
          กลับหน้าประวัติการสอบ
        </Link>
      </div>
    );
  }
  return (
    <div
      className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
      role="alert"
    >
      <p className="font-heading text-base font-semibold text-ink-900">โหลดข้อมูลไม่สำเร็จ</p>
      <p className="mt-1 text-sm text-ink-600">
        ระบบขัดข้องชั่วคราว กรุณารีเฟรชหน้าเว็บเพื่อลองใหม่อีกครั้ง หากยังมีปัญหา
        กรุณาติดต่อเจ้าหน้าที่สภาทนายความแห่งประเทศไทย โทร 0 2351 1128
      </p>
    </div>
  );
}

/** ป้ายสถานะของ attempt (ใช้เฉพาะโทนที่มีใน theme) */
const RESULT_STATUS: Record<string, { text: string; className: string }> = {
  in_progress: { text: "กำลังสอบ", className: "bg-warning-50 text-warning-600" },
  submitted: { text: "ส่งแล้ว", className: "bg-brand-50 text-brand-600" },
  passed: { text: "ผ่าน", className: "bg-success-50 text-success-600" },
  failed: { text: "ไม่ผ่าน", className: "bg-danger-50 text-danger-600" },
  expired: { text: "หมดเวลา", className: "bg-mist-100 text-ink-500" },
  voided: { text: "ยกเลิก", className: "bg-mist-100 text-ink-500" },
};

export default async function ExamResultPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const { attemptId } = await params;
  const data = await loadAttemptResult(attemptId);

  if (data.kind !== "ready") {
    return (
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink-900">ผลการสอบ</h1>
        <ResultErrorPanel kind={data.kind} />
      </div>
    );
  }

  const result = data.result;
  const status = RESULT_STATUS[result.status] ?? {
    text: result.status,
    className: "bg-mist-100 text-ink-500",
  };
  const submittedLabel =
    result.submittedAt === null ? null : (formatThaiDateTime(result.submittedAt) ?? null);
  const startedLabel = formatThaiDateTime(result.startedAt) ?? "-";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-bold text-ink-900">ผลการสอบ ครั้งที่ {result.attemptNo}</h1>
        <span className={"rounded-full px-3 py-1 text-xs font-semibold " + status.className}>
          {status.text}
        </span>
      </div>

      <section className="mt-5 rounded-[14px] border border-mist-200 bg-white p-6 shadow-card">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
          <div className="flex justify-between gap-4 border-b border-mist-100 py-2 text-sm">
            <dt className="text-ink-500">เริ่มสอบ</dt>
            <dd className="font-semibold text-ink-900">{startedLabel}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-mist-100 py-2 text-sm">
            <dt className="text-ink-500">ส่งข้อสอบ</dt>
            <dd className="font-semibold text-ink-900">
              {submittedLabel ?? "ยังไม่ส่ง (ระบบจะสรุปผลตามกติกา)"}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-mist-100 py-2 text-sm">
            <dt className="text-ink-500">จำนวนข้อ</dt>
            <dd className="font-semibold text-ink-900">{result.questionCount} ข้อ</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-mist-100 py-2 text-sm">
            <dt className="text-ink-500">คะแนนรวม</dt>
            <dd className="font-semibold text-ink-900">
              {result.scorePct === null ? "รอผล" : `${result.scorePct}%`}
            </dd>
          </div>
        </dl>
        {result.passed === true ? (
          <p className="mt-4 rounded-[10px] bg-success-50 p-4 text-sm font-semibold text-success-600">
            ยินดีด้วย ท่านสอบผ่านตามเกณฑ์ที่กำหนด
          </p>
        ) : null}
        {result.passed === false ? (
          <p className="mt-4 rounded-[10px] bg-danger-50 p-4 text-sm font-semibold text-danger-600">
            ครั้งนี้ท่านยังไม่ผ่านเกณฑ์ที่กำหนด
          </p>
        ) : null}
      </section>

      <h2 className="mt-8 font-heading text-lg font-bold text-ink-900">รายข้อ</h2>
      {result.questions.map((question) => {
        const answerKeyOpen = question.content !== null;
        return (
          <section
            key={question.questionId}
            className="mt-3 rounded-[14px] border border-mist-200 bg-white p-6 shadow-card"
          >
            <p className="font-heading text-base font-semibold text-ink-900">
              ข้อ {question.seq} จาก {result.questionCount}
            </p>
            {question.content === null ? (
              <p className="mt-2 text-sm text-ink-500">
                ข้อความโจทย์ยังไม่แสดงตามกติกาการเปิดเฉลยของระบบ
              </p>
            ) : (
              <p className="mt-2 whitespace-pre-line text-sm text-ink-700">{question.content.text}</p>
            )}
            <p className="mt-2 text-sm text-ink-500">
              ที่ตอบ: {question.selectedOptionIds === null || question.selectedOptionIds.length === 0
                ? "ไม่ได้ตอบข้อนี้"
                : `ตอบ ${question.selectedOptionIds.length} ตัวเลือก`}
              {answerKeyOpen ? "" : " · ยังไม่เปิดเฉลยตามกติกา"}
            </p>
            {question.content !== null ? (
              <ol className="mt-3 space-y-2">
                {question.content.options.map((option) => {
                  const selected = (question.selectedOptionIds ?? []).includes(option.id);
                  const optionTone = option.isCorrect === true
                    ? "border-success-600 bg-success-50"
                    : selected
                      ? "border-danger-600 bg-danger-50"
                      : "border-mist-200 bg-white";
                  return (
                    <li
                      key={option.id}
                      className={"rounded-[10px] border p-3 text-sm text-ink-700 " + optionTone}
                    >
                      <span className="mr-2">{option.isCorrect === true ? "ถูกต้อง" : selected ? "ที่ท่านเลือก" : ""}</span>
                      {option.text}
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {question.content !== null && question.explanation !== null && question.explanation !== "" ? (
              <div className="mt-3 rounded-[10px] bg-mist-50 p-3 text-sm text-ink-700">
                <p className="font-semibold">คำอธิบาย</p>
                <p className="mt-1 whitespace-pre-line">{question.explanation}</p>
              </div>
            ) : null}
            {question.content !== null && question.pointsEarned !== null ? (
              <p className="mt-2 text-xs text-ink-500">ได้ {question.pointsEarned} คะแนน</p>
            ) : null}
          </section>
        );
      })}

      <div className="mt-8">
        <Link
          href="/my/exams"
          className="inline-flex rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-mist-50"
        >
          กลับหน้าประวัติการสอบ
        </Link>
      </div>
    </div>
  );
}

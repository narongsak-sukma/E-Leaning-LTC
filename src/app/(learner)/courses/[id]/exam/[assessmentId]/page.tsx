/**
 * หน้ากติกาก่อนสอบ (/courses/[id]/exam/[assessmentId]) — ธง lead ข้อ 1
 *
 * - โหลด AssessmentDetailView จาก BFF (GET /assessments/{id}) ผ่าน exam.server
 *   (server-only + forward cookie) แล้วแสดงกติกา: จำนวนข้อ, เวลา, เกณฑ์ผ่าน,
 *   จำนวนครั้ง, cooldown, การสลับข้อ/ตัวเลือก, proctoring
 * - ตรวว่า detail.courseId ตรงกับ [id] ใน URL - ไม่ตรง = not_found (fail-closed)
 * - ERR-ASM-002 flow อยู่ที่ปุ่มเริ่มสอบ (ExamRulesStart) - หน้านี้แสดงกติกาตาม BFF
 * - attemptsUsed นับจาก GET /me/attempts เฉพาะเมื่อ hasMore = false เท่านั้น
 */
import type { Metadata } from "next";
import Link from "next/link";

import { ExamRulesStart } from "@/components/learner/exam/exam-rules-start";
import { loadAssessmentDetail, loadMyAttemptsPage, type ExamPageError } from "@/lib/exam/exam.server";

export const metadata: Metadata = {
  title: "กติกาการสอบ — ระบบฝึกอบรมออนไลน์",
  description: "กติกาการสอบและการยืนยันเริ่มสอบ",
};

/** แผง error กลางของหน้า (fail-closed ตาม C-8) */
function RulesErrorPanel({ kind }: { kind: ExamPageError["kind"] }): React.ReactElement {
  if (kind === "unauthenticated") {
    return (
      <div
        className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
        role="alert"
      >
        <p className="font-heading text-base font-semibold text-ink-900">กรุณาเข้าสู่ระบบ</p>
        <p className="mt-1 text-sm text-ink-600">
          ท่านยังไม่ได้เข้าสู่ระบบ กรุณาเข้าสู่ระบบด้วยบัญชีผู้เรียนของท่าน
        </p>
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
        <p className="font-heading text-base font-semibold text-ink-900">ไม่พบการสอบนี้</p>
        <p className="mt-1 text-sm text-ink-600">
          ไม่พบการสอบที่ท่านเรียก หรือท่านไม่มีสิทธิ์เข้าถึง กรุณาตรวจสอบลิงก์อีกครั้ง
        </p>
        <Link
          href="/my/courses"
          className="mt-4 inline-flex rounded-[10px] border border-mist-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-mist-50"
        >
          กลับหน้าหลักสูตรของฉัน
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

/** แถวข้อมูลกติกา */
function RuleRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-4 border-b border-mist-100 py-2 text-sm last:border-b-0">
      <dt className="text-ink-500">{label}</dt>
      <dd className="font-semibold text-ink-900">{value}</dd>
    </div>
  );
}

export default async function ExamRulesPage({
  params,
}: {
  params: Promise<{ id: string; assessmentId: string }>;
}) {
  const { id, assessmentId } = await params;
  const data = await loadAssessmentDetail(assessmentId);

  if (data.kind !== "ready") {
    return (
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink-900">กติกาการสอบ</h1>
        <RulesErrorPanel kind={data.kind} />
      </div>
    );
  }

  // fail-closed: courseId ใน URL ไม่ตรงกับ BFF = ไม่พบ (ไม่เปิดเผยข้อมูลรายวิชาอื่น)
  if (data.detail.courseId !== id) {
    return (
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink-900">กติกาการสอบ</h1>
        <RulesErrorPanel kind="not_found" />
      </div>
    );
  }

  const detail = data.detail;
  const rules = detail.rules;
  // นับครั้งที่ใช้ไปเฉพาะเมื่อประวัติไม่มีหน้าถัดไป (ไม่งั้นจะไม่ครบ - ส่ง null แทน)
  const history = await loadMyAttemptsPage(undefined);
  const attemptsUsed =
    history.kind === "ready" && history.hasMore === false
      ? history.attempts.filter((attempt) => attempt.assessmentId === assessmentId).length
      : null;
  const shuffleText =
    rules.shuffleQuestions || rules.shuffleOptions ? "มีการสลับลำดับ" : "ไม่สลับลำดับ";

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">{detail.title}</h1>
      {detail.description !== null ? (
        <p className="mt-2 text-sm text-ink-600">{detail.description}</p>
      ) : null}

      <section className="mt-6 rounded-[14px] border border-mist-200 bg-white p-6 shadow-card">
        <h2 className="font-heading text-lg font-bold text-ink-900">กติกาการสอบ</h2>
        <dl className="mt-3">
          <RuleRow label="จำนวนข้อสอบ" value={`${rules.questionCount} ข้อ`} />
          <RuleRow label="เวลาที่ได้รับ" value={`${rules.timeLimitMinutes} นาที`} />
          <RuleRow
            label="เกณฑ์ผ่าน"
            value={`คะแนนรวมไม่น้อยกว่า ${rules.passPct} เปอร์เซ็นต์`}
          />
          <RuleRow label="จำนวนครั้งที่สอบได้" value={`${rules.maxAttempts} ครั้ง`} />
          <RuleRow
            label="เวลารอระหว่างครั้ง"
            value={rules.attemptCooldownMinutes === 0 ? "ไม่มี" : `${rules.attemptCooldownMinutes} นาที`}
          />
          <RuleRow label="ลำดับข้อ/ตัวเลือก" value={shuffleText} />
          <RuleRow
            label="เงื่อนไขเข้าสอบ"
            value={rules.requireCourseComplete ? "ต้องเรียนบทเรียนให้ครบก่อน" : "ไม่มีเงื่อนไขการเรียน"}
          />
          <RuleRow
            label="การควบคุมการสอบ"
            value={rules.proctoringMode === "basic" ? "เปิดใช้การตรวจสอบพื้นฐาน" : "ไม่มี"}
          />
          <RuleRow
            label="เฉลย"
            value="เปิดหลังใช้ครั้งการสอบครั้งสุดท้ายตามกติกา"
          />
        </dl>
      </section>

      <ExamRulesStart
        courseId={id}
        assessmentId={assessmentId}
        attemptsUsed={attemptsUsed}
        maxAttempts={rules.maxAttempts}
        />
</div>
  );
}

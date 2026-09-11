/**
 * หน้าประวัติการสอบ (/my/exams) — ธง lead ข้อ 4
 *
 * - โหลด GET /me/attempts (limit 100/หน้า เรียงใหม่ล่าสุดก่อน) ผ่าน exam.server
 * - แบ่งหน้าด้วย cursor (?cursor=) ตาม envelope 1.2 · cursor จาก BFF ต่อท้ายลิงก์
 * - แสดงตามที่ BFF ตอบเท่านั้น - วันเวลาจัดฝั่ง server (th-TH พุทธศักราช)
 */
import type { Metadata } from "next";
import Link from "next/link";

import { formatThaiDateTime, loadMyAttemptsPage, type ExamPageError } from "@/lib/exam/exam.server";

export const metadata: Metadata = {
  title: "ประวัติการสอบ — ระบบฝึกอบรมออนไลน์",
  description: "ประวัติการสอบทั้งหมดของท่าน",
};

/** ป้ายสถานะการสอบ */
const STATUS_TEXT: Record<string, string> = {
  in_progress: "กำลังสอบ",
  submitted: "ส่งแล้ว",
  passed: "ผ่าน",
  failed: "ไม่ผ่าน",
  expired: "หมดเวลา",
  voided: "ยกเลิก",
};

/** ชั้นสีของป้ายสถานะ (ใช้เฉพาะโทนที่มีใน theme) */
const STATUS_CLASS: Record<string, string> = {
  in_progress: "bg-warning-50 text-warning-600",
  submitted: "bg-brand-50 text-brand-600",
  passed: "bg-success-50 text-success-600",
  failed: "bg-danger-50 text-danger-600",
  expired: "bg-mist-100 text-ink-500",
  voided: "bg-mist-100 text-ink-500",
};

function HistoryErrorPanel({ kind }: { kind: ExamPageError["kind"] }): React.ReactElement {
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
        <p className="font-heading text-base font-semibold text-ink-900">ไม่พบข้อมูล</p>
        <p className="mt-1 text-sm text-ink-600">ไม่พบประวัติการสอบของท่าน</p>
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

export default async function MyExamsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const data = await loadMyAttemptsPage(cursor);

  if (data.kind !== "ready") {
    return (
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink-900">ประวัติการสอบ</h1>
        <HistoryErrorPanel kind={data.kind} />
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">ประวัติการสอบ</h1>
      {data.attempts.length === 0 ? (
        <div className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card">
          <p className="font-heading text-base font-semibold text-ink-900">ยังไม่มีประวัติการสอบ</p>
          <p className="mt-1 text-sm text-ink-600">เมื่อท่านเริ่มทำการสอบ รายการจะแสดงที่หน้านี้</p>
          <Link
            href="/my/courses"
            className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-2 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
          >
            ไปที่หลักสูตรของฉัน
          </Link>
        </div>
      ) : (
        <ul className="mt-5 space-y-3">
          {data.attempts.map((attempt) => {
            const statusText = STATUS_TEXT[attempt.status] ?? attempt.status;
            const statusClass = STATUS_CLASS[attempt.status] ?? "bg-mist-100 text-ink-500";
            const submittedLabel = attempt.submittedAt === null
              ? null
              : (formatThaiDateTime(attempt.submittedAt) ?? null);
            const startedLabel = formatThaiDateTime(attempt.startedAt) ?? "-";
            return (
              <li
                key={attempt.id}
                className="rounded-[14px] border border-mist-200 bg-white p-5 shadow-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-heading text-base font-semibold text-ink-900">
                      การสอบครั้งที่ {attempt.attemptNo}
                    </p>
                    <p className="mt-1 text-sm text-ink-500">เริ่ม {startedLabel}</p>
                    {submittedLabel !== null ? (
                      <p className="text-sm text-ink-500">ส่ง {submittedLabel}</p>
                    ) : null}
                  </div>
                  <span className={"rounded-full px-3 py-1 text-xs font-semibold " + statusClass}>
                    {statusText}
                  </span>
                </div>
                {attempt.scorePct !== null ? (
                  <p className="mt-2 text-sm text-ink-700">
                    คะแนน {attempt.scorePct}%{attempt.passed === true ? " (ผ่าน)" : attempt.passed === false ? " (ไม่ผ่าน)" : ""}
                  </p>
                ) : null}
                <Link
                  href={`/my/exams/${attempt.id}`}
                  className="mt-3 inline-flex text-sm font-semibold text-brand-600 hover:text-brand-700"
                >
                  ดูผลการสอบ
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {/* แบ่งหน้าด้วย cursor จาก BFF (envelope 1.2) */}
      {data.kind === "ready" && data.hasMore === true && data.nextCursor !== null ? (
        <div className="mt-6 text-center">
          <Link
            href={`/my/exams?cursor=${encodeURIComponent(data.nextCursor)}`}
            className="inline-flex rounded-[10px] border border-mist-300 bg-white px-6 py-2 text-sm font-semibold text-ink-700 hover:bg-mist-50"
          >
            โหลดรายการก่อนหน้าเพิ่มเติม
          </Link>
        </div>
      ) : null}
    </div>
  );
}

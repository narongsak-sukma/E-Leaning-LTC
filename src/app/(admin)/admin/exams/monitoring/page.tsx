import type { Metadata } from "next";
import Link from "next/link";
import { AdminDataState } from "@/components/admin/AdminDataState";
import { formatThaiDateTime } from "@/lib/exam-admin.view";
import { getExamMonitoringData } from "@/components/admin/reports/exams";

export const metadata: Metadata = {
  title: "มอนิเตอร์การสอบสด · หลังบ้าน",
  description:
    "จำนวนที่กำลังสอบ/ค้างเกินเวลา แยกตามชุดข้อสอบ/หลักสูตร (GET /api/v1/admin/exams/monitoring)",
};

export default async function AdminExamMonitoringPage() {
  const result = await getExamMonitoringData();
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">มอนิเตอร์การสอบสด</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/exams/monitoring" />
        </div>
      </div>
    );
  }
  const { generatedAt, summary, byAssessment, byCourse } = result.data;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">มอนิเตอร์การสอบสด</h1>
          <p className="mt-1 text-sm text-ink-500">
            ข้อมูลสดจาก BFF — สรุปเวลา {formatThaiDateTime(generatedAt)}
          </p>
        </div>
        <Link
          href="/admin/reports"
          className="inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          กลับศูนย์รายงาน
        </Link>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-[10px] border border-mist-200 bg-white p-5 shadow-card">
          <p className="text-sm text-ink-500">กำลังสอบอยู่</p>
          <p className="font-heading text-3xl font-bold text-ink-900">
            {summary.inProgressCount === null ? "—" : String(summary.inProgressCount)}
          </p>
        </div>
        <div className="rounded-[10px] border border-mist-200 bg-white p-5 shadow-card">
          <p className="text-sm text-ink-500">ค้างเกินเวลา</p>
          <p className="font-heading text-3xl font-bold text-ink-900">
            {summary.overdueCount === null ? "—" : String(summary.overdueCount)}
          </p>
        </div>
      </div>

      <h2 className="mt-6 font-heading text-base font-semibold text-ink-900">แยกตามชุดข้อสอบ</h2>
      <div className="mt-2 overflow-x-auto rounded-[10px] border border-mist-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mist-200 text-start text-xs text-ink-500">
              <th className="px-4 py-3 text-start font-medium">ชุดข้อสอบ</th>
              <th className="px-4 py-3 text-start font-medium">กำลังสอบ</th>
              <th className="px-4 py-3 text-start font-medium">ค้างเกินเวลา</th>
            </tr>
          </thead>
          <tbody>
            {byAssessment.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-ink-400">
                  ไม่มีการสอบให้มอนิเตอร์ในขณะนี้
                </td>
              </tr>
            ) : (
              byAssessment.map((row) => (
                <tr key={row.assessmentId} className="border-b border-mist-100 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-ink-600">{row.assessmentId}</td>
                  <td className="px-4 py-3">{row.inProgress}</td>
                  <td className="px-4 py-3">{row.overdue}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 className="mt-6 font-heading text-base font-semibold text-ink-900">แยกตามหลักสูตร</h2>
      <div className="mt-2 overflow-x-auto rounded-[10px] border border-mist-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mist-200 text-start text-xs text-ink-500">
              <th className="px-4 py-3 text-start font-medium">หลักสูตร</th>
              <th className="px-4 py-3 text-start font-medium">กำลังสอบ</th>
              <th className="px-4 py-3 text-start font-medium">ค้างเกินเวลา</th>
            </tr>
          </thead>
          <tbody>
            {byCourse.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-ink-400">
                  ไม่มีข้อมูลหลักสูตร
                </td>
              </tr>
            ) : null}
            {byCourse.map((row) => (
              <tr key={row.courseId} className="border-b border-mist-100 last:border-0">
                <td className="px-4 py-3">
                  {row.titleTh ?? <span className="font-mono text-xs">{row.courseId}</span>}
                </td>
                <td className="px-4 py-3">{row.inProgress === null ? "—" : String(row.inProgress)}</td>
                <td className="px-4 py-3">{row.overdue === null ? "—" : String(row.overdue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { AdminDataState } from "@/components/admin/AdminDataState";
import { getExamStatisticsData } from "@/components/admin/reports/exams";

export const metadata: Metadata = {
  title: "สถิติผลสอบ · หลังบ้าน",
  description:
    "จำนวนสอบ/ผ่าน/เรทผ่าน/คะแนนเฉลี่ย ต่อชุดข้อสอบ (GET /api/v1/admin/exams/statistics)",
};

/** pure — แสดงตัวเลขหรือ — เมื่อ null (บทบาทไม่มีสิทธิ์ดูตัวเลขนั้น) */
function pct(value: number | null): string {
  return value === null ? "—" : String(value);
}

export default async function AdminExamStatisticsPage() {
  const result = await getExamStatisticsData();
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">สถิติผลสอบ</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/exams/statistics" />
        </div>
      </div>
    );
  }
  const rows = result.data;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">สถิติผลสอบ</h1>
          <p className="mt-1 text-sm text-ink-500">
            ต่อชุดข้อสอบ (ล่าสุด {rows.length} ชุด — เพดาน 500 ตาม route จริง)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/api/v1/admin/reports/assessments/export?format=csv"
            className="inline-flex rounded-[10px] bg-brand-600 px-[18px] py-2 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
          >
            ส่งออก CSV ผลสอบ
          </a>
          <Link
            href="/admin/reports"
            className="inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
          >
            กลับศูนย์รายงาน
          </Link>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto rounded-[10px] border border-mist-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mist-200 text-start text-xs text-ink-500">
              <th className="px-4 py-3 text-start font-medium">ชุดข้อสอบ</th>
              <th className="px-4 py-3 text-start font-medium">สอบทั้งหมด</th>
              <th className="px-4 py-3 text-start font-medium">ผ่าน</th>
              <th className="px-4 py-3 text-start font-medium">เรทผ่าน (%)</th>
              <th className="px-4 py-3 text-start font-medium">คะแนนเฉลี่ย (%)</th>
            </tr>
          </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-ink-400">
                ยังไม่มีข้อมูลสถิติ
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.assessmentId} className="border-b border-mist-100 last:border-0">
                <td className="px-4 py-3 font-mono text-xs text-ink-600">{row.assessmentId}</td>
                <td className="px-4 py-3">{pct(row.attemptTotal)}</td>
                <td className="px-4 py-3">{pct(row.attemptPassed)}</td>
                <td className="px-4 py-3">{pct(row.passRatePct)}</td>
                <td className="px-4 py-3">{pct(row.avgScorePct)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

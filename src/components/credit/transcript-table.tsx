/**
 * TranscriptTable — ตาราง transcript ของหน้า /my/transcript (Wave E Phase 3)
 *
 * - Server Component (ไม่มี "use client") — ข้อมูลเป็น props จากหน้า RSC
 * - คอลัมน์: หลักสูตร · สถานะ · ผ่าน · คะแนนสูงสุด (%) · หน่วยกิต · ใบประกาศณียบัตร
 *   (badge ต่อใบ — ป้ายสถานะไทย + โทนจากทะเบียนกลาง fixtures/certificates เดียวกับ
 *   หน้าประกาศนียบัตรของฉัน)
 * - ป้ายสถานะ/จำนวนหน่วยกิตมาจาก pure helpers ของ src/lib/api/credits.ts
 */
import {
  enrollmentStatusThai,
  formatCreditsText,
  passedLabel,
  type TranscriptEntryParsed,
} from "@/lib/api/credits";
import { certificateStatusThai, certificateStatusTone } from "@/lib/fixtures/certificates";

/** badge สถานะใบประกาศฯ — ป้ายไทย + โทนตาม DESIGN-SYSTEM §5.6 (Record ครบทุก enum ให้ tsc บังคับครบ) */
function CertBadge({ cert }: { cert: TranscriptEntryParsed["certificates"][number] }) {
  const tone = certificateStatusTone(cert.status);
  const toneClass =
    tone === "success"
      ? "bg-success-50 text-success-600"
      : tone === "danger"
        ? "bg-danger-50 text-danger-600"
        : "bg-warning-50 text-warning-600";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[10px] border border-mist-200 px-2 py-1 text-xs font-semibold ${toneClass}`}
    >
      {cert.cert_no} · {certificateStatusThai(cert.status)}
    </span>
  );
}

/** แถวเดียวของตาราง — ป้าย "ผ่าน" โทนสีตามผล (ผ่าน = เขียว, ไม่ผ่าน = แดง, ยังไม่มีผล = เทา) */
function PassedCell({ passed }: { passed: boolean | null }) {
  const label = passedLabel(passed);
  return (
    <span
      className={
        passed === true
          ? "font-semibold text-success-600"
          : passed === false
            ? "font-semibold text-danger-600"
            : "text-ink-500"
      }
    >
      {label}
    </span>
  );
}

/** ตาราง transcript — เรียงแถวตาม entries ที่ RPC จัดลำดับมาแล้ว */
export function TranscriptTable({ entries }: { entries: readonly TranscriptEntryParsed[] }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-[14px] border border-mist-200 bg-white shadow-card">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-mist-200 bg-mist-50">
            <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
              หลักสูตร
            </th>
            <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
              สถานะ
            </th>
            <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
              ผ่าน
            </th>
            <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
              คะแนนสูงสุด (%)
            </th>
            <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
              หน่วยกิต
            </th>
            <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
              ใบประกาศณียบัตร
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            return (
              <tr key={entry.enrollment_id} className="border-b border-mist-100 last:border-b-0">
                <td className="px-4 py-3 font-semibold text-ink-900">{entry.course_title}</td>
                <td className="px-4 py-3 text-ink-600">
                  {enrollmentStatusThai(entry.enrollment_status)}
                </td>
                <td className="px-4 py-3">
                  <PassedCell passed={entry.passed} />
                </td>
                <td className="px-4 py-3 text-ink-600 tabular-nums">
                  {entry.best_score_pct === null ? "-" : entry.best_score_pct}
                </td>
                <td className="px-4 py-3 text-ink-600">
                  {formatCreditsText(entry.credits) === "" ? "—" : formatCreditsText(entry.credits)}
                </td>
                <td className="px-4 py-3">
                  {entry.certificates.length === 0 ? (
                    <span className="text-ink-500">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {entry.certificates.map((cert) => {
                        return <CertBadge key={cert.cert_no} cert={cert} />;
                      })}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


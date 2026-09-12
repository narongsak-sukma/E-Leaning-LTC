/**
 * CreditHistoryTable — ตารางประวัติรายรอบของหน้า /my/credits (Wave E Phase 3)
 *
 * - Server Component (ไม่มี "use client") — ข้อมูลเป็น props จากหน้า RSC
 * - คอลัมน์: รอบที่ · ช่วงวัน · สถานะ · เกณฑ์ · ยอด
 * - history ว่าง = แถวเดียวแจ้งว่ายังไม่มีประวัติ (ไม่ทิ้งพื้นที่ว่างเปล่า)
 */
import {
  creditTypeThai,
  cycleStatusThai,
  formatCreditAmount,
  formatCycleDateThai,
  type CreditCycleParsed,
} from "@/lib/api/credits";

import { creditTypeRowsOfCycle } from "./cycle-progress-card";

/** ยอดรวมต่อ type เป็น text — "ทั่วไป 3.5/12" คั่น ", " · ไม่มีรายการ = "—" */
function amountsText(cycle: CreditCycleParsed): string {
  const rows = creditTypeRowsOfCycle(cycle);
  if (rows.length === 0) {
    return "—";
  }
  return rows
    .map((row) => `${row.label} ${formatCreditAmount(row.earned)}/${formatCreditAmount(row.required)}`)
    .join(", ");
}

/** เกณฑ์ต่อ type เป็น text — "ทั่วไป 12" คั่น ", " · ไม่มีเกณฑ์ = "—" */
function requirementsText(cycle: CreditCycleParsed): string {
  const keys = Object.keys(cycle.required_credits);
  if (keys.length === 0) {
    return "—";
  }
  return keys
    .map((creditType) => {
      return `${creditTypeThai(creditType)} ${formatCreditAmount(cycle.required_credits[creditType] ?? 0)}`;
    })
    .join(", ");
}

/** ป้ายสถานะรอบ (โทนเดียวกับการ์ดรอบปัจจุบัน) */
function HistoryStatusBadge({ status }: { status: CreditCycleParsed["status"] }) {
  const label = cycleStatusThai(status);
  const toneClass =
    status === "open" ? "bg-success-50 text-success-600" : "bg-mist-100 text-ink-600";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold ${toneClass}`}
    >
      {label}
    </span>
  );
}

/** ตารางประวัติรายรอบ — คอลัมน์: รอบที่ · ช่วงวัน · สถานะ · เกณฑ์ · ยอด */
export function CreditHistoryTable({ history }: { history: readonly CreditCycleParsed[] }) {
  return (
    <section aria-labelledby="credit-history-heading" className="mt-6">
      <h2 id="credit-history-heading" className="font-heading text-lg font-bold text-ink-900">
        ประวัติรายรอบ
      </h2>
      <div className="mt-3 overflow-x-auto rounded-[14px] border border-mist-200 bg-white shadow-card">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-mist-200 bg-mist-50">
              <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
                รอบที่
              </th>
              <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
                ช่วงวัน
              </th>
              <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
                สถานะ
              </th>
              <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
                เกณฑ์
              </th>
              <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
                ยอด
              </th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-600">
                  ยังไม่มีประวัติรอบ
                </td>
              </tr>
            ) : (
              history.map((cycle) => {
                return (
                  <tr key={cycle.cycle_id} className="border-b border-mist-100 last:border-b-0">
                    <td className="px-4 py-3 font-semibold tabular-nums text-ink-900">
                      {cycle.cycle_no}
                    </td>
                    <td className="px-4 py-3 text-ink-600">
                      {formatCycleDateThai(cycle.starts_on)} – {formatCycleDateThai(cycle.ends_on)}
                    </td>
                    <td className="px-4 py-3">
                      <HistoryStatusBadge status={cycle.status} />
                    </td>
                    <td className="px-4 py-3 text-ink-600">{requirementsText(cycle)}</td>
                    <td className="px-4 py-3 text-ink-600">{amountsText(cycle)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * CycleProgressCard — การ์ด "หน่วยกิตรอบปัจจุบัน" ของหน้า /my/credits (Wave E Phase 3)
 *
 * - Server Component (ไม่มี "use client") — ข้อมูลเป็น props จากหน้า RSC (โหลดผ่าน
 *   delegate src/lib/api/credits.ts — cookie forward ในหน้า)
 * - แถมแถวย่อยต่อ credit_type: รวมคีย์ required_credits ∪ balances — balances มีเฉพาะ
 *   type ที่มีรายการ ledger แล้ว จึงต้องรวมกัน type ที่ยังไม่มีรายการ (earned = 0,
 *   missing = เกณฑ์เต็ม) ไม่งั้นการ์ดโชว์น้อยกว่าเกณฑ์จริง
 * - แถบความคืบหน้าใช้ ProgressBar กลางของผู้เรียน (DESIGN-SYSTEM §5.4) · ข้อความไทยทั้งหมด
 */
import {
  creditTypeThai,
  cycleStatusThai,
  formatCreditAmount,
  formatCycleDateThai,
  type CreditCycleParsed,
} from "@/lib/api/credits";
import { ProgressBar } from "@/components/learner/progress-bar";

/** แถวย่อยต่อ credit_type หลังรวม required_credits กับ balances แล้ว */
export interface CreditTypeRow {
  readonly creditType: string;
  readonly label: string;
  readonly earned: number;
  readonly required: number;
  readonly missing: number;
}

/**
 * รวมคีย์ required_credits ∪ balances ต่อ cycle — เรียง: คีย์ของ required_credits ตามลำดับ
 * ที่ RPC ส่งมาก่อน แล้วคีย์เฉพาะที่มีใน balances (เช่น type ที่ไม่มีเกณฑ์แต่มีรายการ ledger)
 */
export function creditTypeRowsOfCycle(cycle: CreditCycleParsed): readonly CreditTypeRow[] {
  const rows: CreditTypeRow[] = [];
  const seen = new Set<string>();
  for (const creditType of Object.keys(cycle.required_credits)) {
    if (seen.has(creditType)) {
      continue;
    }
    seen.add(creditType);
    const balance = cycle.balances[creditType];
    if (balance === undefined) {
      // type ที่ตั้งเกณฑ์ไว้แต่ยังไม่มีรายการ ledger — นับว่าได้รับ 0 ขาดเท่ากับเกณฑ์เต็ม
      const required = cycle.required_credits[creditType] ?? 0;
      rows.push({
        creditType,
        label: creditTypeThai(creditType),
        earned: 0,
        required,
        missing: Math.max(required, 0),
      });
      continue;
    }
    rows.push({
      creditType,
      label: creditTypeThai(creditType),
      earned: balance.earned,
      required: balance.required,
      missing: balance.missing,
    });
  }
  for (const creditType of Object.keys(cycle.balances)) {
    if (seen.has(creditType)) {
      continue;
    }
    seen.add(creditType);
    const balance = cycle.balances[creditType];
    if (balance === undefined) {
      continue;
    }
    rows.push({
      creditType,
      label: creditTypeThai(creditType),
      earned: balance.earned,
      required: balance.required,
      missing: balance.missing,
    });
  }
  return rows;
}

/** เปอร์เซ็นต์ความคืบหน้า — เกณฑ์ 0 = ไม่มีเกณฑ์ (100% เมื่อมีหน่วยกิต ไม่งั้น 0) */
export function progressPercent(earned: number, required: number): number {
  if (required <= 0) {
    return earned > 0 ? 100 : 0;
  }
  return Math.max(0, Math.min(100, Math.round((earned / required) * 100)));
}

/** ป้ายสถานะรอบ — ข้อความไทย + โทนสีตาม DESIGN-SYSTEM §5.6 */
function CycleStatusBadge({ status }: { status: CreditCycleParsed["status"] }) {
  const label = cycleStatusThai(status);
  const toneClass =
    status === "open"
      ? "bg-success-50 text-success-600"
      : status === "closed"
        ? "bg-mist-100 text-ink-600"
        : "bg-warning-50 text-warning-600";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold ${toneClass}`}
    >
      <span
        aria-hidden="true"
        className={
          status === "open"
            ? "bg-success-600"
            : status === "closed"
              ? "bg-ink-400"
              : "bg-warning-600"
        }
      />
      {label}
    </span>
  );
}

/** แถวย่อยต่อ credit_type — ป้าย + ยอด + แถบความคืบหน้า + สรุปสิ่งที่ขาด */
function CreditTypeProgressRow({ row }: { row: CreditTypeRow }) {
  const percent = progressPercent(row.earned, row.required);
  return (
    <li className="border-t border-mist-100 pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-heading text-sm font-semibold text-ink-900">{row.label}</p>
        <p className="text-sm text-ink-600 tabular-nums">
          ได้รับ {formatCreditAmount(row.earned)} จาก {formatCreditAmount(row.required)} หน่วยกิต
        </p>
      </div>
      <div className="mt-2">
        <ProgressBar
          percent={percent}
          label={`ความคืบหน้าหน่วยกิต${row.label !== row.creditType ? ` (${row.creditType})` : ""}`}
        />
      </div>
      <p
        className={
          row.missing > 0
            ? "mt-1.5 text-sm font-semibold text-gold-600"
            : "mt-1.5 text-sm font-semibold text-success-600"
        }
      >
        {row.missing > 0
          ? `ขาดอีก ${formatCreditAmount(row.missing)} หน่วยกิต`
          : "ครบตามเกณฑ์แล้ว"}
      </p>
    </li>
  );
}

/** การ์ดหน่วยกิตรอบปัจจุบัน — หัวรอบ + สถานะ + แถวย่อยต่อ credit_type */
export function CycleProgressCard({ cycle }: { cycle: CreditCycleParsed }) {
  const rows = creditTypeRowsOfCycle(cycle);
  return (
    <section
      aria-labelledby="credit-cycle-heading"
      className="mt-5 rounded-[14px] border border-mist-200 bg-white p-6 shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="credit-cycle-heading" className="font-heading text-lg font-bold text-ink-900">
          หน่วยกิตรอบปัจจุบัน
        </h2>
        <CycleStatusBadge status={cycle.status} />
      </div>
      <p className="mt-1 text-sm text-ink-600">
        รอบที่ {cycle.cycle_no} · {formatCycleDateThai(cycle.starts_on)} –{" "}
        {formatCycleDateThai(cycle.ends_on)}
      </p>
      <ul className="mt-4">
        {rows.map((row) => {
          return <CreditTypeProgressRow key={row.creditType} row={row} />;
        })}
      </ul>
    </section>
  );
}


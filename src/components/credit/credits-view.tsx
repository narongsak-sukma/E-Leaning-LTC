/**
 * CreditsView — มุมมองทั้งหน้าของ /my/credits (Wave E Phase 3)
 *
 * - Server Component (ไม่มี "use client") — ข้อมูลเป็น props จากหน้า RSC
 * - สถานะหน้า: ยังไม่เข้าสู่ระบบ / ระบบขัดข้อง / ผู้ไม่มีรอบ (citizen/ยังไม่มีข้อมูล —
 *   ข้อความอธิบาย ไม่ error) / พร้อมแสดง (การ์ดรอบปัจจุบัน + ตารางประวัติรายรอบ)
 */
import Link from "next/link";

import type { CreditSummaryViewParsed } from "@/lib/api/credits";

import { CreditHistoryTable } from "./credit-history-table";
import { CycleProgressCard } from "./cycle-progress-card";

/** ข้อมูลหน้า /my/credits — สถานะ ยังไม่ login / ระบบขัดข้อง / ไม่มีรอบ / พร้อมแสดง */
export type CreditsPageData =
  | { kind: "unauthenticated" }
  | { kind: "error" }
  | { kind: "no-cycle"; summary: CreditSummaryViewParsed }
  | { kind: "ready"; summary: CreditSummaryViewParsed };

/** สถานะ "ยังไม่เข้าสู่ระบบ" — แผงไทย + ปุ่มไปหน้าเข้าสู่ระบบ (next กลับมาหน้าเดิม) */
function UnauthenticatedPanel() {
  return (
    <section
      aria-labelledby="credit-unauth-heading"
      className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
    >
      <h2 id="credit-unauth-heading" className="font-heading text-lg font-bold text-ink-900">
        กรุณาเข้าสู่ระบบ
      </h2>
      <p className="mt-2 text-sm text-ink-600">
        หน้านี้แสดงหน่วยกิตสะสมของผู้ใช้ที่เข้าสู่ระบบแล้วเท่านั้น
      </p>
      <Link
        href="/login?next=%2Fmy%2Fcredits"
        className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
      >
        ไปหน้าเข้าสู่ระบบ
      </Link>
    </section>
  );
}

/** สถานะระบบขัดข้อง — fail-closed ภาษาไทย (ไม่แสดง error ดิบ/stack) */
function ErrorPanel() {
  return (
    <div
      role="alert"
      className="mt-5 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center"
    >
      <p className="font-heading text-base font-semibold text-danger-700">
        โหลดข้อมูลหน่วยกิตของท่านไม่สำเร็จ
      </p>
      <p className="mt-1 text-sm text-danger-600">
        กรุณารีเฟรชหน้าเว็บเพื่อลองใหม่อีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่
      </p>
    </div>
  );
}

/**
 * สถานะ "ผู้ไม่มีรอบ" (citizen/ยังไม่มีข้อมูล) — ข้อความอธิบาย ไม่ error (CRB-005:
 * RPC คืน current: null) · ถ้ามีประวัติรอบเดิมค้างอยู่ แสดงตารางประวัติต่อท้ายด้วย
 */
function NoCyclePanel({ summary }: { summary: CreditSummaryViewParsed }) {
  return (
    <div>
      <section
        aria-labelledby="credit-nocycle-heading"
        className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
      >
        <h2 id="credit-nocycle-heading" className="font-heading text-lg font-bold text-ink-900">
          ยังไม่มีรอบหน่วยกิตสะสม
        </h2>
        <p className="mt-2 text-sm text-ink-600">
          หน่วยกิตสะสมใช้สำหรับการต่ออายุใบอนุญาตว่าความสำหรับทนายความ — รอบหน่วยกิตจะเริ่มนับ
          เมื่อท่านเป็นทนายความที่ถือใบอนุญาต หรือเมื่อมีรายการหน่วยกิตเข้ามา
        </p>
      </section>
      {summary.history.length > 0 ? <CreditHistoryTable history={summary.history} /> : null}
    </div>
  );
}

/** มุมมองทั้งหน้า — แยกตามสถานะของ page data */
export function CreditsView({ data }: { data: CreditsPageData }) {
  if (data.kind === "unauthenticated") {
    return <UnauthenticatedPanel />;
  }
  if (data.kind === "error") {
    return <ErrorPanel />;
  }
  if (data.kind === "no-cycle") {
    return <NoCyclePanel summary={data.summary} />;
  }
  // ready — current รับประกัน non-null ที่ loader (แต่ยังกัน fail-safe ถ้าไม่ narrow)
  const cycle = data.summary.current;
  if (cycle === null) {
    return <NoCyclePanel summary={data.summary} />;
  }
  return (
    <div>
      <CycleProgressCard cycle={cycle} />
      <CreditHistoryTable history={data.summary.history} />
    </div>
  );
}



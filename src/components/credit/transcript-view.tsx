/**
 * TranscriptView — มุมมองทั้งหน้าของ /my/transcript (Wave E Phase 3)
 *
 * - Server Component (ไม่มี "use client") — ข้อมูลเป็น props จากหน้า RSC
 * - สถานะหน้า: ยังไม่เข้าสู่ระบบ / ระบบขัดข้อง / ว่าง / พร้อมแสดง (ตาราง + ปุ่มดาวน์โหลด CSV
 *   — <a download> ไป GET /api/v1/me/transcript?format=csv · ดาวน์โหลดผ่าน browser ปกติ
 *   ไม่ fetch อ่านเป็น text — แบบเดียวกับ PDF ของใบประกาศฯ)
 */
import Link from "next/link";

import { transcriptCsvApiUrl, type TranscriptViewParsed } from "@/lib/api/credits";

import { TranscriptTable } from "./transcript-table";

/** ข้อมูลหน้า /my/transcript — สถานะ ยังไม่ login / ระบบขัดข้อง / ว่าง / พร้อมแสดง */
export type TranscriptPageData =
  | { kind: "unauthenticated" }
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "ready"; transcript: TranscriptViewParsed };

/** ปุ่มดาวน์โหลด CSV — <a download> browser ปกติ */
function DownloadCsvButton() {
  return (
    <a
      href={transcriptCsvApiUrl()}
      download="credit-transcript.csv"
      className="inline-flex items-center gap-2 rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
    >
      ดาวน์โหลด CSV
    </a>
  );
}

/** สถานะ "ยังไม่เข้าสู่ระบบ" — แผงไทย + ปุ่มไปหน้าเข้าสู่ระบบ (next กลับมาหน้าเดิม) */
function UnauthenticatedPanel() {
  return (
    <section
      aria-labelledby="transcript-unauth-heading"
      className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
    >
      <h2 id="transcript-unauth-heading" className="font-heading text-lg font-bold text-ink-900">
        กรุณาเข้าสู่ระบบ
      </h2>
      <p className="mt-2 text-sm text-ink-600">
        หน้านี้แสดง transcript ของผู้ใช้ที่เข้าสู่ระบบแล้วเท่านั้น
      </p>
      <Link
        href="/login?next=%2Fmy%2Ftranscript"
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
        โหลดข้อมูล transcript ของท่านไม่สำเร็จ
      </p>
      <p className="mt-1 text-sm text-danger-600">
        กรุณารีเฟรชหน้าเว็บเพื่อลองใหม่อีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่
      </p>
    </div>
  );
}

/** สถานะว่าง — ยังไม่มีรายการ — ชวนไปหน้าหลักสูตรของฉัน */
function EmptyPanel() {
  return (
    <section
      aria-labelledby="transcript-empty-heading"
      className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
    >
      <h2 id="transcript-empty-heading" className="font-heading text-lg font-bold text-ink-900">
        ยังไม่มีรายการใน transcript
      </h2>
      <p className="mt-2 text-sm text-ink-600">
        รายการจะปรากฏในหน้านี้เมื่อท่านลงทะเบียนหลักสูตร — เลือกชมหลักสูตรได้จากหน้าแคตตาล็อก
      </p>
      <Link
        href="/courses"
        className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
      >
        เลือกชมหลักสูตร
      </Link>
    </section>
  );
}

/** มุมมองพร้อมแสดง — ปุ่มดาวน์โหลด CSV + ตาราง transcript */
function ReadyPanel({ transcript }: { transcript: TranscriptViewParsed }) {
  return (
    <div>
      <div className="mt-5 flex justify-end">
        <DownloadCsvButton />
      </div>
      <TranscriptTable entries={transcript.entries} />
    </div>
  );
}

/** มุมมองทั้งหน้า — แยกตามสถานะของ page data */
export function TranscriptView({ data }: { data: TranscriptPageData }) {
  if (data.kind === "unauthenticated") {
    return <UnauthenticatedPanel />;
  }
  if (data.kind === "error") {
    return <ErrorPanel />;
  }
  if (data.kind === "empty") {
    return <EmptyPanel />;
  }
  return <ReadyPanel transcript={data.transcript} />;
}

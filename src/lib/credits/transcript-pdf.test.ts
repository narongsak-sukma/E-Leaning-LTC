/**
 * transcript-pdf.test — unit tests ของ src/lib/credits/transcript-pdf.ts
 * (แบบเดียวกับ src/lib/certificates/pdf.test.ts · vitest alias "server-only" ให้แล้ว — PB-5)
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";

import { TranscriptView, type TranscriptViewParsed } from "@/lib/api/credits";
import { renderTranscriptPdf, transcriptPdfInputOf } from "./transcript-pdf";

const USER_ID = "b0000000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "c0000000-0000-4000-8000-000000000003";
const COURSE_ID = "d0000000-0000-4000-8000-000000000004";
const ISO = "2026-09-10T03:00:00+07:00";

function entryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enrollment_id: ENROLLMENT_ID,
    course_id: COURSE_ID,
    course_title: "หลักสูตร A",
    enrollment_status: "completed",
    completed_at: ISO,
    passed: true,
    best_score_pct: 90,
    passed_at: ISO,
    credits: { general: 3.5 },
    certificates: [],
    ...overrides,
  };
}

function viewFixture(entries: Record<string, unknown>[]): Record<string, unknown> {
  return { user_id: USER_ID, generated_at: ISO, entries };
}

describe("transcriptPdfInputOf", () => {
  it("entry มี credits → แถวต่อ credit_type (ป้ายไทย + formatCreditAmount)", () => {
    const parsed = TranscriptView.parse(viewFixture([entryFixture()])) as TranscriptViewParsed;
    const input = transcriptPdfInputOf(parsed);
    expect(input.rows).toEqual([
      {
        no: "1",
        date: expect.stringContaining("2569"),
        source: "หลักสูตร A",
        creditType: "ทั่วไป",
        amount: "3.50",
      },
    ]);
    expect(input.totals).toEqual([{ creditType: "ทั่วไป", amount: "3.50" }]);
    expect(input.userId).toBe(USER_ID);
  });

  it("entry ไม่มี credits → แถวช่องว่าง + วันที่ว่าง", () => {
    const parsed = TranscriptView.parse(
      viewFixture([entryFixture({ credits: {}, completed_at: null })]),
    ) as TranscriptViewParsed;
    const input = transcriptPdfInputOf(parsed);
    expect(input.rows).toEqual([{ no: "1", date: "", source: "หลักสูตร A", creditType: "", amount: "" }]);
    expect(input.totals).toEqual([]);
  });

  it("หลายชนิด → เรียงตามคีย์ · สรุป earned = ผลรวมต่อชนิด", () => {
    const parsed = TranscriptView.parse(
      viewFixture([
        entryFixture({ credits: { general: 3.5 } }),
        entryFixture({ credits: { general: 1, professional: 2.25 } }),
      ]),
    ) as TranscriptViewParsed;
    const input = transcriptPdfInputOf(parsed);
    expect(input.rows.map((row) => [row.no, row.creditType, row.amount])).toEqual([
      ["1", "ทั่วไป", "3.50"],
      ["2", "ทั่วไป", "1"],
      ["2", "professional", "2.25"],
    ]);
    expect(input.totals).toEqual([
      { creditType: "ทั่วไป", amount: "4.50" },
      { creditType: "professional", amount: "2.25" },
    ]);
  });
});

describe("renderTranscriptPdf", () => {
  it("แถวน้อย → %PDF magic + PDFDocument.load ผ่าน + 1 หน้า", async () => {
    const parsed = TranscriptView.parse(viewFixture([entryFixture()])) as TranscriptViewParsed;
    const bytes = await renderTranscriptPdf(transcriptPdfInputOf(parsed));
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF-")).toBe(true);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it("แถวมาก (30 รายการ) → ข้ามหน้าอัตโนมัติ = 2 หน้า", async () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      entryFixture({ course_title: "หลักสูตรยาวตรวจการขึ้นหน้า " + String(i + 1) }),
    );
    const parsed = TranscriptView.parse(viewFixture(entries)) as TranscriptViewParsed;
    const bytes = await renderTranscriptPdf(transcriptPdfInputOf(parsed));
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(2);
  });

  it("transcript ว่าง → 1 หน้า ไม่ล้ม", async () => {
    const parsed = TranscriptView.parse(viewFixture([])) as TranscriptViewParsed;
    const bytes = await renderTranscriptPdf(transcriptPdfInputOf(parsed));
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });
});

/**
 * transcript-pdf — เรนเดอร์ PDF "ใบแสดงผลการศึกษา/หน่วยกิตสะสม" (Wave E Phase 3 · CRB-006 ·
 * API-SPECIFICATION 1.1.2 §3 แถว /me/transcript ?format=pdf)
 *
 * - แบบเดียวกับ src/lib/certificates/pdf.ts — pdf-lib + ฟอนต์ไทย Sarabun จาก src/assets/fonts
 *   (TTF — embed ผ่าน fontkit · subset:false กัน subsetter ตก glyph ไทย combining marks ·
 *   StandardFonts encode ไทยไม่ได้ — WinAnsi) · ไม่มี network/QR — เนื้อหาจาก transcript ที่
 *   ผ่าน zod strict แล้วเท่านั้น (ข้อมูลชุดเดียวกับแถว CSV)
 * - เนื้อหา: หัวเรื่อง + ข้อมูลผู้ถือ (user_id — ตัวตนในสัญญา my_credit_transcript · ไม่มี
 *   ชื่อ-นามสกุลใน view จึงไม่พิมพ์) + วันที่ออก + สรุปหน่วยกิตสะสม (earned รวมทุกรอบ ต่อ
 *   credit_type — คำนวณจากแถวเดียวกันกับ CSV · หมายเหตุ: เกณฑ์ required/รอบ (cycle) ไม่ได้อยู่ใน
 *   สัญญา my_credit_transcript และ RPC my_credit_summary มี side effect สร้างรอบแบบ lazy
 *   จึงไม่เรียกเพิ่มใน lane อ่าน transcript — ดูรายงานผู้ปฏิบัติงาน) + ตารางแถวต่อ enrollment
 *   (วันที่ · หลักสูตร · ชนิดหน่วยกิต · จำนวน) — ข้ามหน้าอัตโนมัติ
 * - ธง dependency: @pdf-lib/fontkit โหลดผ่าน createRequire แบบ fail-closed เมื่อไม่พบ
 *   (ERR-SYS-002 "pdf_fontkit_missing") — แบบเดียวกับใบประกาศฯ
 */
import "server-only";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { formatThaiDate } from "@/lib/certificates/pdf";
import type { TranscriptViewParsed } from "@/lib/api/credits";
import { creditTypeThai, formatActivityDateThai, formatCreditAmount } from "@/lib/api/credits";
import { AppError } from "@/lib/errors";

/** A4 แนวตั้ง (pt) */
const PAGE_SIZE: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const CONTENT_W = PAGE_SIZE[0] - MARGIN * 2;
/** เส้นฐานต่ำสุดของแถวตารางต่อหน้า — เว้นที่ footer (หมายเลขหน้า) */
const ROW_BOTTOM = 78;
/** ความสูงแถวตาราง (pt) */
const ROW_H = 20;

const FONT_DIR = path.join(process.cwd(), "src/assets/fonts");
const SARABUN_REGULAR_FILE = "Sarabun-Regular.ttf";
const SARABUN_BOLD_FILE = "Sarabun-Bold.ttf";
const INK = rgb(0.09, 0.13, 0.22);
const ACCENT = rgb(0.1, 0.2, 0.55);
const MUTED = rgb(0.42, 0.47, 0.55);
const RULE = rgb(0.82, 0.85, 0.9);

const TITLE = "ใบแสดงผลการศึกษา/หน่วยกิตสะสม";
const ORG_NAME = "สภาทนายความแห่งประเทศไทย";
const SYSTEM_NAME = "ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย";

/** คอลัมน์ตาราง: [คีย์เริ่ม, ความกว้าง] — ช่องจำนวนชิดขวา (ขวาสุด = MARGIN + CONTENT_W) */
const COL_NO: readonly [number, number] = [MARGIN, 30];
const COL_DATE: readonly [number, number] = [78, 92];
const COL_SOURCE: readonly [number, number] = [170, 200];
const COL_TYPE: readonly [number, number] = [370, 88];
const AMOUNT_RIGHT = MARGIN + CONTENT_W;

/** ชนิด fontkit ที่ pdf-lib ต้องการ — signature เดียวกับ registerFontkit (แบบใบประกาศฯ) */
type FontkitLike = Parameters<PDFDocument["registerFontkit"]>[0];

/** แถวตาราง PDF — ข้อความแสดงผลขั้นสุดท้าย (route ประกอบจาก view ที่ผ่าน schema แล้ว) */
export interface TranscriptPdfRow {
  /** ลำดับ enrollment (เริ่ม 1 — เรียงตาม entries ที่ RPC จัดลำดับมาแล้ว) */
  readonly no: string;
  /** วันที่เรียนจบ (ไทย พ.ศ.) — "" เมื่อยังไม่จบ */
  readonly date: string;
  /** ชื่อหลักสูตร (แหล่งของหน่วยกิต) */
  readonly source: string;
  /** ป้ายชนิดหน่วยกิต (ไทย) — "" เมื่อแถวนี้ยังไม่มีหน่วยกิต */
  readonly creditType: string;
  /** จำนวนหน่วยกิต (formatCreditAmount) — "" เมื่อแถวนี้ยังไม่มีหน่วยกิต */
  readonly amount: string;
}

/** แถวสรุปหน่วยกิตสะสมต่อ credit_type — earned รวมทุกรอบ */
export interface TranscriptPdfTotal {
  readonly creditType: string;
  readonly amount: string;
}

/** input ของการเรนเดอร์ — เฉพาะข้อมูลที่สัญญา transcript ให้พิมพ์ได้ (snapshot ณ วันออก) */
export interface TranscriptPdfInput {
  readonly userId: string;
  readonly generatedAt: Date;
  readonly totals: ReadonlyArray<TranscriptPdfTotal>;
  readonly rows: ReadonlyArray<TranscriptPdfRow>;
}

/** อ่านไบต์ฟอนต์จริง — อ่านไม่ได้ = fail-closed (ไม่เรนเดอร์เอง) — แบบเดียวกับใบประกาศฯ */
async function loadFontBytes(file: string): Promise<Buffer> {
  try {
    return await readFile(path.join(FONT_DIR, file), null);
  } catch {
    throw new AppError("ERR-SYS-002", { details: { reason: "transcript_font_unreadable" } });
  }
}

/**
 * โหลด fontkit — pdf-lib ต้อง register ก่อน embed ฟอนต์ TTF · โหลดผ่าน createRequire
 * แบบ fail-closed เมื่อไม่พบ (แบบเดียวกับ src/lib/certificates/pdf.ts)
 */
async function loadFontkit(): Promise<FontkitLike | null> {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const mod = requireFromHere("@pdf-lib/fontkit") as { default?: FontkitLike } | FontkitLike;
    const withDefault = (mod as { default?: FontkitLike }).default;
    const resolved = withDefault ?? (mod as FontkitLike);
    if (typeof resolved?.create !== "function") {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/** จัดกึ่งกลางแนวนอน (คำนวณความกว้างจากฟอนต์จริง) */
function drawCentered(page: PDFPage, font: PDFFont, text: string, size: number, y: number, color = INK): void {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (page.getWidth() - width) / 2, y, size, font, color });
}

/** ชิดขวาที่ xRight */
function drawRight(
  page: PDFPage,
  font: PDFFont,
  text: string,
  size: number,
  y: number,
  xRight: number,
  color = INK,
): void {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: xRight - width, y, size, font, color });
}

/**
 * ตัดข้อความให้พอดีคอลัมน์ (ไทยไม่เว้นวรรค — ตัดตรง ๆ ด้วยความกว้างฟอนต์จริง) —
 * ใช้ "..." (ไม่ใช้ "…" กัน glyph ตก subset เดิม)
 */
function fitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }
  let end = text.length;
  while (end > 1 && font.widthOfTextAtSize(`${text.slice(0, end)}...`, size) > maxWidth) {
    end -= 1;
  }
  return end <= 1 ? "..." : `${text.slice(0, end)}...`;
}

/**
 * แปลง transcript ที่ผ่าน zod strict แล้ว → input ของ renderer — ข้อมูลชุดเดียวกับแถว CSV
 * (formatActivityDateThai/formatCreditAmount/creditTypeThai — ทะเบียนข้อความไทยกลาง
 * src/lib/api/credits) · แถวต่อ (enrollment × credit_type) — enrollment ที่ยังไม่มีหน่วยกิต
 * = 1 แถวช่องว่าง · สรุป earned = ผลรวม credits ทุกแถว ต่อ credit_type (เรียงตามคีย์)
 */
export function transcriptPdfInputOf(view: TranscriptViewParsed): TranscriptPdfInput {
  const totals = new Map<string, number>();
  const rows: TranscriptPdfRow[] = [];
  view.entries.forEach((entry, index) => {
    const no = String(index + 1);
    const date = entry.completed_at === null ? "" : formatActivityDateThai(entry.completed_at);
    const types = Object.keys(entry.credits).sort();
    if (types.length === 0) {
      rows.push({ no, date, source: entry.course_title, creditType: "", amount: "" });
      return;
    }
    for (const type of types) {
      rows.push({
        no,
        date,
        source: entry.course_title,
        creditType: creditTypeThai(type),
        amount: formatCreditAmount(entry.credits[type] ?? 0),
      });
    }
    for (const [type, amount] of Object.entries(entry.credits)) {
      totals.set(type, (totals.get(type) ?? 0) + amount);
    }
  });
  return {
    userId: view.user_id,
    generatedAt: new Date(view.generated_at),
    totals: [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, amount]) => ({ creditType: creditTypeThai(type), amount: formatCreditAmount(amount) })),
    rows,
  };
}

/** หัวตาราง + เส้นใต้ — วาดใหม่ทุกครั้งที่ขึ้นหน้าใหม่ */
function drawTableHeader(page: PDFPage, bold: PDFFont, yBaseline: number): void {
  const cells: Array<readonly [string, readonly [number, number]]> = [
    ["ลำดับ", COL_NO],
    ["วันที่", COL_DATE],
    ["หลักสูตร", COL_SOURCE],
    ["ชนิดหน่วยกิต", COL_TYPE],
  ];
  for (const [label, [x]] of cells) {
    page.drawText(label, { x, y: yBaseline, size: 9.5, font: bold, color: INK });
  }
  drawRight(page, bold, "จำนวน", 9.5, yBaseline, AMOUNT_RIGHT);
  page.drawLine({
    start: { x: MARGIN, y: yBaseline - 6 },
    end: { x: MARGIN + CONTENT_W, y: yBaseline - 6 },
    thickness: 0.75,
    color: ACCENT,
  });
}

/** แถวเดียวของตาราง + เส้นคั่นบาง */
function drawTableRow(page: PDFPage, regular: PDFFont, row: TranscriptPdfRow, yBaseline: number): void {
  page.drawText(row.no, { x: COL_NO[0], y: yBaseline, size: 9.5, font: regular, color: INK });
  page.drawText(fitText(regular, row.date, 9.5, COL_DATE[1] - 6), {
    x: COL_DATE[0],
    y: yBaseline,
    size: 9.5,
    font: regular,
    color: INK,
  });
  page.drawText(fitText(regular, row.source, 9.5, COL_SOURCE[1] - 6), {
    x: COL_SOURCE[0],
    y: yBaseline,
    size: 9.5,
    font: regular,
    color: INK,
  });
  page.drawText(fitText(regular, row.creditType, 9.5, COL_TYPE[1] - 6), {
    x: COL_TYPE[0],
    y: yBaseline,
    size: 9.5,
    font: regular,
    color: INK,
  });
  if (row.amount !== "") {
    drawRight(page, regular, row.amount, 9.5, yBaseline, AMOUNT_RIGHT);
  }
  page.drawLine({
    start: { x: MARGIN, y: yBaseline - 7 },
    end: { x: MARGIN + CONTENT_W, y: yBaseline - 7 },
    thickness: 0.5,
    color: RULE,
  });
}

/** หน้าถัดไปของตาราง — หัวเรื่องย่อ "(ต่อ)" + หัวตาราง */
function addContinuationPage(pdf: PDFDocument, bold: PDFFont): PDFPage {
  const page = pdf.addPage(PAGE_SIZE);
  drawCentered(page, bold, `${TITLE} (ต่อ)`, 11, page.getHeight() - MARGIN);
  drawTableHeader(page, bold, page.getHeight() - MARGIN - 26);
  return page;
}

/**
 * เรนเดอร์ PDF A4 แนวตั้ง — snapshot ณ วันออก: หัวเรื่อง + ข้อมูลผู้ถือ + สรุปหน่วยกิตสะสม +
 * ตารางรายการ (ข้ามหน้าอัตโนมัติ — หัวตารางวาดซ้ำทุกหน้า) + เลขหน้า footer ทุกหน้า
 */
export async function renderTranscriptPdf(input: TranscriptPdfInput): Promise<Uint8Array> {
  const [regularBytes, boldBytes] = await Promise.all([
    loadFontBytes(SARABUN_REGULAR_FILE),
    loadFontBytes(SARABUN_BOLD_FILE),
  ]);
  const fontkit = await loadFontkit();
  if (fontkit === null) {
    // ธง dependency — แบบเดียวกับใบประกาศฯ (D-4): ไม่มี fontkit = ไม่เรนเดอร์ (fail-closed)
    throw new AppError("ERR-SYS-002", { details: { reason: "pdf_fontkit_missing" } });
  }

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // subset:false — กัน subsetter ตก glyph ไทยที่มี combining marks (แบบเดียวกับใบประกาศฯ)
  const regular = await pdf.embedFont(regularBytes, { subset: false });
  const bold = await pdf.embedFont(boldBytes, { subset: false });

  let page = pdf.addPage(PAGE_SIZE);
  let y = page.getHeight() - MARGIN;

  // ── หัวเรื่อง (หน้าแรก) ──
  drawCentered(page, bold, ORG_NAME, 13, y);
  y -= 18;
  drawCentered(page, regular, SYSTEM_NAME, 9, y);
  y -= 28;
  drawCentered(page, bold, TITLE, 17, y);
  y -= 12;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + CONTENT_W, y },
    thickness: 1,
    color: ACCENT,
  });
  y -= 24;

  // ── ข้อมูลผู้ถือ + วันที่ออก (ตัวตน = user_id ตามสัญญา my_credit_transcript) ──
  page.drawText(`รหัสผู้ใช้: ${input.userId}`, { x: MARGIN, y, size: 10, font: regular, color: INK });
  y -= 16;
  page.drawText(`ออกให้ ณ วันที่ ${formatThaiDate(input.generatedAt)}`, {
    x: MARGIN,
    y,
    size: 10,
    font: regular,
    color: INK,
  });
  y -= 26;

  // ── สรุปหน่วยกิตสะสม (earned รวมทุกรอบ — ผลรวมจากแถวชุดเดียวกับ CSV) ──
  page.drawText("สรุปหน่วยกิตสะสม (รวมทุกรอบ)", { x: MARGIN, y, size: 11, font: bold, color: INK });
  y -= 16;
  if (input.totals.length === 0) {
    page.drawText("ยังไม่มีรายการหน่วยกิตสะสม", { x: MARGIN, y, size: 10, font: regular, color: MUTED });
    y -= 16;
  } else {
    for (const total of input.totals) {
      page.drawText(`• ${total.creditType}: ${total.amount} หน่วยกิต`, {
        x: MARGIN + 8,
        y,
        size: 10,
        font: regular,
        color: INK,
      });
      y -= 16;
    }
  }
  y -= 14;

  // ── ตารางรายการ (ข้ามหน้าอัตโนมัติ — หัวตารางวาดซ้ำทุกหน้า) ──
  let cursor: number;
  if (y >= ROW_BOTTOM) {
    drawTableHeader(page, bold, y);
    cursor = y - 22;
  } else {
    page = addContinuationPage(pdf, bold);
    cursor = page.getHeight() - MARGIN - 48;
  }
  for (const row of input.rows) {
    if (cursor < ROW_BOTTOM) {
      page = addContinuationPage(pdf, bold);
      cursor = page.getHeight() - MARGIN - 48;
    }
    drawTableRow(page, regular, row, cursor);
    cursor -= ROW_H;
  }
  if (input.rows.length === 0) {
    page.drawText("ยังไม่มีรายการ", { x: MARGIN, y: cursor, size: 9.5, font: regular, color: MUTED });
  }

  // ── footer ทุกหน้า: ผู้ออก + เลขหน้า ──
  const pages = pdf.getPages();
  pages.forEach((p, index) => {
    p.drawText(SYSTEM_NAME, { x: MARGIN, y: 36, size: 8, font: regular, color: MUTED });
    drawRight(p, regular, `หน้า ${index + 1} / ${pages.length}`, 8, 36, MARGIN + CONTENT_W);
  });

  return pdf.save();
}

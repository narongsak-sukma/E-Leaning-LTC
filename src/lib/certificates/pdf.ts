/**
 * pdf — เรนเดอร์ PDF ประกาศนียบัตร (Wave D — D-4 · SDS §3.4)
 *
 * - ฟอนต์ไทย: Sarabun Regular/Bold จาก src/assets/fonts (TTF — embed ผ่าน fontkit;
 *   embedStandardFont ใช้กับ TTF ไม่ได้ และ StandardFonts ของ pdf-lib encode ไทยไม่ได้ — WinAnsi)
 * - QR payload = `${certPublicBaseUrl}/verify/${verify_code}` (SDS §3.4b D10) — ไม่มี PII ใน QR
 * - **PDF = snapshot นิ่ง**: เขียนข้อมูลณวันออกครั้งเดียว — revoke ไม่ re-render
 * - ธง: `@pdf-lib/fontkit` ยังไม่อยู่ใน package.json — โหลดผ่าน createRequire แบบ fail-closed
 *   เมื่อไม่พบ (ERR-SYS-002 "pdf_fontkit_missing") · ฟอนต์อ่านจาก process.cwd()/src/assets/fonts
 */
import "server-only";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

const PAGE_SIZE: [number, number] = [841.89, 595.28];

const FONT_DIR = path.join(process.cwd(), "src/assets/fonts");
const SARABUN_REGULAR_FILE = "Sarabun-Regular.ttf";
const SARABUN_BOLD_FILE = "Sarabun-Bold.ttf";
const INK = rgb(0.09, 0.13, 0.22);
const ACCENT = rgb(0.1, 0.2, 0.55);

/** ชนิด fontkit ที่ pdf-lib ต้องการ — signature เดียวกับ registerFontkit (ไม่ import ชนิดตรง) */
type FontkitLike = Parameters<PDFDocument["registerFontkit"]>[0];

/** QR payload ตาม SDS §3.4b (D10) — มีแค่ URL ตรวจสอบ ไม่มี PII */
export function qrUrlOf(baseUrl: string, verifyCode: string): string {
  return `${baseUrl}/verify/${verifyCode}`;
}

/** วันที่ไทย (พ.ศ.) — snapshot ณ วันออก */
export function formatThaiDate(date: Date): string {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/** อ่านไบต์ฟอนต์จริง — อ่านไม่ได้ = fail-closed (ไม่เรนเดอร์เอง) */
async function loadFontBytes(file: string): Promise<Buffer> {
  try {
    return await readFile(path.join(FONT_DIR, file), null);
  } catch {
    throw new AppError("ERR-SYS-002", { details: { reason: "cert_font_unreadable" } });
  }
}

/**
 * โหลด fontkit — pdf-lib ต้อง register ก่อน embed ฟอนต์ TTF
 * (node_modules/pdf-lib/cjs/api/PDFDocument.js:1355 assertFontkit โยนถ้าไม่มี)
 * ยังไม่ประกาศใน package.json → createRequire + fail-closed เมื่อไม่พบ
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

/** ตรวจกลางหน้า + จัดกึ่งกลางแนวนอน (คำนวณความกว้างจากฟอนต์จริง) */
function drawCentered(
  page: PDFPage,
  font: PDFFont,
  text: string,
  size: number,
  y: number,
  color = INK,
): void {
  const width = font.widthOfTextAtSize(text, size);
  const x = (page.getWidth() - width) / 2;
  page.drawText(text, { x, y, size, font, color });
}

/** input ของการเรนเดอร์ — เฉพาะข้อมูลที่ doc กำหนดให้พิมพ์บนเอกสาร */
export interface CertificatePdfInput {
  readonly certNo: string;
  readonly verifyCode: string;
  readonly holderName: string;
  readonly courseTitle: string;
  readonly issuedAt: Date;
}

/**
 * เรนเดอร์ PDF A4 แนวนอน — ข้อมูล = snapshot ณ วันออกเท่านั้น:
 * ชื่อระบบ/สภาทนายความฯ · ชื่อผู้ถือ · ชื่อหลักสูตร · cert_no · วันที่ออก · QR (ไม่มีข้อมูลอื่น)
 */
export async function renderCertificatePdf(input: CertificatePdfInput): Promise<Uint8Array> {
  const baseUrl = getConfig().certPublicBaseUrl;
  if (baseUrl === null) {
    // ธง config: ไม่มี CERT_PUBLIC_BASE_URL → สร้าง QR ที่ถูกต้องไม่ได้ = ไม่เรนเดอร์ (fail-closed)
    throw new AppError("ERR-SYS-002", { details: { reason: "cert_public_base_url_missing" } });
  }
  const qrPayload = qrUrlOf(baseUrl, input.verifyCode);
  const qrPng = await QRCode.toBuffer(qrPayload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
    type: "png",
  });

  const [regularBytes, boldBytes] = await Promise.all([
    loadFontBytes(SARABUN_REGULAR_FILE),
    loadFontBytes(SARABUN_BOLD_FILE),
  ]);
  const fontkit = await loadFontkit();
  if (fontkit === null) {
    // ธง dependency: ดูรายงาน D-4 — lead ต้องเพิ่ม @pdf-lib/fontkit ใน package.json
    throw new AppError("ERR-SYS-002", { details: { reason: "pdf_fontkit_missing" } });
  }

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // subset:false — กัน subsetter ตก glyph ไทยที่มี combining marks (ความน่าเชื่อถือเอกสาร > ขนาดไฟล์)
  const regular = await pdf.embedFont(regularBytes, { subset: false });
  const bold = await pdf.embedFont(boldBytes, { subset: false });

  const page = pdf.addPage(PAGE_SIZE);
  const pageWidth = page.getWidth();

  // กรอบสองชั้น
  page.drawRectangle({
    x: 30,
    y: 30,
    width: pageWidth - 60,
    height: 535.28,
    borderColor: ACCENT,
    borderWidth: 2,
  });
  page.drawRectangle({
    x: 36,
    y: 36,
    width: pageWidth - 72,
    height: 523.28,
    borderColor: ACCENT,
    borderWidth: 0.75,
  });

  // ชื่อระบบ/สภาทนายความฯ + หัวเรื่อง (ไทย-first)
  drawCentered(page, bold, "สภาทนายความแห่งประเทศไทย", 24, 505);
  drawCentered(page, regular, "ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย", 13, 476);
  drawCentered(page, bold, "ประกาศนียบัตร", 36, 418);
  drawCentered(page, regular, "มอบประกาศนียบัตรฉบับนี้ไว้เป็นสำหรับ", 13, 372);
  drawCentered(page, bold, input.holderName, 30, 328);
  drawCentered(page, regular, "ได้ศึกษาและผ่านการประเมินผลหลักสูตร", 13, 284);
  drawCentered(page, bold, input.courseTitle, 20, 250);
  page.drawLine({
    start: { x: 331, y: 232 },
    end: { x: 511, y: 232 },
    thickness: 0.75,
    color: ACCENT,
  });

  // บล็อกข้อมูลอ้างอิง (cert_no + วันที่ออก)
  page.drawText(`เลขที่ ${input.certNo}`, { x: 76, y: 150, size: 12, font: regular, color: INK });
  page.drawText(`ออกให้ ณ วันที่ ${formatThaiDate(input.issuedAt)}`, {
    x: 76,
    y: 126,
    size: 12,
    font: regular,
    color: INK,
  });

  // QR (ล่างขวา) + คำอธิบายสั้น
  const qr = await pdf.embedPng(qrPng);
  const qrSize = 92;
  page.drawImage(qr, { x: 706, y: 64, width: qrSize, height: qrSize });
  // คำอธิบายใต้ QR — จัดกึ่งกลางใต้ภาพ QR (ไม่ใช่กลางหน้า)
  const qrCaption = "สแกนเพื่อตรวจสอบ";
  const qrCaptionWidth = regular.widthOfTextAtSize(qrCaption, 9);
  page.drawText(qrCaption, {
    x: 706 + (qrSize - qrCaptionWidth) / 2,
    y: 48,
    size: 9,
    font: regular,
    color: INK,
  });
  return pdf.save();
}

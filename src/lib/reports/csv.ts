/**
 * csv — ตัวสร้าง CSV กลางของ export (Wave E · D55-6 · API-SPECIFICATION §3.8 แถว 221)
 *
 * - UTF-8 มี BOM (﻿) — Excel เปิดไฟล์ UTF-8 ได้ถูกต้อง
 * - header ภาษาไทยต่อประเภทรายงาน (นิยามใน export.ts)
 * - RFC 4180: ครอบฟิลด์ที่มี , " หรือขึ้นบรรทัด · เขียน " ซ้ำเป็น "" · บรรทัดจบด้วย CRLF
 * - pure module (ไม่แตะ DB/cookie) — ทดสอบได้โดยไม่ต้อง mock server runtime
 */

/** BOM ของไฟล์ CSV (UTF-8) — ต่อท้ายบรรทัดแรกเสมอ */
export const CSV_BOM = "﻿";

/** ตัดสินว่าฟิลด์ต้องครอบด้วย double quote ตาม RFC 4180 */
function needsQuote(field: string): boolean {
  return field.includes(",") || field.includes('"') || field.includes("\n") || field.includes("\r");
}

/** เขียนฟิลด์เดียวแบบ RFC 4180 — quote เมื่อจำเป็น และ " ภายในเขียนซ้ำเป็น "" */
export function csvField(field: string): string {
  if (!needsQuote(field)) {
    return field;
  }
  return '"' + field.replaceAll('"', '""') + '"';
}

/**
 * สร้างไฟล์ CSV เต็ม (BOM + header ไทย + แถวข้อมูล · จบด้วย CRLF ทุกบรรทัดตาม RFC 4180)
 * headers และ cells ต้องยาวเท่ากัน — ไม่เท่า = บั๊กผู้เรียก (throw ไม่เขียนไฟล์เพี้ยน ๆ)
 */
export function buildCsv(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  if (rows.some((row) => row.length !== headers.length)) {
    throw new Error("csv_row_column_mismatch");
  }
  const lines: string[] = [
    CSV_BOM + headers.map(csvField).join(","),
    ...rows.map((row) => row.map(csvField).join(",")),
  ];
  return lines.join("\r\n") + "\r\n";
}

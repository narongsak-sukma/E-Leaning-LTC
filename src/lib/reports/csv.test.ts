/**
 * csv.test — ตัวสร้าง CSV ของ export (Wave E · D55-6)
 * BOM + header ไทย + RFC 4180 (quote · "" · CRLF) — pure module ทดสอบตรง ๆ
 */
import { describe, expect, it } from "vitest";
import { CSV_BOM, buildCsv, csvField } from "./csv";

describe("CSV_BOM", () => {
  it("เป็น BOM ของ UTF-8 (U+FEFF) ตัวเดียว", () => {
    expect(CSV_BOM).toBe("\uFEFF");
    expect(CSV_BOM.length).toBe(1);
  });
});

describe("csvField — RFC 4180", () => {
  it("ข้อความปกติไม่ครอบ quote", () => {
    expect(csvField("abc123")).toBe("abc123");
    expect(csvField("สมชาย")).toBe("สมชาย");
  });
  it("มี comma → ครอบ quote", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });
  it("มี double quote ภายใน → ครอบ quote + ซ้ำเป็น \"\"", () => {
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
  });
  it("มีขึ้นบรรทัด → ครอบ quote", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("x\r\ny")).toBe('"x\r\ny"');
  });
});

describe("buildCsv — BOM + header ไทย + CRLF", () => {
  const headers = ["รหัส", "ความคืบหน้า (%)"];
  it("บรรทัดแรก = BOM + header · จบด้วย CRLF", () => {
    const csv = buildCsv(headers, [["e1", "50"]]);
    expect(csv.startsWith(CSV_BOM + "รหัส,ความคืบหน้า (%)" + "\r\n")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });
  it("หลายแถว คั่นด้วย CRLF", () => {
    const csv = buildCsv(headers, [["e1", "50"], ["e2", "80"]]);
    expect(csv).toBe(CSV_BOM + headers.join(",") + "\r\ne1,50\r\ne2,80\r\n");
  });
  it("แถวที่มี comma/quote ในค่า → quote ตาม RFC 4180", () => {
    const csv = buildCsv(headers, [["a,b", '"q"']]);
    expect(csv).toBe(CSV_BOM + headers.join(",") + '\r\n"a,b","""q"""\r\n');
  });
  it("คอลัมน์ไม่เท่า header → throw csv_row_column_mismatch (fail-closed)", () => {
    expect(() => buildCsv(headers, [["e1"]])).toThrow("csv_row_column_mismatch");
  });
  it("ตารางว่าง (0 แถว) → เหลือแค่ header + CRLF", () =>  {
    expect(buildCsv(headers, [])).toBe(CSV_BOM + headers.join(",") + "\r\n");
  });
});

/**
 * rpc-errors.test — unit test ของ parseRpcErrorCode (Wave C-11)
 *
 * ยึดข้อความ exception จริงจาก supabase/migrations/0011_functions.sql /
 * 0005_assessment.sql — code ทะเบียนอยู่ปิดท้าย message รูปแบบ "(ERR-XXX-NNN)"
 */
import { describe, expect, it } from "vitest";
import { parseRpcErrorCode } from "./rpc-errors";

describe("parseRpcErrorCode — แกะ code ทะเบียนท้ายข้อความ RPC", () => {
  it("ข้อความไทย + (ERR-ENR-001) ปิดท้าย → ERR-ENR-001", () => {
    expect(parseRpcErrorCode({ message: "คุณลงทะเบียนหลักสูตรนี้แล้ว (ERR-ENR-001)" })).toBe(
      "ERR-ENR-001",
    );
  });

  it("ข้อความจริงของทุกกลุ่ม — VAL/ASM/LRN/NF/CRS/ENR-002 → ตามทะเบียน", () => {
    expect(parseRpcErrorCode({ message: "ตัวเลือกไม่ตรงกับข้อสอบ (ERR-VAL-001)" })).toBe(
      "ERR-VAL-001",
    );
    expect(parseRpcErrorCode({ message: "ส่งแบบทดสอบเกินจำนวนครั้งที่กำหนด (ERR-ASM-001)" })).toBe(
      "ERR-ASM-001",
    );
    expect(parseRpcErrorCode({ message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)" })).toBe(
      "ERR-LRN-001",
    );
    expect(parseRpcErrorCode({ message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)" })).toBe("ERR-NF-001");
    expect(
      parseRpcErrorCode({ message: "ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่ (ERR-CRS-001)" }),
    ).toBe("ERR-CRS-001");
    expect(
      parseRpcErrorCode({
        message: "หลักสูตรนี้จำกัดเฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว (ERR-ENR-002)",
      }),
    ).toBe("ERR-ENR-002");
  });

  it("หลาย code ใน message เดียว — เอาตัวที่ปิดท้าย (anchored)", () => {
    expect(parseRpcErrorCode({ message: "อ้างอิง (ERR-VAL-001) แล้วล้มเหลว (ERR-LRN-001)" })).toBe(
      "ERR-LRN-001",
    );
  });

  it('วงเล็บตามหลังข้อความที่มีเครื่องหมาย " — (ERR-SYS-002) ปิดท้าย', () => {
    expect(parseRpcErrorCode({ message: 'บริบท "ข้อความ" (ERR-SYS-002)' })).toBe("ERR-SYS-002");
  });

  it("trim เว้นวรรค/ขึ้นบรรทัดท้าย message ก่อนตรวจ", () => {
    expect(parseRpcErrorCode({ message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)  \n" })).toBe(
      "ERR-LRN-001",
    );
  });

  it("anchored — code กลางประโยคไม่รับ (ไม่ใช่ปิดท้าย)", () => {
    expect(parseRpcErrorCode({ message: "ERR-VAL-001 เกิดขึ้นก่อนล้มเหลว" })).toBeUndefined();
    expect(
      parseRpcErrorCode({ message: "ล้มเหลว (ERR-VAL-001) ตามด้วยข้อความอื่น" }),
    ).toBeUndefined();
  });

  it("code ไม่อยู่ในทะเบียน (รูปแบบถูก) → undefined", () => {
    expect(parseRpcErrorCode({ message: "บริบท (ERR-ZZZ-999)" })).toBeUndefined();
  });

  it("code รูปแบบต่างจากทะเบียน (4 ตัวอักษร / ตัวพิมพ์เล็ก) → undefined", () => {
    expect(parseRpcErrorCode({ message: "บริบท (ERR-TEST-001)" })).toBeUndefined();
    expect(parseRpcErrorCode({ message: "บริบท (err-lrn-001)" })).toBeUndefined();
  });

  it("message ไม่มี code เลย (ข้อความ SQL จริง) → undefined", () => {
    expect(
      parseRpcErrorCode({
        message: 'SQLSTATE 23505: duplicate key value violates unique constraint "qa_unique"',
      }),
    ).toBeUndefined();
  });

  it("message ว่าง / null / undefined / ไม่ใช่ string / object ไม่มี message → undefined", () => {
    expect(parseRpcErrorCode({ message: "" })).toBeUndefined();
    expect(parseRpcErrorCode({ message: null })).toBeUndefined();
    expect(parseRpcErrorCode(null)).toBeUndefined();
    expect(parseRpcErrorCode(undefined)).toBeUndefined();
    expect(parseRpcErrorCode({})).toBeUndefined();
    expect(parseRpcErrorCode({ message: 42 as never })).toBeUndefined();
  });
});

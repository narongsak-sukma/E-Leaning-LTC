/**
 * rpc-errors.test — unit test ของ parseRpcErrorCode (Wave C-11)
 *
 * ยึดข้อความ exception จริงจาก supabase/migrations/0011_functions.sql /
 * 0005_assessment.sql — code ทะเบียนอยู่ปิดท้าย message รูปแบบ "(ERR-XXX-NNN)"
 */
import { describe, expect, it } from "vitest";
import { parseRpcErrorCode, parseRpcErrorCodeDetailed } from "./rpc-errors";

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

  it("รูป 0019-r1 (ERR-XXX-NNN|reason) — parseRpcErrorCode ยังได้ code เหมือนเดิม", () => {
    expect(parseRpcErrorCode({ message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)" })).toBe(
      "ERR-NF-001",
    );
    expect(parseRpcErrorCode({ message: "สถานะไม่ถูกต้อง (ERR-VAL-001|not_valid)" })).toBe("ERR-VAL-001");
  });
});

describe("parseRpcErrorCodeDetailed — แกะ code + เหตุผลรูป 0019-r1 (ERR-XXX-NNN|reason)", () => {
  it("มีเหตุผล → {code, reason} — ข้อความไทยจริงของ RPC D-3/D-4", () => {
    expect(
      parseRpcErrorCodeDetailed({ message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)" }),
    ).toEqual({ code: "ERR-NF-001", reason: "certificate_not_found" });
    expect(
      parseRpcErrorCodeDetailed({ message: "ข้อมูลไม่ถูกต้อง: ใบนี้ไม่ได้อยู่ในสถานะออกใบแล้ว (ERR-VAL-001|not_valid)" }),
    ).toEqual({ code: "ERR-VAL-001", reason: "not_valid" });
    expect(
      parseRpcErrorCodeDetailed({ message: "ต้องระบุผู้ดำเนินการ (ERR-AUTH-001|actor_required)" }),
    ).toEqual({ code: "ERR-AUTH-001", reason: "actor_required" });
  });

  it("รูปเดิมไม่มีเหตุผล → reason เป็น null (ไม่ใช่ undefined)", () => {
    expect(parseRpcErrorCodeDetailed({ message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)" })).toEqual({
      code: "ERR-LRN-001",
      reason: null,
    });
  });

  it("มี code คู่กัน — เอาปิดท้ายพร้อมเหตุผลของตัวนั้น (anchored)", () => {
    expect(
      parseRpcErrorCodeDetailed({ message: "อ้าง (ERR-VAL-001|bad) แล้วล้ม (ERR-LRN-001|not_enrolled)" }),
    ).toEqual({ code: "ERR-LRN-001", reason: "not_enrolled" });
  });

  it("เหตุผลอนุญาตเฉพาะ [a-z0-9_] — มีช่องว่าง/ขีดกลาง → ทั้ง message ไม่ match → undefined", () => {
    expect(parseRpcErrorCodeDetailed({ message: "บริบท (ERR-VAL-001|not valid)" })).toBeUndefined();
    expect(parseRpcErrorCodeDetailed({ message: "บริบท (ERR-VAL-001|not-valid)" })).toBeUndefined();
  });

  it("code ไม่อยู่ในทะเบียน (มีเหตุผลแนบ) → undefined", () => {
    expect(parseRpcErrorCodeDetailed({ message: "บริบท (ERR-ZZZ-999|whatever)" })).toBeUndefined();
  });

  it("ไม่พบรูปแบบ / message ไม่ใช่ string → undefined (เสมือน parseRpcErrorCode)", () => {
    expect(parseRpcErrorCodeDetailed({ message: "SQLSTATE 23505: duplicate key" })).toBeUndefined();
    expect(parseRpcErrorCodeDetailed(null)).toBeUndefined();
    expect(parseRpcErrorCodeDetailed({ message: 42 as never })).toBeUndefined();
  });

  it("trim ท้าย message ก่อนตรวจ (เหมือนรูปเดิม)", () => {
    expect(parseRpcErrorCodeDetailed({ message: "สถานะไม่ถูกต้อง (ERR-VAL-001|not_valid) \n" })).toEqual({
      code: "ERR-VAL-001",
      reason: "not_valid",
    });
  });
});

describe("DCR 22023 — ข้อความปฏิเสธ PII ของ append_audit_event ต้องเป็นรูป anchored (CODE|tag)", () => {
  // ข้อความจริงจาก supabase/migrations ก่อนแก้ (probe สด 2026-09-16
  // .omc/artifacts/dcr22023-probe-old-form.log): รูป "(CODE — ข้อความ)" ไม่ตรง
  // TRAILING_CODE_RE → parser คืน undefined → rpcOnceWithClassification
  // (src/lib/admin/users.ts) จัด transient → retry 3 ครั้ง → route ตอบ 503
  // ERR-SYS-002 ทั้งที่เป็นความผิดสัญญาถาวรที่ควรตอบ 400 ERR-VAL-001 ทันที
  // (พบใน pass 4c f4d9988 · แก้ที่แหล่งยก error ของ 0008 + สำเนา 0019/0025/0032)
  it("รูปเก่า (ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw) → undefined (ทิศสกปรกของ two-way)", () => {
    expect(
      parseRpcErrorCodeDetailed({
        message: "append_audit_event: context มีรูปแบบ PII ในฟิลด์ฟรีเท็กซ์ (ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw)",
      }),
    ).toBeUndefined();
    expect(
      parseRpcErrorCode({
        message: "append_audit_event: before/after มีรูปแบบ PII (ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw)",
      }),
    ).toBeUndefined();
  });

  it("รูปใหม่ (ERR-VAL-001|pii_rejected) → {code, reason} (ทิศสะอาด)", () => {
    expect(
      parseRpcErrorCodeDetailed({
        message: "append_audit_event: context มีรูปแบบ PII ในฟิลด์ฟรีเท็กซ์ (ERR-VAL-001|pii_rejected)",
      }),
    ).toEqual({ code: "ERR-VAL-001", reason: "pii_rejected" });
    expect(
      parseRpcErrorCodeDetailed({
        message: "append_audit_event: before/after มีรูปแบบ PII (ERR-VAL-001|pii_rejected)",
      }),
    ).toEqual({ code: "ERR-VAL-001", reason: "pii_rejected" });
  });
});

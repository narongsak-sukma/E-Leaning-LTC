/**
 * transcript-table.test — ตาราง transcript (Wave E Phase 3)
 *
 * - คอลัมน์ครบ 6 คอลัมน์ไทย · แถว: ชื่อหลักสูตร + สถานะไทย + ป้ายผล + คะแนน + หน่วยกิต + badge ใบประกาศฯ
 * - ใบประกาศฯหลายใบ/สถานะ revoked แสดงครบ · ไม่มีค่า = "—" ไม่ใช่คำว่า null
 * (เรียก Server Component เป็นฟังก์ชันตรง ๆ ตามแบบ PB-2 — ตัวช่วยเดินต้นไม้ใน test-tree)
 */
import { describe, expect, it } from "vitest";

import type { TranscriptEntryParsed } from "@/lib/api/credits";

import { TranscriptTable } from "./transcript-table";
import { textOf } from "./test-tree";

const ENROLLMENT_ID = "c0000000-0000-4000-8000-000000000003";
const COURSE_ID = "d0000000-0000-4000-8000-000000000004";
const ISO = "2026-09-10T03:00:00+07:00";

function entryFixture(overrides: Partial<TranscriptEntryParsed> = {}): TranscriptEntryParsed {
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
    certificates: [{ cert_no: "LTC-2026-000001", status: "valid", issued_at: ISO }],
    ...overrides,
  };
}

describe("TranscriptTable — ตาราง transcript", () => {
  it("หัวตารางครบ 6 คอลัมน์ (หลักสูตร · สถานะ · ผ่าน · คะแนนสูงสุด (%) · หน่วยกิต · ใบประกาศณียบัตร)", () => {
    const text = textOf(TranscriptTable({ entries: [entryFixture()] }));
    for (const header of [
      "หลักสูตร",
      "สถานะ",
      "ผ่าน",
      "คะแนนสูงสุด (%)",
      "หน่วยกิต",
      "ใบประกาศณียบัตร",
    ]) {
      expect(text).toContain(header);
    }
  });

  it("แถว — ชื่อหลักสูตร + สถานะไทย + ป้ายผ่าน + คะแนน + หน่วยกิต text + badge ใบประกาศฯ", () => {
    const text = textOf(TranscriptTable({ entries: [entryFixture()] }));
    expect(text).toContain("หลักสูตร A");
    expect(text).toContain("เรียนจบแล้ว");
    expect(text).toContain("ผ่าน");
    expect(text).toContain("90");
    expect(text).toContain("general: 3.50");
    expect(text).toContain("LTC-2026-000001 · ใช้งานได้");
  });

  it("ใบประกาศฯหลายใบ — แสดงครบทุกใบพร้อมป้ายสถานะไทย", () => {
    const text = textOf(
      TranscriptTable({
        entries: [
          entryFixture({
            certificates: [
              { cert_no: "LTC-2026-000001", status: "valid", issued_at: ISO },
              { cert_no: "LTC-2026-000002", status: "revoked", issued_at: ISO },
            ],
            credits: { general: 3.5, ethics: 1 },
          }),
        ],
      }),
    );
    expect(text).toContain("LTC-2026-000001 · ใช้งานได้");
    expect(text).toContain("LTC-2026-000002 · ถูกเพิกถอน");
    expect(text).toContain("ethics: 1; general: 3.50");
  });
});

describe("TranscriptTable — เคสขอบ", () => {
  it("ไม่ผ่าน + ไม่มีคะแนน/หน่วยกิต/ใบประกาศฯ — เซลล์ขีดและ 'ยังไม่มีผลสอบ'", () => {
    const text = textOf(
      TranscriptTable({
        entries: [
          entryFixture({
            passed: false,
            best_score_pct: null,
            credits: {},
            certificates: [],
          }),
        ],
      }),
    );
    expect(text).toContain("ไม่ผ่าน");
    expect(text).not.toContain("LTC-2026-");
  });

  it("passed = null — ป้าย 'ยังไม่มีผลสอบ'", () => {
    const text = textOf(
      TranscriptTable({
        entries: [entryFixture({ passed: null })],
      }),
    );
    expect(text).toContain("ยังไม่มีผลสอบ");
  });

  it("หน่วยกิตว่าง = เซลล์ขีดกลาง ไม่ใช่คำว่า null", () => {
    const text = textOf(
      TranscriptTable({
        entries: [entryFixture({ credits: {} })],
      }),
    );
    expect(text).toContain("—");
    expect(text).not.toContain("null");
  });
});

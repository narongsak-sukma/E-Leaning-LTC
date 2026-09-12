/**
 * transcript-view.test — มุมมองทั้งหน้า /my/transcript ครบ 4 สถานะ (Wave E Phase 3)
 *
 * - ยังไม่ login (next กลับมาหน้าเดิม) · ระบบขัดข้อง (role=alert) · ว่าง (ชวนไปแคตตาล็อก)
 * · พร้อมแสดง (ตาราง + ปุ่มดาวน์โหลด CSV ไป GET /api/v1/me/transcript?format=csv) —
 * เรียก Server Component เป็นฟังก์ชันตรง ๆ ตามแบบ PB-2
 */
import { describe, expect, it } from "vitest";

import type { TranscriptEntryParsed, TranscriptViewParsed } from "@/lib/api/credits";

import { countWhere, textOf } from "./test-tree";
import { TranscriptView } from "./transcript-view";

const USER_ID = "b0000000-0000-4000-8000-000000000002";
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

function transcriptFixture(
  overrides: Partial<TranscriptViewParsed> = {},
): TranscriptViewParsed {
  return {
    user_id: USER_ID,
    generated_at: ISO,
    entries: [entryFixture()],
    ...overrides,
  };
}

describe("TranscriptView — สถานะยังไม่เข้าสู่ระบบ / ระบบขัดข้อง / ว่าง", () => {
  it("ยังไม่ login — แผงไทย + ปุ่มกลับมาหน้า /my/transcript", () => {
    const tree = TranscriptView({ data: { kind: "unauthenticated" } });
    const text = textOf(tree);
    expect(text).toContain("กรุณาเข้าสู่ระบบ");
    expect(text).toContain("หน้านี้แสดง transcript ของผู้ใช้ที่เข้าสู่ระบบแล้วเท่านั้น");
    expect(
      countWhere(tree, (props) => props["href"] === "/login?next=%2Fmy%2Ftranscript"),
    ).toBe(1);
  });

  it("ระบบขัดข้อง — role=alert + ข้อความไทย fail-closed", () => {
    const tree = TranscriptView({ data: { kind: "error" } });
    expect(textOf(tree)).toContain("โหลดข้อมูล transcript ของท่านไม่สำเร็จ");
    expect(countWhere(tree, (props) => props["role"] === "alert")).toBe(1);
  });

  it("ว่าง — แผงไทย + ลิงก์ไปแคตตาล็อกหลักสูตร", () => {
    const tree = TranscriptView({ data: { kind: "empty" } });
    const text = textOf(tree);
    expect(text).toContain("ยังไม่มีรายการใน transcript");
    expect(
      countWhere(tree, (props) => props["href"] === "/courses"),
    ).toBe(1);
  });
});

describe("TranscriptView — พร้อมแสดง", () => {
  it("ตาราง transcript + ปุ่มดาวน์โหลด CSV ชี้ GET /api/v1/me/transcript?format=csv", () => {
    const tree = TranscriptView({ data: { kind: "ready", transcript: transcriptFixture() } });
    const text = textOf(tree);
    expect(text).toContain("ดาวน์โหลด CSV");
    expect(text).toContain("หลักสูตร A");
    expect(
      countWhere(tree, (props) => props["href"] === "/api/v1/me/transcript?format=csv"),
    ).toBe(1);
    expect(
      countWhere(tree, (props) => props["download"] === "credit-transcript.csv"),
    ).toBe(1);
  });

  it("entries ว่างในสถานะ ready — ยังคงมีปุ่มดาวน์โหลด (แต่ loader จะจัดสถานะ empty ให้ก่อนแล้ว)", () => {
    const tree = TranscriptView({
      data: { kind: "ready", transcript: transcriptFixture({ entries: [] }) },
    });
    expect(textOf(tree)).toContain("ดาวน์โหลด CSV");
  });
});

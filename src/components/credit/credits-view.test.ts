/**
 * credits-view.test — มุมมองทั้งหน้า /my/credits ครบ 4 สถานะ (Wave E Phase 3)
 *
 * - ยังไม่ login (ปุ่มกลับมาหน้าเดิม) · ระบบขัดข้อง (role=alert) · ผู้ไม่มีรอบ
 *   (citizen — ข้อความอธิบาย ไม่ error และไม่มีแถบความคืบหน้า) · พร้อมแสดง (การ์ดรอบ +
 *   ตารางประวัติ) — เรียก Server Component เป็นฟังก์ชันตรง ๆ ตามแบบ PB-2
 */
import { describe, expect, it } from "vitest";

import type { CreditCycleParsed, CreditSummaryViewParsed } from "@/lib/api/credits";

import { countWhere, textOf } from "./test-tree";
import { CreditsView } from "./credits-view";

const USER_ID = "b0000000-0000-4000-8000-000000000002";
const CYCLE_ID = "a0000000-0000-4000-8000-000000000001";

function cycleFixture(overrides: Partial<CreditCycleParsed> = {}): CreditCycleParsed {
  return {
    cycle_id: CYCLE_ID,
    cycle_no: 1,
    starts_on: "2026-01-01",
    ends_on: "2026-12-31",
    status: "open",
    required_credits: { general: 12 },
    balances: { general: { earned: 3.5, required: 12, missing: 8.5 } },
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<CreditSummaryViewParsed> = {}): CreditSummaryViewParsed {
  return {
    user_id: USER_ID,
    current: cycleFixture(),
    history: [cycleFixture()],
    ...overrides,
  };
}

describe("CreditsView — สถานะยังไม่เข้าสู่ระบบ / ระบบขัดข้อง", () => {
  it("ยังไม่ login — แผงไทย + ปุ่มกลับมาหน้า /my/credits", () => {
    const tree = CreditsView({ data: { kind: "unauthenticated" } });
    const text = textOf(tree);
    expect(text).toContain("กรุณาเข้าสู่ระบบ");
    expect(text).toContain("หน้านี้แสดงหน่วยกิตสะสมของผู้ใช้ที่เข้าสู่ระบบแล้วเท่านั้น");
    expect(
      countWhere(tree, (props) => props["href"] === "/login?next=%2Fmy%2Fcredits"),
    ).toBe(1);
  });

  it("ระบบขัดข้อง — role=alert + ข้อความไทย fail-closed (ไม่มี error ดิบ)", () => {
    const tree = CreditsView({ data: { kind: "error" } });
    expect(textOf(tree)).toContain("โหลดข้อมูลหน่วยกิตของท่านไม่สำเร็จ");
    expect(countWhere(tree, (props) => props["role"] === "alert")).toBe(1);
  });
});

describe("CreditsView — สถานะผู้ไม่มีรอบ (citizen) — ข้อความอธิบาย ไม่ error", () => {
  it("current = null — แผงอธิบาย + ไม่มีแถบความคืบหน้า + แสดงประวัติเดิมต่อท้าย", () => {
    const tree = CreditsView({
      data: { kind: "no-cycle", summary: summaryFixture({ current: null }) },
    });
    const text = textOf(tree);
    expect(text).toContain("ยังไม่มีรอบหน่วยกิตสะสม");
    expect(text).toContain(
      "หน่วยกิตสะสมใช้สำหรับการต่ออายุใบอนุญาตว่าความสำหรับทนายความ",
    );
    expect(
      countWhere(tree, (props) => props["role"] === "progressbar"),
    ).toBe(0);
    expect(text).toContain("ประวัติรายรอบ");
  });
});

describe("CreditsView — สถานะพร้อมแสดง", () => {
  it("การ์ดรอบปัจจุบัน + ตารางประวัติรายรอบ", () => {
    const tree = CreditsView({ data: { kind: "ready", summary: summaryFixture() } });
    const text = textOf(tree);
    expect(text).toContain("หน่วยกิตรอบปัจจุบัน");
    expect(text).toContain("รอบที่ 1");
    expect(text).toContain("ประวัติรายรอบ");
    expect(
      countWhere(tree, (props) => props["role"] === "progressbar"),
    ).toBe(1);
  });

  it("history ว่าง — ตารางประวัติแจ้งว่ายังไม่มีประวัติรอบ", () => {
    const tree = CreditsView({
      data: { kind: "ready", summary: summaryFixture({ history: [] }) },
    });
    expect(textOf(tree)).toContain("ยังไม่มีประวัติรอบ");
  });
});

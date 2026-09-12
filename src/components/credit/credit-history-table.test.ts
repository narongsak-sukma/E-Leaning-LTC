/**
 * credit-history-table.test — ตารางประวัติรายรอบ (Wave E Phase 3)
 *
 * - หัวตารางครบ 5 คอลัมน์ไทย · แถวรอบ: ช่วงวันพุทธศักราช + ป้ายสถานะไทย + เกณฑ์/ยอดต่อ type
 * - history ว่าง = แถวเดียว "ยังไม่มีประวัติรอบ" (colSpan 5) — ไม่ทิ้งพื้นที่ว่างเปล่า
 * (เรียก Server Component เป็นฟังก์ชันตรง ๆ ตามแบบ PB-2 — ตัวช่วยเดินต้นไม้ใน test-tree)
 */
import { describe, expect, it } from "vitest";

import type { CreditCycleParsed } from "@/lib/api/credits";

import { CreditHistoryTable } from "./credit-history-table";
import { countWhere, textOf } from "./test-tree";

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

describe("CreditHistoryTable — ตารางประวัติรายรอบ", () => {
  it("หัวตาราง + คอลัมน์ครบ 5 คอลัมน์ (รอบที่ · ช่วงวัน · สถานะ · เกณฑ์ · ยอด)", () => {
    const text = textOf(CreditHistoryTable({ history: [cycleFixture()] }));
    expect(text).toContain("ประวัติรายรอบ");
    for (const header of ["รอบที่", "ช่วงวัน", "สถานะ", "เกณฑ์", "ยอด"]) {
      expect(text).toContain(header);
    }
  });

  it("แถวรอบ — ช่วงวันพุทธศักราช + ป้ายสถานะไทย + เกณฑ์/ยอดต่อ type", () => {
    const text = textOf(CreditHistoryTable({ history: [cycleFixture()] }));
    expect(text).toContain("1 มกราคม 2569 – 31 ธันวาคม 2569");
    expect(text).toContain("กำลังดำเนินอยู่");
    expect(text).toContain("ทั่วไป 12");
    expect(text).toContain("ทั่วไป 3.50/12");
  });

  it("รอบสถานะ closed — ป้าย 'ปิดแล้ว'", () => {
    const text = textOf(CreditHistoryTable({ history: [cycleFixture({ status: "closed" })] }));
    expect(text).toContain("ปิดแล้ว");
  });

  it("history ว่าง — แถวเดียว 'ยังไม่มีประวัติรอบ' (colSpan ครบ 5 คอลัมน์)", () => {
    const tree = CreditHistoryTable({ history: [] });
    expect(textOf(tree)).toContain("ยังไม่มีประวัติรอบ");
    expect(countWhere(tree, (props) => props["colSpan"] === 5)).toBe(1);
  });
});

/**
 * cycle-progress-card.test — ตรรกะรวม credit_type + เปอร์เซ็นต์ + เรนเดอร์การ์ด
 * (Wave E Phase 3 — เรียก Server Component เป็นฟังก์ชันตรง ๆ ใน node env ตามแบบ PB-2)
 */
import { describe, expect, it } from "vitest";

import type { CreditCycleParsed } from "@/lib/api/credits";

import { creditTypeRowsOfCycle, CycleProgressCard, progressPercent } from "./cycle-progress-card";
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

describe("creditTypeRowsOfCycle — รวม required_credits ∪ balances", () => {
  it("type ที่มี balances = ใช้ยอดจริงจาก ledger", () => {
    const cycle = cycleFixture();
    const rows = creditTypeRowsOfCycle(cycle);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      creditType: "general",
      earned: 3.5,
      required: 12,
      missing: 8.5,
    });
  });

  it("type ที่ตั้งเกณฑ์ไว้แต่ยังไม่มี ledger — earned 0 · missing เท่ากับเกณฑ์เต็ม", () => {
    const cycle = cycleFixture({
      required_credits: { general: 12, ethics: 2 },
      balances: { general: { earned: 3.5, required: 12, missing: 8.5 } },
    });
    const rows = creditTypeRowsOfCycle(cycle);
    expect(rows).toHaveLength(2);
    const ethicsRow = rows.find((row) => row.creditType === "ethics");
    expect(ethicsRow).toMatchObject({ earned: 0, required: 2, missing: 2 });
  });

  it("type ที่มี ledger แต่ไม่มีเกณฑ์ — ต่อท้ายคิวของ required", () => {
    const cycle = cycleFixture({
      required_credits: { general: 12 },
      balances: {
        general: { earned: 3.5, required: 12, missing: 8.5 },
        ethics: { earned: 1, required: 0, missing: 0 },
        teaching: { earned: 2, required: 0, missing: 0 },
      },
    });
    const rows = creditTypeRowsOfCycle(cycle);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.creditType)).toEqual(["general", "ethics", "teaching"]);
  });
});

describe("progressPercent", () => {
  it("ครบกรณีขอบ (เกณฑ์ 0 · เกินเกณฑ์ · ทศนิยม)", () => {
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(5, 0)).toBe(100);
    expect(progressPercent(6, 12)).toBe(50);
    expect(progressPercent(15, 12)).toBe(100);
    expect(progressPercent(3, 12)).toBe(25);
  });
});


describe("CycleProgressCard — เรนเดอร์ (เรียก component เป็นฟังก์ชัน)", () => {
  it("หัวการ์ด + รอบ/ช่วงวัน + ป้ายสถานะ + แถวย่อยต่อ credit_type", () => {
    const tree = CycleProgressCard({ cycle: cycleFixture() });
    const text = textOf(tree);
    expect(text).toContain("หน่วยกิตรอบปัจจุบัน");
    expect(text).toContain("รอบที่ 1");
    expect(text).toContain("1 มกราคม 2569");
    expect(text).toContain("31 ธันวาคม 2569");
    expect(text).toContain("กำลังดำเนินอยู่");
    expect(text).toContain("ทั่วไป");
    expect(text).toContain("ได้รับ 3.50 จาก 12 หน่วยกิต");
    expect(text).toContain("ขาดอีก 8.50 หน่วยกิต");
    expect(
      countWhere(tree, (props) => props["role"] === "progressbar"),
    ).toBe(1);
  });

  it("ครบเกณฑ์แล้ว — แสดง 'ครบตามเกณฑ์แล้ว' และไม่แสดง 'ขาดอีก'", () => {
    const tree = CycleProgressCard({
      cycle: cycleFixture({
        balances: { general: { earned: 12, required: 12, missing: 0 } },
      }),
    });
    const text = textOf(tree);
    expect(text).toContain("ครบตามเกณฑ์แล้ว");
    expect(text).not.toContain("ขาดอีก");
  });

  it("หลาย type — progressbar หนึ่งอันต่อ type", () => {
    const tree = CycleProgressCard({
      cycle: cycleFixture({
        required_credits: { general: 12, ethics: 2 },
        balances: {
          general: { earned: 3.5, required: 12, missing: 8.5 },
          ethics: { earned: 2, required: 2, missing: 0 },
        },
      }),
    });
    const text = textOf(tree);
    expect(text).toContain("ได้รับ 2 จาก 2 หน่วยกิต");
    expect(
      countWhere(tree, (props) => props["role"] === "progressbar"),
    ).toBe(2);
  });
});

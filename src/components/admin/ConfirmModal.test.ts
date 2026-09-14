/**
 * unit tests — ConfirmModal focus trap (gate r2 m1)
 * confirmFocusWrap เป็น pure function — ทดสอบใน node env ได้โดยไม่ต้อง DOM
 * ครอบ: กรณีปกติ (first/last ของรายการ) + กรณีที่ gate r2 จับ — focus ค้างที่
 * dialog root หรือนอกรายการโฟกัสได้ (activeElement ไม่อยู่ใน items) ต้อง wrap
 * กลับเข้ากล่องเสมอ ไม่ปล่อย Shift+Tab หลุดออกไปหลังฉากหลัง
 */
import { describe, expect, it } from "vitest";

import { confirmFocusWrap } from "./ConfirmModal";

describe("confirmFocusWrap — focus trap ของ ConfirmModal (gate r2 m1)", () => {
  const items = ["btn-cancel", "btn-confirm"] as const;

  it("focus ที่ตัวแรก + Shift+Tab → wrap ไปตัวสุดท้าย (พฤติกรรมเดิม)", () => {
    expect(confirmFocusWrap(true, items, "btn-cancel")).toBe("last");
  });

  it("focus ที่ตัวสุดท้าย + Tab → wrap ไปตัวแรก (พฤติกรรมเดิม)", () => {
    expect(confirmFocusWrap(false, items, "btn-confirm")).toBe("first");
  });

  it("focus ตรงกลางรายการ → ปล่อยตามลำดับธรรมชาติของ browser", () => {
    expect(confirmFocusWrap(true, ["a", "b", "c"], "b")).toBeNull();
    expect(confirmFocusWrap(false, ["a", "b", "c"], "b")).toBeNull();
  });

  it("focus อยู่ที่ dialog root (ไม่อยู่ในรายการ) → wrap กลับเข้ากล่องทั้งสองทิศ (gate r2 m1)", () => {
    // นี่คือรูที่ gate จับ: เดิมตรวจแค่ active===first/last — root ไม่ตรงเงื่อนไข
    // ไหนเลย browser ปล่อย focus ออกไปหลังฉากหลังได้
    expect(confirmFocusWrap(true, items, null)).toBe("last");
    expect(confirmFocusWrap(false, items, null)).toBe("first");
    // ค่าที่ "อยู่นอกรายการ" (เช่น element หลังฉาก) ก็ถือว่าไม่อยู่ในกล่อง
    expect(confirmFocusWrap(true, items, "opener-behind-backdrop")).toBe("last");
    expect(confirmFocusWrap(false, items, "opener-behind-backdrop")).toBe("first");
  });

  it("รายการว่าง → null (component จัดการเองด้วย dialog.focus())", () => {
    expect(confirmFocusWrap(true, [], null)).toBeNull();
    expect(confirmFocusWrap(false, [], "x")).toBeNull();
  });
});

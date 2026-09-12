/**
 * เทส pure helpers ของ credit.view — ฟอร์ม validate/build mirror กับ zod ขาเข้า BFF
 * (node env · ไม่ render)
 */
import { describe, expect, it } from "vitest";

import {
  CREDIT_ADJUST_FORM_DEFAULTS,
  buildAdjustBody,
  buildCreditRuleCreateBody,
  formatRuleCredits,
  isLedgerEntryType,
  ledgerActorThai,
  ledgerAmountThai,
  ledgerReasonThai,
  ruleLifecycleActions,
  ruleWindowThai,
  validateAdjustForm,
  validateCreditRuleForm,
  type CreditAdjustFormState,
  type CreditRuleFormState,
} from "./credit.view";

/** state ที่ผ่านทุกช่อง (ใช้เป็นฐานแก้ทีละฟิลด์เพื่อทดสอบ) */
const RULE_OK: CreditRuleFormState = {
  code: "CR-LTC-010",
  name: "ผ่านหลักสูตรจริยธรรมวิชาชีพ",
  courseId: "",
  creditType: "general",
  credits: "12",
  validDays: "",
  carryOver: false,
  requiredCreditsPerCycle: "",
  priority: "100",
  renewalCycle: "",
  effectiveFrom: "2026-10-01",
  effectiveTo: "",
};

const ADJUST_OK: CreditAdjustFormState = {
  userId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d61",
  cycleId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d62",
  creditType: "general",
  amount: "-3",
  reason: "ปรับยอดตามมติที่ประชุมคณะกรรมการ",
};

describe("ฟอร์มสร้างกฎ — validate mirror กับ BFF", () => {
  it("ค่าที่ถูกต้องครบผ่าน (ว่าง = ไม่มี error)", () => {
    expect(validateCreditRuleForm(RULE_OK).size).toBe(0);
  });

  it("code ผิดรูป CR-LTC-### → error ช่อง code", () => {
    expect(validateCreditRuleForm({ ...RULE_OK, code: "cr-1" }).has("code")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, code: "CR-LTC-12" }).has("code")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, code: " CR-LTC-011 " }).has("code")).toBe(false);
  });

  it("credits — ห้าม 0/ติดลบ/เกิน 9999.99/ทศนิยมเกิน 2 ตำแหน่ง/ไม่ใช่ตัวเลข", () => {
    expect(validateCreditRuleForm({ ...RULE_OK, credits: "0" }).has("credits")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, credits: "-1" }).has("credits")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, credits: "10000" }).has("credits")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, credits: "1.234" }).has("credits")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, credits: "abc" }).has("credits")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, credits: "12.25" }).has("credits")).toBe(false);
  });

  it("priority — ต้องเป็นจำนวนเต็ม 0..2147483647 (default 100)", () => {
    expect(validateCreditRuleForm({ ...RULE_OK, priority: "-1" }).has("priority")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, priority: "1.5" }).has("priority")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, priority: "2147483648" }).has("priority")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, priority: "" }).has("priority")).toBe(true);
  });

  it("effectiveTo ต้องหลัง effectiveFrom (mirror cross-field ของ BFF)", () => {
    expect(validateCreditRuleForm({ ...RULE_OK, effectiveTo: "2026-10-01" }).has("effectiveTo")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, effectiveTo: "2026-09-30" }).has("effectiveTo")).toBe(true);
    expect(validateCreditRuleForm({ ...RULE_OK, effectiveTo: "2026-10-02" }).has("effectiveTo")).toBe(false);
  });

  it("buildCreditRuleCreateBody — ใส่เฉพาะ key ที่กรอก (\"\" = ไม่ส่ง)", () => {
    const built = buildCreditRuleCreateBody(RULE_OK);
    if (!built.ok) {
      throw new Error("ต้องผ่าน");
    }
    expect(built.body["code"]).toBe("CR-LTC-010");
    expect(built.body["credits"]).toBe(12);
    expect("courseId" in built.body).toBe(false);
    expect("validDays" in built.body).toBe(false);
    expect("effectiveTo" in built.body).toBe(false);
  });

  it("buildCreditRuleCreateBody — ฟอร์มผิด = ไม่ส่งอะไรออก (ok:false + fields)", () => {
    const built = buildCreditRuleCreateBody({ ...RULE_OK, credits: "0" });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.fields.has("credits")).toBe(true);
    }
  });
});

describe("ฟอร์มปรับ credit — validate mirror กับ BFF", () => {
  it("ค่าถูกต้องครบผ่าน", () => {
    expect(validateAdjustForm(ADJUST_OK).size).toBe(0);
    // default: userId/cycleId/amount/reason ยังว่าง = 4 ช่องผิด (creditType "general" ผ่าน)
    expect(validateAdjustForm(CREDIT_ADJUST_FORM_DEFAULTS).size).toBe(4);
  });

  it("amount — ห้าม 0/เกิน ±9999.99/ทศนิยมเกิน 2/ไม่ใช่ตัวเลข", () => {
    expect(validateAdjustForm({ ...ADJUST_OK, amount: "0" }).has("amount")).toBe(true);
    expect(validateAdjustForm({ ...ADJUST_OK, amount: "9999.991" }).has("amount")).toBe(true);
    expect(validateAdjustForm({ ...ADJUST_OK, amount: "-9999.99" }).has("amount")).toBe(false);
    expect(validateAdjustForm({ ...ADJUST_OK, amount: "1e3" }).has("amount")).toBe(false);
    expect(validateAdjustForm({ ...ADJUST_OK, amount: "สาม" }).has("amount")).toBe(true);
  });

  it("reason ต้องยาว 10-500 ตัวอักษร (trim แล้ว — ERR-CRD-002)", () => {
    expect(validateAdjustForm({ ...ADJUST_OK, reason: "สั้นเกิน" }).has("reason")).toBe(true);
    expect(
      validateAdjustForm({ ...ADJUST_OK, reason: "ก".repeat(501) }).has("reason"),
    ).toBe(true);
    expect(
      validateAdjustForm({ ...ADJUST_OK, reason: "  ปรับยอดตามมติที่ประชุม  " }).has("reason"),
    ).toBe(false);
  });

  it("buildAdjustBody — body camelCase ครบ 5 ฟิลด์ amount เป็น number", () => {
    const built = buildAdjustBody(ADJUST_OK);
    if (!built.ok) {
      throw new Error("ต้องผ่าน");
    }
    expect(built.body).toEqual({
      userId: ADJUST_OK.userId,
      cycleId: ADJUST_OK.cycleId,
      creditType: "general",
      amount: -3,
      reason: ADJUST_OK.reason,
    });
  });
});

describe("ป้าย/ฟอร์แมตของหน้า", () => {
  const RULE = {
    id: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d70",
    code: "CR-LTC-001",
    name: "กฎทดสอบ",
    courseId: null,
    creditType: "general",
    credits: 12,
    validDays: null,
    carryOver: false,
    requiredCreditsPerCycle: null,
    priority: 100,
    renewalCycle: null,
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveTo: null,
    status: "draft",
    createdAt: "2026-09-01T00:00:00Z",
  } as const;

  it("formatRuleCredits ตัดทศนิยมเท่าที่จำเป็น", () => {
    expect(formatRuleCredits(12)).toBe("12");
    expect(formatRuleCredits(12.5)).toBe("12.5");
    expect(formatRuleCredits(0.05)).toBe("0.05");
  });

  it("ruleWindowThai — ไม่มี effectiveTo = ไม่กำหนด (พ.ศ.)", () => {
    expect(ruleWindowThai(RULE)).toContain("2569");
    expect(ruleWindowThai(RULE)).toContain("ไม่กำหนด");
  });

  it("ruleLifecycleActions — draft เผยแพร่ · active ปลดระวัง · retired ไม่มีปุ่ม", () => {
    expect(ruleLifecycleActions("draft")).toEqual([{ status: "active", label: "เผยแพร่" }]);
    expect(ruleLifecycleActions("active")).toEqual([{ status: "retired", label: "ปลดระวัง" }]);
    expect(ruleLifecycleActions("retired")).toEqual([]);
  });

  it("ledger helpers — actor ระบบ · เหตุผลว่างเป็น — · จำนวนมีเครื่องหมาย", () => {
    expect(ledgerActorThai(null)).toBe("ระบบ");
    expect(ledgerActorThai("0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d71")).toBe("เจ้าหน้าที่");
    expect(ledgerReasonThai(null)).toBe("—");
    expect(ledgerAmountThai(12)).toBe("+12");
    expect(ledgerAmountThai(-3)).toBe("-3");
  });

  it("isLedgerEntryType — จำกัด 4 ค่า enum", () => {
    expect(isLedgerEntryType("accrual")).toBe(true);
    expect(isLedgerEntryType("expiry")).toBe(true);
    expect(isLedgerEntryType("manual")).toBe(false);
  });
});

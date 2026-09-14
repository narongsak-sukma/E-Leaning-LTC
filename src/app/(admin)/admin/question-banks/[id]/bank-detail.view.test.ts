/**
 * unit tests — bank-detail.view (Wave G P2 · lane W2)
 * ครอบ: ผู้ช่วยบทบาท (ซ่อนปุ่มตาม role — mock roles ตาม RBAC §2) · hint D77
 * (หัวคลัง + toggle) · transition ปุ่ม toggle · body/endpoint ของ PATCH status
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVATE_POOL_HINT_TH,
  BANK_POOL_HINT_TH,
  bankQuestionEditEndpointOf,
  bankQuestionPatchEndpointOf,
  bankQuestionStatusEndpointOf,
  bankQuestionsListPathOf,
  canEditQuestionBank,
  canToggleQuestionStatus,
  isQuestionDifficulty,
  isQuestionStatus,
  isQuestionType,
  QUESTION_STATUS_LABEL_TH,
  QUESTION_STATUS_TONE,
  QUESTION_STATUS_VALUES,
  questionStatusBody,
  RETIRE_POOL_HINT_TH,
  statusActionLabelTh,
  statusConfirmDescriptionTh,
  statusTargetOf,
  truncateQuestionTextTh,
} from "./bank-detail.view";

describe("ผู้ช่วยบทบาท — canEditQuestionBank (question_bank:update)", () => {
  it("instructor/staff:exam/super_admin → true", () => {
    expect(canEditQuestionBank(["instructor"])).toBe(true);
    expect(canEditQuestionBank(["staff:exam"])).toBe(true);
    expect(canEditQuestionBank(["super_admin"])).toBe(true);
  });

  it("staff:viewer/staff:registrar/ไม่มี role → false", () => {
    expect(canEditQuestionBank(["staff:viewer"])).toBe(false);
    expect(canEditQuestionBank(["staff:registrar"])).toBe(false);
    expect(canEditQuestionBank([])).toBe(false);
  });

  it("role หลายตัว — มีตัวใดตัวหนึ่งที่อนุญาต = true", () => {
    expect(canEditQuestionBank(["staff:viewer", "instructor"])).toBe(true);
    expect(canEditQuestionBank(["instructor", "staff:viewer"])).toBe(true);
  });
});

describe("ผู้ช่วยบทบาท — canToggleQuestionStatus (D75 · staff:exam/super_admin)", () => {
  it("staff:exam/super_admin → true", () => {
    expect(canToggleQuestionStatus(["staff:exam"])).toBe(true);
    expect(canToggleQuestionStatus(["super_admin"])).toBe(true);
  });

  it("instructor/staff:viewer/ไม่มี role → false (ปุ่ม toggle ถูกซ่อน)", () => {
    expect(canToggleQuestionStatus(["instructor"])).toBe(false);
    expect(canToggleQuestionStatus(["staff:viewer"])).toBe(false);
    expect(canToggleQuestionStatus(["staff:registrar"])).toBe(false);
    expect(canToggleQuestionStatus([])).toBe(false);
  });
});

describe("สถานะข้อสอบ — label/tone/guards", () => {
  it("label ไทยครบ 3 สถานะ", () => {
    expect(QUESTION_STATUS_LABEL_TH).toEqual({
      draft: "ร่าง",
      active: "ใช้งาน",
      retired: "ปลดจากการใช้งาน",
    });
  });

  it("tone ของ badge ต่อสถานะ", () => {
    expect(QUESTION_STATUS_TONE).toEqual({
      draft: "info",
      active: "success",
      retired: "neutral",
    });
  });

  it("guards ตัดค่านอก enum (parser fail-closed ใช้ร่วมกัน)", () => {
    expect(isQuestionStatus("active")).toBe(true);
    expect(isQuestionStatus("disabled")).toBe(false);
    expect(isQuestionStatus(null)).toBe(false);
    expect(isQuestionType("single_choice")).toBe(true);
    expect(isQuestionType("essay")).toBe(false);
    expect(isQuestionDifficulty("hard")).toBe(true);
    expect(isQuestionDifficulty("impossible")).toBe(false);
  });

  it("enum values ครบ 3 ค่า", () => {
    expect(QUESTION_STATUS_VALUES).toEqual(["draft", "active", "retired"]);
  });
});

describe("hint ผลกระทบ pool — D77", () => {
  it("hint หัวคลัง ตรงตามแผน (bank inactive ไม่หยุด selection)", () => {
    expect(BANK_POOL_HINT_TH).toBe(
      "ปิดคลังไม่ได้ตัดข้อออกจากการสุ่ม ข้อสถานะใช้งานยังอาจถูกเลือกตามเกณฑ์การสอบ",
    );
  });

  it("hint ตอนปลดข้อ ตรงตามแผน", () => {
    expect(RETIRE_POOL_HINT_TH).toBe("ข้อที่ปลดจะไม่ถูกสุ่มให้การสอบที่เริ่มใหม่");
  });

  it("hint ตอนเปิดใช้งานข้อ มีเงื่อนไขการสอบที่กำลังทำอยู่ไม่เปลี่ยน", () => {
    expect(ACTIVATE_POOL_HINT_TH).toContain("การสอบที่กำลังทำอยู่ไม่เปลี่ยน");
  });
});

describe("toggle สถานะ — transition ปุ่ม + ข้อความยืนยัน from→to", () => {
  it("statusTargetOf: draft→active · active→retired · retired→active (D75)", () => {
    expect(statusTargetOf("draft")).toBe("active");
    expect(statusTargetOf("active")).toBe("retired");
    expect(statusTargetOf("retired")).toBe("active");
  });

  it("ป้ายปุ่ม toggle ตามสถานะปัจจุบัน", () => {
    expect(statusActionLabelTh("active")).toBe("ปลดจากการใช้งาน");
    expect(statusActionLabelTh("draft")).toBe("เปิดใช้งาน");
    expect(statusActionLabelTh("retired")).toBe("เปิดใช้งาน");
  });

  it("ข้อความยืนยันแสดง from→to ไทย + hint ปลด", () => {
    const message = statusConfirmDescriptionTh("active");
    expect(message).toContain('จาก "ใช้งาน"');
    expect(message).toContain('เป็น "ปลดจากการใช้งาน"');
    expect(message).toContain("ข้อที่ปลดจะไม่ถูกสุ่มให้การสอบที่เริ่มใหม่");
  });

  it("ข้อความยืนยันตอนเปิดใช้งาน ใช้ hint อีกชุด", () => {
    const message = statusConfirmDescriptionTh("retired");
    expect(message).toContain('จาก "ปลดจากการใช้งาน"');
    expect(message).toContain('เป็น "ใช้งาน"');
    expect(message).toContain("การสอบที่กำลังทำอยู่ไม่เปลี่ยน");
  });
});

describe("endpoint ตาม API-SPECIFICATION §3.8 (1.3.0)", () => {
  it("edit GET / PATCH / status / list path ตรง contract", () => {
    expect(bankQuestionEditEndpointOf("B1", "Q9")).toBe(
      "/api/v1/admin/question-banks/B1/questions/Q9",
    );
    expect(bankQuestionPatchEndpointOf("B1", "Q9")).toBe(
      "/api/v1/admin/question-banks/B1/questions/Q9",
    );
    expect(bankQuestionStatusEndpointOf("B1", "Q9")).toBe(
      "/api/v1/admin/question-banks/B1/questions/Q9/status",
    );
    expect(bankQuestionsListPathOf("B1")).toBe(
      "/api/v1/admin/question-banks/B1/questions",
    );
  });

  it("body ของ PATCH status — strict single-key body เท่านั้น (D75)", () => {
    expect(questionStatusBody("active")).toEqual({ status: "active" });
    expect(questionStatusBody("retired")).toEqual({ status: "retired" });
    expect(Object.keys(questionStatusBody("active"))).toEqual(["status"]);
    expect(Object.keys(questionStatusBody("retired")).length).toBe(1);
  });
});

describe("โจทย์ย่อในตาราง — truncateQuestionTextTh", () => {
  it("สั้น = คงเดิม", () => {
    expect(truncateQuestionTextTh("ข้อสอบสั้น")).toBe("ข้อสอบสั้น");
  });

  it("ยาวเกิน 80 → ตัด + จุดไข่ปลา รวมยาวไม่เกิน 80", () => {
    const text = "ก".repeat(200);
    const truncated = truncateQuestionTextTh(text);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.length).toBe(80);
    expect(truncated.startsWith("ก".repeat(79))).toBe(true);
  });
});

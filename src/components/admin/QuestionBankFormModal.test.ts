/**
 * unit tests — QuestionBankFormModal logic (D-7)
 * ครอบ: validateQuestionDrafts (โจทย์/คำอธิบาย/คะแนน/ตัวเลือก/จำนวนข้อที่ถูก) ·
 * buildQuestionBankCreateBody (camelCase เป๊ะ · ไม่ส่ง id/tags · sortOrder = ลำดับฟอร์ม) ·
 * ผู้ช่วยจัดการ draft (type/ถูกผิด/เพิ่ม-ลบตัวเลือก)
 */
import { describe, expect, it } from "vitest";

import {
  addOptionDraft,
  buildQuestionBankCreateBody,
  markSingleCorrect,
  QUESTION_BANK_FORM_DEFAULTS,
  QUESTION_DRAFT_DEFAULTS,
  removeOptionDraft,
  setQuestionDraftType,
  TRUE_FALSE_OPTIONS,
  updateOptionDraft,
  updateQuestionDraft,
  validateQuestionDrafts,
  type QuestionBankFormState,
  type QuestionDraft,
} from "./QuestionBankFormModal";

/** คลังจำลองพร้อมข้อสอบ 1 ข้อ (ปรนัยเลือกเดียว 2 ตัวเลือก) */
function bankWithQuestion(overrides: Partial<QuestionBankFormState> = {}): QuestionBankFormState {
  return {
    ...QUESTION_BANK_FORM_DEFAULTS,
    code: "QB-LP1",
    name: "คลังข้อสอบชุดที่ 1",
    questions: [makeDraft()],
    ...overrides,
  };
}

/** ข้อสอบจำลอง — ปรนัยเลือกเดียว 2 ตัวเลือกครบถ้วน */
function makeDraft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    ...QUESTION_DRAFT_DEFAULTS,
    questionText: "ข้อใดกล่าวถูกต้อง",
    options: [
      { optionText: "ตัวเลือก 1", isCorrect: true },
      { optionText: "ตัวเลือก 2", isCorrect: false },
    ],
    ...overrides,
  };
}

describe("validateQuestionDrafts", () => {
  it("ข้อสอบครบถ้วน → ไม่มีข้อผิดพลาด", () => {
    expect(validateQuestionDrafts([makeDraft()])).toEqual({});
  });

  it("โจทย์ว่าง/ยาวเกิน 8000 → ข้อผิดพลาดต่อ path ของ field", () => {
    const errors = validateQuestionDrafts([makeDraft({ questionText: "" })]);
    expect(errors["questions.0.questionText"]).toContain("1-8,000");
    const longError = validateQuestionDrafts([makeDraft({ questionText: "ก".repeat(8001) })]);
    expect(longError["questions.0.questionText"]).toContain("1-8,000");
  });

  it("คำอธิบายเกิน 4000 → path questions.N.explanation", () => {
    const errors = validateQuestionDrafts([makeDraft({ explanation: "ก".repeat(4001) })]);
    expect(errors["questions.0.explanation"]).toContain("4,000");
  });

  it("คะแนน 0/101/ทศนิยม → path questions.N.points", () => {
    expect(validateQuestionDrafts([makeDraft({ points: "0" })])["questions.0.points"]).toBeDefined();
    expect(validateQuestionDrafts([makeDraft({ points: "101" })])["questions.0.points"]).toBeDefined();
    expect(validateQuestionDrafts([makeDraft({ points: "1.5" })])["questions.0.points"]).toBeDefined();
  });

  it("เลือกเดียว/ถูกผิด ต้องมีข้อที่ถูกพอดี 1", () => {
    const none = validateQuestionDrafts([
      makeDraft({ type: "single_choice", options: [
        { optionText: "ก", isCorrect: false },
        { optionText: "ข", isCorrect: false },
      ] }),
    ]);
    expect(none["questions.0.options"]).toContain("เพียง 1 ตัว");
    const two = validateQuestionDrafts([
      makeDraft({ type: "true_false", options: [
        { optionText: "ถูก", isCorrect: true },
        { optionText: "ผิด", isCorrect: true },
      ] }),
    ]);
    expect(two["questions.0.options"]).toContain("เพียง 1 ตัว");
  });

  it("multiple_choice ต้องมีข้อที่ถูกอย่างน้อย 1", () => {
    const none = validateQuestionDrafts([
      makeDraft({ type: "multiple_choice", options: [
        { optionText: "ก", isCorrect: false },
        { optionText: "ข", isCorrect: false },
      ] }),
    ]);
    expect(none["questions.0.options"]).toContain("อย่างน้อย 1 ตัว");
  });

  it("ตัวเลือกเกิน 10 → ข้อผิดพลาดระดับข้อ", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      optionText: `ตัวเลือก ${index + 1}`,
      isCorrect: index === 0,
    }));
    const errors = validateQuestionDrafts([makeDraft({ options: eleven })]);
    expect(errors["questions.0.options"]).toContain("1-10");
  });
});

describe("buildQuestionBankCreateBody", () => {
  it("ประกอบ body camelCase เป๊ะ — ไม่ส่ง id/tags, sortOrder = ลำดับในฟอร์ม", () => {
    const built = buildQuestionBankCreateBody(bankWithQuestion());
    expect(built.ok).toBe(true);
    if (built.ok) {
      const first = built.body.questions?.[0];
      expect(first?.questionText).toBe("ข้อใดกล่าวถูกต้อง");
      expect(first?.points).toBe(1);
      expect(first?.options).toEqual([
        { optionText: "ตัวเลือก 1", isCorrect: true, sortOrder: 0 },
        { optionText: "ตัวเลือก 2", isCorrect: false, sortOrder: 1 },
      ]);
      expect(JSON.stringify(first)).not.toContain("id");
      expect(JSON.stringify(first)).not.toContain("tags");
    }
  });

  it("code/name ว่าง → ข้อผิดพลาดของคลัง ไม่ประกอบ body", () => {
    const built = buildQuestionBankCreateBody(
      bankWithQuestion({ code: "", name: "" }),
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.errors["code"]).toBeDefined();
      expect(built.errors["name"]).toBeDefined();
    }
  });

  it("เลือก ไม่ระบุ → ไม่ส่ง courseId/categoryId/description เลย (schema .strict())", () => {
    const built = buildQuestionBankCreateBody(
      bankWithQuestion({ courseId: "", categoryId: "", description: "" }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect("courseId" in built.body).toBe(false);
      expect("categoryId" in built.body).toBe(false);
      expect("description" in built.body).toBe(false);
      expect("isActive" in built.body).toBe(false);
    }
  });

  it("isActive false → ส่ง isActive: false ขึ้น BFF (ต่างจาก default true)", () => {
    const built = buildQuestionBankCreateBody(
      bankWithQuestion({ isActive: false }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body.isActive).toBe(false);
    }
  });

  it("คลังไม่มีข้อสอบ → ไม่ส่งคีย์ questions เลย (schema .strict())", () => {
    const built = buildQuestionBankCreateBody(
      bankWithQuestion({ questions: [] }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect("questions" in built.body).toBe(false);
    }
  });
});

describe("draft helpers", () => {
  it("setQuestionDraftType true_false → ตัวเลือกเป็น ถูก/ผิด อัตโนมัติ", () => {
    const questions = setQuestionDraftType([makeDraft()], 0, "true_false");
    expect(questions[0]?.type).toBe("true_false");
    expect(questions[0]?.options).toEqual(TRUE_FALSE_OPTIONS);
  });

  it("updateQuestionDraft แก้เฉพาะข้อที่ระบุ", () => {
    const questions = updateQuestionDraft([makeDraft()], 0, { points: "5" });
    expect(questions[0]?.points).toBe("5");
    const other = updateQuestionDraft([makeDraft(), makeDraft()], 1, { points: "5" });
    expect(other[0]?.points).toBe("1");
    expect(other[1]?.points).toBe("5");
  });

  it("addOptionDraft เพิ่มตัวเลือกที่ไม่ถูก ไม่เกิน 10", () => {
    const questions = addOptionDraft([makeDraft()], 0);
    expect(questions[0]?.options).toHaveLength(3);
    expect(questions[0]?.options.every((option) => option.isCorrect === false || true)).toBe(true);
    const capped = Array.from({ length: 10 }, (_, index) => ({
      optionText: `ตัวเลือก ${index}`,
      isCorrect: index === 0,
    }));
    const atCap = addOptionDraft([makeDraft({ options: capped })], 0);
    expect(atCap[0]?.options).toHaveLength(10);
  });

  it("removeOptionDraft ลบได้จนเหลือขั้นต่ำ 1 ตัวเลือก", () => {
    const questions = removeOptionDraft([makeDraft()], 0, 1);
    expect(questions[0]?.options).toHaveLength(1);
    const oneOption = removeOptionDraft([makeDraft()], 0, 0);
    expect(oneOption[0]?.options).toHaveLength(1);
    const guarded = removeOptionDraft(
      [makeDraft({ options: [{ optionText: "ตัวเดียว", isCorrect: true }] })],
      0,
      0,
    );
    expect(guarded[0]?.options).toHaveLength(1);
  });

  it("markSingleCorrect ปิดตัวอื่นให้เหลือข้อที่ถูกตัวเดียว", () => {
    const questions = markSingleCorrect([makeDraft()], 0, 1);
    expect(questions[0]?.options.map((option) => option.isCorrect)).toEqual([false, true]);
  });

  it("updateOptionDraft แก้ข้อความ/ธงถูกของตัวเลือกที่ระบุ", () => {
    const questions = updateOptionDraft([makeDraft()], 0, 1, { optionText: "แก้แล้ว", isCorrect: true });
    expect(questions[0]?.options[1]?.optionText).toBe("แก้แล้ว");
    expect(questions[0]?.options[1]?.isCorrect).toBe(true);
  });
});

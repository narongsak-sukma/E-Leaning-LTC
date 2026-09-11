/**
 * unit tests — AssessmentFormModal logic (D-7)
 * ครอบ: validateAssessmentForm mirror zod ขาเข้า · buildAssessmentCreateBody
 * (camelCase เป๊ะ · conditional spread · includeRules=false ไม่แนบกติกา)
 * (logic ทั้งหมดถูก export ออกจาก component เป็น pure function — test ใน node env ได้)
 */
import { describe, expect, it } from "vitest";

import {
  ASSESSMENT_FORM_DEFAULTS,
  buildAssessmentCreateBody,
  validateAssessmentForm,
  type AssessmentFormState,
} from "./AssessmentFormModal";

/** ฟอร์มที่ผ่านทุกช่อง — ปรับค่าทีละช่องเพื่อทดสอบข้อผิดพลาด */
function validForm(overrides: Partial<AssessmentFormState> = {}): AssessmentFormState {
  return { ...ASSESSMENT_FORM_DEFAULTS, courseId: "c-101", code: "EXM-1", title: "ข้อสอบ 1", ...overrides };
}

describe("validateAssessmentForm", () => {
  it("ฟอร์มครบ → ไม่มีข้อผิดพลาด", () => {
    expect(validateAssessmentForm(validForm())).toEqual({});
  });

  it("ไม่เลือกหลักสูตร/รหัสว่าง → ข้อความไทยต่อช่อง", () => {
    const errors = validateAssessmentForm(ASSESSMENT_FORM_DEFAULTS);
    expect(errors["courseId"]).toContain("หลักสูตร");
    expect(errors["code"]).toContain("1-120");
  });

  it("เกณฑ์ผ่านนอกช่วง 1-100 → ข้อความไทยที่ระบุช่วง", () => {
    const errors = validateAssessmentForm(validForm({ passPct: "0" }));
    expect(errors["passPct"]).toContain("1-100");
    const tooBig = validateAssessmentForm(validForm({ passPct: "101" }));
    expect(tooBig["passPct"]).toContain("1-100");
  });

  it("ตัวเลขไม่ใช่จำนวนเต็ม → ข้อผิดพลาดของช่องนั้น", () => {
    expect(validateAssessmentForm(validForm({ timeLimitMinutes: "abc" }))["timeLimitMinutes"]).toBeDefined();
    expect(validateAssessmentForm(validForm({ questionCount: "30.5" }))["questionCount"]).toBeDefined();
    expect(validateAssessmentForm(validForm({ maxAttempts: "" }))["maxAttempts"]).toBeDefined();
  });

  it("ชื่อยาวเกิน 300 → ข้อผิดพลาด ไม่ยิงขึ้น BFF", () => {
    const errors = validateAssessmentForm(validForm({ title: "ก".repeat(301) }));
    expect(errors["title"]).toContain("1-300");
  });
});

describe("buildAssessmentCreateBody", () => {
  it("ประกอบ body camelCase เป๊ะตาม AssessmentCreateBody (rules แนบครบทุกคีย์)", () => {
    const built = buildAssessmentCreateBody(validForm());
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body).toEqual({
        courseId: "c-101",
        code: "EXM-1",
        title: "ข้อสอบ 1",
        rules: {
          timeLimitMinutes: 60,
          questionCount: 30,
          passPct: 70,
          maxAttempts: 3,
          attemptCooldownMinutes: 1440,
          shuffleQuestions: true,
          shuffleOptions: true,
          requireCourseComplete: true,
          proctoringMode: "basic",
        },
      });
    }
  });

  it("includeRules: false → body ไม่มีคีย์ rules เลย (instructor ไม่มี ar_write)", () => {
    const built = buildAssessmentCreateBody(validForm(), { includeRules: false });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect("rules" in built.body).toBe(false);
    }
  });

  it("isFinal + description → conditional spread ถูกต้อง (ไม่ส่ง undefined ตรง ๆ)", () => {
    const built = buildAssessmentCreateBody(
      validForm({ isFinal: true, description: "ใช้สอบปลายภาค" }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body.isFinal).toBe(true);
      expect(built.body.description).toBe("ใช้สอบปลายภาค");
      const noDescription = buildAssessmentCreateBody(validForm());
      if (noDescription.ok) {
        expect("description" in noDescription.body).toBe(false);
      }
    }
  });

  it("ค่าเริ่มต้นของฟอร์ม mirror default ของ AssessmentRuleInput จริง", () => {
    expect(ASSESSMENT_FORM_DEFAULTS.passPct).toBe("70");
    expect(ASSESSMENT_FORM_DEFAULTS.timeLimitMinutes).toBe("60");
    expect(ASSESSMENT_FORM_DEFAULTS.questionCount).toBe("30");
    expect(ASSESSMENT_FORM_DEFAULTS.maxAttempts).toBe("3");
    expect(ASSESSMENT_FORM_DEFAULTS.attemptCooldownMinutes).toBe("1440");
    expect(ASSESSMENT_FORM_DEFAULTS.shuffleQuestions).toBe(true);
    expect(ASSESSMENT_FORM_DEFAULTS.proctoringMode).toBe("basic");
  });
});

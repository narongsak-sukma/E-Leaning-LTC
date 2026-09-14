/**
 * unit tests — AssessmentRulesVersionModal pure helpers (gate GP3 r2 · M1/M2)
 * ครอบ: prefill ฟอร์มจากกติกาล่าสุด (formStateForAssessment) · unwrap envelope
 * { data: { version } } fail-closed (readCreatedRulesVersion — บั๊ก M1: อ่านตรง body
 * เห็น undefined เสมอ) · body ต้องส่งต่อ selection เดิม ไม่ใช่ '{}' ทับขอบเขตคลัง (M2)
 */
import { describe, expect, it } from "vitest";

import {
  ASSESSMENT_RULES_FORM_DEFAULTS,
  buildAssessmentRuleVersionBody,
  formStateForAssessment,
  readCreatedRulesVersion,
  type AssessmentRulesPrefill,
} from "./AssessmentRulesVersionModal";

const PREFILL: AssessmentRulesPrefill = {
  version: 4,
  timeLimitMinutes: 90,
  questionCount: 25,
  passPct: 75,
  maxAttempts: 2,
  cooldownMinutes: 720,
  shuffleQuestions: false,
  shuffleOptions: true,
  requireCourseComplete: false,
  selection: { bank_ids: ["b00000000-0000-4000-8000-000000000001"], per_difficulty: 2 },
  proctoringMode: "none",
  examReviewMode: "never",
};

describe("formStateForAssessment — prefill จากกติกา version ล่าสุด", () => {
  it("rules = null (ชุดยังไม่มีกติกา) → ค่า default ของ schema + selection null", () => {
    const state = formStateForAssessment("d0000000-0000-4000-8000-000000000001", null);
    expect(state).toEqual({
      ...ASSESSMENT_RULES_FORM_DEFAULTS,
      assessmentId: "d0000000-0000-4000-8000-000000000001",
    });
    expect(state.selection).toBeNull();
  });

  it("มีกติกาเดิม → ทุกช่องตามค่าจริง (แปลง number → string) + selection ส่งต่อเป๊ะ", () => {
    const state = formStateForAssessment("d0000000-0000-4000-8000-000000000002", PREFILL);
    expect(state.assessmentId).toBe("d0000000-0000-4000-8000-000000000002");
    expect(state.passPct).toBe("75");
    expect(state.timeLimitMinutes).toBe("90");
    expect(state.questionCount).toBe("25");
    expect(state.maxAttempts).toBe("2");
    expect(state.attemptCooldownMinutes).toBe("720");
    expect(state.shuffleQuestions).toBe(false);
    expect(state.shuffleOptions).toBe(true);
    expect(state.requireCourseComplete).toBe(false);
    expect(state.proctoringMode).toBe("none");
    expect(state.examReviewMode).toBe("never");
    expect(state.selection).toEqual(PREFILL.selection);
  });
});

describe("readCreatedRulesVersion — unwrap envelope { data: { version } } fail-closed", () => {
  it("envelope ถูกต้อง → ได้เลข version", () => {
    expect(readCreatedRulesVersion({ data: { version: 5 } })).toBe(5);
  });

  it("อ่านตรง body แบบเก่า (ไม่มีชั้น data — บั๊ก M1) → null ไม่ใช่ undefined", () => {
    expect(readCreatedRulesVersion({ version: 5 })).toBeNull();
  });

  it("data ไม่มี version / version ผิดชนิด / ค่าติดลบ → null (drift = fail-closed)", () => {
    expect(readCreatedRulesVersion({ data: {} })).toBeNull();
    expect(readCreatedRulesVersion({ data: { version: "5" } })).toBeNull();
    expect(readCreatedRulesVersion({ data: { version: 1.5 } })).toBeNull();
    expect(readCreatedRulesVersion({ data: { version: 0 } })).toBeNull();
  });

  it("body null/undefined/primitive → null ไม่ throw", () => {
    expect(readCreatedRulesVersion(null)).toBeNull();
    expect(readCreatedRulesVersion(undefined)).toBeNull();
    expect(readCreatedRulesVersion("data")).toBeNull();
  });
});

describe("buildAssessmentRuleVersionBody — selection ต้องรอดไปถึง RPC (M2)", () => {
  const base = {
    assessmentId: "d0000000-0000-4000-8000-000000000001",
    passPct: "75",
    timeLimitMinutes: "90",
    questionCount: "25",
    maxAttempts: "2",
    attemptCooldownMinutes: "720",
    shuffleQuestions: true,
    shuffleOptions: true,
    requireCourseComplete: true,
    proctoringMode: "basic" as const,
    examReviewMode: "after_final_attempt" as const,
  };

  it("มี selection เดิม → แนบใน body เป๊ะ (ไม่ใช่ '{}' ทับขอบเขตคลัง)", () => {
    const built = buildAssessmentRuleVersionBody({ ...base, selection: PREFILL.selection });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body.selection).toEqual(PREFILL.selection);
    }
  });

  it("selection null (ชุดยังไม่มีกติกา) → ไม่แนบคีย์ selection ให้ RPC ใช้ default ตามสัญญา", () => {
    const built = buildAssessmentRuleVersionBody({ ...base, selection: null });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect("selection" in built.body).toBe(false);
    }
  });
});

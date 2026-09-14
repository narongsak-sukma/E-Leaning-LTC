/**
 * unit tests — AssessmentRulesVersionModal pure helpers (gate GP3 r2 · M1/M2 + R2-M1/R2-M2)
 * ครอบ: prefill ฟอร์มจากกติกาล่าสุด (formStateForAssessment) · unwrap envelope
 * { data: { version } } fail-closed (readCreatedRulesVersion — บั๊ก M1: อ่านตรง body
 * เห็น undefined เสมอ) · body ต้องส่งต่อ selection เดิม ไม่ใช่ '{}' ทับขอบเขตคลัง (M2) ·
 * state machine การส่ง (nextModalCoreState/confirmGateOf — R2-M1 ล็อกกันสร้าง version
 * ซ้ำ · R2-M2 ปิดกลาง POST แล้วเปิดใหม่ต้องไม่ติดค้าง)
 */
import { describe, expect, it } from "vitest";

import { AdminApiError } from "@/lib/exam-admin.client";
import {
  ASSESSMENT_RULES_FORM_DEFAULTS,
  MODAL_CORE_CLOSED,
  buildAssessmentRuleVersionBody,
  confirmGateOf,
  formStateForAssessment,
  isDefinitiveRejection,
  nextModalCoreState,
  readCreatedRulesVersion,
  type AssessmentRulesPrefill,
  type ModalCoreState,
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

/* ─── state machine การส่ง (gate GP3 r2 R2-M1/R2-M2) ─── */

/** สถานะเปิดปกติ — ฟอร์มพร้อมกรอก ยังไม่ส่ง */
const OPEN_IDLE: ModalCoreState = { ...MODAL_CORE_CLOSED, open: true };

/** กำลังรอ POST .../rules กลับ */
const OPEN_SUBMITTING: ModalCoreState = { ...OPEN_IDLE, submitting: true };

describe("nextModalCoreState — transition การส่งของโมดัล", () => {
  it("open จาก closed → สถานะเปิดสดทุกช่อง (ไม่มีอะไรค้างจากรอบก่อน)", () => {
    expect(nextModalCoreState(MODAL_CORE_CLOSED, { kind: "open" })).toEqual(OPEN_IDLE);
  });

  it("R2-M2: close กลาง POST → submitting รีเซ็ตเป็น false (ไม่ค้างหลังเปิดใหม่)", () => {
    const closed = nextModalCoreState(OPEN_SUBMITTING, { kind: "close" });
    expect(closed).toEqual(MODAL_CORE_CLOSED);
    expect(closed.submitting).toBe(false);
    // เปิดใหม่ทันที = ฟอร์มใช้ได้เลย ไม่ติดล็อกจากการส่งครั้งก่อน
    expect(nextModalCoreState(closed, { kind: "open" })).toEqual(OPEN_IDLE);
  });

  it("R2-M2: outcome ที่มาถึงหลัง close (response เก่า) ถูกทิ้ง — ไม่ฟื้น submitting/open", () => {
    const closed = nextModalCoreState(OPEN_SUBMITTING, { kind: "close" });
    expect(nextModalCoreState(closed, { kind: "outcome_success", version: 7 })).toBe(closed);
    expect(nextModalCoreState(closed, { kind: "outcome_uncertain" })).toBe(closed);
    expect(nextModalCoreState(closed, { kind: "outcome_error" })).toBe(closed);
  });

  it("R2-M1: submit_start ถูกปฏิเสธเมื่อ uncertainSave (กันสร้าง version ซ้ำ)", () => {
    const uncertain = nextModalCoreState(OPEN_SUBMITTING, { kind: "outcome_uncertain" });
    expect(uncertain).toEqual({ ...OPEN_IDLE, uncertainSave: true });
    expect(nextModalCoreState(uncertain, { kind: "submit_start" })).toBe(uncertain);
  });

  it("R2-M1: submit_start ถูกปฏิเสธเมื่อกำลังส่งอยู่ (double-click) และเมื่อสำเร็จแล้ว", () => {
    expect(nextModalCoreState(OPEN_SUBMITTING, { kind: "submit_start" })).toBe(OPEN_SUBMITTING);
    const succeeded = nextModalCoreState(OPEN_SUBMITTING, { kind: "outcome_success", version: 3 });
    expect(nextModalCoreState(succeeded, { kind: "submit_start" })).toBe(succeeded);
  });

  it("submit_start เมื่อปิดอยู่ = ไม่ทำอะไร (ปุ่มอยู่ในโมดัลเท่านั้น)", () => {
    expect(nextModalCoreState(MODAL_CORE_CLOSED, { kind: "submit_start" })).toBe(MODAL_CORE_CLOSED);
  });

  it("outcome_success ตอน submitting → สำเร็จพร้อมเลข version · ตอน idle = ทิ้ง", () => {
    expect(nextModalCoreState(OPEN_SUBMITTING, { kind: "outcome_success", version: 5 })).toEqual({
      ...OPEN_IDLE,
      successVersion: 5,
    });
    expect(nextModalCoreState(OPEN_IDLE, { kind: "outcome_success", version: 5 })).toBe(OPEN_IDLE);
  });

  it("outcome_error ตอน submitting → กลับ idle ให้แก้ฟอร์มส่งใหม่ได้", () => {
    expect(nextModalCoreState(OPEN_SUBMITTING, { kind: "outcome_error" })).toEqual(OPEN_IDLE);
  });
});

describe("confirmGateOf — gate ปุ่มยืนยัน", () => {
  it("idle เปิด → ปลดล็อก", () => {
    expect(confirmGateOf(OPEN_IDLE).disabled).toBe(false);
  });

  it("กำลังส่ง → ล็อกพร้อมเหตุผลไทย", () => {
    const gate = confirmGateOf(OPEN_SUBMITTING);
    expect(gate.disabled).toBe(true);
    expect(typeof gate.reason).toBe("string");
    expect(gate.reason).toContain("กำลังบันทึก");
  });

  it("R2-M1: uncertainSave → ล็อก + เหตุผลบอกให้ตรวจ version ในตารางก่อน", () => {
    const gate = confirmGateOf({ ...OPEN_IDLE, uncertainSave: true });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("version");
  });

  it("สำเร็จแล้ว → ปลดล็อก (ปุ่มกลายเป็น กลับไปยังรายการ)", () => {
    expect(confirmGateOf({ ...OPEN_IDLE, successVersion: 6 }).disabled).toBe(false);
  });
});

describe("isDefinitiveRejection — แยก 4xx ที่แน่ใจว่าไม่มี version ถูกสร้าง", () => {
  it("AdminApiError 4xx (400/403/404) → true — แก้ฟอร์มแล้วส่งใหม่ได้", () => {
    expect(isDefinitiveRejection(new AdminApiError("ERR-VAL-001", 400, "x"))).toBe(true);
    expect(isDefinitiveRejection(new AdminApiError("ERR-RBAC-001", 403, "x"))).toBe(true);
    expect(isDefinitiveRejection(new AdminApiError("ERR-NF-001", 404, "x"))).toBe(true);
  });

  it("AdminApiError 5xx (เช่น 503 rpc row drift หลัง commit) → false = ผลยังไม่แน่นอน", () => {
    expect(isDefinitiveRejection(new AdminApiError("ERR-SYS-002", 503, "x"))).toBe(false);
  });

  it("transport ธรรมดา (TypeError fetch ล้ม) → false = ผลยังไม่แน่นอน", () => {
    expect(isDefinitiveRejection(new TypeError("fetch failed"))).toBe(false);
    expect(isDefinitiveRejection(new Error("network"))).toBe(false);
  });
});

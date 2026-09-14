/**
 * unit tests — AssessmentRulesVersionModal pure helpers (gate GP3 r2 · M1/M2 + R2-M1/R2-M2)
 * ครอบ: prefill ฟอร์มจากกติกาล่าสุด (formStateForAssessment) · unwrap envelope
 * { data: { version } } fail-closed (readCreatedRulesVersion — บั๊ก M1: อ่านตรง body
 * เห็น undefined เสมอ) · body ต้องส่งต่อ selection เดิม ไม่ใช่ '{}' ทับขอบเขตคลัง (M2) ·
 * state machine การส่ง (nextModalCoreState/confirmGateOf — R2-M1 ล็อกกันสร้าง version
 * ซ้ำ · R2-M2 ปิดกลาง POST แล้วเปิดใหม่ต้องไม่ติดค้าง)
 * R3-M1 (gate GP3 r3): registry
 * unresolved รอดการปิดโมดัล · outcome_resolved ทางออกเดียวจาก uncertain · read-back
 * parser fail-closed · submitBlockedGate = gate ที่ handleSubmit ใช้จริง
 * R4-M1 (gate GP3 r4): read-back unreadable = fail-closed คงล็อก (decisionForReadBack
 * pure ที่ callback ใช้จริง — เดิม resolve ทั้ง unreadable)
 * R4-M2 (gate GP3 r4): in-flight tracking นอก lifecycle โมดัล + ผล deferred จัดการ
 * registry ทุกกรณีแม้ epoch ไม่ตรง (deferredOutcomeHandling) — ปิดกลาง POST แล้ว
 * เปิดใหม่ต้องยังล็อกจนคำขอเสร็จ
 * R5-M1 (gate GP3 r5): registry observable + ผล deferred ปลุกโมดัลที่เปิดอยู่ — uncertain → เริ่ม read-back เอง (deferredRegistryReaction)
 * · หาง callback จริง applyDeferredRulesOutcome (registry ทุกกรณี + refresh ทุกผล รวม definitive 400)
 * R6-M1 (gate GP3 r6): SSR ของ component จริงผ่าน react-dom/server — useSyncExternalStore
 * ต้องมี getServerSnapshot (server snapshot = 0 ตรง client ตอน hydration) ไม่งั้น renderToString throw
 */
import { describe, expect, it, vi } from "vitest";

import { AdminApiError } from "@/lib/exam-admin.client";
import {
  applyDeferredRulesOutcome,
  ASSESSMENT_RULES_FORM_DEFAULTS,
  MODAL_CORE_CLOSED,
  UnresolvedRulesRegistry,
  buildAssessmentRuleVersionBody,
  confirmGateOf,
  decisionForReadBack,
  deferredOutcomeHandling,
  deferredRegistryReaction,
  formStateForAssessment,
  isDefinitiveRejection,
  nextModalCoreState,
  parseRulesReadBack,
  readCreatedRulesVersion,
  resolveUnsavedRulesOutcome,
  submitBlockedGate,
  AssessmentRulesVersionModal,
  type AssessmentRulesPrefill,
  type ModalCoreState,
  type RulesPostOutcome,
} from "./AssessmentRulesVersionModal";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// R6-M1: component จริงเรียก useRouter ตอน render — mock เฉพาะตัวนี้ (เทียบวิธีพิสูจน์ของ gate r6)
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => undefined,
    push: () => undefined,
    replace: () => undefined,
    prefetch: () => undefined,
    back: () => undefined,
  }),
}));

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

/* ─── R3-M1 (gate GP3 r3): unresolved รอดการปิดโมดัล + ปลดล็อกผูกกับการตรวจจริง ─── */

describe("nextModalCoreState — outcome_resolved (ทางออกเดียวจาก uncertain)", () => {
  const OPEN_UNCERTAIN: ModalCoreState = { ...OPEN_IDLE, uncertainSave: true };

  it("จาก uncertainSave → กลับ idle แก้/ส่งใหม่ได้ (ปลดล็อกเพราะการตรวจเสร็จจริง)", () => {
    expect(nextModalCoreState(OPEN_UNCERTAIN, { kind: "outcome_resolved" })).toEqual(OPEN_IDLE);
  });

  it("ตอน idle/submitting/closed = ทิ้งเงียบ (ไม่ใช่ทางเข้าสถานะใด)", () => {
    expect(nextModalCoreState(OPEN_IDLE, { kind: "outcome_resolved" })).toBe(OPEN_IDLE);
    expect(nextModalCoreState(OPEN_SUBMITTING, { kind: "outcome_resolved" })).toBe(OPEN_SUBMITTING);
    expect(nextModalCoreState(MODAL_CORE_CLOSED, { kind: "outcome_resolved" })).toBe(MODAL_CORE_CLOSED);
  });

  it("ลำดับเต็ม: submit → uncertain → resolved → submit ใหม่ได้อีก (วงจรปกติหลังตรวจ)", () => {
    let state = nextModalCoreState(OPEN_IDLE, { kind: "submit_start" });
    state = nextModalCoreState(state, { kind: "outcome_uncertain" });
    expect(state.uncertainSave).toBe(true);
    state = nextModalCoreState(state, { kind: "outcome_resolved" });
    expect(state).toEqual(OPEN_IDLE);
    state = nextModalCoreState(state, { kind: "submit_start" });
    expect(state.submitting).toBe(true);
  });
});

describe("UnresolvedRulesRegistry — สถานะ unresolved รอดการปิดโมดัล", () => {
  it("register → peek เห็น knownVersionAtSend · resolve → หาย (ปลดเฉพาะเมื่อตรวจเสร็จ)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a0000000-0000-4000-8000-000000000001", 3);
    expect(registry.peek("a0000000-0000-4000-8000-000000000001")).toMatchObject({
      assessmentId: "a0000000-0000-4000-8000-000000000001",
      knownVersionAtSend: 3,
    });
    registry.resolve("a0000000-0000-4000-8000-000000000001");
    expect(registry.peek("a0000000-0000-4000-8000-000000000001")).toBeUndefined();
  });

  it("register knownVersionAtSend null ได้ (ชุดยังไม่มีกติกาตอนส่ง)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a0000000-0000-4000-8000-000000000002", null);
    expect(registry.peek("a0000000-0000-4000-8000-000000000002")?.knownVersionAtSend).toBeNull();
  });

  it("แยกรายการต่อชุดข้อสอบ — ชุดอื่นไม่โดนล็อกไปด้วย", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a0000000-0000-4000-8000-000000000001", 1);
    expect(registry.peek("a0000000-0000-4000-8000-000000000099")).toBeUndefined();
    registry.resolve("a0000000-0000-4000-8000-000000000001");
    expect(registry.peek("a0000000-0000-4000-8000-000000000001")).toBeUndefined();
  });

  it("clear ล้างทั้งหมด (ใช้ใน test เท่านั้น)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a0000000-0000-4000-8000-000000000001", null);
    registry.clear();
    expect(registry.peek("a0000000-0000-4000-8000-000000000001")).toBeUndefined();
  });
});

describe("resolveUnsavedRulesOutcome — ตัดสินจาก version ล่าสุดจริงบนเซิร์ฟเวอร์ (pure)", () => {
  it("เซิร์ฟเวอร์ยังไม่มีกติกาเลย → not_committed ทุกกรณี", () => {
    expect(resolveUnsavedRulesOutcome(null, null)).toBe("not_committed");
    expect(resolveUnsavedRulesOutcome(3, null)).toBe("not_committed");
  });

  it("known null + เซิร์ฟเวอร์มี v1 → committed_expected (การบันทึกครั้งนั้นสำเร็จ)", () => {
    expect(resolveUnsavedRulesOutcome(null, 1)).toBe("committed_expected");
  });

  it("known N + เซิร์ฟเวอร์ N+1 → committed_expected", () => {
    expect(resolveUnsavedRulesOutcome(1, 2)).toBe("committed_expected");
    expect(resolveUnsavedRulesOutcome(4, 5)).toBe("committed_expected");
  });

  it("เซิร์ฟเวอร์สูงกว่า expected → committed_newer (prefill จากของจริงบนเซิร์ฟเวอร์)", () => {
    expect(resolveUnsavedRulesOutcome(1, 5)).toBe("committed_newer");
    expect(resolveUnsavedRulesOutcome(null, 2)).toBe("committed_newer");
  });

  it("เซิร์ฟเวอร์ไม่สูงกว่า known (ไม่มี version ใหม่) → not_committed — บันทึกใหม่ได้", () => {
    expect(resolveUnsavedRulesOutcome(1, 1)).toBe("not_committed");
    expect(resolveUnsavedRulesOutcome(3, 2)).toBe("not_committed");
  });
});

describe("parseRulesReadBack — envelope ของ GET ?id=… fail-closed", () => {
  const RULES = {
    version: 5,
    passPct: 70,
    timeLimitMinutes: 60,
    questionCount: 30,
    maxAttempts: 3,
    cooldownMinutes: 1440,
    shuffleQuestions: true,
    shuffleOptions: false,
    requireCourseComplete: true,
    selection: { bank_ids: ["b00000000-0000-4000-8000-000000000001"] },
    proctoringMode: "basic",
    examReviewMode: "after_final_attempt",
    effectiveFrom: "2026-09-14T00:00:00Z",
  };

  it("แถวมี rules ครบ → kind rules + version + prefill ครบทุกฟิลด์", () => {
    const readBack = parseRulesReadBack({ data: [{ id: "x", rules: RULES }], page: {} });
    expect(readBack.kind).toBe("rules");
    if (readBack.kind === "rules") {
      expect(readBack.version).toBe(5);
      expect(readBack.prefill.cooldownMinutes).toBe(1440);
      expect(readBack.prefill.selection).toEqual(RULES.selection);
      expect(readBack.prefill.examReviewMode).toBe("after_final_attempt");
    }
  });

  it("rules = null (ยังไม่มีกติกาบนเซิร์ฟเวอร์) → no_rules", () => {
    expect(parseRulesReadBack({ data: [{ id: "x", rules: null }] })).toEqual({ kind: "no_rules" });
  });

  it("data ไม่ใช่ array / ว่าง / แถวไม่ใช่ object → unreadable", () => {
    expect(parseRulesReadBack({ data: null }).kind).toBe("unreadable");
    expect(parseRulesReadBack({ data: [] }).kind).toBe("unreadable");
    expect(parseRulesReadBack({ data: ["x"] }).kind).toBe("unreadable");
    expect(parseRulesReadBack(undefined).kind).toBe("unreadable");
  });

  it("rules ผิดชนิดสักฟิลด์ → unreadable ไม่ปล่อย prefill เพี้ยนเข้าฟอร์ม", () => {
    expect(parseRulesReadBack({ data: [{ rules: { ...RULES, version: 0 } }] }).kind).toBe("unreadable");
    expect(parseRulesReadBack({ data: [{ rules: { ...RULES, passPct: "70" } }] }).kind).toBe("unreadable");
    expect(parseRulesReadBack({ data: [{ rules: { ...RULES, shuffleQuestions: "yes" } }] }).kind).toBe("unreadable");
    expect(parseRulesReadBack({ data: [{ rules: { ...RULES, proctoringMode: "strict" } }] }).kind).toBe("unreadable");
    expect(parseRulesReadBack({ data: [{ rules: { ...RULES, selection: null } }] }).kind).toBe("unreadable");
  });
});

describe("submitBlockedGate — gate รวมที่ handleSubmit ใช้จริง (R3-M1)", () => {
  const ASSESSMENT_ID = "a0000000-0000-4000-8000-000000000001";

  it("ไม่มีรายการค้าง + idle → ปลดล็อก (ส่งได้ปกติ)", () => {
    const registry = new UnresolvedRulesRegistry();
    expect(submitBlockedGate(OPEN_IDLE, ASSESSMENT_ID, null, registry).disabled).toBe(false);
  });

  it("registry มีรายการของชุดที่เลือก → ล็อก แม้ core จะ idle สดหลังปิด-เปิดโมดัลใหม่", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register(ASSESSMENT_ID, 2);
    const gate = submitBlockedGate(OPEN_IDLE, ASSESSMENT_ID, null, registry);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("ตรวจสอบอีกครั้ง");
  });

  it("กำลังตรวจ read-back ของชุดนั้น (resolvingId ตรง) → ล็อกพร้อมเหตุผลรอ", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register(ASSESSMENT_ID, 2);
    const gate = submitBlockedGate(OPEN_IDLE, ASSESSMENT_ID, ASSESSMENT_ID, registry);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("กำลังตรวจสอบ");
  });

  it("registry.resolve แล้ว (ตรวจเสร็จ) → ปลดล็อกทันที — ปลดล็อกผูกกับการตรวจจริง", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register(ASSESSMENT_ID, 2);
    registry.resolve(ASSESSMENT_ID);
    expect(submitBlockedGate(OPEN_IDLE, ASSESSMENT_ID, null, registry).disabled).toBe(false);
  });

  it("รายการค้างเป็นชุดอื่น → ชุดที่เลือกไม่โดนล็อก (แยกรายการต่อชุด)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a0000000-0000-4000-8000-000000000099", 1);
    expect(submitBlockedGate(OPEN_IDLE, ASSESSMENT_ID, null, registry).disabled).toBe(false);
  });

  it("assessmentId ว่าง (ยังไม่เลือก) → ตกไปชั้น confirmGateOf ตามปกติ", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register(ASSESSMENT_ID, 1);
    expect(submitBlockedGate(OPEN_IDLE, "", null, registry).disabled).toBe(false);
    expect(submitBlockedGate(OPEN_SUBMITTING, "", null, registry).disabled).toBe(true);
  });

  it("R4-M2: POST กำลังส่งอยู่ (in-flight) → ล็อกแม้ core จะ idle สดหลังปิด-เปิดโมดัลใหม่", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.markInFlight(ASSESSMENT_ID);
    const gate = submitBlockedGate(OPEN_IDLE, ASSESSMENT_ID, null, registry);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("ยังไม่เสร็จ");
  });

  it("R4-M2: คำขอเสร็จ (clearInFlight) และไม่มีรายการค้าง → ปลดล็อกกลับ", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.markInFlight(ASSESSMENT_ID);
    registry.clearInFlight(ASSESSMENT_ID);
    expect(submitBlockedGate(OPEN_IDLE, ASSESSMENT_ID, null, registry).disabled).toBe(false);
  });
});

/* ─── R4-M1 (gate GP3 r4): read-back ที่อ่านไม่ได้ = fail-closed ห้ามปลดล็อก ─── */

describe("decisionForReadBack — การตัดสินจากผลอ่านกลับ (pure ที่ callback ใช้จริง)", () => {
  const RULES = {
    version: 5,
    passPct: 70,
    timeLimitMinutes: 60,
    questionCount: 30,
    maxAttempts: 3,
    cooldownMinutes: 1440,
    shuffleQuestions: true,
    shuffleOptions: false,
    requireCourseComplete: true,
    selection: { bank_ids: ["b00000000-0000-4000-8000-000000000001"] },
    proctoringMode: "basic",
    examReviewMode: "after_final_attempt",
  } as const;

  it("อ่านได้ครบ (rules) → resolve พร้อม prefill จากเซิร์ฟเวอร์", () => {
    const decision = decisionForReadBack(parseRulesReadBack({ data: [{ id: "x", rules: RULES }] }));
    expect(decision).toEqual({ action: "resolve", prefill: expect.objectContaining({ version: 5 }) });
  });

  it("no_rules (อ่านได้จริง และแน่ใจว่าไม่มีกติกา) → resolve พร้อม prefill null — บันทึกใหม่ได้", () => {
    expect(decisionForReadBack(parseRulesReadBack({ data: [{ id: "x", rules: null }] }))).toEqual({
      action: "resolve",
      prefill: null,
    });
  });

  it("R4-M1: unreadable (อ่านความจริงไม่ได้) → fail_closed คงล็อก — ไม่ใช่ 'ไม่มีกติกา'", () => {
    const unreadableCases = [
      { data: null }, // ไม่ใช่ array
      { data: [] }, // ว่าง
      { data: ["x"] }, // แถวไม่ใช่ object
      { data: [{ rules: { ...RULES, version: 0 } }] }, // ฟิลด์ผิดชนิด
      { data: [{ rules: { ...RULES, passPct: "70" } }] },
    ];
    for (const envelope of unreadableCases) {
      expect(decisionForReadBack(parseRulesReadBack(envelope))).toEqual({ action: "fail_closed" });
    }
  });
});

/* ─── R4-M2 (gate GP3 r4): ผล POST ที่มาช้าหลังปิด/เปิดโมดัลใหม่ ─── */

describe("deferredOutcomeHandling — จัดการ registry ทุกกรณี · UI เฉพาะ epoch ตรง", () => {
  it("R4-M2 เคสหลัก: uncertain + ปิดโมดัลไปแล้ว (epoch ไม่ตรง) → คงล็อก registry แต่ทิ้ง UI", () => {
    const handling = deferredOutcomeHandling({ kind: "uncertain" }, false);
    expect(handling.registry).toBe("keep_locked"); // เดิม epoch guard ทิ้งก่อนลงทะเบียน = ส่งซ้ำได้
    expect(handling.ui).toBe("discard");
  });

  it("uncertain + epoch ตรง → คงล็อก registry + อัปเดต UI ตามปกติ", () => {
    expect(deferredOutcomeHandling({ kind: "uncertain" }, true)).toEqual({
      registry: "keep_locked",
      ui: "apply",
    });
  });

  it("committed + epoch ไม่ตรง → resolve registry (รู้ความจริงจาก response) + ทิ้ง UI", () => {
    expect(deferredOutcomeHandling({ kind: "committed", version: 7 }, false)).toEqual({
      registry: "resolve",
      ui: "discard",
    });
  });

  it("definitely_not_committed + epoch ไม่ตรง → resolve + ทิ้ง UI (แน่ใจว่าไม่มี version ใหม่)", () => {
    expect(deferredOutcomeHandling({ kind: "definitely_not_committed" }, false)).toEqual({
      registry: "resolve",
      ui: "discard",
    });
  });

  it("committed/definitely_not_committed + epoch ตรง → resolve + apply", () => {
    const committed: RulesPostOutcome = { kind: "committed", version: 3 };
    expect(deferredOutcomeHandling(committed, true)).toEqual({ registry: "resolve", ui: "apply" });
    expect(deferredOutcomeHandling({ kind: "definitely_not_committed" }, true)).toEqual({
      registry: "resolve",
      ui: "apply",
    });
  });

  it("ผลสามชนิดครบชุด (table-driven กันชนิดใหม่หลุด)", () => {
    const outcomes: readonly RulesPostOutcome[] = [
      { kind: "committed", version: 1 },
      { kind: "definitely_not_committed" },
      { kind: "uncertain" },
    ];
    for (const outcome of outcomes) {
      for (const epochMatches of [true, false]) {
        const handling = deferredOutcomeHandling(outcome, epochMatches);
        expect(handling.registry).toBe(outcome.kind === "uncertain" ? "keep_locked" : "resolve");
        expect(handling.ui).toBe(epochMatches ? "apply" : "discard");
      }
    }
  });
});

describe("UnresolvedRulesRegistry — in-flight (R4-M2)", () => {
  it("markInFlight → isInFlight จนกว่าจะ clearInFlight — มีชีวิตนอก lifecycle โมดัล", () => {
    const registry = new UnresolvedRulesRegistry();
    expect(registry.isInFlight("a0000000-0000-4000-8000-000000000001")).toBe(false);
    registry.markInFlight("a0000000-0000-4000-8000-000000000001");
    expect(registry.isInFlight("a0000000-0000-4000-8000-000000000001")).toBe(true);
    registry.clearInFlight("a0000000-0000-4000-8000-000000000001");
    expect(registry.isInFlight("a0000000-0000-4000-8000-000000000001")).toBe(false);
  });

  it("in-flight แยกรายการต่อชุด — ชุดอื่นไม่โดนล็อกไปด้วย", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.markInFlight("a0000000-0000-4000-8000-000000000001");
    expect(registry.isInFlight("a0000000-0000-4000-8000-000000000099")).toBe(false);
  });

  it("in-flight อยู่ร่วมกับ entry ได้ (uncertain ลงทะเบียนก่อนคำขอเสร็อย่างอื่น) · clear ล้างทั้งคู่", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.markInFlight("a0000000-0000-4000-8000-000000000001");
    registry.register("a0000000-0000-4000-8000-000000000001", 2);
    expect(registry.isInFlight("a0000000-0000-4000-8000-000000000001")).toBe(true);
    expect(registry.peek("a0000000-0000-4000-8000-000000000001")?.knownVersionAtSend).toBe(2);
    registry.clear();
    expect(registry.isInFlight("a0000000-0000-4000-8000-000000000001")).toBe(false);
    expect(registry.peek("a0000000-0000-4000-8000-000000000001")).toBeUndefined();
  });
});

/* ─── R5-M1 (gate GP3 r5): ผล deferred ของ POST ต้องถึงโมดัลที่เปิดใหม่ ─── */

describe("UnresolvedRulesRegistry — subscription แจ้งทุกการเปลี่ยน (R5-M1)", () => {
  it("register/resolve/markInFlight/clearInFlight แต่ละครั้ง → listener ถูกเรียก + version บวกตามจำนวน · ถอนแล้วเงียบ", () => {
    const registry = new UnresolvedRulesRegistry();
    let calls = 0;
    const unsubscribe = registry.subscribe(() => {
      calls += 1;
    });
    const v0 = registry.version();
    registry.markInFlight("a1");
    registry.register("a1", 1);
    registry.clearInFlight("a1");
    registry.resolve("a1");
    expect(calls).toBe(4);
    expect(registry.version()).toBe(v0 + 4);
    unsubscribe();
    registry.register("a2", null);
    expect(calls).toBe(4);
  });

  it("version คงเดิมเมื่อไม่มีการเปลี่ยน (snapshot เสถียร — ไม่วน render)", () => {
    const registry = new UnresolvedRulesRegistry();
    expect(registry.version()).toBe(registry.version());
    registry.register("a1", null);
    const after = registry.version();
    expect(registry.peek("a1")).toBeDefined();
    expect(registry.version()).toBe(after);
  });
});

describe("deferredRegistryReaction — โมดัลที่เปิดอยู่ตอบอะไรต่อ registry (R5-M1)", () => {
  const base = { open: true, assessmentId: "a1", resolvingId: null, retryNoticeVisible: false };

  it("โมดัลปิดอยู่ → none แม้มีรายการค้าง (เปิด+เลือกชุดจึงตรวจ)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a1", 1);
    expect(deferredRegistryReaction({ ...base, open: false, registry })).toEqual({ kind: "none" });
  });

  it("ยังไม่เลือกชุด (id ว่าง) → none", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a1", 1);
    expect(deferredRegistryReaction({ ...base, assessmentId: "", registry })).toEqual({
      kind: "none",
    });
  });

  it("คำขอ POST ยังค้าง (in-flight) → none — ห้ามอ่านก่อนคำขอตอบ (R4-M2 คงอยู่)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.markInFlight("a1");
    registry.register("a1", 1);
    expect(deferredRegistryReaction({ ...base, registry })).toEqual({ kind: "none" });
  });

  it("ไม่มีรายการ unresolved ของชุดที่เลือก → none", () => {
    expect(
      deferredRegistryReaction({ ...base, registry: new UnresolvedRulesRegistry() }),
    ).toEqual({ kind: "none" });
  });

  it("กำลังตรวจชุดนี้อยู่ (resolvingId === id) → none — อย่ายิงซ้ำซ้อน", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a1", 1);
    expect(deferredRegistryReaction({ ...base, resolvingId: "a1", registry })).toEqual({
      kind: "none",
    });
  });

  it("notice รอผู้ใช้กด retry อยู่ → none — ห้ามวนตรวจอัตโนมัติตอนเซิร์ฟเวิร์งล้ม", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a1", 1);
    expect(deferredRegistryReaction({ ...base, retryNoticeVisible: true, registry })).toEqual({
      kind: "none",
    });
  });

  it("เปิด + เลือกชุดที่ค้าง unresolved + ว่าง → start_read_back (กรณีหลัก: ผล deferred มาถึงหลังเปิดโมดัลใหม่)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.register("a1", 1);
    expect(deferredRegistryReaction({ ...base, registry })).toEqual({ kind: "start_read_back" });
  });
});

describe("ลำดับจบจริงของผล deferred ผ่าน applyDeferredRulesOutcome (R5-M1 — close/reopen + remount ตามข้อสั่ง r4/r5)", () => {
  it("uncertain หลังปิดกลาง POST แล้วเปิดใหม่เลือกชุดเดิม: registry คงรายการ + notify ปลุก + reaction เริ่ม read-back → ตรวจจบ resolve → gate ปลดล็อกจริง", () => {
    const registry = new UnresolvedRulesRegistry();
    const notified: number[] = [];
    registry.subscribe(() => notified.push(registry.version()));
    // ส่ง → ปิดกลางคัน → เปิดใหม่เลือก a1 ขณะคำขอยังค้าง: ห้ามเริ่มตรวจ
    registry.markInFlight("a1");
    const duringFlight = deferredRegistryReaction({
      open: true,
      assessmentId: "a1",
      resolvingId: null,
      retryNoticeVisible: false,
      registry,
    });
    expect(duringFlight).toEqual({ kind: "none" });
    // คำขอตอบผิดรูป = uncertain และ epoch ไม่ตรง — หางจริงของ callback ที่ handleSubmit ใช้
    let refreshes = 0;
    const handling = applyDeferredRulesOutcome({
      assessmentId: "a1",
      knownVersionAtSend: 1,
      outcome: { kind: "uncertain" },
      epochMatches: false,
      registry,
      refresh: () => {
        refreshes += 1;
      },
    });
    expect(handling).toEqual({ ui: "discard" });
    expect(refreshes).toBe(1);
    expect(notified.length).toBeGreaterThan(0); // subscription ปลุก — สิ่งที่ effect ของโมดัลฟังอยู่
    expect(registry.peek("a1")).toBeDefined();
    expect(registry.isInFlight("a1")).toBe(false);
    // โมดัลที่เปิดอยู่ (เปิดใหม่แล้วเลือก a1 — notice ถูกเคลียร์ตอนเลือกชุด) ต้องเริ่มตรวจเอง
    const afterOutcome = deferredRegistryReaction({
      open: true,
      assessmentId: "a1",
      resolvingId: null,
      retryNoticeVisible: false,
      registry,
    });
    expect(afterOutcome).toEqual({ kind: "start_read_back" });
    // read-back สำเร็จ → resolve → reaction กลาย none + gate ปลดล็อกจริง (ไม่ใช่แค่ข้อความ)
    registry.resolve("a1");
    expect(
      deferredRegistryReaction({
        open: true,
        assessmentId: "a1",
        resolvingId: null,
        retryNoticeVisible: false,
        registry,
      }),
    ).toEqual({ kind: "none" });
    const idleOpen: ModalCoreState = {
      open: true,
      submitting: false,
      uncertainSave: false,
      successVersion: null,
    };
    expect(submitBlockedGate(idleOpen, "a1", null, registry).disabled).toBe(false);
  });

  it("definite 400 หลังปิดกลาง POST: clearInFlight + resolve + refresh ด้วย (R5-M1: ทุกผล) → gate คลายล็อก 'ยังไม่เสร็จ' ทันทีที่ re-render", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.markInFlight("a1");
    const idleOpen: ModalCoreState = {
      open: true,
      submitting: false,
      uncertainSave: false,
      successVersion: null,
    };
    expect(submitBlockedGate(idleOpen, "a1", null, registry).disabled).toBe(true);
    let refreshes = 0;
    const handling = applyDeferredRulesOutcome({
      assessmentId: "a1",
      knownVersionAtSend: 1,
      outcome: { kind: "definitely_not_committed" },
      epochMatches: false,
      registry,
      refresh: () => {
        refreshes += 1;
      },
    });
    expect(handling).toEqual({ ui: "discard" });
    expect(refreshes).toBe(1); // เดิม 400 ไม่ refresh — หน้าเลยค้างสถานะรอ
    expect(registry.isInFlight("a1")).toBe(false);
    expect(registry.peek("a1")).toBeUndefined();
    // re-render ที่ได้จาก subscription → gate คำนวณใหม่ = ปลดล็อก
    expect(submitBlockedGate(idleOpen, "a1", null, registry).disabled).toBe(false);
  });

  it("uncertain รอบเดียวกัน (epoch ตรง): คืน ui apply + registry ค้าง → reaction เริ่ม read-back (effect แทนการเรียกตรงใน callback)", () => {
    const registry = new UnresolvedRulesRegistry();
    registry.markInFlight("a1");
    const handling = applyDeferredRulesOutcome({
      assessmentId: "a1",
      knownVersionAtSend: null,
      outcome: { kind: "uncertain" },
      epochMatches: true,
      registry,
      refresh: () => undefined,
    });
    expect(handling).toEqual({ ui: "apply" });
    expect(registry.peek("a1")).toBeDefined();
    expect(
      deferredRegistryReaction({
        open: true,
        assessmentId: "a1",
        resolvingId: null,
        retryNoticeVisible: false,
        registry,
      }),
    ).toEqual({ kind: "start_read_back" });
  });

  it("remount: ผล deferred เกิดตอนไม่มีโมดัล (listener เก่าถูกถอด) — mount ใหม่สมัครใหม่ และรอบแรกของ effect ต้องตรวจรายการที่ค้างจากอดีต", () => {
    const registry = new UnresolvedRulesRegistry();
    const unsubscribeOld = registry.subscribe(() => undefined);
    unsubscribeOld(); // โมดัลเก่า unmount = ถอนผู้ฟัง
    registry.markInFlight("a1");
    let mountNotified = 0;
    registry.subscribe(() => {
      mountNotified += 1;
    }); // โมดัลใหม่ mount สมัครใหม่
    applyDeferredRulesOutcome({
      assessmentId: "a1",
      knownVersionAtSend: 1,
      outcome: { kind: "uncertain" },
      epochMatches: false,
      registry,
      refresh: () => undefined,
    });
    expect(mountNotified).toBeGreaterThan(0);
    // effect รอบแรกของ mount (เปิด + เลือก a1 + ว่าง) → ตรวจรายการค้างจาก mount ก่อน
    expect(
      deferredRegistryReaction({
        open: true,
        assessmentId: "a1",
        resolvingId: null,
        retryNoticeVisible: false,
        registry,
      }),
    ).toEqual({ kind: "start_read_back" });
  });
});


/* ─── R6-M1 (gate GP3 r6): SSR ของ component จริง — registry store ต้องมี server snapshot ─── */

describe("SSR ของ component จริง (R6-M1 — renderToString ผ่าน react-dom/server)", () => {
  it("renderToString ต้องไม่ throw ทั้ง allowRules=false (early return) และ true (ปุ่มเปิดโมดัล) — เดิม throw Missing getServerSnapshot", () => {
    // allowRules=false: hooks ทุกตัว (รวม useSyncExternalStore) ยังรันก่อน early return — จุดที่ SSR เคย throw
    const closedHtml = renderToString(
      createElement(AssessmentRulesVersionModal, { assessmentOptions: [], allowRules: false }),
    );
    expect(closedHtml).not.toContain("เพิ่มกติกา version ใหม่");
    // allowRules=true: render เต็มถึงปุ่ม trigger (วิธีเดียวกับ repro ของ gate r6 — "ได้ปุ่มตามปกติ")
    const openHtml = renderToString(
      createElement(AssessmentRulesVersionModal, {
        assessmentOptions: [
          { id: "a1", label: "ชุดที่ 1", currentVersion: 3, currentRules: null },
        ],
        allowRules: true,
      }),
    );
    expect(openHtml).toContain("+ เพิ่มกติกา version ใหม่");
  });
});

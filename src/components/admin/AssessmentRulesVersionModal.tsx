"use client";

/**
 * ฟอร์ม "เพิ่มกติกา version ใหม่" — POST /api/v1/admin/assessments/{id}/rules
 * (Wave G P3 · D87 · API-SPECIFICATION §3.8 แถว 226)
 *
 * - body ตรง AssessmentRuleInput (schema ขาเข้าของ route จริง) เป๊ะ — camelCase ทุกคีย์ ·
 *   ห้ามส่ง version/effective_to (schema strict ไม่มีคีย์นี้ — version = max+1 server-side)
 * - เลือกชุดข้อสอบแล้ว prefill ทุกช่องจากกติกา version ล่าสุด (embed GET /admin/assessments)
 *   และส่งต่อ selection (ขอบเขตคลังข้อสอบ) ตามเดิมเสมอ — ไม่ส่ง = RPC เขียน '{}' ทับ
 *   ขอบเขตคลังเดิมเงียบ ๆ (ห้าม — แก้ที่อื่นเท่านั้น)
 * - เขียนกติกาได้เฉพาะ staff:exam/super_admin (allowRules — ตัดสินจริงที่ BFF เสมอ)
 * - validation error ของ BFF (ERR-VAL-001 details.fields) แปลงเป็นชื่อฟิลด์ไทย
 *   ผ่าน validationFieldLabels — แสดงในโมดัล ไม่ปิดฟอร์มทิ้ง
 * - response แบบ envelope { data: { version } } ต้อง unwrap ก่อนอ่าน version —
 *   อ่านผิดชั้น = successVersion null ตลอด (แสดงสำเร็จไม่ได้) · ปิดโมดัลกลางคัน =
 *   response เก่าตายทันที (request epoch)
 * - สถานะการส่งเป็น state machine เดียว (ModalCoreState — gate GP3 r2 R2-M1/R2-M2):
 *   201 แต่อ่าน version ไม่ได้ / network ตาย / 5xx หลัง commit = **ผลยังไม่แน่นอน**
 *   → ล็อกปุ่มบันทึกกันสร้าง version ซ้ำ (RPC max+1 ทุกครั้ง ไม่มี dedup) +
 *   router.refresh ให้ตารางอ่านกลับ version ล่าสุดจริง · ปิดโมดัลกลางคัน = รีเซ็ต
 *   ทุกสถานะรวม submitting (เดิมค้าง true ตลอดหลังเปิดใหม่)
 * - R3-M1 (gate GP3 r3): สถานะ "ผลยังไม่แน่นอน" ถูกจดทะเบียนที่ module-level
 *   UnresolvedRulesRegistry — รอดการปิดโมดัล/รี-เมานต์ ปุ่มบันทึกของชุดนั้นล็อกอยู่จนกว่า
 *   read-back (GET /admin/assessments?id=… · no-store) จะเสร็จจริง: committed → prefill
 *   จากกติกาจริงบนเซิร์ฟเวอร์ · not_committed → ปลดล็อกให้บันทึกใหม่ · อ่านไม่ได้ = คงล็อก
 *   fail-closed พร้อมปุ่ม "ตรวจสอบอีกครั้ง" · event ใหม่ outcome_resolved คือทางออกเดียว
 *   จาก uncertainSave (ผูกการปลดล็อกกับการตรวจผลที่เสร็จจริง ไม่ใช่การเดา)
 * - R4-M1 (gate GP3 r4): read-back ที่อ่านไม่ได้ (unreadable) = fail-closed คงล็อก
 *   คงรายการ registry — ห้าม resolve (เดิม resolve ทั้ง unreadable แล้วแจ้งว่า
 *   "ครั้งก่อนไม่สำเร็จ" ทั้งที่ยังไม่รู้ความจริง) · decisionForReadBack = pure ที่
 *   callback ใช้จริง
 * - R4-M2 (gate GP3 r4): คำขอที่กำลังส่งถูกติดตามนอก lifecycle ของโมดัล (in-flight set
 *   ใน registry เดียวกัน) ตั้งแต่ก่อน POST — ปิดกลางคันแล้วเปิดใหม่ ปุ่มยังล็อกระหว่าง
 *   คำขอค้าง · ผลที่มาช้า (deferred) จัดการ registry ทุกกรณีแม้ epoch ไม่ตรง
 *   (uncertain → ลงทะเบียนเสมอ · committed/definitely-not → resolve) — เขียน state
 *   ของฟอร์มเท่านั้นที่ติด epoch · read-back ระหว่าง in-flight ถูกห้าม (แข่งกับ POST)
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  AdminApiError,
  postAdminJson,
  TRANSPORT_FALLBACK_MESSAGE,
  unwrapDataEnvelope,
} from "@/lib/exam-admin.client";
import {
  PROCTORING_MODE_LABEL_TH,
  validationFieldLabels,
  type ExamAdminProctoringMode,
} from "@/lib/exam-admin.view";
import { ConfirmModal } from "./ConfirmModal";

/** โหมดเปิดเฉลยหลังสอบ — enum exam_review_mode (0049) */
export type ExamAdminExamReviewMode = "after_final_attempt" | "never";

/** ป้ายไทยของโหมดเปิดเฉลย — แหล่งเดียวของฟอร์มนี้ (I18N-003) */
export const EXAM_REVIEW_MODE_LABEL_TH: Record<ExamAdminExamReviewMode, string> = {
  after_final_attempt: "เปิดเฉลยเมื่อจบโอกาสสอบหรือผ่านแล้ว",
  never: "ไม่เปิดเฉลย",
};

/**
 * กติกา version ล่าสุดแบบ camelCase (ตรง AssessmentRuleSummary ของ BFF) —
 * ใช้ prefill ฟอร์มเมื่อเลือกชุดข้อสอบ
 */
export interface AssessmentRulesPrefill {
  readonly version: number;
  readonly timeLimitMinutes: number;
  readonly questionCount: number;
  readonly passPct: number;
  readonly maxAttempts: number;
  readonly cooldownMinutes: number;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly requireCourseComplete: boolean;
  readonly selection: Record<string, unknown>;
  readonly proctoringMode: ExamAdminProctoringMode;
  readonly examReviewMode: ExamAdminExamReviewMode;
}

/** ชุดข้อสอบที่หน้า RSC ส่งมาให้เลือก (id + ป้าย + กติกา version ล่าสุด — null = ยังไม่มี) */
export interface AssessmentOption {
  readonly id: string;
  readonly label: string;
  readonly currentVersion: number | null;
  readonly currentRules: AssessmentRulesPrefill | null;
}

/** ช่องกรอกของฟอร์ม — ตัวเลขเก็บเป็นสตริงจาก input แล้ว validate/แปลงตอน submit */
export interface AssessmentRulesFormState {
  readonly assessmentId: string;
  readonly passPct: string;
  readonly timeLimitMinutes: string;
  readonly questionCount: string;
  readonly maxAttempts: string;
  readonly attemptCooldownMinutes: string;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly requireCourseComplete: boolean;
  readonly proctoringMode: ExamAdminProctoringMode;
  readonly examReviewMode: ExamAdminExamReviewMode;
  /**
   * ขอบเขตคลังข้อสอบของ version ล่าสุด — ส่งต่อเป๊ะเสมอ (แสดงอ่านอย่างเดียว) ·
   * null = ชุดข้อสอบยังไม่มีกติกา → ไม่แนบคีย์ selection ใน body (ใช้ default ของ RPC)
   */
  readonly selection: Record<string, unknown> | null;
}

/** ค่าเริ่มต้นตรง default ของ AssessmentRuleInput (schema ขาเข้าของ route จริง) */
export const ASSESSMENT_RULES_FORM_DEFAULTS: AssessmentRulesFormState = {
  assessmentId: "",
  passPct: "70",
  timeLimitMinutes: "60",
  questionCount: "30",
  maxAttempts: "3",
  attemptCooldownMinutes: "1440",
  shuffleQuestions: true,
  shuffleOptions: true,
  requireCourseComplete: true,
  proctoringMode: "basic",
  examReviewMode: "after_final_attempt",
  selection: null,
};

/** body ของ POST .../rules — คีย์ตรง AssessmentRuleInput เป๊ะ (strict — ไม่มี version/effective_to) */
export type AssessmentRuleVersionBody = {
  readonly timeLimitMinutes: number;
  readonly questionCount: number;
  readonly passPct: number;
  readonly maxAttempts: number;
  readonly attemptCooldownMinutes: number;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly requireCourseComplete: boolean;
  readonly proctoringMode: ExamAdminProctoringMode;
  readonly examReviewMode: ExamAdminExamReviewMode;
  /** แนบเฉพาะเมื่อมีกติกาเดิม — ไม่แนบ = RPC ใช้ default ('{}') ตามสัญญา */
  readonly selection?: Record<string, unknown>;
};

/**
 * ฟอร์มเริ่มจากกติกา version ล่าสุดของชุดข้อสอบที่เลือก — ทุกช่อง prefill ตามจริง
 * (ผู้ใช้เห็นค่าปัจจุบันก่อนแก้ ไม่ใช่ default ที่บังเอิญ) · rules = null (ชุดใหม่
 * ยังไม่มีกติกา) → ค่า default ของ schema
 */
export function formStateForAssessment(
  assessmentId: string,
  rules: AssessmentRulesPrefill | null,
): AssessmentRulesFormState {
  if (rules === null) {
    return { ...ASSESSMENT_RULES_FORM_DEFAULTS, assessmentId };
  }
  return {
    assessmentId,
    passPct: String(rules.passPct),
    timeLimitMinutes: String(rules.timeLimitMinutes),
    questionCount: String(rules.questionCount),
    maxAttempts: String(rules.maxAttempts),
    attemptCooldownMinutes: String(rules.cooldownMinutes),
    shuffleQuestions: rules.shuffleQuestions,
    shuffleOptions: rules.shuffleOptions,
    requireCourseComplete: rules.requireCourseComplete,
    proctoringMode: rules.proctoringMode,
    examReviewMode: rules.examReviewMode,
    selection: rules.selection,
  };
}

/**
 * อ่าน version ที่สร้างสำเร็จจาก response ของ POST .../rules — ตรงสัญญา
 * envelope { data: { version } } (ข้ามชั้น data = เห็น undefined เสมอ) ·
 * คืน null เมื่อ envelope ผิดรูป/ไม่มี version จำนวนเต็มบวก = drift —
 * caller ต้อง fail-closed (ไม่อวดสำเร็จ ไม่ refresh ตามเปล่า)
 */
export function readCreatedRulesVersion(envelope: unknown): number | null {
  const resource = unwrapDataEnvelope(envelope);
  if (resource === null || typeof resource !== "object") {
    return null;
  }
  const version = (resource as { version?: unknown }).version;
  return typeof version === "number" && Number.isInteger(version) && version >= 1
    ? version
    : null;
}

/* ─── state machine การส่งของโมดัล (gate GP3 r2 R2-M1/R2-M2) ─── */

/**
 * แกนสถานะเดียวของโมดัล — แยกจากข้อมูลฟอร์ม (form/fieldErrors/formError) เพื่อให้
 * สถานะ "ผลการบันทึกยังไม่แน่นอน" (uncertainSave) มีที่ยืนและตรวจ pure ได้:
 * - R2-M1: 201 แต่ envelope ผิดสัญญา/network ตาย/5xx หลัง commit = version
 *   "อาจถูกสร้างแล้ว" — ห้ามปล่อยกดบันทึกซ้ำ (RPC max+1 ทุกครั้ง = version ใหม่ทุกครั้ง)
 * - R2-M2: ปิดโมดัลกลาง POST → เปิดใหม่ ต้องได้สถานะสดทุกช่อง (เดิม submitting
 *   ค้าง true เพราะ finally ถูก epoch guard ทิ้ง)
 */
export interface ModalCoreState {
  readonly open: boolean;
  readonly submitting: boolean;
  readonly uncertainSave: boolean;
  readonly successVersion: number | null;
}

/** สถานะปิด = จุดเริ่มและจุดจบของทุกการเปิด (ไม่มีอะไรค้างข้ามการปิด) */
export const MODAL_CORE_CLOSED: ModalCoreState = {
  open: false,
  submitting: false,
  uncertainSave: false,
  successVersion: null,
};

export type ModalCoreEvent =
  | { readonly kind: "open" }
  | { readonly kind: "close" }
  | { readonly kind: "submit_start" }
  | { readonly kind: "outcome_success"; readonly version: number }
  | { readonly kind: "outcome_uncertain" }
  | { readonly kind: "outcome_error" }
  | { readonly kind: "outcome_resolved" };

/**
 * สถานะถัดไปของโมดัล — pure · event ที่ไม่ผ่าน guard = คืน state เดิม (idempotent):
 * - open/close → สถานะสดเสมอ (close รีเซ็ต submitting ด้วย — R2-M2)
 * - submit_start ยอมเฉพาะ open และยังไม่ส่ง/ไม่ uncertain/ยังไม่สำเร็จ (R2-M1)
 * - outcome_* ยอมเฉพาะตอน submitting (response เก่าหลัง close ถูกทิ้งเงียบ ๆ)
 */
export function nextModalCoreState(
  state: ModalCoreState,
  event: ModalCoreEvent,
): ModalCoreState {
  switch (event.kind) {
    case "open":
      return { ...MODAL_CORE_CLOSED, open: true };
    case "close":
      return MODAL_CORE_CLOSED;
    case "submit_start":
      if (!state.open || state.submitting || state.uncertainSave || state.successVersion !== null) {
        return state;
      }
      return { ...state, submitting: true };
    case "outcome_success":
      if (!state.submitting) {
        return state;
      }
      return { open: true, submitting: false, uncertainSave: false, successVersion: event.version };
    case "outcome_uncertain":
      if (!state.submitting) {
        return state;
      }
      return { open: true, submitting: false, uncertainSave: true, successVersion: null };
    case "outcome_error":
      if (!state.submitting) {
        return state;
      }
      return { open: true, submitting: false, uncertainSave: false, successVersion: null };
    case "outcome_resolved":
      // R3-M1: ทางออกเดียวจาก uncertain คือ "การตรวจกับเซิร์ฟเวอร์เสร็จจริง" —
      // ไม่มี event ไหนปลดล็อก uncertainSave ด้วยการเดาว่า commit ไปแล้ว/ไม่ไป
      if (!state.uncertainSave) {
        return state;
      }
      return { open: true, submitting: false, uncertainSave: false, successVersion: null };
  }
}

/** ผลลัพธ์ gate ของปุ่มยืนยัน — disabled พร้อมเหตุผลไทย (แสดงเป็น confirmDisabledReason) */
export interface ModalConfirmGate {
  readonly disabled: boolean;
  readonly reason?: string;
}

/**
 * ปุ่มยืนยันถูกล็อกเมื่อ: กำลังส่ง หรือ ผลยังไม่แน่นอน (R2-M1 — กัน version ซ้ำ) ·
 * โหมดสำเร็จ (successVersion ≠ null) ปลดล็อกเพราะปุ่มกลายเป็น "กลับไปยังรายการ"
 */
export function confirmGateOf(core: ModalCoreState): ModalConfirmGate {
  if (core.submitting) {
    return { disabled: true, reason: "กำลังบันทึก กรุณารอสักครู่" };
  }
  if (core.uncertainSave) {
    return {
      disabled: true,
      reason:
        "ผลการบันทึกยังไม่แน่นอน — กรุณาตรวจสอบ version ล่าสุดในตารางก่อน เพื่อป้องกันการสร้าง version ซ้ำ",
    };
  }
  return { disabled: false };
}

/**
 * gate รวมของปุ่ม/submit สี่ชั้น — ใช้ที่เดียวกันทั้ง render และ handleSubmit:
 * (0) มี POST กติกาของชุดนี้กำลังส่งอยู่ (R4-M2 — in-flight รอดการปิดโมดัล) → ล็อก
 * (1) registry มีรายการ "ผลยังไม่แน่นอน" ของชุดที่เลือก (R3-M1) → ล็อก
 * (2) กำลังตรวจ read-back ของชุดนั้นอยู่ → ล็อก + เหตุผลรอ
 * (3) แกนเดิม confirmGateOf (submitting/uncertainSave/success)
 */
export function submitBlockedGate(
  core: ModalCoreState,
  assessmentId: string,
  resolvingId: string | null,
  registry: UnresolvedRulesRegistry,
): ModalConfirmGate {
  if (assessmentId !== "") {
    if (registry.isInFlight(assessmentId)) {
      return {
        disabled: true,
        reason: "การบันทึกกติกาของชุดนี้ยังไม่เสร็จ (คำขอกำลังส่งอยู่) — กรุณารอให้ระบบตอบก่อน",
      };
    }
    const unresolved = registry.peek(assessmentId);
    if (unresolved !== undefined) {
      return resolvingId === assessmentId
        ? { disabled: true, reason: "กำลังตรวจสอบผลการบันทึกครั้งก่อนกับเซิร์ฟเวอร์ กรุณารอสักครู่" }
        : {
            disabled: true,
            reason:
              "ชุดข้อสอบนี้มีผลการบันทึกที่ยังไม่ได้ยืนยัน — กด 'ตรวจสอบอีกครั้ง' เพื่อตรวจกับเซิร์ฟเวอร์ก่อนจึงจะบันทึกได้",
          };
    }
    if (resolvingId !== null) {
      // resolving ของชุดอื่น (เพิ่งสลับเลือก) — ไม่ล็อกชุดปัจจุบัน
      return confirmGateOf(core);
    }
  }
  return confirmGateOf(core);
}

/**
 * error ที่ "แน่ใจว่าไม่มี version ถูกสร้าง" = BFF ตอบ 4xx กลับมาจริง (validation/
 * RBAC/ไม่พบ) — แก้ฟอร์มแล้วส่งใหม่ได้ · อื่น (network ตายก่อนมี response · 5xx
 * เช่น 503 assessment_rule_rpc_row_drift ที่ RPC commit สำเร็จแล้วแต่แถวที่คืนไม่ผ่าน
 * strict parse) = ผลยังไม่แน่นอน → ต้องเข้าสถานะ uncertainSave (R2-M1)
 */
export function isDefinitiveRejection(error: unknown): boolean {
  return error instanceof AdminApiError && error.status >= 400 && error.status < 500;
}

/* ─── R3-M1 (gate GP3 r3): สถานะ unresolved ต้องรอดข้ามการปิดโมดัล ─── */

/**
 * รายการ "ผลการบันทึกยังไม่แน่นอน" ของแต่ละชุดข้อสอบ — อยู่นอก component state
 * (module-level singleton) เพราะปิดโมดัล/ปิด-เปิดใหม่ต้องไม่ทำให้สถานะนี้หาย:
 * ปุ่มบันทึกของชุดข้อสอบนั้นถูกล็อกจนกว่าการตรวจกับเซิร์ฟเวอร์ (read-back) จะเสร็จจริง
 * · knownVersionAtSend = version ล่าสุดที่ผู้ใช้เห็น "ตอนกดส่ง" (จาก props ของหน้า —
 *   null = ชุดยังไม่มีกติกา) ใช้เป็นฐานเทียบตอน read-back
 */
export interface UnresolvedRulesEntry {
  readonly assessmentId: string;
  readonly knownVersionAtSend: number | null;
  readonly registeredAt: number;
}

export class UnresolvedRulesRegistry {
  private readonly entries = new Map<string, UnresolvedRulesEntry>();

  /** R4-M2: ชุดข้อสอบที่มี POST กติกากำลังส่งอยู่ — มีชีวิตข้ามการปิดโมดัลเหมือน entries */
  private readonly inFlight = new Set<string>();

  /** R5-M1: ผู้ฟังการเปลี่ยนแปลง — โมดัลที่เปิดอยู่สมัครรับเพื่อรับรู้ผล deferred ของ POST */
  private readonly listeners = new Set<() => void>();

  /** R5-M1: เลขก้าวของการเปลี่ยนแปลง — snapshot เสถียรระหว่างการเปลี่ยน (useSyncExternalStore) */
  private mutationVersion = 0;

  register(assessmentId: string, knownVersionAtSend: number | null): void {
    // เขียนทับได้ (idempotent) — จริง ๆ เกิดไม่ได้เพราะมี entry = ปุ่มถูกล็อก ส่งซ้ำไม่ได้
    this.entries.set(assessmentId, {
      assessmentId,
      knownVersionAtSend,
      registeredAt: Date.now(),
    });
    this.notify();
  }

  peek(assessmentId: string): UnresolvedRulesEntry | undefined {
    return this.entries.get(assessmentId);
  }

  /** ปลดสถานะ — เรียกเฉพาะเมื่อการตรวจกับเซิร์ฟเวอร์เสร็จสมบูรณ์ */
  resolve(assessmentId: string): void {
    this.entries.delete(assessmentId);
    this.notify();
  }

  /** R4-M2: จดว่าคำขอ POST ของชุดนี้กำลังส่งอยู่ — เรียกก่อน await ของทุกการส่ง */
  markInFlight(assessmentId: string): void {
    this.inFlight.add(assessmentId);
    this.notify();
  }

  /** R4-M2: คำขอเสร็จ (ทุกผล) — ปลดสถานะ in-flight เพื่อให้ gate ตัดสินจาก entries ต่อ */
  clearInFlight(assessmentId: string): void {
    this.inFlight.delete(assessmentId);
    this.notify();
  }

  isInFlight(assessmentId: string): boolean {
    return this.inFlight.has(assessmentId);
  }

  /** สำหรับ test เท่านั้น */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.notify();
  }

  /** R5-M1: สมัครรับการแจ้งเตือนการเปลี่ยนแปลง — คืนฟังก์ชันถอนการสมัคร (unmount) */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** R5-M1: snapshot ปัจจุบันของการเปลี่ยนแปลง — ใช้กับ useSyncExternalStore */
  version(): number {
    return this.mutationVersion;
  }

  private notify(): void {
    this.mutationVersion += 1;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** singleton ของหน้า — อยู่ตลอดอายุของ module (รอดการปิดโมดัล/รี-เมานต์ของ component) */
export const unresolvedRulesRegistry = new UnresolvedRulesRegistry();

/** R5-M1: subscribe/getSnapshot เสถียร (identity คงที่ข้าม render — ไม่ resubscribe ทุกเรนเดอร์) */
const subscribeRulesRegistry = (onChange: () => void): (() => void) =>
  unresolvedRulesRegistry.subscribe(onChange);
const getRulesRegistryVersion = (): number => unresolvedRulesRegistry.version();

/**
 * ตัดสินผลของการบันทึกที่ค้าง "ไม่แน่นอน" จาก version ล่าสุดจริงบนเซิร์ฟเวอร์ — pure:
 * - no_rules บนเซิร์ฟเวอร์ = แน่ใจว่าไม่มี version ใหม่ถูกสร้าง → not_committed
 * - เทียบกับ version ที่คาดหลังส่ง (knownVersionAtSend + 1):
 *   - ตรง = การบันทึกของเราเองสำเร็จ (committed_expected)
 *   - สูงกว่า = มี version ใหม่กว่าที่เราเห็นตอนส่ง (ของเราหรือของคนอื่น — ไม่มี request
 *     identity แยกไม่ได้ จึง prefill จากของจริงบนเซิร์ฟเวอร์เสมอ) → committed_newer
 *   - ต่ำกว่า/เท่ากับ known = ไม่มี version ใหม่ → not_committed
 */
export type UnsavedRulesResolution = "committed_expected" | "committed_newer" | "not_committed";

export function resolveUnsavedRulesOutcome(
  knownVersionAtSend: number | null,
  serverLatestVersion: number | null,
): UnsavedRulesResolution {
  if (serverLatestVersion === null) {
    return "not_committed";
  }
  const expected = (knownVersionAtSend ?? 0) + 1;
  if (serverLatestVersion === expected) {
    return "committed_expected";
  }
  return serverLatestVersion > expected ? "committed_newer" : "not_committed";
}

/** ผลการอ่านกลับจาก GET /admin/assessments?id=… — unreadable = อ่านไม่ได้/ผิดรูป (fail-closed) */
export type RulesReadBack =
  | { readonly kind: "no_rules" }
  | { readonly kind: "rules"; readonly version: number; readonly prefill: AssessmentRulesPrefill }
  | { readonly kind: "unreadable" };

/**
 * แปลง envelope ของ GET /admin/assessments?id=<uuid> (data แถวเดียว · rules nullable)
 * เป็นข้อมูลที่ใช้ตัดสินผล — ตรวจชนิดทุกฟิลด์ของ rules ตาม AssessmentRuleSummary
 * (admin-exam.ts) ก่อนเชื่อ: ผิดสักฟิลด์ = unreadable ไม่ปล่อย prefill เพี้ยนเข้าฟอร์ม
 */
export function parseRulesReadBack(envelope: unknown): RulesReadBack {
  const data = unwrapDataEnvelope(envelope);
  if (!Array.isArray(data) || data.length === 0) {
    return { kind: "unreadable" };
  }
  const row = data[0];
  if (typeof row !== "object" || row === null) {
    return { kind: "unreadable" };
  }
  const rules = (row as { rules?: unknown }).rules;
  if (rules === null) {
    return { kind: "no_rules" };
  }
  if (typeof rules !== "object") {
    return { kind: "unreadable" };
  }
  const r = rules as Record<string, unknown>;
  const isInt = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value);
  const isBool = (value: unknown): value is boolean => typeof value === "boolean";
  if (
    !isInt(r["version"]) ||
    (r["version"] as number) < 1 ||
    !isInt(r["passPct"]) ||
    !isInt(r["timeLimitMinutes"]) ||
    !isInt(r["questionCount"]) ||
    !isInt(r["maxAttempts"]) ||
    !isInt(r["cooldownMinutes"]) ||
    !isBool(r["shuffleQuestions"]) ||
    !isBool(r["shuffleOptions"]) ||
    !isBool(r["requireCourseComplete"]) ||
    typeof r["selection"] !== "object" ||
    r["selection"] === null ||
    Array.isArray(r["selection"]) ||
    (r["proctoringMode"] !== "none" && r["proctoringMode"] !== "basic") ||
    (r["examReviewMode"] !== "after_final_attempt" && r["examReviewMode"] !== "never")
  ) {
    return { kind: "unreadable" };
  }
  const selection = r["selection"] as Record<string, unknown>;
  return {
    kind: "rules",
    version: r["version"] as number,
    prefill: {
      version: r["version"] as number,
      timeLimitMinutes: r["timeLimitMinutes"] as number,
      questionCount: r["questionCount"] as number,
      passPct: r["passPct"] as number,
      maxAttempts: r["maxAttempts"] as number,
      cooldownMinutes: r["cooldownMinutes"] as number,
      shuffleQuestions: r["shuffleQuestions"] as boolean,
      shuffleOptions: r["shuffleOptions"] as boolean,
      requireCourseComplete: r["requireCourseComplete"] as boolean,
      selection,
      proctoringMode: r["proctoringMode"] as ExamAdminProctoringMode,
      examReviewMode: r["examReviewMode"] as ExamAdminExamReviewMode,
    },
  };
}

/**
 * การตัดสินจากผลอ่านกลับ (R4-M1) — pure ที่ startResolution ใช้จริง:
 * unreadable = fail_closed (คงรายการ + คงล็อก + ปุ่ม "ตรวจสอบอีกครั้ง") ห้าม resolve —
 * "อ่านความจริงจากเซิร์ฟเวอร์ไม่ได้" ไม่ใช่ "ไม่มีกติกาใหม่" · prefill null = no_rules
 * (อ่านได้จริงและแน่ใจว่าไม่มีกติกา) เท่านั้นที่ปลดล็อกให้บันทึกใหม่ได้
 */
export type ReadBackDecision =
  | { readonly action: "fail_closed" }
  | { readonly action: "resolve"; readonly prefill: AssessmentRulesPrefill | null };

export function decisionForReadBack(readBack: RulesReadBack): ReadBackDecision {
  if (readBack.kind === "unreadable") {
    return { action: "fail_closed" };
  }
  return { action: "resolve", prefill: readBack.kind === "rules" ? readBack.prefill : null };
}

/** ผลของ POST กติกาแบ่งสามทาง (R4-M2) — ใช้ตัดสิน registry ไม่สน epoch ของ UI */
export type RulesPostOutcome =
  | { readonly kind: "committed"; readonly version: number }
  | { readonly kind: "definitely_not_committed" }
  | { readonly kind: "uncertain" };

/**
 * การจัดการผล POST ที่อาจมาถึงหลังโมดัลปิด/เปิดใหม่ (epoch ไม่ตรง) — pure:
 * - registry จัดการทุกกรณีแม้ UI ไปแล้ว: uncertain → keep_locked (ลงทะเบียนรอ
 *   read-back) · committed/definitely_not_committed → resolve (รู้ความจริงแล้ว
 *   จากตัว response เอง ไม่ต้องเดา) — ปิดช่อง r4 ที่ "ปิดกลาง POST → เปิดใหม่ →
 *   ส่งซ้ำได้ เพราะผลที่มาช้าถูก epoch guard ทิ้งก่อนลงทะเบียน"
 * - ui = apply เฉพาะเมื่อ epoch ตรง — เขียน state ของฟอร์มด้วยผลรอบเก่าห้ามเด็ดขาด
 */
export function deferredOutcomeHandling(
  outcome: RulesPostOutcome,
  epochMatches: boolean,
): { readonly registry: "resolve" | "keep_locked"; readonly ui: "apply" | "discard" } {
  return {
    registry: outcome.kind === "uncertain" ? "keep_locked" : "resolve",
    ui: epochMatches ? "apply" : "discard",
  };
}

/**
 * R5-M1 (gate GP3 r5): ตัดสินว่าโมดัลที่เปิดอยู่ "ตอบสนองอะไร" ต่อสถานะ registry
 * ปัจจุบัน — pure ที่ effect กลางของโมดัลใช้จริง (ผู้ฟัง subscription):
 * - start_read_back: ชุดที่เลือกอยู่มีรายการ "ผลยังไม่แน่นอน" + ไม่มีคำขอค้าง +
 *   ไม่กำลังตรวจอยู่ + ไม่มี notice รอผู้ใช้กด retry → เริ่ม read-back เอง
 *   (ปิดช่อง r5: ผล deferred มาถึงหลังเปิดโมดัลใหม่ ผู้ใช้เห็นข้อความให้
 *   "ตรวจสอบอีกครั้ง" แต่ไม่มีปุ่ม และไม่มีใครเริ่มตรวจ)
 * - none: ทุกกรณีอื่น — รวม retryNoticeVisible (ห้ามวนตรวจอัตโนมัติไปเรื่อย ๆ ตอน
 *   เซิร์ฟเวิร์งล้ม: รอผู้ใช้กดปุ่มเอง) · effect รันรอบแรกตอน mount ด้วย → remount
 *   เจอ entry เก่าที่ค้างก็ตัดสินชุดเดียวกันนี้ (reconcile ตอนเริ่มโมดัลใหม่)
 */
export interface DeferredRegistryReactionInput {
  readonly open: boolean;
  readonly assessmentId: string;
  readonly resolvingId: string | null;
  readonly retryNoticeVisible: boolean;
  readonly registry: UnresolvedRulesRegistry;
}
export type DeferredRegistryReaction =
  | { readonly kind: "start_read_back" }
  | { readonly kind: "none" };

export function deferredRegistryReaction(
  input: DeferredRegistryReactionInput,
): DeferredRegistryReaction {
  if (!input.open) {
    return { kind: "none" };
  }
  if (input.assessmentId === "") {
    return { kind: "none" };
  }
  if (input.registry.isInFlight(input.assessmentId)) {
    return { kind: "none" };
  }
  if (input.registry.peek(input.assessmentId) === undefined) {
    return { kind: "none" };
  }
  if (input.resolvingId === input.assessmentId) {
    return { kind: "none" };
  }
  if (input.retryNoticeVisible) {
    return { kind: "none" };
  }
  return { kind: "start_read_back" };
}

/**
 * R5-M1 (gate GP3 r5): หางจริงของ callback POST (เรียกจาก handleSubmit) — แหล่งเดียว
 * ของการเปลี่ยน registry + refresh หน้าหลังคำขอจบ **ทุกผล รวม definitive rejection**
 * (เดิม 400 ไม่ refresh และไม่มี state update ใด หน้าเลยค้างล็อก "ยังไม่เสร็จ" จน
 * เกิด render จากเหตุอื่น) · notify ของ registry ปลุกโมดัลที่เปิดอยู่ให้ตัดสินใหม่
 * ผ่าน deferredRegistryReaction — คืน ui: apply|discard ตาม epoch ให้ผู้เรียก
 * นำไปเขียน state ของฟอร์มต่อ
 */
export interface ApplyDeferredRulesOutcomeParams {
  readonly assessmentId: string;
  readonly knownVersionAtSend: number | null;
  readonly outcome: RulesPostOutcome;
  readonly epochMatches: boolean;
  readonly registry: UnresolvedRulesRegistry;
  readonly refresh: () => void;
}

export function applyDeferredRulesOutcome(
  params: ApplyDeferredRulesOutcomeParams,
): { readonly ui: "apply" | "discard" } {
  const handling = deferredOutcomeHandling(params.outcome, params.epochMatches);
  params.registry.clearInFlight(params.assessmentId);
  if (handling.registry === "keep_locked") {
    params.registry.register(params.assessmentId, params.knownVersionAtSend);
  } else {
    params.registry.resolve(params.assessmentId);
  }
  params.refresh();
  return { ui: handling.ui };
}

/** ตรวจความถูกต้องของตัวเลข — คืน number ที่ผ่านช่วง หรือ null (ยังไม่กรอก/ผิด) */
function intInRange(value: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** ขอบเขตตัวเลข mirror zod ขาเข้าของ route จริง (admin-exam.ts) — แสดงเป็นข้อความไทยก่อนยิง */
const PASS_PCT_RANGE = { min: 1, max: 100 };
const TIME_LIMIT_RANGE = { min: 5, max: 480 };
const QUESTION_COUNT_RANGE = { min: 1, max: 1000 };
const MAX_ATTEMPTS_RANGE = { min: 1, max: 100 };
const COOLDOWN_RANGE = { min: 0, max: 525600 };

/** ข้อผิดพลาดตรวจฟอร์ม — key = ชื่อช่องใน AssessmentRulesFormState, value = ข้อความไทย */
export type AssessmentRulesFormErrors = Readonly<Record<string, string>>;

/**
 * ตรวจฟอร์มทั้งหมด — คืนข้อผิดพลาดภาษาไทยต่อช่อง (ว่าง = ผ่านทุกช่อง)
 * mirror เงื่อนไข zod ของ AssessmentRuleInput เป๊ะ เพื่อให้ผู้ใช้เห็นปัญหาก่อนยิง request —
 * ฝั่ง BFF ยังตรวจซ้ำเสมอ (client validation ไม่ใช่ชั้นความปลอดภัย)
 */
export function validateAssessmentRulesForm(state: AssessmentRulesFormState): AssessmentRulesFormErrors {
  const errors: Record<string, string> = {};
  if (state.assessmentId.trim().length === 0) {
    errors["assessmentId"] = "กรุณาเลือกชุดข้อสอบ";
  }
  const passPct = intInRange(state.passPct, PASS_PCT_RANGE.min, PASS_PCT_RANGE.max);
  if (passPct === null) {
    errors["passPct"] = `เกณฑ์ผ่านต้องเป็นตัวเลข ${PASS_PCT_RANGE.min}-${PASS_PCT_RANGE.max}`;
  }
  const timeLimit = intInRange(
    state.timeLimitMinutes,
    TIME_LIMIT_RANGE.min,
    TIME_LIMIT_RANGE.max,
  );
  if (timeLimit === null) {
    errors["timeLimitMinutes"] =
      `เวลาทำข้อสอบต้องเป็นตัวเลข ${TIME_LIMIT_RANGE.min}-${TIME_LIMIT_RANGE.max} นาที`;
  }
  const questionCount = intInRange(
    state.questionCount,
    QUESTION_COUNT_RANGE.min,
    QUESTION_COUNT_RANGE.max,
  );
  if (questionCount === null) {
    errors["questionCount"] =
      `จำนวนข้อสอบต้องเป็นตัวเลข ${QUESTION_COUNT_RANGE.min}-${QUESTION_COUNT_RANGE.max}`;
  }
  const maxAttempts = intInRange(
    state.maxAttempts,
    MAX_ATTEMPTS_RANGE.min,
    MAX_ATTEMPTS_RANGE.max,
  );
  if (maxAttempts === null) {
    errors["maxAttempts"] =
      `จำนวนครั้งที่สอบได้ต้องเป็นตัวเลข ${MAX_ATTEMPTS_RANGE.min}-${MAX_ATTEMPTS_RANGE.max}`;
  }
  const cooldown = intInRange(
    state.attemptCooldownMinutes,
    COOLDOWN_RANGE.min,
    COOLDOWN_RANGE.max,
  );
  if (cooldown === null) {
    errors["attemptCooldownMinutes"] =
      `ระยะพักก่อนสอบซ้ำต้องเป็นตัวเลข ${COOLDOWN_RANGE.min}-${COOLDOWN_RANGE.max} นาที`;
  }
  return errors;
}

/**
 * ประกอบ body ของ POST .../rules จากฟอร์ม — คืน { ok, body } เมื่อผ่านทุกช่อง หรือ
 * { ok: false, errors } เมื่อไม่ผ่าน · ห้ามส่ง undefined ตรง ๆ (schema .strict())
 */
export function buildAssessmentRuleVersionBody(
  state: AssessmentRulesFormState,
): { ok: true; body: AssessmentRuleVersionBody } | { ok: false; errors: AssessmentRulesFormErrors } {
  const errors = validateAssessmentRulesForm(state);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const body: AssessmentRuleVersionBody = {
    timeLimitMinutes: intInRange(
      state.timeLimitMinutes,
      TIME_LIMIT_RANGE.min,
      TIME_LIMIT_RANGE.max,
    ) as number,
    questionCount: intInRange(
      state.questionCount,
      QUESTION_COUNT_RANGE.min,
      QUESTION_COUNT_RANGE.max,
    ) as number,
    passPct: intInRange(state.passPct, PASS_PCT_RANGE.min, PASS_PCT_RANGE.max) as number,
    maxAttempts: intInRange(
      state.maxAttempts,
      MAX_ATTEMPTS_RANGE.min,
      MAX_ATTEMPTS_RANGE.max,
    ) as number,
    attemptCooldownMinutes: intInRange(
      state.attemptCooldownMinutes,
      COOLDOWN_RANGE.min,
      COOLDOWN_RANGE.max,
    ) as number,
    shuffleQuestions: state.shuffleQuestions,
    shuffleOptions: state.shuffleOptions,
    requireCourseComplete: state.requireCourseComplete,
    proctoringMode: state.proctoringMode,
    examReviewMode: state.examReviewMode,
    // ขอบเขตคลังเดิมส่งต่อเป๊ะ (ไม่แนบ = RPC เขียน '{}' ทับ) · null ได้เฉพาะชุด
    // ยังไม่มีกติกา — กรณีนั้นไม่แนบคีย์ให้ RPC ใช้ default ตามสัญญา
    ...(state.selection !== null ? { selection: state.selection } : {}),
  };
  return { ok: true, body };
}

/* ─── component — ปุ่มเปิด + โมดัลฟอร์ม (client) ─── */

const ASSESSMENT_RULES_PATH = "/api/v1/admin/assessments";

/** ช่องกรอกมาตรฐานของฟอร์ม — label + ช่อง + ข้อความผิดพลาดใต้ช่อง (เหมือน AssessmentFormModal) */
function FieldRow({
  label,
  error,
  children,
}: {
  readonly label: string;
  readonly error?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-heading text-sm font-semibold text-ink-900">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-sm text-red-600">{error}</span> : null}
    </label>
  );
}

const INPUT_CLASS =
  "w-full rounded-[10px] border border-mist-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none";

export interface AssessmentRulesVersionModalProps {
  /** ตัวเลือกชุดข้อสอบ — หน้า RSC ส่งมาจากแถวตาราง (id + ป้าย + version ล่าสุด) */
  readonly assessmentOptions: readonly AssessmentOption[];
  /** มีสิทธิ์เขียนกติกา (ar_write — staff:exam/super_admin) — false = ไม่แสดงปุ่ม/ฟอร์มเลย */
  readonly allowRules: boolean;
}

/**
 * ปุ่ม "เพิ่มกติกา version ใหม่" + โมดัลฟอร์ม — บันทึกสำเร็จแสดง version ที่ได้จาก BFF
 * (version = max+1 server-side) แล้ว refresh ตารางให้สรุปกติกาล่าสุดสะท้อน
 */
export function AssessmentRulesVersionModal({
  assessmentOptions,
  allowRules,
}: AssessmentRulesVersionModalProps) {
  const router = useRouter();
  // แกนเดียวของ open/submitting/uncertainSave/successVersion — ทุก transition ผ่าน
  // nextModalCoreState (R2-M1/R2-M2 ดู docstring ของ ModalCoreState)
  const [core, setCore] = useState<ModalCoreState>(MODAL_CORE_CLOSED);
  const [form, setForm] = useState<AssessmentRulesFormState>(ASSESSMENT_RULES_FORM_DEFAULTS);
  const [fieldErrors, setFieldErrors] = useState<AssessmentRulesFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [apiFieldLabels, setApiFieldLabels] = useState<readonly string[]>([]);
  /**
   * ยุคของ request ปัจจุบัน — บั๊ก M3: ปิดโมดัล (ยกเลิก/ปิดหลัง/Escape) ระหว่าง POST
   * ค้างอยู่ แล้วเปิดใหม่ = response เก่าไหลเขียน state ของฟอร์มใหม่ · ทุกการปิด/เปิด
   * ใหม่ bump ค่านี้ — response ของยุคก่อนเห็นค่าไม่ตรงจึงทิ้งผลลัพธ์ทิ้งทั้งหมด
   */
  const requestEpochRef = useRef(0);
  /**
   * R3-M1: สถานะการตรวจสอบ read-back — resolvingId = ชุดข้อสอบที่กำลังอ่านกลับจาก
   * เซิร์ฟเวอร์ (ฟอร์ม+ปุ่มล็อกระหว่างนี้) · resolveNotice = ผลตรวจที่เสร็จแล้ว
   * (tone ok/warn + ปุ่ม retry เมื่อตรวจไม่สำเร็จและยังล็อกอยู่)
   */
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveNotice, setResolveNotice] = useState<{
    readonly tone: "ok" | "warn";
    readonly text: string;
    readonly retry: boolean;
  } | null>(null);
  /**
   * R5-M1: สมัครติดตาม registry — ผล POST ที่มาถึงหลังโมดัลนี้ถูกปิด/เปิดใหม่ (epoch
   * ไม่ตรง) เปลี่ยน registry กลางอากาศ โมดัลที่เปิดอยู่ต้องรับรู้แล้วตัดสินใหม่:
   * uncertain ค้าง → เริ่ม read-back เอง (มิฉะนั้นผู้ใช้เห็นข้อความให้ "ตรวจสอบอีกครั้ง"
   * แต่ไร้ปุ่ม) · definitive rejection → ปลดล็อก gate ที่ค้าง "ยังไม่เสร็จ" ·
   * startResolution ผ่าน ref (ประกาศหลัง early-return ไม่ได้ — กัน TDZ ของ deps)
   */
  const registryVersion = useSyncExternalStore(subscribeRulesRegistry, getRulesRegistryVersion);
  const startResolutionRef = useRef<((assessmentId: string) => void) | null>(null);
  const retryNoticeVisible = resolveNotice !== null && resolveNotice.retry;
  useEffect(() => {
    const reaction = deferredRegistryReaction({
      open: core.open,
      assessmentId: form.assessmentId,
      resolvingId,
      retryNoticeVisible,
      registry: unresolvedRulesRegistry,
    });
    if (reaction.kind === "start_read_back") {
      startResolutionRef.current?.(form.assessmentId);
    }
  }, [registryVersion, core.open, form.assessmentId, resolvingId, retryNoticeVisible]);

  if (!allowRules) {
    return null;
  }

  const update = <K extends keyof AssessmentRulesFormState>(
    key: K,
    value: AssessmentRulesFormState[K],
  ) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  /** เลือกชุดข้อสอบ = รีเซ็ตฟอร์มทั้งแบบ prefill จากกติกา version ล่าสุดของชุดนั้น */
  const selectAssessment = (assessmentId: string) => {
    const option = assessmentOptions.find((item) => item.id === assessmentId);
    setForm(formStateForAssessment(assessmentId, option?.currentRules ?? null));
    setFieldErrors({});
    setResolveNotice(null);
    // R3-M1→R5-M1: ชุดที่ค้าง "ผลยังไม่แน่นอน" — ล็อกไว้ แล้วให้ effect กลาง (ที่ฟัง
    // registry ผ่าน subscription) เป็นผู้เริ่ม read-back ทางเดียว: ครอบทั้งเลือกชุด
    // ใหม่ · เลือกซ้ำชุดเดิม · ผล deferred มาถึงหลังเปิดใหม่ — ตัดสินจากเซิร์ฟเวิร์ง
    // เท่านั้น (การเรียกตรงที่นี่ซ้ำซ้อนกับ effect และเดินสองทางพร้อมกัน)
  };

  const closeAndReset = () => {
    requestEpochRef.current += 1; // ฆ่า response ที่ยังค้างของฟอร์มเก่าทันที
    // close = สถานะสดทุกช่องรวม submitting (R2-M2 — เดิม finally ถูก epoch guard
    // ทิ้งจน submitting ค้าง true หลังปิดกลาง POST แล้วเปิดใหม่)
    setCore((previous) => nextModalCoreState(previous, { kind: "close" }));
    setForm(ASSESSMENT_RULES_FORM_DEFAULTS);
    setFieldErrors({});
    setFormError(null);
    setApiFieldLabels([]);
    // read-back ที่ยังลอยอยู่ตายพร้อม epoch — registry entry คงอยู่ต่อ (R3-M1: สถานะ
    // unresolved รอดการปิดโมดัล — เปิดใหม่แล้วเลือกชุดเดิม = ตรวจก่อนปลดล็อกเสมอ)
    setResolvingId(null);
    setResolveNotice(null);
  };

  /** จุดเดียวที่ map error ของ BFF → ข้อความไทย — ดู error.code ก่อน status (403 มีสองสาเหตุ) */
  const showApiError = (error: unknown) => {
    if (error instanceof AdminApiError && error.code === "ERR-VAL-001") {
      setFormError("กรุณาตรวจสอบข้อมูลตามรายการต่อไปนี้");
      setApiFieldLabels(validationFieldLabels(error.fields));
      return;
    }
    if (error instanceof AdminApiError && error.status === 404) {
      setFormError("ไม่พบชุดข้อสอบที่เลือก (อาจถูกลบไปแล้ว) — ERR-NF-001");
      return;
    }
    if (error instanceof AdminApiError && error.code === "ERR-AUTH-004") {
      setFormError(
        "ต้องยืนยันตัวตนด้วย MFA (AAL2) ก่อนแก้ไขกติกาข้อสอบ — กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่พร้อม MFA (ERR-AUTH-004)",
      );
      return;
    }
    if (error instanceof AdminApiError && error.code === "ERR-RBAC-001") {
      setFormError("คุณไม่มีสิทธิ์ดำเนินการนี้ — ติดต่อผู้ดูแลระบบหากถือว่าผิดพลาด (ERR-RBAC-001)");
      return;
    }
    if (error instanceof AdminApiError && error.status === 403) {
      // 403 ที่ไม่ใช่ AUTH-004/RBAC-001 ตาม code — อย่าเดาสาเหตุ แสดงตามข้อความ BFF
      setFormError(error.message);
      return;
    }
    if (error instanceof AdminApiError) {
      setFormError(error.message);
      return;
    }
    setFormError(TRANSPORT_FALLBACK_MESSAGE);
  };

  /**
   * R3-M1: อ่านกลับจากเซิร์ฟเวอร์ (GET /admin/assessments?id=… · no-store) เพื่อตัดสินผล
   * ที่ค้าง "ไม่แน่นอน" ของ assessmentId — เรียกจาก (1) selectAssessment เมื่อ registry
   * มีรายการของชุดนั้น (รวมกรณีปิดโมดัลกลางคันแล้วเปิดใหม่) และ (2) ทันทีที่เข้าสถานะ
   * uncertainSave · ผลลัพธ์ผูกกับการเสร็จจริงของการตรวจเท่านั้น:
   * - สำเร็จ (ไม่ว่าตัดสินอย่างไร) → registry.resolve + ปลดล็อก (outcome_resolved)
   * - อ่านไม่ได้ทุกกรณี (network/ไม่ ok/ผิดรูป) → **คงรายการ + คงล็อก fail-closed**
   *   พร้อมปุ่ม "ตรวจสอบอีกครั้ง"
   * · epoch เดียวกับ request (bump ทุกปิด/เลือกใหม่ผ่าน closeAndReset) — read-back
   * ของรอบเก่าห้ามเขียน state ของฟอร์มใหม่
   */
  const startResolution = (assessmentId: string) => {
    const entry = unresolvedRulesRegistry.peek(assessmentId);
    if (entry === undefined) {
      return;
    }
    if (unresolvedRulesRegistry.isInFlight(assessmentId)) {
      // R4-M2: POST ของชุดนี้ยังค้างอยู่ — read-back ตอนนี้แข่งกับคำขอที่ยังไม่ตอบ
      // (อ่านก่อน commit แล้วตอบ not_committed = ปลดล็อกให้ส่งซ้ำ) จึงไม่ตรวจจนกว่า
      // คำขอจะเสร็จ: ผล uncertain ของคำขอนั้นเป็นผู้เรียกเราอีกครั้งเอง
      return;
    }
    setResolvingId(assessmentId);
    setResolveNotice(null);
    const epoch = requestEpochRef.current;
    const failClosed = () => {
      setResolvingId(null);
      setResolveNotice({
        tone: "warn",
        text: "ตรวจสอบกับเซิร์ฟเวอร์ไม่สำเร็จ (เครือข่ายหรือระบบไม่พร้อม) — ปุ่มบันทึกยังถูกล็อกจนกว่าจะตรวจสอบสำเร็จ เพื่อกันการสร้าง version ซ้ำ",
        retry: true,
      });
    };
    void (async () => {
      let envelope: unknown;
      try {
        const response = await fetch(
          `${ASSESSMENT_RULES_PATH}?id=${encodeURIComponent(assessmentId)}`,
          { headers: { accept: "application/json" }, cache: "no-store" },
        );
        if (epoch !== requestEpochRef.current) {
          return; // ปิด/เลือกใหม่ไปแล้วระหว่างรอ — ทิ้งผลของรอบเก่า
        }
        if (!response.ok) {
          failClosed();
          return;
        }
        envelope = await response.json();
        if (epoch !== requestEpochRef.current) {
          return;
        }
      } catch {
        if (epoch === requestEpochRef.current) {
          failClosed();
        }
        return;
      }
      const readBack = parseRulesReadBack(envelope);
      // R4-M1: อ่านความจริงไม่ได้ (unreadable) = fail-closed — คงรายการ + คงล็อก +
      // ปุ่ม "ตรวจสอบอีกครั้ง" ห้าม resolve (เดิม resolve ทั้ง unreadable แล้วแจ้ง
      // "ครั้งก่อนไม่สำเร็จ" ทั้งที่ยังไม่รู้ว่า commit ไปแล้วหรือยัง)
      const decision = decisionForReadBack(readBack);
      if (decision.action === "fail_closed") {
        failClosed();
        return;
      }
      const outcome = resolveUnsavedRulesOutcome(
        entry.knownVersionAtSend,
        decision.prefill !== null ? decision.prefill.version : null,
      );
      // ปลดสถานะเฉพาะเมื่อการตรวจ "เสร็จจริง" และอ่านความจริงได้ — ไม่มีทางเดา
      unresolvedRulesRegistry.resolve(assessmentId);
      setResolvingId(null);
      setCore((previous) => nextModalCoreState(previous, { kind: "outcome_resolved" }));
      if (decision.prefill !== null) {
        // prefill จากกติกาจริงบนเซิร์ฟเวอร์ (version ล่าสุดจริง ไม่ใช่ props เก่าของหน้า)
        setForm(formStateForAssessment(assessmentId, decision.prefill));
        setResolveNotice({
          tone: outcome === "committed_expected" ? "ok" : "warn",
          text:
            outcome === "committed_expected"
              ? `ยืนยันกับเซิร์ฟเวอร์แล้ว — การบันทึกกติกา version ${decision.prefill.version} สำเร็จแล้ว (ฟอร์ม prefill จาก version นี้)`
              : `ตรวจพบกติกา version ล่าสุด ${decision.prefill.version} บนเซิร์ฟเวอร์ สูงกว่าที่เห็นตอนบันทึก (อาจเป็นการบันทึกของครั้งนั้นหรือของผู้อื่น) — ฟอร์ม prefill จาก version นี้แล้ว บันทึก version ถัดไปได้`,
          retry: false,
        });
        return;
      }
      setResolveNotice({
        tone: "warn",
        text: "ตรวจสอบกับเซิร์ฟเวอร์แล้ว — ยังไม่พบกติกา version ใหม่ของชุดนี้ (การบันทึกครั้งก่อนไม่สำเร็จ) สามารถบันทึกใหม่ได้",
        retry: false,
      });
    })();
  };
  // R5-M1: มอบ reference ให้ effect กลาง (effect ประกาศก่อน early-return จึงอ่าน
  // ตัวแปรนี้ตรง ๆ ไม่ได้ — ป้องกัน TDZ ของ deps array)
  startResolutionRef.current = startResolution;

  const handleSubmit = async () => {
    setFormError(null);
    setApiFieldLabels([]);
    const built = buildAssessmentRuleVersionBody(form);
    if (!built.ok) {
      setFieldErrors(built.errors);
      return;
    }
    setFieldErrors({});
    // gate เดียวกับปุ่ม — กัน double-click/ส่งซ้ำระหว่างผลยังไม่แน่นอน (R2-M1)
    if (
      submitBlockedGate(core, form.assessmentId, resolvingId, unresolvedRulesRegistry).disabled
    ) {
      return;
    }
    // R3-M1: จำ version ล่าสุดที่ผู้ใช้เห็น "ตอนกดส่ง" — เป็นฐานเทียบตอน read-back
    // (null = ชุดยังไม่มีกติกาตอนส่ง) · R4-M2: จำ id ณ ตอนส่ง — ฟอร์มถูกรีเซ็ตระหว่าง
    // รอได้ (ปิดโมดัล) ห้ามใช้ค่าปัจจุบันของ form ตอนจัดการผล
    const assessmentIdAtSend = form.assessmentId;
    const knownVersionAtSend =
      assessmentOptions.find((item) => item.id === assessmentIdAtSend)?.currentVersion ?? null;
    const epoch = requestEpochRef.current;
    // R4-M2: ติดตามคำขอตั้งแต่ก่อนส่ง — in-flight อยู่นอก lifecycle ของโมดัล (ปิดกลาง
    // คันแล้วเปิดใหม่ ปุ่มของชุดนี้ยังล็อกจนกว่าคำขอจะเสร็จ) · clearInFlight ทุกทางออก
    unresolvedRulesRegistry.markInFlight(assessmentIdAtSend);
    setCore((previous) => nextModalCoreState(previous, { kind: "submit_start" }));
    let outcome: RulesPostOutcome;
    let caughtError: unknown = null;
    try {
      const result = await postAdminJson(
        `${ASSESSMENT_RULES_PATH}/${assessmentIdAtSend}/rules`,
        built.body,
      );
      // unwrap envelope { data: { version } } ก่อนอ่าน — อ่านตรง body = undefined เสมอ (M1)
      const version = readCreatedRulesVersion(result.body);
      // 201 แต่ envelope ผิดสัญญา = version อาจถูกสร้างแล้วแต่อ่านไม่ได้ → uncertain
      outcome = version === null ? { kind: "uncertain" } : { kind: "committed", version };
    } catch (error) {
      caughtError = error;
      // BFF ตอบ 4xx กลับมาจริง = แน่ใจว่าไม่มี version ถูกสร้าง · อื่น (network ตาย
      // ก่อนมี response · 5xx ที่ commit อาจเกิดแล้ว เช่น row drift หลัง RPC commit) =
      // ผลยังไม่แน่นอน
      outcome = isDefinitiveRejection(error)
        ? { kind: "definitely_not_committed" }
        : { kind: "uncertain" };
    }
    // R4-M2/R5-M1: จัดการ registry ทุกกรณี "ไม่สน epoch" + refresh หน้าทุกผล — ผ่าน
    // แหล่งเดียว applyDeferredRulesOutcome: uncertain ลงทะเบียนเสมอ · committed/
    // definitely_not_committed resolve จากความจริงใน response · registry เปลี่ยน →
    // notify ปลุกโมดัลที่เปิดอยู่ (subscription) ให้เริ่มตรวจ/ปลดล็อกเอง
    const handling = applyDeferredRulesOutcome({
      assessmentId: assessmentIdAtSend,
      knownVersionAtSend,
      outcome,
      epochMatches: epoch === requestEpochRef.current,
      registry: unresolvedRulesRegistry,
      refresh: () => router.refresh(),
    });
    if (handling.ui === "discard") {
      return; // ปิด/รีเซ็ตไปแล้วระหว่างรอ — ห้ามเขียน state ของฟอร์มใหม่ด้วยผลรอบเก่า
    }
    if (outcome.kind === "committed") {
      setCore((previous) =>
        nextModalCoreState(previous, { kind: "outcome_success", version: outcome.version }),
      );
      return;
    }
    if (outcome.kind === "definitely_not_committed") {
      // แสดงสาเหตุ แก้ฟอร์มแล้วส่งใหม่ได้
      setCore((previous) => nextModalCoreState(previous, { kind: "outcome_error" }));
      if (caughtError !== null) {
        showApiError(caughtError);
      }
      return;
    }
    // uncertain — ล็อกกัน version ซ้ำ (R2-M1) · read-back เริ่มโดย effect กลาง (R5-M1)
    // ทันทีที่ registry ลงทะเบียน (การเรียกตรงที่นี่ซ้ำซ้อนกับ effect — เดินสองทาง)
    setCore((previous) => nextModalCoreState(previous, { kind: "outcome_uncertain" }));
    setFormError(
      caughtError === null
        ? "บันทึกแล้วแต่คำตอบของระบบไม่ตรงสัญญา (ไม่พบเลข version) — ระบบกำลังตรวจสอบกับเซิร์ฟเวอร์อีกครั้ง หากยังไม่พบ version ใหม่จึงบันทึกใหม่ได้"
        : `${
            caughtError instanceof AdminApiError ? caughtError.message : TRANSPORT_FALLBACK_MESSAGE
          } — ไม่แน่ใจว่าบันทึกสำเร็จหรือไม่ ระบบกำลังตรวจสอบกับเซิร์ฟเวอร์ หากยังไม่พบ version ใหม่จึงบันทึกใหม่ได้`,
    );
  };

  // gate ของปุ่มยืนยันจากแกนเดียว — submitting/uncertainSave ล็อก + เหตุผลไทย (R2-M1)
  // R3-M1: gate รวมสามชั้น (registry ข้ามการปิดโมดัล · กำลังตรวจ read-back · แกนเดียวเดิม)
  // — pure เดียวกับที่ handleSubmit ใช้ จึงพิสูจน์ด้วย unit ได้ว่ากัน POST ซ้ำจริง
  const unresolvedForForm =
    form.assessmentId !== "" ? unresolvedRulesRegistry.peek(form.assessmentId) : undefined;
  const confirmGate = submitBlockedGate(core, form.assessmentId, resolvingId, unresolvedRulesRegistry);
  const { successVersion } = core;

  return (
    <>
      <button
        type="button"
        className="rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        onClick={() => setCore((previous) => nextModalCoreState(previous, { kind: "open" }))}
      >
        + เพิ่มกติกา version ใหม่
      </button>
      <ConfirmModal
        open={core.open}
        onClose={closeAndReset}
        title={successVersion !== null ? "เพิ่มกติกาสำเร็จ" : "เพิ่มกติกา version ใหม่"}
        description={
          successVersion !== null
            ? undefined
            : "แก้กติกา = เพิ่ม version ใหม่เสมอ — version ถัดไปคำนวณโดยระบบ (max+1)"
        }
        confirmLabel={
          successVersion !== null ? "กลับไปยังรายการ" : "บันทึกกติกา version ใหม่"
        }
        confirmDisabled={confirmGate.disabled}
        confirmDisabledReason={confirmGate.reason}
        cancelLabel={successVersion !== null ? "ปิด" : "ยกเลิก"}
        onConfirm={
          successVersion !== null
            ? closeAndReset
            : () => {
                void handleSubmit();
              }
        }
      >
        {successVersion !== null ? (
          <p className="rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
            เพิ่มกติกา version {successVersion} สำเร็จแล้ว
          </p>
        ) : (
          <div className="space-y-4">
            {formError !== null ? (
              <div
                className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700"
                role="alert"
                data-error-code={apiFieldLabels.length > 0 ? "ERR-VAL-001" : undefined}
              >
                <p>{formError}</p>
                {apiFieldLabels.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5">
                    {apiFieldLabels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {resolveNotice !== null ? (
              <div
                className={
                  resolveNotice.tone === "ok"
                    ? "rounded-[10px] bg-green-50 p-3 text-sm text-green-800"
                    : "rounded-[10px] bg-amber-50 p-3 text-sm text-amber-800"
                }
                role="status"
              >
                <p>{resolveNotice.text}</p>
                {resolveNotice.retry &&
                unresolvedForForm !== undefined &&
                resolvingId === null ? (
                  <button
                    type="button"
                    className="mt-2 rounded-[10px] border border-amber-600 bg-white px-3 py-1.5 font-heading text-sm font-semibold text-amber-800 hover:bg-amber-100"
                    onClick={() => startResolution(form.assessmentId)}
                  >
                    ตรวจสอบอีกครั้ง
                  </button>
                ) : null}
              </div>
            ) : null}
            <AssessmentRulesFormFields
              form={form}
              fieldErrors={fieldErrors}
              assessmentOptions={assessmentOptions}
              disabled={
                core.submitting ||
                core.uncertainSave ||
                resolvingId !== null ||
                unresolvedRulesRegistry.isInFlight(form.assessmentId)
              }
              onChange={update}
              onAssessmentChange={selectAssessment}
            />
          </div>
        )}
      </ConfirmModal>
    </>
  );
}

/* ─── ส่วนแสดงผล (JSX) ─── */

/** ฟอร์มกรอกกติกา version ใหม่ — โครงเดียวกับ AssessmentFormFields ของ AssessmentFormModal */
export function AssessmentRulesFormFields({
  form,
  fieldErrors,
  assessmentOptions,
  disabled,
  onChange,
  onAssessmentChange,
}: {
  readonly form: AssessmentRulesFormState;
  readonly fieldErrors: AssessmentRulesFormErrors;
  readonly assessmentOptions: readonly AssessmentOption[];
  readonly disabled: boolean;
  readonly onChange: <K extends keyof AssessmentRulesFormState>(
    key: K,
    value: AssessmentRulesFormState[K],
  ) => void;
  /** เลือกชุดข้อสอบไม่ใช่แค่เปลี่ยนคีย์ — ต้อง prefill ทั้งฟอร์มจากกติกาล่าสุดด้วย */
  readonly onAssessmentChange: (assessmentId: string) => void;
}) {
  const fieldErrorOf = (key: string): string | null =>
    key in fieldErrors ? (fieldErrors[key] ?? null) : null;

  return (
    <div className="space-y-4">
      <FieldRow label="ชุดข้อสอบ" error={fieldErrorOf("assessmentId")}>
        <select
          className={INPUT_CLASS}
          value={form.assessmentId}
          disabled={disabled}
          onChange={(event) => onAssessmentChange(event.target.value)}
        >
          <option value="">— เลือกชุดข้อสอบ —</option>
          {assessmentOptions.map((assessment) => (
            <option key={assessment.id} value={assessment.id}>
              {assessment.currentVersion === null
                ? `${assessment.label} (ยังไม่มีกติกา — จะเป็น version 1)`
                : `${assessment.label} (version ล่าสุด ${assessment.currentVersion} → ใหม่ = ${assessment.currentVersion + 1})`}
            </option>
          ))}
        </select>
        {form.assessmentId !== "" ? (
          <span className="mt-1 block text-sm text-ink-500">
            เลือกไว้: version ล่าสุด{" "}
            {assessmentOptions.find((item) => item.id === form.assessmentId)?.currentVersion ?? "—"}
            {" — "}ฟอร์มด้านล่าง prefill จากกติกานี้แล้ว
          </span>
        ) : null}
      </FieldRow>

      {form.selection !== null ? (
        <div className="rounded-[10px] border border-mist-200 bg-mist-50 p-3">
          <p className="font-heading text-sm font-semibold text-ink-900">
            ขอบเขตคลังข้อสอบ (ส่งต่อจาก version ล่าสุด — แก้ที่เมนูคลังข้อสอบเท่านั้น)
          </p>
          <pre className="mt-1 max-h-40 overflow-auto text-xs text-ink-600">
            {JSON.stringify(form.selection, null, 2)}
          </pre>
          <p className="mt-1 text-xs text-ink-500">
            การบันทึก version ใหม่จะส่งค่าขอบเขตนี้ต่อตามเดิมโดยอัตโนมัติ
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FieldRow label="เวลาทำข้อสอบ (นาที)" error={fieldErrorOf("timeLimitMinutes")}>
          <input
            type="number"
            className={INPUT_CLASS}
            value={form.timeLimitMinutes}
            disabled={disabled}
            min={5}
            max={480}
            onChange={(event) => onChange("timeLimitMinutes", event.target.value)}
          />
        </FieldRow>
        <FieldRow label="จำนวนข้อสอบ" error={fieldErrorOf("questionCount")}>
          <input
            type="number"
            className={INPUT_CLASS}
            value={form.questionCount}
            disabled={disabled}
            min={1}
            max={1000}
            onChange={(event) => onChange("questionCount", event.target.value)}
          />
        </FieldRow>
        <FieldRow label="เกณฑ์ผ่าน (%)" error={fieldErrorOf("passPct")}>
          <input
            type="number"
            className={INPUT_CLASS}
            value={form.passPct}
            disabled={disabled}
            min={1}
            max={100}
            onChange={(event) => onChange("passPct", event.target.value)}
          />
        </FieldRow>
        <FieldRow label="จำนวนครั้งที่สอบได้" error={fieldErrorOf("maxAttempts")}>
          <input
            type="number"
            className={INPUT_CLASS}
            value={form.maxAttempts}
            disabled={disabled}
            min={1}
            max={100}
            onChange={(event) => onChange("maxAttempts", event.target.value)}
          />
        </FieldRow>
        <FieldRow label="ระยะพักก่อนสอบซ้ำ (นาที)" error={fieldErrorOf("attemptCooldownMinutes")}>
          <input
            type="number"
            className={INPUT_CLASS}
            min={0}
            max={525600}
            value={form.attemptCooldownMinutes}
            disabled={disabled}
            onChange={(event) => onChange("attemptCooldownMinutes", event.target.value)}
          />
        </FieldRow>
      </div>

      <div className="mt-4 space-y-2">
        <label className="flex items-center gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={form.shuffleQuestions}
            disabled={disabled}
            onChange={(event) => onChange("shuffleQuestions", event.target.checked)}
          />
          สุ่มลำดับข้อสอบ
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={form.shuffleOptions}
            disabled={disabled}
            onChange={(event) => onChange("shuffleOptions", event.target.checked)}
          />
          สุ่มลำดับตัวเลือก
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={form.requireCourseComplete}
            disabled={disabled}
            onChange={(event) => onChange("requireCourseComplete", event.target.checked)}
          />
          ต้องเรียนจบหลักสูตรก่อนเข้าสอบ
        </label>
        <FieldRow label="ระบบคุมการสอบ" error={null}>
          <select
            className={INPUT_CLASS}
            value={form.proctoringMode}
            disabled={disabled}
            onChange={(event) =>
              onChange("proctoringMode", event.target.value as ExamAdminProctoringMode)
            }
          >
            {(Object.keys(PROCTORING_MODE_LABEL_TH) as ExamAdminProctoringMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {PROCTORING_MODE_LABEL_TH[mode]}
              </option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="การเปิดเฉลยหลังสอบ" error={null}>
          <select
            className={INPUT_CLASS}
            value={form.examReviewMode}
            disabled={disabled}
            onChange={(event) =>
              onChange("examReviewMode", event.target.value as ExamAdminExamReviewMode)
            }
          >
            {(Object.keys(EXAM_REVIEW_MODE_LABEL_TH) as ExamAdminExamReviewMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {EXAM_REVIEW_MODE_LABEL_TH[mode]}
              </option>
            ))}
          </select>
        </FieldRow>
      </div>
    </div>
  );
}

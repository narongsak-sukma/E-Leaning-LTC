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
 */

import { useRef, useState, type ReactNode } from "react";
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
  | { readonly kind: "outcome_error" };

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
 * error ที่ "แน่ใจว่าไม่มี version ถูกสร้าง" = BFF ตอบ 4xx กลับมาจริง (validation/
 * RBAC/ไม่พบ) — แก้ฟอร์มแล้วส่งใหม่ได้ · อื่น (network ตายก่อนมี response · 5xx
 * เช่น 503 assessment_rule_rpc_row_drift ที่ RPC commit สำเร็จแล้วแต่แถวที่คืนไม่ผ่าน
 * strict parse) = ผลยังไม่แน่นอน → ต้องเข้าสถานะ uncertainSave (R2-M1)
 */
export function isDefinitiveRejection(error: unknown): boolean {
  return error instanceof AdminApiError && error.status >= 400 && error.status < 500;
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
    if (confirmGateOf(core).disabled) {
      return;
    }
    const epoch = requestEpochRef.current;
    setCore((previous) => nextModalCoreState(previous, { kind: "submit_start" }));
    try {
      const result = await postAdminJson(
        `${ASSESSMENT_RULES_PATH}/${form.assessmentId}/rules`,
        built.body,
      );
      if (epoch !== requestEpochRef.current) {
        return; // ปิด/รีเซ็ตไปแล้วระหว่างรอ — ทิ้ง response ของฟอร์มเก่า
      }
      // unwrap envelope { data: { version } } ก่อนอ่าน — อ่านตรง body = undefined เสมอ (M1)
      const version = readCreatedRulesVersion(result.body);
      if (version === null) {
        // R2-M1: 201 แต่ envelope ผิดสัญญา = version อาจถูกสร้างแล้วแต่อ่านไม่ได้ —
        // ล็อกปุ่มกันสร้างซ้ำ + refresh ให้ตารางอ่านกลับ version ล่าสุดจริงจากเซิร์ฟเวอร์
        setCore((previous) => nextModalCoreState(previous, { kind: "outcome_uncertain" }));
        setFormError(
          "บันทึกแล้วแต่คำตอบของระบบไม่ตรงสัญญา (ไม่พบเลข version) — กรุณาตรวจสอบ version ล่าสุดในตารางก่อน หากยังไม่ถูกสร้างจึงบันทึกใหม่อีกครั้ง",
        );
        router.refresh();
        return;
      }
      setCore((previous) => nextModalCoreState(previous, { kind: "outcome_success", version }));
      router.refresh();
    } catch (error) {
      if (epoch !== requestEpochRef.current) {
        return;
      }
      if (isDefinitiveRejection(error)) {
        // BFF ตอบ 4xx กลับมาจริง = ไม่มี version ถูกสร้าง — แสดงสาเหตุ แก้แล้วส่งใหม่ได้
        setCore((previous) => nextModalCoreState(previous, { kind: "outcome_error" }));
        showApiError(error);
        return;
      }
      // network ตายก่อนมี response หรือ 5xx ที่ commit อาจเกิดแล้ว (เช่น row drift
      // หลัง RPC commit) = ผลยังไม่แน่นอน — ล็อกกัน version ซ้ำ + อ่านกลับ (R2-M1)
      setCore((previous) => nextModalCoreState(previous, { kind: "outcome_uncertain" }));
      const fallback = error instanceof AdminApiError
        ? error.message
        : TRANSPORT_FALLBACK_MESSAGE;
      setFormError(
        `${fallback} — ไม่แน่ใจว่าบันทึกสำเร็จหรือไม่ กรุณาตรวจสอบ version ล่าสุดในตารางก่อน หากยังไม่ถูกสร้างจึงบันทึกใหม่อีกครั้ง`,
      );
      router.refresh();
    }
  };

  // gate ของปุ่มยืนยันจากแกนเดียว — submitting/uncertainSave ล็อก + เหตุผลไทย (R2-M1)
  const confirmGate = confirmGateOf(core);
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
            <AssessmentRulesFormFields
              form={form}
              fieldErrors={fieldErrors}
              assessmentOptions={assessmentOptions}
              disabled={core.submitting || core.uncertainSave}
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

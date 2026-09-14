"use client";

/**
 * ฟอร์ม "เพิ่มกติกา version ใหม่" — POST /api/v1/admin/assessments/{id}/rules
 * (Wave G P3 · D87 · API-SPECIFICATION §3.8 แถว 226)
 *
 * - body ตรง AssessmentRuleInput (schema ขาเข้าของ route จริง) เป๊ะ — camelCase ทุกคีย์ ·
 *   ห้ามส่ง version/effective_to (schema strict ไม่มีคีย์นี้ — version = max+1 server-side)
 * - เขียนกติกาได้เฉพาะ staff:exam/super_admin (allowRules — ตัดสินจริงที่ BFF เสมอ)
 * - validation error ของ BFF (ERR-VAL-001 details.fields) แปลงเป็นชื่อฟิลด์ไทย
 *   ผ่าน validationFieldLabels — แสดงในโมดัล ไม่ปิดฟอร์มทิ้ง
 */

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { AdminApiError, postAdminJson, TRANSPORT_FALLBACK_MESSAGE } from "@/lib/exam-admin.client";
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

/** ชุดข้อสอบที่หน้า RSC ส่งมาให้เลือก (id + ป้าย + version ล่าสุดที่มี) */
export interface AssessmentOption {
  readonly id: string;
  readonly label: string;
  readonly currentVersion: number | null;
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
};

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
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AssessmentRulesFormState>(ASSESSMENT_RULES_FORM_DEFAULTS);
  const [fieldErrors, setFieldErrors] = useState<AssessmentRulesFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [apiFieldLabels, setApiFieldLabels] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [successVersion, setSuccessVersion] = useState<number | null>(null);

  if (!allowRules) {
    return null;
  }

  const update = <K extends keyof AssessmentRulesFormState>(
    key: K,
    value: AssessmentRulesFormState[K],
  ) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const closeAndReset = () => {
    setOpen(false);
    setForm(ASSESSMENT_RULES_FORM_DEFAULTS);
    setFieldErrors({});
    setFormError(null);
    setApiFieldLabels([]);
    setSuccessVersion(null);
  };

  /** จุดเดียวที่ map error ของ BFF → ข้อความไทย (ERR-VAL-001 แสดงเป็นรายการฟิลด์) */
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
    if (error instanceof AdminApiError && error.status === 403) {
      setFormError("คุณไม่มีสิทธิ์ดำเนินการนี้ — ติดต่อผู้ดูแลระบบหากถือว่าผิดพลาด (ERR-RBAC-001)");
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
    setSubmitting(true);
    try {
      const result = await postAdminJson(
        `${ASSESSMENT_RULES_PATH}/${form.assessmentId}/rules`,
        built.body,
      );
      // version ที่ได้จาก BFF (แถวที่แทรก — version = max+1 server-side)
      const version =
        typeof (result.body as { version?: unknown })?.version === "number"
          ? (result.body as { version: number }).version
          : null;
      setSuccessVersion(version);
      router.refresh();
    } catch (error) {
      showApiError(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        onClick={() => setOpen(true)}
      >
        + เพิ่มกติกา version ใหม่
      </button>
      <ConfirmModal
        open={open}
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
        confirmDisabled={successVersion === null && submitting}
        confirmDisabledReason={submitting ? "กำลังบันทึก กรุณารอสักครู่" : undefined}
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
              disabled={submitting}
              onChange={update}
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
}: {
  readonly form: AssessmentRulesFormState;
  readonly fieldErrors: AssessmentRulesFormErrors;
  readonly assessmentOptions: readonly AssessmentOption[];
  readonly disabled: boolean;
  readonly onChange: <K extends keyof AssessmentRulesFormState>(
    key: K,
    value: AssessmentRulesFormState[K],
  ) => void;
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
          onChange={(event) => onChange("assessmentId", event.target.value)}
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
          </span>
        ) : null}
      </FieldRow>

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

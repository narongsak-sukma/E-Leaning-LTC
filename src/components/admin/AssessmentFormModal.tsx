"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { AdminApiError, postAdminJson, TRANSPORT_FALLBACK_MESSAGE } from "@/lib/exam-admin.client";
import {
  PROCTORING_MODE_LABEL_TH,
  validationFieldLabels,
  type ExamAdminProctoringMode,
} from "@/lib/exam-admin.view";
import { ConfirmModal } from "./ConfirmModal";

/**
 * ฟอร์มสร้างชุดข้อสอบ — POST /api/v1/admin/assessments (API-SPECIFICATION §3.8 L216)
 *
 * - body ตรง AssessmentCreateBody (schema ขาเข้าของ route จริง) เป๊ะ — camelCase ทุกคีย์ ·
 *   ไม่มี status (BFF ใส่ 'draft' เสมอ — server-controlled)
 * - กติกา (rules) แนบได้เฉพาะ staff:exam/super_admin (RLS ar_write) — instructor สร้าง
 *   ได้เฉพาะโครงร่าง และได้เฉพาะหลักสูตรตัวเอง (RLS บังคับ — BFF map 42501 → 403)
 * - validation error ของ BFF (ERR-VAL-001 details.fields) แปลงเป็นชื่อฟิลด์ภาษาไทย
 *   ผ่าน validationFieldLabels — แสดงในโมดัล ไม่ปิดฟอร์มทิ้ง
 */

/** ช่องกรอกของฟอร์ม — ตัวเลขเก็บเป็นสตริงจาก input แล้ว validate/แปลงตอน submit */
export interface AssessmentFormState {
  readonly courseId: string;
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly isFinal: boolean;
  readonly passPct: string;
  readonly timeLimitMinutes: string;
  readonly questionCount: string;
  readonly maxAttempts: string;
  readonly attemptCooldownMinutes: string;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly requireCourseComplete: boolean;
  readonly proctoringMode: ExamAdminProctoringMode;
}

/** ค่าเริ่มต้นตรง default ของ AssessmentRuleInput (schema ขาเข้าของ route จริง) */
export const ASSESSMENT_FORM_DEFAULTS: AssessmentFormState = {
  courseId: "",
  code: "",
  title: "",
  description: "",
  isFinal: false,
  passPct: "70",
  timeLimitMinutes: "60",
  questionCount: "30",
  maxAttempts: "3",
  attemptCooldownMinutes: "1440",
  shuffleQuestions: true,
  shuffleOptions: true,
  requireCourseComplete: true,
  proctoringMode: "basic",
};

/** กติกาใน body ของ POST — คีย์ตรง AssessmentRuleInput (ไม่รับ effectiveFrom — DB ตั้ง now()) */
export type AssessmentRuleBody = {
  readonly timeLimitMinutes: number;
  readonly questionCount: number;
  readonly passPct: number;
  readonly maxAttempts: number;
  readonly attemptCooldownMinutes: number;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly requireCourseComplete: boolean;
  readonly proctoringMode: ExamAdminProctoringMode;
};

/** body ของ POST /admin/assessments — คีย์ตรง AssessmentCreateBody เป๊ะ (strict) */
export type AssessmentCreateBody = {
  readonly courseId: string;
  readonly code: string;
  readonly title: string;
  readonly description?: string;
  readonly isFinal?: boolean;
  readonly rules?: AssessmentRuleBody;
};

/** ตัวเลือกหลักสูตรใน select — หน้า RSC ส่งมาจาก GET /admin/courses */
export interface CourseOption {
  readonly id: string;
  readonly label: string;
}

/** ตรวจความถูกต้องของตัวเลข — คืน number ที่ผ่านช่วง หรือ null (ยังไม่กรอก/ผิด) */
function intInRange(value: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** ข้อผิดพลาดตรวจฟอร์ม — key = ชื่อช่องใน AssessmentFormState, value = ข้อความภาษาไทย */
export type AssessmentFormErrors = Readonly<Record<string, string>>;

/** ขอบเขตตัวเลข mirror zod ขาเข้าของ route จริง (admin-exam.ts) — แสดงเป็นข้อความไทยก่อนยิง */
const PASS_PCT_RANGE = { min: 1, max: 100 };
const TIME_LIMIT_RANGE = { min: 5, max: 480 };
const QUESTION_COUNT_RANGE = { min: 1, max: 1000 };
const MAX_ATTEMPTS_RANGE = { min: 1, max: 100 };
const COOLDOWN_RANGE = { min: 0, max: 525600 };

/**
 * ตรวจฟอร์มทั้งหมด — คืนข้อผิดพลาดภาษาไทยต่อช่อง (ว่าง = ผ่านทุกช่อง)
 * mirror เงื่อนไข zod ของ AssessmentCreateBody/AssessmentRuleInput เป๊ะ เพื่อให้ผู้ใช้เห็น
 * ปัญหาก่อนยิง request — ฝั่ง BFF ยังตรวจซ้ำเสมอ (client validation ไม่ใช่ชั้นความปลอดภัย)
 */
export function validateAssessmentForm(state: AssessmentFormState): AssessmentFormErrors {
  const errors: Record<string, string> = {};
  if (state.courseId.trim().length === 0) {
    errors["courseId"] = "กรุณาเลือกหลักสูตร";
  }
  const code = state.code.trim();
  if (code.length < 1 || code.length > 120) {
    errors["code"] = "รหัสต้องมี 1-120 ตัวอักษร";
  }
  const title = state.title.trim();
  if (title.length < 1 || title.length > 300) {
    errors["title"] = "ชื่อชุดข้อสอบต้องมี 1-300 ตัวอักษร";
  }
  if (state.description.trim().length > 4000) {
    errors["description"] = "คำอธิบายต้องไม่เกิน 4,000 ตัวอักษร";
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
 * ประกอบ body ของ POST /admin/assessments จากฟอร์ม — คืน { ok, body } เมื่อผ่านทุกช่อง
 * หรือ { ok: false, errors } เมื่อไม่ผ่าน · ฟิลด์เสริมส่งเมื่อมีค่าเท่านั้น (conditional
 * spread) — ห้ามส่ง undefined ตรง ๆ เพราะ schema ขาเข้าเป็น .strict()
 * - includeRules = false (instructor ไม่มี ar_write) → ไม่แนบกติกา ให้ staff:exam ใส่ทีหลัง
 */
export function buildAssessmentCreateBody(
  state: AssessmentFormState,
  options?: { readonly includeRules?: boolean },
): { ok: true; body: AssessmentCreateBody } | { ok: false; errors: AssessmentFormErrors } {
  const errors = validateAssessmentForm(state);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const description = state.description.trim();
  const includeRules = options?.includeRules !== false;
  const rules: AssessmentRuleBody = {
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
  };
  const body: AssessmentCreateBody = {
    courseId: state.courseId.trim(),
    code: state.code.trim(),
    title: state.title.trim(),
    ...(description.length > 0 ? { description } : {}),
    ...(state.isFinal ? { isFinal: true } : {}),
    ...(includeRules ? { rules } : {}),
  };
  return { ok: true, body };
}

/* ─── component — ปุ่มเปิด + โมดัลฟอร์ม (client) ─── */

const ASSESSMENT_CREATE_PATH = "/api/v1/admin/assessments";

export interface AssessmentFormModalProps {
  /** ตัวเลือกหลักสูตรสำหรับ select — หน้า RSC โหลดมาให้แล้ว (GET /admin/courses) */
  readonly courseOptions: readonly CourseOption[];
  /** assessment:create — false = ไม่แสดงปุ่ม/ฟอร์มเลย (ตัดสินที่ BFF เสมอ) */
  readonly canCreate: boolean;
  /** มีสิทธิ์เขียนกติกา (ar_write) — false = ไม่แนบกติกาใน body (staff:exam ใส่ทีหลัง) */
  readonly allowRules: boolean;
}

/** ชุดข้อความสำเร็จ — แจ้งสถานะเริ่มต้น "ร่าง" ชัดเจน (status = server-controlled) */
const SUCCESS_MESSAGE =
  "สร้างชุดข้อสอบเรียบร้อยแล้ว — บันทึกเป็นสถานะ \"ร่าง\" รอเผยแพร่";

export function AssessmentFormModal({
  courseOptions,
  canCreate,
  allowRules,
}: AssessmentFormModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AssessmentFormState>(ASSESSMENT_FORM_DEFAULTS);
  const [fieldErrors, setFieldErrors] = useState<AssessmentFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [apiFieldLabels, setApiFieldLabels] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (!canCreate) {
    return null;
  }

  const update = <K extends keyof AssessmentFormState>(key: K, value: AssessmentFormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const closeAndReset = () => {
    setOpen(false);
    setForm(ASSESSMENT_FORM_DEFAULTS);
    setFieldErrors({});
    setFormError(null);
    setApiFieldLabels([]);
    setSuccessMessage(null);
  };

  /** จุดเดียวที่ map error ของ BFF → ข้อความไทย (ERR-VAL-001 แสดงเป็นรายการฟิลด์) */
  const showApiError = (error: unknown) => {
    if (error instanceof AdminApiError && error.code === "ERR-VAL-001") {
      setFormError("กรุณาตรวจสอบข้อมูลตามรายการต่อไปนี้");
      setApiFieldLabels(validationFieldLabels(error.fields));
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
    const built = buildAssessmentCreateBody(form, { includeRules: allowRules });
    if (!built.ok) {
      setFieldErrors(built.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await postAdminJson(ASSESSMENT_CREATE_PATH, built.body);
      setSuccessMessage(SUCCESS_MESSAGE);
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
        className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
        onClick={() => setOpen(true)}
      >
        + สร้างชุดข้อสอบ
      </button>
      <ConfirmModal
        open={open}
        onClose={closeAndReset}
        title={successMessage !== null ? "สร้างชุดข้อสอบสำเร็จ" : "สร้างชุดข้อสอบ"}
        description={
          successMessage !== null
            ? undefined
            : "บันทึกเป็นร่างของหลักสูตรที่เลือก — สถานะและการเผยแพร่จัดการโดยระบบ"
        }
        confirmLabel={successMessage !== null ? "กลับไปยังรายการ" : "บันทึกสร้างชุดข้อสอบ"}
        confirmDisabled={successMessage === null && submitting}
        confirmDisabledReason={submitting ? "กำลังบันทึก กรุณารอสักครู่" : undefined}
        cancelLabel={successMessage !== null ? "ปิด" : "ยกเลิก"}
        onConfirm={
          successMessage !== null
            ? closeAndReset
            : () => {
                void handleSubmit();
              }
        }
      >
        {successMessage !== null ? (
          <p className="rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
            {successMessage}
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
            <AssessmentFormFields
              form={form}
              fieldErrors={fieldErrors}
              allowRules={allowRules}
              courseOptions={courseOptions}
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

/** แถวช่องกรอกมาตรฐานของฟอร์ม — label + ช่อง + ข้อความผิดพลาดใต้ช่อง */
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

export function AssessmentFormFields({
  form,
  fieldErrors,
  allowRules,
  courseOptions,
  disabled,
  onChange,
}: {
  readonly form: AssessmentFormState;
  readonly fieldErrors: AssessmentFormErrors;
  readonly allowRules: boolean;
  readonly courseOptions: readonly CourseOption[];
  readonly disabled: boolean;
  readonly onChange: <K extends keyof AssessmentFormState>(
    key: K,
    value: AssessmentFormState[K],
  ) => void;
}) {
  const fieldErrorOf = (key: string): string | null =>
    key in fieldErrors ? (fieldErrors[key] ?? null) : null;

  return (
    <div className="space-y-4">
      <FieldRow label="หลักสูตร" error={fieldErrorOf("courseId")}>
        <select
          className={INPUT_CLASS}
          value={form.courseId}
          disabled={disabled}
          onChange={(event) => onChange("courseId", event.target.value)}
        >
          <option value="">— เลือกหลักสูตร —</option>
          {courseOptions.map((course) => (
            <option key={course.id} value={course.id}>
              {course.label}
            </option>
          ))}
        </select>
      </FieldRow>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FieldRow label="รหัสชุดข้อสอบ" error={fieldErrorOf("code")}>
          <input
            type="text"
            className={INPUT_CLASS}
            value={form.code}
            disabled={disabled}
            maxLength={120}
            placeholder="เช่น EXM-LP1-FINAL"
            onChange={(event) => onChange("code", event.target.value)}
          />
        </FieldRow>
        <FieldRow label="ชื่อชุดข้อสอบ" error={fieldErrorOf("title")}>
          <input
            type="text"
            className={INPUT_CLASS}
            value={form.title}
            disabled={disabled}
            maxLength={300}
            placeholder="เช่น ข้อสอบปลายหลักสูตร"
            onChange={(event) => onChange("title", event.target.value)}
          />
        </FieldRow>
      </div>

      <FieldRow label="คำอธิบาย (ไม่บังคับ)" error={fieldErrorOf("description")}>
        <textarea
          className={INPUT_CLASS}
          value={form.description}
          disabled={disabled}
          rows={2}
          maxLength={4000}
          onChange={(event) => onChange("description", event.target.value)}
        />
      </FieldRow>

      <label className="flex items-center gap-2 text-sm text-ink-900">
        <input
          type="checkbox"
          checked={form.isFinal}
          disabled={disabled}
          onChange={(event) => onChange("isFinal", event.target.checked)}
        />
        เป็นข้อสอบปลายหลักสูตร
      </label>

      {allowRules ? (
        <fieldset className="rounded-[10px] border border-mist-300 p-4">
          <legend className="px-1 font-heading text-sm font-semibold text-ink-900">
            กติกาการสอบ (เพิ่มได้ภายหลังโดยผู้ดูแลข้อสอบ)
          </legend>
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
                value={form.attemptCooldownMinutes}
                disabled={disabled}
                min={0}
                max={525600}
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
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { AdminApiError, postAdminJson, TRANSPORT_FALLBACK_MESSAGE } from "@/lib/exam-admin.client";
import {
  QUESTION_DIFFICULTY_LABEL_TH,
  QUESTION_TYPE_LABEL_TH,
  validationFieldLabels,
  type ExamAdminQuestionDifficulty,
  type ExamAdminQuestionType,
} from "@/lib/exam-admin.view";
import { ConfirmModal } from "./ConfirmModal";

/**
 * ฟอร์มสร้างคลังข้อสอบ (พร้อมเพิ่มข้อสอบได้ทันทีสูงสุด 100 ข้อ) —
 * POST /api/v1/admin/question-banks (API-SPECIFICATION §3.8)
 *
 * - body ตรง QuestionBankCreateBody / QuestionCreateInput / QuestionOptionInput
 *   (schema ขาเข้าของ route จริง) เป๊ะ — camelCase ทุกคีย์ · ไม่ส่ง id ของ option
 *   (BFF สร้างให้) · sortOrder = ลำดับในฟอร์ม
 * - ความถูกต้องของข้อสอบ (ตัวเลือกที่ถูก) เป็นข้อมูลของผู้แต่งข้อสอบเท่านั้น — อยู่
 *   ในฟอร์มสร้างนี้เท่านั้น ห้ามแสดงในตารางรายการของหลังบ้าน (กฎ lane D-7 ข้อ 2)
 * - validation error ของ BFF (ERR-VAL-001 details.fields เช่น questions.0.questionText)
 *   แปลงเป็นภาษาไทยผ่าน validationFieldLabels
 */

/** ตัวเลือกของข้อสอบในฟอร์ม — ระบุว่าถูกหรือไม่ (camelCase ตาม contract) */
export interface OptionDraft {
  readonly optionText: string;
  readonly isCorrect: boolean;
}

/** ข้อสอบหนึ่งข้อในฟอร์ม — points เก็บเป็นสตริงจาก input แล้วตรวจตอน build */
export interface QuestionDraft {
  readonly type: ExamAdminQuestionType;
  readonly difficulty: ExamAdminQuestionDifficulty;
  readonly questionText: string;
  readonly explanation: string;
  readonly points: string;
  readonly options: readonly OptionDraft[];
}

/** ตัวเลือกหมวด/หลักสูตรใน select — หน้า RSC โหลดมาให้ */
export interface BankRefOption {
  readonly id: string;
  readonly label: string;
}

/** ค่าเริ่มต้นของข้อสอบใหม่ — ปรนัยเลือกเดียว 2 ตัวเลือกเปล่า */
export const QUESTION_DRAFT_DEFAULTS: QuestionDraft = {
  type: "single_choice",
  difficulty: "medium",
  questionText: "",
  explanation: "",
  points: "1",
  options: [
    { optionText: "", isCorrect: true },
    { optionText: "", isCorrect: false },
  ],
};

/** ชุดข้อสอบถูก/ผิด — 2 ตัวเลือกตาม enum จริง (ถูก = ถูก) */
export const TRUE_FALSE_OPTIONS: readonly OptionDraft[] = [
  { optionText: "ถูก", isCorrect: true },
  { optionText: "ผิด", isCorrect: false },
];

/** ข้อมูลคลังข้อสอบส่วนของฟอร์ม */
export interface QuestionBankFormState {
  readonly code: string;
  readonly name: string;
  readonly courseId: string;
  readonly categoryId: string;
  readonly description: string;
  readonly isActive: boolean;
  readonly questions: readonly QuestionDraft[];
}

/** ค่าเริ่มต้นของฟอร์ม — คลังใช้งานได้ทันที ยังไม่มีข้อสอบ */
export const QUESTION_BANK_FORM_DEFAULTS: QuestionBankFormState = {
  code: "",
  name: "",
  courseId: "",
  categoryId: "",
  description: "",
  isActive: true,
  questions: [],
};

/** ข้อผิดพลาด — key = ชื่อช่อง (คลัง) หรือ path เช่น "questions.0.questionText" (ข้อสอบ) */
export type QuestionBankFormErrors = Readonly<Record<string, string>>;

const QUESTION_MAX = 100;
const OPTIONS_MIN = 1;
const OPTIONS_MAX = 10;
const POINTS_RANGE = { min: 1, max: 100 };

/** ตรวจข้อสอบทุกข้อในฟอร์ม — คืนข้อความไทยต่อ path · mirror zod ขาเข้าของ route จริง */
export function validateQuestionDrafts(
  questions: readonly QuestionDraft[],
): QuestionBankFormErrors {
  const errors: Record<string, string> = {};
  if (questions.length > QUESTION_MAX) {
    errors["questions"] = `เพิ่มข้อสอบได้สูงสุด ${QUESTION_MAX} ข้อ`;
  }
  questions.forEach((question, index) => {
    const prefix = `questions.${index}`;
    const text = question.questionText.trim();
    if (text.length < 1 || text.length > 8000) {
      errors[`${prefix}.questionText`] = "โจทย์ต้องมี 1-8,000 ตัวอักษร";
    }
    if (question.explanation.trim().length > 4000) {
      errors[`${prefix}.explanation`] = "คำอธิบายต้องไม่เกิน 4,000 ตัวอักษร";
    }
    const points = Number(question.points);
    if (
      !/^\d+$/.test(question.points.trim()) ||
      !Number.isInteger(points) ||
      points < POINTS_RANGE.min ||
      points > POINTS_RANGE.max
    ) {
      errors[`${prefix}.points`] = `คะแนนของข้อต้องเป็นตัวเลข 1-100`;
    }
    if (question.options.length < OPTIONS_MIN || question.options.length > OPTIONS_MAX) {
      errors[`${prefix}.options`] = `ตัวเลือกต้องมี ${OPTIONS_MIN}-${OPTIONS_MAX} ตัว`;
    }
    question.options.forEach((option, optionIndex) => {
      const optionText = option.optionText.trim();
      if (optionText.length < 1 || optionText.length > 2000) {
        errors[`${prefix}.options.${optionIndex}.optionText`] = "ข้อความตัวเลือกต้องมี 1-2,000 ตัวอักษร";
      }
    });
    const correctCount = question.options.filter((option) => option.isCorrect).length;
    if (question.type === "multiple_choice") {
      if (correctCount < 1) {
        errors[`${prefix}.options`] =
          errors[`${prefix}.options`] ?? "ข้อสอบตอบหลายข้อต้องมีตัวเลือกที่ถูกอย่างน้อย 1 ตัว";
      }
    } else if (correctCount !== 1) {
      errors[`${prefix}.options`] =
        errors[`${prefix}.options`] ?? "ข้อสอบเลือกตอบเดียว/ถูกผิด ต้องมีตัวเลือกที่ถูกเพียง 1 ตัว";
    }
  });
  return errors;
}

/** ตัวเลือกใน body ของ POST — คีย์ตรง QuestionOptionInput เป๊ะ (ไม่ส่ง id — server สร้าง) */
export type QuestionOptionBody = {
  readonly optionText: string;
  readonly isCorrect: boolean;
  readonly sortOrder: number;
};

/** ข้อสอบใน body ของ POST — คีย์ตรง QuestionCreateInput เป๊ะ (ไม่ส่ง tags — ใช้ default []) */
export type QuestionBody = {
  readonly type: ExamAdminQuestionType;
  readonly difficulty: ExamAdminQuestionDifficulty;
  readonly questionText: string;
  readonly explanation?: string;
  readonly points: number;
  readonly options: readonly QuestionOptionBody[];
};

/** body ของ POST /admin/question-banks — คีย์ตรง QuestionBankCreateBody เป๊ะ (.strict()) */
export type QuestionBankCreateBody = {
  readonly code: string;
  readonly name: string;
  readonly courseId?: string;
  readonly categoryId?: string;
  readonly description?: string;
  readonly isActive?: boolean;
  readonly questions?: readonly QuestionBody[];
};

/**
 * ประกอบ body ของ POST /admin/question-banks — คืน { ok, body } / { ok: false, errors }
 * - คลัง: code/name/courseId/categoryId/description/isActive — เลือก "ไม่ระบุ" = ไม่ส่งคีย์
 *   (schema .strict() — ห้ามส่ง undefined ตรง ๆ)
 * - ข้อสอบ: sortOrder = ลำดับในฟอร์ม (0-999) · ไม่ส่ง id ของตัวเลือก · ไม่ส่ง tags (ใช้ default [])
 */
export function buildQuestionBankCreateBody(
  state: QuestionBankFormState,
): { ok: true; body: QuestionBankCreateBody } | { ok: false; errors: QuestionBankFormErrors } {
  const bankErrors: Record<string, string> = {};
  const code = state.code.trim();
  if (code.length < 1 || code.length > 120) {
    bankErrors["code"] = "รหัสคลังข้อสอบต้องมี 1-120 ตัวอักษร";
  }
  const name = state.name.trim();
  if (name.length < 1 || name.length > 300) {
    bankErrors["name"] = "ชื่อคลังข้อสอบต้องมี 1-300 ตัวอักษร";
  }
  if (state.description.trim().length > 4000) {
    bankErrors["description"] = "คำอธิบายต้องไม่เกิน 4,000 ตัวอักษร";
  }
  const draftErrors = validateQuestionDrafts(state.questions);
  const errors: Record<string, string> = { ...bankErrors, ...draftErrors };
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const courseId = state.courseId.trim();
  const categoryId = state.categoryId.trim();
  const description = state.description.trim();
  const questions = state.questions.map((question) => ({
    type: question.type,
    difficulty: question.difficulty,
    questionText: question.questionText.trim(),
    ...(question.explanation.trim().length > 0
      ? { explanation: question.explanation.trim() }
      : {}),
    points: Number(question.points.trim()),
    options: question.options.map((option, optionIndex) => ({
      optionText: option.optionText.trim(),
      isCorrect: option.isCorrect,
      sortOrder: Math.min(optionIndex, 999),
    })),
  }));
  const body: QuestionBankCreateBody = {
    code,
    name,
    ...(courseId.length > 0 ? { courseId } : {}),
    ...(categoryId.length > 0 ? { categoryId } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(state.isActive !== true ? { isActive: state.isActive } : {}),
    ...(state.questions.length > 0 ? { questions } : {}),
  };
  return { ok: true, body };
}

/* ─── component — ปุ่มเปิด + โมดัลฟอร์ม (client) ─── */

const QUESTION_BANK_CREATE_PATH = "/api/v1/admin/question-banks";

const BANK_SUCCESS_MESSAGE =
  "สร้างคลังข้อสอบเรียบร้อยแล้ว — ข้อสอบที่แนบมาเข้าสู่คลังเป็นสถานะ \"ร่าง\"";

export interface QuestionBankFormModalProps {
  /** ตัวเลือกหลักสูตร (select) — หน้า RSC โหลดมาให้แล้ว */
  readonly courseOptions: readonly BankRefOption[];
  /** ตัวเลือกหมวดหลักสูตร (select) — หน้า RSC โหลดมาให้แล้ว */
  readonly categoryOptions: readonly BankRefOption[];
  /** question_bank:create — false = ไม่แสดงปุ่ม/ฟอร์มเลย (ตัดสินที่ BFF เสมอ) */
  readonly canCreate: boolean;
}

/** ค่าของฟอร์มที่แก้ได้ตอนพิมพ์ — ใช้ใน update helper ของ component */
export function updateQuestionDraft(
  questions: readonly QuestionDraft[],
  index: number,
  patch: Partial<Pick<QuestionDraft, "questionText" | "explanation" | "points" | "difficulty">>,
): readonly QuestionDraft[] {
  return questions.map((question, questionIndex) =>
    questionIndex === index ? { ...question, ...patch } : question,
  );
}

/** เปลี่ยนชนิดข้อสอบ — true_false เปลี่ยนตัวเลือกเป็น ถูก/ผิด อัตโนมัติ */
export function setQuestionDraftType(
  questions: readonly QuestionDraft[],
  index: number,
  type: ExamAdminQuestionType,
): readonly QuestionDraft[] {
  return questions.map((question, questionIndex) => {
    if (questionIndex !== index) {
      return question;
    }
    if (type === "true_false") {
      return { ...question, type, options: TRUE_FALSE_OPTIONS };
    }
    return { ...question, type };
  });
}

/** เพิ่มตัวเลือกของข้อสอบ (ไม่เกิน 10) — เป็นตัวเลือกที่ไม่ถูกเสมอ */
export function addOptionDraft(
  questions: readonly QuestionDraft[],
  index: number,
): readonly QuestionDraft[] {
  return questions.map((question, questionIndex) =>
    questionIndex === index && question.options.length < OPTIONS_MAX
      ? { ...question, options: [...question.options, { optionText: "", isCorrect: false }] }
      : question,
  );
}

/** ลบตัวเลือก (คงเหลืออย่างน้อย 1) */
export function removeOptionDraft(
  inputs: readonly QuestionDraft[],
  index: number,
  optionIndex: number,
): readonly QuestionDraft[] {
  return inputs.map((question, questionIndex) =>
    questionIndex === index && question.options.length > OPTIONS_MIN
      ? { ...question, options: question.options.filter((_, i) => i !== optionIndex) }
      : question,
  );
}

/** แก้ไขตัวเลือกหนึ่งช่อง — patchText / patchIsCorrect */
export function updateOptionDraft(
  inputs: readonly QuestionDraft[],
  index: number,
  optionIndex: number,
  patch: { readonly optionText?: string; readonly isCorrect?: boolean },
): readonly QuestionDraft[] {
  return inputs.map((question, questionIndex) => {
    if (questionIndex !== index) {
      return question;
    }
    const options = question.options.map((option, optionIndex_) => {
      if (optionIndex_ !== optionIndex) {
        return option;
      }
      return {
        optionText: patch.optionText ?? option.optionText,
        isCorrect: patch.isCorrect ?? option.isCorrect,
      };
    });
    return { ...question, options };
  });
}

/** สลับ "ถูก" ของข้อเลือกเดียว/ถูกผิด — เลือกตัวเดียวพอ (ตัวอื่นปิดอัตโนมัติ) */
export function markSingleCorrect(
  inputs: readonly QuestionDraft[],
  index: number,
  optionIndex: number,
): readonly QuestionDraft[] {
  return inputs.map((question, questionIndex) => {
    if (questionIndex !== index || question.type === "multiple_choice") {
      return question;
    }
    const options = question.options.map((option, optionIndex_) => ({
      optionText: option.optionText,
      isCorrect: optionIndex_ === optionIndex,
    }));
    return { ...question, options };
  });
}

/* ─── โมดัล — ปุ่มเปิด + ฟอร์ม + ผลลัพธ์ ─── */

export function QuestionBankFormModal({
  courseOptions,
  categoryOptions,
  canCreate,
}: QuestionBankFormModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<QuestionBankFormState>(QUESTION_BANK_FORM_DEFAULTS);
  const [fieldErrors, setFieldErrors] = useState<QuestionBankFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [apiFieldLabels, setApiFieldLabels] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (!canCreate) {
    return null;
  }

  const update = <K extends keyof QuestionBankFormState>(key: K, value: QuestionBankFormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const closeAndReset = () => {
    setOpen(false);
    setForm(QUESTION_BANK_FORM_DEFAULTS);
    setFieldErrors({});
    setFormError(null);
    setApiFieldLabels([]);
    setSuccessMessage(null);
  };

  /** จุดเดียวที่ map error ของ BFF → ข้อความไทย (ERR-VAL-001 → รายการฟิลด์ภาษาไทย) */
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
    const built = buildQuestionBankCreateBody(form);
    if (!built.ok) {
      setFieldErrors(built.errors);
      setFormError("กรุณาตรวจสอบข้อมูลตามรายการต่อไปนี้");
      setApiFieldLabels(validationFieldLabels(Object.keys(built.errors)));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await postAdminJson(QUESTION_BANK_CREATE_PATH, built.body);
      setSuccessMessage(BANK_SUCCESS_MESSAGE);
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
        + สร้างคลังข้อสอบ
      </button>
      <ConfirmModal
        open={open}
        onClose={closeAndReset}
        title={successMessage !== null ? "สร้างคลังข้อสอบสำเร็จ" : "สร้างคลังข้อสอบ"}
        description={
          successMessage !== null
            ? undefined
            : "คลังข้อสอบใช้รวบรวมโจทย์ของหลักสูตร/หมวดที่เกี่ยวข้อง — แนบข้อสอบได้ทันทีสูงสุด 100 ข้อ"
        }
        confirmLabel={successMessage !== null ? "กลับไปยังรายการ" : "บันทึกสร้างคลังข้อสอบ"}
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
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <div className="space-y-4">
              {formError !== null ? (
                <div className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <BankField label="รหัสคลังข้อสอบ" error={fieldErrors["code"] ?? null}>
                  <input
                    type="text"
                    className={BANK_INPUT_CLASS}
                    value={form.code}
                    disabled={submitting}
                    maxLength={120}
                    onChange={(event) => update("code", event.target.value)}
                  />
                </BankField>
                <BankField label="ชื่อคลังข้อสอบ" error={fieldErrors["name"] ?? null}>
                  <input
                    type="text"
                    className={BANK_INPUT_CLASS}
                    value={form.name}
                    disabled={submitting}
                    maxLength={300}
                    onChange={(event) => update("name", event.target.value)}
                  />
                </BankField>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <BankField label="หลักสูตร (ไม่บังคับ)" error={null}>
                  <select
                    className={BANK_INPUT_CLASS}
                    value={form.courseId}
                    disabled={submitting}
                    onChange={(event) => update("courseId", event.target.value)}
                  >
                    <option value="">— ไม่ระบุ —</option>
                    {courseOptions.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.label}
                      </option>
                    ))}
                  </select>
                </BankField>
                <BankField label="หมวดหลักสูตร (ไม่บังคับ)" error={null}>
                  <select
                    className={BANK_INPUT_CLASS}
                    value={form.categoryId}
                    disabled={submitting}
                    onChange={(event) => update("categoryId", event.target.value)}
                  >
                    <option value="">— ไม่ระบุ —</option>
                    {categoryOptions.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </BankField>
              </div>
              <BankField label="คำอธิบาย (ไม่บังคับ)" error={fieldErrors["description"] ?? null}>
                <textarea
                  className={BANK_INPUT_CLASS}
                  value={form.description}
                  disabled={submitting}
                  rows={2}
                  maxLength={4000}
                  onChange={(event) => update("description", event.target.value)}
                />
              </BankField>
              <label className="flex items-center gap-2 text-sm text-ink-900">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  disabled={submitting}
                  onChange={(event) => update("isActive", event.target.checked)}
                />
                เปิดใช้งานคลังข้อสอบทันที
              </label>

              <div className="border-t border-mist-200 pt-4">
                <div className="flex items-center justify-between">
                  <span className="font-heading text-sm font-semibold text-ink-900">
                    ข้อสอบในคลัง ({form.questions.length}/100 ข้อ)
                  </span>
                  <button
                    type="button"
                    className="rounded-[10px] border border-brand-600 px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={submitting || form.questions.length >= 100}
                    onClick={() => update("questions", [...form.questions, QUESTION_DRAFT_DEFAULTS])}
                  >
                    + เพิ่มข้อสอบ
                  </button>
                </div>
                {form.questions.map((question, questionIndex) => (
                  <div
                    key={questionIndex}
                    className="mt-3 rounded-[10px] border border-mist-300 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink-900">
                        ข้อที่ {questionIndex + 1}
                      </span>
                      <button
                        type="button"
                        className="text-sm text-red-600 hover:underline"
                        disabled={submitting}
                        onClick={() =>
                          update(
                            "questions",
                            form.questions.filter((_, i) => i !== questionIndex),
                          )
                        }
                      >
                        ลบข้อนี้
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <BankField label="ชนิดข้อสอบ" error={null}>
                        <select
                          className={BANK_INPUT_CLASS}
                          value={question.type}
                          disabled={submitting}
                          onChange={(event) =>
                            update(
                              "questions",
                              setQuestionDraftType(
                                form.questions,
                                questionIndex,
                                event.target.value as ExamAdminQuestionType,
                              ),
                            )
                          }
                        >
                          {(Object.keys(QUESTION_TYPE_LABEL_TH) as ExamAdminQuestionType[]).map(
                            (type) => (
                              <option key={type} value={type}>
                                {QUESTION_TYPE_LABEL_TH[type]}
                              </option>
                            ),
                          )}
                        </select>
                      </BankField>
                      <BankField label="ระดับความยาก" error={null}>
                        <select
                          className={BANK_INPUT_CLASS}
                          value={question.difficulty}
                          disabled={submitting}
                          onChange={(event) =>
                            update(
                              "questions",
                              updateQuestionDraft(form.questions, questionIndex, {
                                difficulty: event.target.value as ExamAdminQuestionDifficulty,
                              }),
                            )
                          }
                        >
                          {(Object.keys(QUESTION_DIFFICULTY_LABEL_TH) as ExamAdminQuestionDifficulty[]).map(
                            (difficulty) => (
                              <option key={difficulty} value={difficulty}>
                                {QUESTION_DIFFICULTY_LABEL_TH[difficulty]}
                              </option>
                            ),
                          )}
                        </select>
                      </BankField>
                    </div>
                    <BankField label="โจทย์" error={questionDraftErrorOf(fieldErrors, questionIndex, "questionText")}>
                      <textarea
                        className={BANK_INPUT_CLASS}
                        value={question.questionText}
                        disabled={submitting}
                        rows={2}
                        maxLength={8000}
                        onChange={(event) =>
                          update(
                            "questions",
                            updateQuestionDraft(form.questions, questionIndex, {
                              questionText: event.target.value,
                            }),
                          )
                        }
                      />
                    </BankField>
                    <BankField label="คำอธิบายหลังตรวจ (ไม่บังคับ)" error={questionDraftErrorOf(fieldErrors, questionIndex, "explanation")}>
                      <input
                        type="text"
                        className={BANK_INPUT_CLASS}
                        value={question.explanation}
                        disabled={submitting}
                        maxLength={4000}
                        onChange={(event) =>
                          update(
                            "questions",
                            updateQuestionDraft(form.questions, questionIndex, {
                              explanation: event.target.value,
                            }),
                          )
                        }
                      />
                    </BankField>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <BankField label="คะแนนของข้อ (1-100)" error={questionDraftErrorOf(fieldErrors, questionIndex, "points")}>
                        <input
                          type="number"
                          className={BANK_INPUT_CLASS}
                          value={question.points}
                          disabled={submitting}
                          min={1}
                          max={100}
                          onChange={(event) =>
                            update(
                              "questions",
                              updateQuestionDraft(form.questions, questionIndex, {
                                points: event.target.value,
                              }),
                            )
                          }
                        />
                      </BankField>
                    </div>
                    <div className="mt-2 space-y-2">
                      <span className="block font-heading text-sm font-semibold text-ink-900">
                        ตัวเลือก (คลิกช่อง &quot;ถูก&quot; ข้างตัวเลือกที่ถูกต้อง)
                      </span>
                      {question.options.map((option, optionIndex) => (
                        <div key={optionIndex} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-2"
                            checked={option.isCorrect}
                            disabled={submitting}
                            aria-label={`ตัวเลือกที่ ${optionIndex + 1} ถูกต้อง`}
                            onChange={(event) => {
                              if (question.type === "multiple_choice") {
                                update(
                                  "questions",
                                  updateOptionDraft(form.questions, questionIndex, optionIndex, {
                                    isCorrect: event.target.checked,
                                  }),
                                );
                              } else {
                                update(
                                  "questions",
                                  markSingleCorrect(form.questions, questionIndex, optionIndex),
                                );
                              }
                            }}
                          />
                          <div className="flex-1">
                            <BankField
                              label={`ตัวเลือกที่ ${optionIndex + 1}`}
                              error={
                                fieldErrors[`questions.${questionIndex}.options.${optionIndex}.optionText`] ??
                                null
                              }
                            >
                              <input
                                type="text"
                                className={BANK_INPUT_CLASS}
                                value={option.optionText}
                                disabled={submitting}
                                maxLength={2000}
                                onChange={(event) =>
                                  update(
                                    "questions",
                                    updateOptionDraft(form.questions, questionIndex, optionIndex, {
                                      optionText: event.target.value,
                                    }),
                                  )
                                }
                              />
                            </BankField>
                          </div>
                          <button
                            type="button"
                            className="mt-2 text-sm text-red-600 hover:underline"
                            disabled={submitting || question.options.length <= 1}
                            onClick={() =>
                              update(
                                "questions",
                                removeOptionDraft(form.questions, questionIndex, optionIndex),
                              )
                            }
                          >
                            ลบ
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="rounded-[10px] border border-brand-600 px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={submitting || question.options.length >= 10}
                        onClick={() =>
                          update("questions", addOptionDraft(form.questions, questionIndex))
                        }
                      >
                        + เพิ่มตัวเลือก
                      </button>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            </div>
        )}
      </ConfirmModal>
    </>
  );
}

/* ─── ผู้ช่วยแสดงผลของฟอร์มคลังข้อสอบ ─── */

const BANK_INPUT_CLASS =
  "w-full rounded-[10px] border border-mist-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none";

/** แถวช่องกรอกของฟอร์มคลังข้อสอบ — label + ช่อง + ข้อความผิดพลาดใต้ช่อง */
function questionDraftErrorOf(
  errors: QuestionBankFormErrors,
  questionIndex: number,
  field: "questionText" | "explanation" | "points",
): string | null {
  const key = `questions.${questionIndex}.${field}`;
  return key in errors ? (errors[key] ?? null) : null;
}

function BankField({ label, error, children }: {
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

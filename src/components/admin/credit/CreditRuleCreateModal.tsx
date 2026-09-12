"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createCreditRule } from "@/lib/api/admin-credit";
import { ApiError } from "@/lib/api/transport";

import {
  CREDIT_RULE_FIELD_LABELS_TH,
  CREDIT_RULE_FORM_DEFAULTS,
  buildCreditRuleCreateBody,
  type CreditRuleFormField,
  type CreditRuleFormState,
} from "./credit.view";
import { ConfirmModal } from "../ConfirmModal";

/**
 * ปุ่ม "สร้างกฎใหม่" + โมดัลฟอร์ม (Wave E Phase 3 · Credit Bank)
 *
 * - POST /api/v1/admin/credit-rules ผ่าน delegate admin-credit (client — same-origin)
 * - validate ฝั่งนี้ก่อนยิง (mirror zod ของ BFF — credit.view) เพื่อ error ต่อฟิลด์
 *   ทันที · BFF ยังตรวจซ้ำเสมอ · error จาก BFF แสดงข้อความไทยจาก envelope ตรง ๆ
 *   (เช่น รหัสซ้ำ 23505 → "ข้อมูลที่ส่งมาไม่ถูกต้อง" พร้อมบอกฟิลด์ code)
 * - สร้างสำเร็จ = แจ้งในโมดัล + router.refresh() (RSC โหลดรายการใหม่)
 * - สิทธิ์: ปุ่มนี้เรนเดอร์เฉพาะผู้ถือ credit_rule:create (หน้าเป็นผู้ gate — staff:registrar/
 *   super_admin) — สถานะเริ่ม 'draft' บังคับที่ BFF/DB ไม่รับจากฟอร์ม
 */

/** input กลางของฟอร์ม — เดียวกับแบบแผน AssessmentFormModal */
const INPUT_CLASS =
  "w-full rounded-[10px] border border-mist-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none";

const SUCCESS_MESSAGE = "สร้างกฎเครดิตใหม่แล้ว — อยู่ในสถานะฉบับร่าง รอเผยแพร่";

/** แถวฟิลด์ — ป้ายไทย + ช่องกรอก + error รายช่อง */
function FieldRow({
  field,
  label,
  errors,
  children,
  hint,
}: {
  readonly field: CreditRuleFormField;
  readonly label: string;
  readonly errors: ReadonlySet<CreditRuleFormField>;
  readonly children: React.ReactNode;
  readonly hint?: string | undefined;
}) {
  const invalid = errors.has(field);
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">{label}</span>
      {children}
      {hint !== undefined && !invalid ? (
        <span className="mt-1 block text-xs text-ink-500">{hint}</span>
      ) : null}
      {invalid ? (
        <span className="mt-1 block text-xs font-medium text-danger-600" role="alert">
          ข้อมูลช่องนี้ไม่ถูกต้อง
        </span>
      ) : null}
    </label>
  );
}

export function CreditRuleCreateModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreditRuleFormState>(CREDIT_RULE_FORM_DEFAULTS);
  const [fieldErrors, setFieldErrors] = useState<ReadonlySet<CreditRuleFormField>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const update = (patch: Partial<CreditRuleFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const closeAndReset = () => {
    setOpen(false);
    setForm(CREDIT_RULE_FORM_DEFAULTS);
    setFieldErrors(new Set());
    setFormError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async () => {
    setFormError(null);
    const built = buildCreditRuleCreateBody(form);
    if (!built.ok) {
      setFieldErrors(built.fields);
      return;
    }
    setFieldErrors(new Set());
    setSubmitting(true);
    try {
      await createCreditRule(built.body);
      setSuccessMessage(SUCCESS_MESSAGE);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError("ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง");
      }
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
        + สร้างกฎเครดิต
      </button>
      <ConfirmModal
        open={open}
        onClose={closeAndReset}
        title={successMessage !== null ? "สร้างกฎเครดิตสำเร็จ" : "สร้างกฎเครดิตใหม่"}
        description={
          successMessage !== null
            ? undefined
            : "กฎใหม่จะถูกบันทึกเป็นฉบับร่าง — กฎที่เผยแพร่แล้วแก้เนื้อหาไม่ได้ หากต้องการปรับให้สร้างฉบับใหม่"
        }
        confirmLabel={successMessage !== null ? "กลับไปยังรายการ" : "บันทึกสร้างกฎ"}
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
              <div className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
                <p>{formError}</p>
                {fieldErrors.size > 0 ? (
                  <ul className="mt-1 list-disc pl-5">
                    {[...fieldErrors].map((field) => (
                      <li key={field}>{CREDIT_RULE_FIELD_LABELS_TH[field]}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FieldRow field="code" label={CREDIT_RULE_FIELD_LABELS_TH["code"]} errors={fieldErrors}>
                <input
                  className={INPUT_CLASS}
                  value={form.code}
                  onChange={(event) => update({ code: event.target.value })}
                  placeholder="CR-LTC-001"
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow field="name" label={CREDIT_RULE_FIELD_LABELS_TH["name"]} errors={fieldErrors}>
                <input
                  className={INPUT_CLASS}
                  value={form.name}
                  onChange={(event) => update({ name: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
            </div>
            <FieldRow
              field="courseId"
              label={CREDIT_RULE_FIELD_LABELS_TH["courseId"]}
              errors={fieldErrors}
              hint="เว้นว่าง = กฎทั่วไปใช้กับทุกหลักสูตร"
            >
              <input
                className={INPUT_CLASS}
                value={form.courseId}
                onChange={(event) => update({ courseId: event.target.value })}
                disabled={submitting}
              />
            </FieldRow>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FieldRow field="creditType" label={CREDIT_RULE_FIELD_LABELS_TH["creditType"]} errors={fieldErrors}>
                <input
                  className={INPUT_CLASS}
                  value={form.creditType}
                  onChange={(event) => update({ creditType: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow field="credits" label={CREDIT_RULE_FIELD_LABELS_TH["credits"]} errors={fieldErrors}>
                <input
                  className={INPUT_CLASS}
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.credits}
                  onChange={(event) => update({ credits: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow
                field="validDays"
                label={CREDIT_RULE_FIELD_LABELS_TH["validDays"]}
                errors={fieldErrors}
                hint="เว้นว่าง = อายุตามรอบต่ออายุ"
              >
                <input
                  className={INPUT_CLASS}
                  type="number"
                  min="1"
                  value={form.validDays}
                  onChange={(event) => update({ validDays: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow
                field="requiredCreditsPerCycle"
                label={CREDIT_RULE_FIELD_LABELS_TH["requiredCreditsPerCycle"]}
                errors={fieldErrors}
                hint="เว้นว่าง = ตามค่า default ของรอบ"
              >
                <input
                  className={INPUT_CLASS}
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.requiredCreditsPerCycle}
                  onChange={(event) => update({ requiredCreditsPerCycle: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow field="priority" label={CREDIT_RULE_FIELD_LABELS_TH["priority"]} errors={fieldErrors} hint="ตัวเลขน้อย = จับคู่ก่อน">
                <input
                  className={INPUT_CLASS}
                  type="number"
                  min="0"
                  value={form.priority}
                  onChange={(event) => update({ priority: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow
                field="renewalCycle"
                label={CREDIT_RULE_FIELD_LABELS_TH["renewalCycle"]}
                errors={fieldErrors}
                hint="เว้นว่าง = ตามรอบ default ของระบบ"
              >
                <input
                  className={INPUT_CLASS}
                  value={form.renewalCycle}
                  onChange={(event) => update({ renewalCycle: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow field="effectiveFrom" label={CREDIT_RULE_FIELD_LABELS_TH["effectiveFrom"]} errors={fieldErrors}>
                <input
                  className={INPUT_CLASS}
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(event) => update({ effectiveFrom: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
              <FieldRow field="effectiveTo" label={CREDIT_RULE_FIELD_LABELS_TH["effectiveTo"]} errors={fieldErrors} hint="เว้นว่าง = ไม่มีวันสิ้นสุด">
                <input
                  className={INPUT_CLASS}
                  type="date"
                  value={form.effectiveTo}
                  onChange={(event) => update({ effectiveTo: event.target.value })}
                  disabled={submitting}
                />
              </FieldRow>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={form.carryOver}
                onChange={(event) => update({ carryOver: event.target.checked })}
                disabled={submitting}
              />
              ยกยอด credit ข้ามรอบได้
            </label>
          </div>
        )}
      </ConfirmModal>
    </>
  );
}

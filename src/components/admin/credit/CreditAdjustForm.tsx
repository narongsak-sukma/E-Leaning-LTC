"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { adjustCredit } from "@/lib/api/admin-credit";
import { ApiError } from "@/lib/api/transport";

import {
  CREDIT_ADJUST_FIELD_LABELS_TH,
  CREDIT_ADJUST_FORM_DEFAULTS,
  buildAdjustBody,
  type CreditAdjustFormField,
  type CreditAdjustFormState,
} from "./credit.view";
import { ConfirmModal } from "../ConfirmModal";

/**
 * ฟอร์มปรับ credit มือ (+/−) ของเจ้าหน้าที่ — POST /api/v1/admin/credits/adjustments
 *
 * - เรียก RPC admin_credit_adjust ผ่าน BFF (user-JWT — D68 C-9) · reason บังคับ 10-500
 *   (ERR-CRD-002) · validate ฝั่งนี้ mirror กับ BFF ก่อนยิง (credit.view)
 * - creditTypeOptions = ประเภทจากกฎที่ใช้งาน (datalist ช่วยกรอก — ยังพิมพ์เองได้
 *   เพราะ credit_type เป็น config ไม่ใช่ enum ใน DB)
 * - สำเร็จ → แจ้งยอดที่ปรับ + router.refresh() · error ธุรกิจจาก BFF (เช่น รอบไม่ตรงผู้ใช้
 *   ERR-NF-001) แสดงข้อความไทยจาก envelope ตรง ๆ
 * - ปุ่มยืนยันเรนเดอร์เฉพาะผู้ถือ credit_adjustment:create (staff:registrar/super_admin)
 */
const INPUT_CLASS =
  "w-full rounded-[10px] border border-mist-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none";

export function CreditAdjustForm({
  creditTypeOptions,
}: {
  /** ประเภท credit แนะนำจากกฎที่ใช้งาน (โหลดฝั่ง RSC) — ว่างได้ */
  readonly creditTypeOptions: ReadonlyArray<string>;
}) {
  const router = useRouter();
  const [form, setForm] = useState<CreditAdjustFormState>(CREDIT_ADJUST_FORM_DEFAULTS);
  const [fieldErrors, setFieldErrors] = useState<ReadonlySet<CreditAdjustFormField>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const update = (patch: Partial<CreditAdjustFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const amountInvalid = fieldErrors.has("amount");

  const handleSubmit = async () => {
    setError(null);
    const built = buildAdjustBody(form);
    if (!built.ok) {
      setFieldErrors(built.fields);
      setConfirmOpen(false);
      return;
    }
    setFieldErrors(new Set());
    setSubmitting(true);
    try {
      const result = await adjustCredit(built.body);
      setSuccessMessage(
        `ปรับ credit เรียบร้อย — ${result.amount > 0 ? "+" : ""}${result.amount} หน่วย (${result.creditType})`,
      );
      setConfirmOpen(false);
      setForm(CREDIT_ADJUST_FORM_DEFAULTS);
      router.refresh();
    } catch (error) {
      setError(
        error instanceof ApiError
          ? error.message
          : "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // setError เป็นชื่อภายใน — หลีกเลี่ยงชนกับ state setter ของ error
  function setError(message: string | null) {
    setFormError(message);
  }

  return (
    <section className="rounded-[14px] border border-mist-200 bg-white p-6 shadow-card">
      <h2 className="font-heading text-base font-semibold text-ink-900">ปรับ credit ด้วยมือ (+/−)</h2>
      <p className="mt-1 text-sm text-ink-500">
        ทุกการปรับต้องระบุเหตุผล 10-500 ตัวอักษร และถูกบันทึกในบัญชี credit ของผู้ใช้พร้อมบันทึกการตรวจสอบ
      </p>
      {successMessage !== null ? (
        <p className="mt-4 rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
          {successMessage}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            {CREDIT_ADJUST_FIELD_LABELS_TH["userId"]}
          </span>
          <input
            className={INPUT_CLASS}
            value={form.userId}
            onChange={(event) => update({ userId: event.target.value })}
            placeholder="uuid ของผู้ใช้"
          />
          {fieldErrors.has("userId") ? (
            <span className="mt-1 block text-xs font-medium text-danger-600" role="alert">
              ต้องเป็น uuid ที่ถูกต้อง
            </span>
          ) : null}
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            {CREDIT_ADJUST_FIELD_LABELS_TH["cycleId"]}
          </span>
          <input
            className={INPUT_CLASS}
            value={form.cycleId}
            onChange={(event) => update({ cycleId: event.target.value })}
            placeholder="uuid ของรอบต่ออายุ (ดูจากบัญชี credit ด้านล่าง)"
          />
          {fieldErrors.has("cycleId") ? (
            <span className="mt-1 block text-xs font-medium text-danger-600" role="alert">
              ต้องเป็น uuid ของรอบที่ถูกต้อง
            </span>
          ) : null}
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            {CREDIT_ADJUST_FIELD_LABELS_TH["creditType"]}
          </span>
          <input
            className={INPUT_CLASS}
            value={form.creditType}
            list="credit-type-options"
            onChange={(event) => update({ creditType: event.target.value })}
          />
          <datalist id="credit-type-options">
            {creditTypeOptions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          {fieldErrors.has("creditType") ? (
            <span className="mt-1 block text-xs font-medium text-danger-600" role="alert">
              ตัวพิมพ์เล็ก a-z เริ่มด้วยตัวอักษร ยาวไม่เกิน 50
            </span>
          ) : null}
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            {CREDIT_ADJUST_FIELD_LABELS_TH["amount"]}
          </span>
          <input
            className={INPUT_CLASS}
            type="number"
            step="0.01"
            value={form.amount}
            onChange={(event) => update({ amount: event.target.value })}
            placeholder="เช่น 5 หรือ -3"
          />
          {amountInvalid ? (
            <span className="mt-1 block text-xs font-medium text-danger-600" role="alert">
              ต้องไม่เป็น 0 · ไม่เกิน ±9999.99 · ทศนิยมไม่เกิน 2 ตำแหน่ง
            </span>
          ) : null}
        </label>
      </div>
      <label className="mt-4 block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          {CREDIT_ADJUST_FIELD_LABELS_TH["reason"]}
        </span>
        <textarea
          className={INPUT_CLASS}
          rows={3}
          value={form.reason}
          onChange={(event) => update({ reason: event.target.value })}
          placeholder="อย่างน้อย 10 ตัวอักษร เช่น อ้างหนังสือ/มติที่ประชุม"
        />
        {fieldErrors.has("reason") ? (
          <span className="mt-1 block text-xs font-medium text-danger-600" role="alert">
            เหตุผลต้องยาว 10-500 ตัวอักษร
          </span>
        ) : null}
      </label>
      <div className="mt-4">
        <button
          type="button"
          className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
          onClick={() => {
            setError(null);
            const built = buildAdjustBody(form);
            if (!built.ok) {
              setFieldErrors(built.fields);
              return;
            }
            setFieldErrors(new Set());
            setConfirmOpen(true);
          }}
        >
          ปรับ credit
        </button>
      </div>
      <ConfirmModal
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
        }}
        title="ยืนยันการปรับ credit"
        description="การปรับจะถูกบันทึกลงบัญชี credit ของผู้ใช้ทันที และไม่สามารถแก้ไขย้อนหลังได้ (แก้ด้วยรายการปรับใหม่เท่านั้น)"
        confirmLabel={submitting ? "กำลังบันทึก…" : "ยืนยันปรับ credit"}
        confirmDisabled={submitting}
        confirmDisabledReason={submitting ? "กำลังบันทึก กรุณารอสักครู่" : undefined}
        onConfirm={() => {
          void handleSubmit();
        }}
      >
        {formError !== null ? (
          <div className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            <p>{formError}</p>
          </div>
        ) : null}
      </ConfirmModal>
    </section>
  );
}

"use client";

/**
 * StatusConfirm — ปุ่มเปลี่ยนสถานะข้อสอบ + ConfirmModal ยืนยัน (Wave G P2 · lane W2)
 *
 * - ข้อความไทย from→to + hint ผลกระทบ pool ตาม D77 ("ข้อที่ปลดจะไม่ถูกสุ่มให้การสอบที่เริ่มใหม่")
 * - เรียก PATCH .../questions/{qid}/status ผ่าน patchAdminJson (ท่าเดียวกับต้นแบบ
 *   users/api-client.ts sendAdminJson) — body strict {"status": "active"|"retired"} ตาม D75
 * - แสดงเฉพาะเมื่อ canToggle = staff:exam/super_admin (ตัดสินจริงที่ BFF/RPC 0047 เสมอ)
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { ConfirmModal } from "@/components/admin/ConfirmModal";
import { AdminApiError, TRANSPORT_FALLBACK_MESSAGE } from "@/lib/exam-admin.client";

import { patchAdminJson } from "./api-client";
import {
  bankQuestionStatusEndpointOf,
  questionStatusBody,
  QUESTION_STATUS_LABEL_TH,
  statusActionLabelTh,
  statusConfirmDescriptionTh,
  statusTargetOf,
  type ExamAdminQuestionStatus,
} from "./bank-detail.view";

export interface StatusConfirmProps {
  readonly bankId: string;
  readonly qid: string;
  readonly status: ExamAdminQuestionStatus;
  /** staff:exam/super_admin — false = ไม่แสดงปุ่มเลย (ตัดสินจริงที่ BFF เสมอ) */
  readonly canToggle: boolean;
}

export function StatusConfirm({ bankId, qid, status, canToggle }: StatusConfirmProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (!canToggle) {
    return null;
  }

  const target = statusTargetOf(status);

  const closeAndReset = () => {
    setOpen(false);
    setSubmitting(false);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleConfirm = async () => {
    setErrorMessage(null);
    setSubmitting(true);
    try {
      await patchAdminJson(bankQuestionStatusEndpointOf(bankId, qid), questionStatusBody(target));
      setSuccessMessage(
        `เปลี่ยนสถานะข้อสอบเป็น "${QUESTION_STATUS_LABEL_TH[target]}" เรียบร้อยแล้ว`,
      );
      router.refresh();
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 403) {
        setErrorMessage("คุณไม่มีสิทธิ์เปลี่ยนสถานะข้อสอบ (ERR-RBAC-001)");
      } else if (error instanceof AdminApiError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(TRANSPORT_FALLBACK_MESSAGE);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="font-semibold text-brand-700 hover:underline disabled:cursor-not-allowed disabled:text-ink-400"
        onClick={() => setOpen(true)}
      >
        {statusActionLabelTh(status)}
      </button>
      <ConfirmModal
        open={open}
        onClose={closeAndReset}
        cancelDisabled={successMessage === null && submitting}
        title="เปลี่ยนสถานะข้อสอบ"
        description={statusConfirmDescriptionTh(status)}
        confirmLabel={successMessage !== null ? "ปิด" : "ยืนยันเปลี่ยนสถานะ"}
        confirmDisabled={successMessage === null && submitting}
        confirmDisabledReason={submitting ? "กำลังเปลี่ยนสถานะ กรุณารอสักครู่" : undefined}
        cancelLabel={successMessage !== null ? "ปิด" : "ยกเลิก"}
        onConfirm={
          successMessage !== null
            ? closeAndReset
            : () => {
                void handleConfirm();
              }
        }
      >
        {successMessage !== null ? (
          <p className="rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
            {successMessage}
          </p>
        ) : errorMessage !== null ? (
          <div className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            <p>{errorMessage}</p>
          </div>
        ) : null}
      </ConfirmModal>
    </>
  );
}

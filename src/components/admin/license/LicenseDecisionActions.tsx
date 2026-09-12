"use client";

/**
 * LicenseDecisionActions — ปุ่ม/โมดัลตัดสินคำขอใบอนุญาตต่อแถว (Wave E Phase 5 · lane F · ADM-003)
 *
 * - อนุมัติ (approve) → PATCH /api/v1/admin/license-applications/{id} body { action: "approve" }
 *   (RPC admin_decide_license_application ฝั่ง BFF — approve เลขซ้ำ = 409 แจ้งข้อความไทยจาก BFF)
 * - ปฏิเสธ (reject) → PATCH เดียวกัน body { action: "reject", reason } — reason บังคับ ≥10
 *   ตัวอักษร (trim) ตาม RPC จริง · ทุก action ผ่าน ConfirmModal ภาษาไทยก่อนยิงเสมอ
 * - pure helpers export เพื่อ unit test ใน node (แบบ UserActions)
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmModal } from "@/components/admin/ConfirmModal";
import { AdminApiError } from "@/lib/exam-admin.client";
import { patchAdminJson } from "@/components/admin/users/api-client";

/** ความยาวขั้นต่ำของเหตุผลปฏิเสธ (mirror RPC admin_decide_license_application — 0035) */
export const REJECT_REASON_MIN_LENGTH = 10;

/** pure — เหตุผลผ่านเงื่อนไข — trim แล้วยาว ≥10 */
export function rejectReasonValid(reason: string): boolean {
  return reason.trim().length >= REJECT_REASON_MIN_LENGTH;
}

// pure mapping สถานะย้ายไป license-status.ts (ไม่มี "use client") — หน้า server
// /admin/license-applications เรียกตอน SSR ต้องมาจากโมดูลนั้น (โมดูล client ห้าม
// เรียกจาก server) · re-export ต่อเพื่อ test/UI เดิมไม่ต้องแก้ import
export { licenseStatusViewOf, LICENSE_STATUS_VIEW } from "./license-status";

/** pure — บอดี้ของ PATCH ตัดสิน — reject แนบ reason บังคับ · approve ไม่แนบ reason (RPC ไม่ใช้) */
export function buildDecisionBody(
  action: "approve" | "reject",
  reason: string,
): { action: "approve" } | { action: "reject"; reason: string } {
  if (action === "reject") {
    return { action: "reject", reason: reason.trim() };
  }
  return { action: "approve" };
}

/** pure — path ของ PATCH ตัดสิน (กัน id ว่าง/ตัวอักษรควบคุม) */
export function licenseApplicationPath(id: string): string {
  return `/api/v1/admin/license-applications/${encodeURIComponent(id)}`;
}

/** แผงข้อผิดพลาดในโมดัล — ข้อความไทยจาก envelope ของ BFF */
function ErrorPanel({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-3 rounded-[10px] bg-danger-50 px-3 py-2 text-sm text-danger-600">
      {message}
    </p>
  );
}

/** ป้ายเหตุผล + textarea ของโมดัลปฏิเสธ */
function RejectReasonField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor="reject-reason" className="block text-sm font-medium text-ink-700">
        เหตุผลที่ปฏิเสธ (บังคับ)
      </label>
      <textarea
        id="reject-reason"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        maxLength={500}
        className="mt-1 w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
      />
      <p className="mt-1 text-xs text-ink-500">
        เหตุผลจะแสดงต่อผู้ขอและบันทึกในบันทึกการตรวจสอบ (audit) — ยาวอย่างน้อย 10 ตัวอักษร
      </p>
    </div>
  );
}

export type LicenseDecisionActionsProps = {
  applicationId: string;
  applicantName: string;
  status: string;
  /** คำนวณฝั่ง server จาก session จริง (staff:registrar / super_admin) */
  canDecide: boolean;
};

/** ปุ่ม + โมดัลตัดสินต่อแถวคำขอ (อนุมัติ / ปฏิเสธ — เฉพาะคำขอสถานะ pending) */
export function LicenseDecisionActions({
  applicationId,
  applicantName,
  status,
  canDecide,
}: LicenseDecisionActionsProps) {
  const router = useRouter();
  const [modal, setModal] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isPending = status === "pending";

  function resetAndClose() {
    setModal(null);
    setReason("");
    setError(null);
    setSubmitting(false);
  }

  async function submitDecision(action: "approve" | "reject") {
    setSubmitting(true);
    setError(null);
    try {
      await patchAdminJson(licenseApplicationPath(applicationId), buildDecisionBody(action, reason));
      resetAndClose();
      router.refresh();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof AdminApiError ? caught.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  if (canDecide === false || isPending === false) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setModal("approve")}
        className="rounded-[10px] border border-brand-600 bg-white px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50"
      >
        อนุมัติ
        <span className="sr-only">คำขอของ {applicantName}</span>
      </button>
      <button
        type="button"
        onClick={() => setModal("reject")}
        className="rounded-[10px] border border-danger-600 bg-white px-3 py-1.5 text-sm font-semibold text-danger-600 hover:bg-danger-50"
      >
        ปฏิเสธ
        <span className="sr-only">คำขอของ {applicantName}</span>
      </button>

      <ConfirmModal
        open={modal === "approve"}
        onClose={() => (submitting ? undefined : resetAndClose())}
        title={`อนุมัติคำขอของ ${applicantName}`}
        description="ระบบจะผูกเลขที่ใบอนุญาต ออกใบรับรองยืนยันสถานะทนาย และมอบบทบาททนายความให้อัตโนมัติในธุรกรรมเดียว"
        confirmLabel="ยืนยันอนุมัติ"
        confirmDisabled={submitting}
        confirmDisabledReason={submitting ? "กำลังส่งข้อมูล โปรดรอสักครู่" : undefined}
        onConfirm={() => void submitDecision("approve")}
      >
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>

      <ConfirmModal
        open={modal === "reject"}
        onClose={() => (submitting ? undefined : resetAndClose())}
        title={`ปฏิเสธคำขอของ ${applicantName}`}
        description="ผู้ขอจะได้รับแจ้งเหตุผลและสามารถยื่นคำขอใหม่ได้ภายหลัง"
        confirmLabel="ยืนยันปฏิเสธ"
        confirmDisabled={rejectReasonValid(reason) === false || submitting}
        confirmDisabledReason={
          submitting ? "กำลังส่งข้อมูล โปรดรอสักครู่" : "ระบุเหตุผลให้ยาวอย่างน้อย 10 ตัวอักษรก่อนยืนยัน"
        }
        onConfirm={() => void submitDecision("reject")}
      >
        <RejectReasonField value={reason} onChange={setReason} />
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>
    </div>
  );
}

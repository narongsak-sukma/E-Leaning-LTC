"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { updateCreditRuleStatus } from "@/lib/api/admin-credit";
import { ApiError } from "@/lib/api/transport";

import { ruleLifecycleActions } from "./credit.view";
import { ConfirmModal } from "../ConfirmModal";

/**
 * ปุ่มเปลี่ยนสถานะ lifecycle ของกฎเครดิต (ต่อแถว) — PATCH /api/v1/admin/credit-rules/{id}
 *
 * - ทางที่อนุญาต (ตรง trigger guard_credit_rule_versioning 0010): ร่าง→เผยแพร่ ·
 *   ใช้งาน→ปลดระวัง — แถว retired ไม่มีปุ่ม (จบ lifecycle · แก้ = สร้างฉบับใหม่)
 * - ยืนยันผ่าน ConfirmModal ก่อนเสมอ (mutation ของเจ้าหน้าที่ — DS §5.8) · สำเร็จ →
 *   router.refresh() · ผิด transition (เช่น แข่งกับเจ้าหน้าที่คนอื่น) → ข้อความไทยเจาะจง
 *   จาก BFF (ERR-VAL-001 invalid_transition)
 * - ปุ่มเรนเดอร์เฉพาะผู้ถือ credit_rule:update (หน้าเป็นผู้ส่ง canUpdate)
 */
export function CreditRuleRowActions({
  ruleId,
  code,
  status,
  canUpdate,
}: {
  readonly ruleId: string;
  readonly code: string;
  readonly status: "draft" | "active" | "retired";
  readonly canUpdate: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"active" | "retired" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actions = ruleLifecycleActions(status);
  if (!canUpdate || actions.length === 0) {
    return <span className="text-sm text-ink-500">—</span>;
  }

  const action = actions[0]!;

  const handleConfirm = async () => {
    if (pending === null) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await updateCreditRuleStatus(ruleId, pending);
      setConfirmOpen(false);
      setPending(null);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="rounded-[10px] border border-brand-600 bg-white px-3 py-1.5 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
        disabled={submitting}
        onClick={() => {
          setPending(action.status);
          setError(null);
          setConfirmOpen(true);
        }}
      >
        {action.label}
      </button>
      <ConfirmModal
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
          setPending(null);
        }}
        title={action.status === "active" ? "เผยแพร่กฎเครดิต" : "ปลดระวังกฎเครดิต"}
        description={
          action.status === "active"
            ? `ยืนยันเผยแพร่กฎ ${code} — กฎจะเริ่มใช้จับคู่การได้ credit ตามช่วงเวลามีผล และแก้เนื้อหาไม่ได้อีก`
            : `ยืนยันปลดระวังกฎ ${code} — กฎจะหยุดจับคู่การได้ credit ทันที (ประวัติที่เคยให้ไปคงเดิม)`
        }
        confirmLabel={submitting ? "กำลังบันทึก…" : action.label}
        confirmDisabled={submitting}
        confirmDisabledReason={submitting ? "กำลังบันทึก กรุณารอสักครู่" : undefined}
        onConfirm={() => {
          void handleConfirm();
        }}
      >
        {error !== null ? (
          <div className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            <p>{error}</p>
          </div>
        ) : null}
      </ConfirmModal>
    </>
  );
}

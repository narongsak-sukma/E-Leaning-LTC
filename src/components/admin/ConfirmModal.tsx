"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Modal ยืนยัน / ฟอร์มโมดัล — DESIGN-SYSTEM §5.8
 * - ฉากหลังดำ 55% + blur 2px, กล่องขาว rounded-[14px] shadow-pop max-w-lg
 * - a11y: role="dialog" + aria-modal + Esc ปิด + focus trap + ล็อก scroll + คืน focus ตอนปิด
 * - ปุ่มยืนยันรองรับสถานะ disabled พร้อมเหตุผล (tooltip) — สำหรับปุ่มที่ยังไม่เชื่อมต่อ API
 */

export type ConfirmModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string | undefined;
  /** เนื้อหาเพิ่มเติมกลางกล่อง (เช่น ช่องกรอกของฟอร์ม) */
  children?: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean | undefined;
  /** เหตุผลที่ปุ่มยืนยันกดไม่ได้ — แสดงเป็น tooltip (title) + ข้อความ sr-only */
  confirmDisabledReason?: string | undefined;
  cancelLabel?: string | undefined;
  onConfirm?: (() => void) | undefined;
};

export function ConfirmModal({
  open,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  confirmDisabled = false,
  confirmDisabledReason,
  cancelLabel = "ยกเลิก",
  onConfirm,
}: ConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = "confirm-modal-title";

  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const items = Array.from(focusables).filter((element) => element.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-ink-900/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-lg rounded-[14px] bg-white p-6 shadow-pop focus:outline-none"
      >
        <h2 id={titleId} className="font-heading text-lg font-semibold text-ink-900">
          {title}
        </h2>
        {description ? (
          <p className="mt-2 text-sm leading-relaxed text-ink-600">{description}</p>
        ) : null}
        {children ? <div className="mt-4">{children}</div> : null}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[10px] px-[18px] py-2.5 font-heading text-base font-semibold text-brand-700 hover:bg-brand-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            title={confirmDisabledReason}
            className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px disabled:cursor-not-allowed disabled:bg-mist-200 disabled:text-ink-500"
          >
            {confirmLabel}
          </button>
          {confirmDisabled && confirmDisabledReason ? (
            <span className="sr-only">{confirmDisabledReason}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

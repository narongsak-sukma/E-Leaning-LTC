"use client";

/**
 * ExportDeleteActions — ปุ่มส่งออกข้อมูล + ขอลบบัญชี ของหน้า my/privacy
 * (D-p5-13 items 3-4 · SEC-011/IDENT-008 · lane E)
 *
 * - export: GET /profile/export → 202 {jobId,status} — สำเร็จ = แสดงสถานะ "กำลังเตรียมไฟล์
 *   — ระบบจะแจ้งทางอีเมลและแจ้งเตือนในระบบเมื่อพร้อม พร้อมลิงก์ดาวน์โหลดที่ใช้ได้ 7 วัน"
 *   · 409 (มี pending อยู่) / 429 (cooldown 24 ชม.) = ข้อความไทยจาก envelope หรือ fallback
 * - delete: ปุ่มเปิด ConfirmModal (components/admin — ใช้ซ้ำแบบ read-only) พร้อมคำเตือน
 *   retention "ผลการสอบและประวัติการตรวจสอบถูกเก็บตามกฎหมาย" → ยืนยัน → POST /profile/delete
 *   → 202 = ข้อความ "โปรดตรวจอีเมลเพื่อยืนยันการลบบัญชี (ลิงก์มีอายุ 24 ชั่วโมง)"
 *   · 403 (guard บทบาทพนักงาน/ผู้สอน) = ข้อความจาก envelope หรือ fallback
 *
 * ลำดับ useState (ผูกกับ test — ห้ามสลับ): 1 exportBusy · 2 exportStatus · 3 deleteBusy ·
 * 4 deleteStatus · 5 dialogOpen
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmModal } from "@/components/admin/ConfirmModal";

import { requestMyAccountDeletion, requestMyDataExport } from "./api";

/** ข้อความสถานะของปุ่มใดปุ่มหนึ่ง — kind=success → role=status · kind=error → role=alert */
export interface ActionStatus {
  readonly kind: "success" | "error";
  readonly text: string;
}

/** ข้อความสำเร็จของ export — ตามที่ D-p5-13 กำหนดเป๊ะ (แจ้งล่วงหน้าว่าไฟล์มาทางไหน) */
export const EXPORT_PENDING_TEXT =
  "กำลังเตรียมไฟล์ — ระบบจะแจ้งทางอีเมลและแจ้งเตือนในระบบเมื่อพร้อม พร้อมลิงก์ดาวน์โหลดที่ใช้ได้ 7 วัน";

/** ข้อความสำเร็จของ delete — ตามที่ D-p5-13 กำหนดเป๊ะ */
export const DELETE_PENDING_TEXT = "โปรดตรวจอีเมลเพื่อยืนยันการลบบัญชี (ลิงก์มีอายุ 24 ชั่วโมง)";

/** คำเตือนใน ConfirmModal ของการลบบัญชี — retention ตาม SEC-012 */
export const DELETE_CONFIRM_WARNING =
  "การลบบัญชีเป็นแบบถาวร เมื่อยืนยันแล้วจะเข้าสู่ระบบไม่ได้อีก ข้อมูลโปรไฟล์และการเรียนของท่านจะถูกลบ " +
  "อย่างไรก็ตาม ผลการสอบและประวัติการตรวจสอบถูกเก็บตามกฎหมาย — ระบบจึงเก็บรักษาไว้ตามระยะเวลาที่กฎหมายกำหนด";

/**
 * ข้อความกลางของชั้นขนส่ง (transport fallback) — ใช้แยก "envelope ไม่มีข้อความเฉพาะ"
 * ออกจาก "มีข้อความไทยจาก BFF" เพื่อให้ fallback ตาม code (409/429/403) ถึงมีที่ให้แสดง
 */
export const GENERIC_TRANSPORT_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";

/**
 * ข้อความไทยจาก envelope ของ BFF — null เมื่อไม่มี "ข้อความเฉพาะ" (ว่าง หรือเป็น
 * fallback กลางของชั้นขนส่ง)
 */
export function envelopeMessageOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (
      typeof message === "string" &&
      message.length > 0 &&
      message !== GENERIC_TRANSPORT_MESSAGE
    ) {
      return message;
    }
  }
  return null;
}

/**
 * ข้อความ error ของ action — ข้อความจาก envelope ก่อน (error tags ของ BFF) ·
 * ไม่มีข้อความเฉพาะ → fallback ไทยที่ให้มา
 */
export function actionErrorText(error: unknown, fallback: string): string {
  return envelopeMessageOf(error) ?? fallback;
}

export function ExportDeleteActions() {
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<ActionStatus | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<ActionStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleExport = useCallback(async (): Promise<void> => {
    if (exportBusy) {
      return;
    }
    setExportBusy(true);
    setExportStatus(null);
    try {
      await requestMyDataExport();
      if (!mountedRef.current) {
        return;
      }
      setExportStatus({ kind: "success", text: EXPORT_PENDING_TEXT });
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      const text =
        envelopeMessageOf(error) ??
        (code === "HTTP_409" || code === "ERR-CONFLICT-001"
          ? "คุณมีคำขอส่งออกที่กำลังดำเนินการอยู่แล้ว กรุณารอการแจ้งเตือนเมื่อไฟล์พร้อม"
          : code === "HTTP_429" || code === "ERR-RATE-001"
            ? "ท่านเพิ่งขอส่งออกข้อมูลไป ระบบให้ขอได้ทุก 24 ชั่วโมง กรุณาลองใหม่ภายหลัง"
            : actionErrorText(error, "ขอส่งออกข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"));
      setExportStatus({ kind: "error", text });
    } finally {
      setExportBusy(false);
    }
  }, [exportBusy]);

  /** ยืนยันจาก ConfirmModal → POST /profile/delete — ปิด dialog แล้วแสดงผลเป็นแผงใต้ปุ่ม */
  const handleDeleteConfirm = useCallback(async (): Promise<void> => {
    if (deleteBusy) {
      return;
    }
    setDeleteBusy(true);
    setDeleteStatus(null);
    try {
      await requestMyAccountDeletion();
      if (!mountedRef.current) {
        return;
      }
      setDialogOpen(false);
      setDeleteStatus({ kind: "success", text: DELETE_PENDING_TEXT });
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      const text =
        envelopeMessageOf(error) ??
        (code === "HTTP_403" || code === "ERR-AUTHZ-003"
          ? "บัญชีเจ้าหน้าที่หรือผู้สอนต้องขอลบผ่านผู้ดูแลระบบเท่านั้น"
          : actionErrorText(error, "ขอลบบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"));
      setDeleteStatus({ kind: "error", text });
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy]);

  return (
    <section aria-labelledby="export-delete-heading" className="mt-6">
      <h2 id="export-delete-heading" className="font-heading text-lg font-semibold text-ink-900">
        ส่งออกหรือลบข้อมูลของท่าน
      </h2>
      <p className="mt-1 text-sm text-ink-600">
        สิทธิของเจ้าของข้อมูลตาม PDPA — ขอสำเนาข้อมูลที่ระบบเก็บ หรือขอลบบัญชี
      </p>

      {exportStatus !== null ? (
        exportStatus.kind === "success" ? (
          <p role="status" data-testid="privacy-export-status" className="mt-3 rounded-[10px] bg-success-50 p-3 text-sm text-success-600">
            {exportStatus.text}
          </p>
        ) : (
          <p role="alert" data-testid="privacy-export-status" className="mt-3 rounded-[10px] border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
            {exportStatus.text}
          </p>
        )
      ) : null}
      {deleteStatus !== null ? (
        deleteStatus.kind === "success" ? (
          <p role="status" data-testid="privacy-delete-status" className="mt-3 rounded-[10px] bg-success-50 p-3 text-sm text-success-600">
            {deleteStatus.text}
          </p>
        ) : (
          <p role="alert" data-testid="privacy-delete-status" className="mt-3 rounded-[10px] border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
            {deleteStatus.text}
          </p>
        )
      ) : null}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-[14px] border border-mist-200 bg-white p-4 shadow-card">
          <p className="font-semibold text-ink-900">ขอสำเนาข้อมูลส่วนบุคคล</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            ระบบจะประกอบไฟล์ JSON ข้อมูลของท่าน (โปรไฟล์ การเรียน ผลสอบ ใบประกาศฯ หน่วยกิต
            และการแจ้งเตือน) แล้วส่งลิงก์ดาวน์โหลดทางอีเมล — ลิงก์ใช้ได้ 7 วัน
          </p>
          <button
            type="button"
            data-testid="privacy-export"
            onClick={() => {
              void handleExport();
            }}
            disabled={exportBusy}
            className="mt-3 rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
          >
            {exportBusy ? "กำลังส่งคำขอ..." : "ขอสำเนาข้อมูล"}
          </button>
        </div>
        <div className="rounded-[10px] border border-danger-200 bg-danger-50/40 p-4">
          <p className="font-semibold text-ink-900">ขอลบบัญชี</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            ระบบจะส่งอีเมลยืนยันไปที่อีเมลของท่าน — กดยืนยันในลิงก์ (อายุ 24 ชั่วโมง)
            จึงจะลบบัญชีจริง และผลการสอบ/ประวัติการตรวจสอบจะถูกเก็บต่อตามกฎหมาย
          </p>
          <button
            type="button"
            data-testid="privacy-delete"
            onClick={() => {
              setDialogOpen(true);
              setDeleteStatus(null);
            }
            }
            disabled={deleteBusy}
            className="mt-3 rounded-[10px] border border-danger-600 px-5 py-2.5 font-heading text-sm font-semibold text-danger-700 hover:bg-danger-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            ขอลบบัญชี
          </button>
        </div>
      </div>

      <ConfirmModal
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
        }}
        onConfirm={() => {
          void handleDeleteConfirm();
        }}
        title="ยืนยันการขอลบบัญชี"
        description={DELETE_CONFIRM_WARNING}
        confirmLabel={deleteBusy ? "กำลังส่งคำขอ..." : "ยืนยันขอลบบัญชี"}
        cancelLabel="ยกเลิก"
        confirmDisabled={deleteBusy}
      />
    </section>
  );
}

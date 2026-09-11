"use client";

import { useReducer, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AdminApiError,
  postAdminJson,
  TRANSPORT_FALLBACK_MESSAGE,
  unwrapDataEnvelope,
} from "@/lib/exam-admin.client";
import { validationFieldLabels } from "@/lib/exam-admin.view";
import { ConfirmModal } from "./ConfirmModal";

/**
 * ปุ่ม/แผงจัดการประกาศนียบัตร (Wave D · D-7)
 *
 * - IssueCertificateButton — คิวผู้มีสิทธิ์ → ออกใบ (POST /api/v1/admin/certificates
 *   body {enrollmentId} strict → 201 IssuedCertificateResource)
 * - CertificateRowActions (Wave E · PB-20) — ปุ่มเพิกถอน/ออกใบแทนต่อแถวของตาราง
 *   ทะเบียนใบ (ย้ายมาจากแผงรับ uuid เดิม — ใช้ id ของแถวแทนการพิมพ์ uuid):
 *   เพิกถอน POST .../{id}/revoke body {reason} ≥10 ตัวอักษร / ออกใบแทน
 *   POST .../{id}/reissue ไม่มี body → 201 · แสดงเฉพาะแถวสถานะ valid
 * - ทุก action ร้ายแรงผ่าน ConfirmModal ภาษาไทยก่อนยิงเสมอ · 403 → แจ้งไม่มีสิทธิ์
 *   (ERR-RBAC-001) ไม่ crash · ข้อมูลใบที่ได้กลับตรวจรูปก่อนใช้ (fail-closed → null)
 */

/** ความยาวขั้นต่ำของเหตุผลการเพิกถอน (mirror zod ของ route จริง — ประกาศ local ตามขอบเขตไฟล์) */
export const REVOKE_REASON_MIN_LENGTH = 10;

/** เหตุผลเพิกถอนผ่านเงื่อนไข — trim แล้วยาว ≥10 (mirror route จริง) */
export function revokeReasonValid(reason: string): boolean {
  return reason.trim().length >= REVOKE_REASON_MIN_LENGTH;
}

/** uuid แบบง่าย (กันส่ง id มั่ว ๆ ขึ้น BFF — BFF ยังตรวจซ้ำเสมอ) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** รูปแบบ uuid → boolean */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoStringOf(value: string): string | null {
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/* ─── parsers ของ resource ที่ BFF ตอบกลับ — ผิดรูป = fail-closed (null) ─── */

/** มุมมองใบที่ออกแล้ว (IssuedCertificateResource ของ BFF — camelCase เป๊ะ) */
export interface IssuedCertificateView {
  readonly id: string;
  readonly certNo: string;
  readonly verifyCode: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderNameSnapshot: string;
  readonly courseTitleSnapshot: string;
  readonly creditSnapshot: number | null;
  readonly status: "valid";
  readonly issuedAt: string;
  readonly pdfMediaId: string | null;
}

/** มุมมองใบที่เพิกถอน (RevokedCertificateResource) */
export interface RevokedCertificateView {
  readonly id: string;
  readonly certNo: string;
  readonly status: "revoked";
  readonly revokedAt: string;
  readonly revokedReason: string;
}

/** มุมมองผล reissue (ReissuedCertificateResource) */
export interface ReissuedCertificateView {
  readonly newCertificate: IssuedCertificateView;
  readonly oldCertificateId: string;
  readonly oldStatus: "superseded";
  readonly oldSupersededBy: string;
}

/**
 * ตรวจแถวใบที่ออกแล้ว — คืน view หรือ null (contract drift = ไม่แสดงผลเด็ดขาด)
 * creditSnapshot เป็น null ได้จริง — แยก "null จริง" จาก "type ผิด" ให้ชัด
 */
export function parseIssuedCertificateView(raw: unknown): IssuedCertificateView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredString(raw, "id");
  const certNo = requiredString(raw, "certNo");
  const verifyCode = requiredString(raw, "verifyCode");
  const enrollmentId = requiredString(raw, "enrollmentId");
  const userId = requiredString(raw, "userId");
  const courseId = requiredString(raw, "courseId");
  const holderNameSnapshot = requiredString(raw, "holderNameSnapshot");
  const courseTitleSnapshot = requiredString(raw, "courseTitleSnapshot");
  const creditRaw = raw["creditSnapshot"];
  const creditOk =
    creditRaw === null ||
    (typeof creditRaw === "number" && Number.isInteger(creditRaw));
  const creditSnapshot =
    creditRaw === null
      ? null
      : typeof creditRaw === "number" && Number.isInteger(creditRaw)
        ? creditRaw
        : null;
  const statusOk = raw["status"] === "valid";
  const issuedAtRaw = requiredString(raw, "issuedAt");
  const issuedAt = issuedAtRaw === null ? null : isoStringOf(issuedAtRaw);
  const pdfRaw = raw["pdfMediaId"];
  const pdfMediaId =
    pdfRaw === null ? null : typeof pdfRaw === "string" && pdfRaw.length > 0 ? pdfRaw : null;
  if (
    id === null ||
    certNo === null ||
    verifyCode === null ||
    enrollmentId === null ||
    userId === null ||
    courseId === null ||
    holderNameSnapshot === null ||
    courseTitleSnapshot === null ||
    !statusOk ||
    !creditOk ||
    issuedAt === null ||
    pdfMediaId === null && pdfRaw !== null
  ) {
    return null;
  }
  return {
    id,
    certNo,
    verifyCode,
    enrollmentId,
    userId,
    courseId,
    holderNameSnapshot,
    courseTitleSnapshot,
    creditSnapshot,
    status: "valid",
    issuedAt,
    pdfMediaId,
  };
}

/** ตรวจแถวใบที่เพิกถอน — ผิดรูป → null */
export function parseRevokedCertificateView(raw: unknown): RevokedCertificateView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredString(raw, "id");
  const certNo = requiredString(raw, "certNo");
  const statusOk = raw["status"] === "revoked";
  const revokedAtRaw = requiredString(raw, "revokedAt");
  const revokedAt = revokedAtRaw === null ? null : isoStringOf(revokedAtRaw);
  const revokedReason = requiredString(raw, "revokedReason");
  if (id === null || certNo === null || !statusOk || revokedAt === null || revokedReason === null) {
    return null;
  }
  return { id, certNo, status: "revoked", revokedAt, revokedReason };
}

/** ตรวจผล reissue — ผิดรูป → null (newCertificate ตรวจซ้ำด้วย parser ใบ valid เสมอ) */
export function parseReissuedCertificateView(raw: unknown): ReissuedCertificateView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const newCertificate = parseIssuedCertificateView(raw["newCertificate"]);
  const oldCertificateId = requiredString(raw, "oldCertificateId");
  const oldStatusOk = raw["oldStatus"] === "superseded";
  const oldSupersededBy = requiredString(raw, "oldSupersededBy");
  if (
    newCertificate === null ||
    oldCertificateId === null ||
    !oldStatusOk ||
    oldSupersededBy === null
  ) {
    return null;
  }
  return { newCertificate, oldCertificateId, oldStatus: "superseded", oldSupersededBy };
}

/* ─── state machine ของปุ่มออกใบ (pure — test ได้ใน node) ─── */

export type CertIssuePhase = "idle" | "confirming" | "submitting" | "success" | "error";

export interface CertIssueState {
  readonly phase: CertIssuePhase;
  /** ข้อความสำเร็จ/ล้มเหลวที่คงอยู่ในโมดัลจนกดปิด (กัน unmount ทิ้งผลลัพธ์) */
  readonly message: string | null;
  /** certNo ของใบที่ออกสำเร็จ — null จนกว่าจะสำเร็จ */
  readonly issuedCertNo: string | null;
}

export type CertIssueEvent =
  | { type: "OPEN_CONFIRM" }
  | { type: "CANCEL" }
  | { type: "SUBMIT" }
  | { type: "RESOLVE_SUCCESS"; certNo: string }
  | { type: "REJECT"; message: string }
  | { type: "CLOSE" };

/** reducer ของปุ่มออกใบ — idle → confirming → submitting → success | error → idle */
export function certIssueReducer(state: CertIssueState, event: CertIssueEvent): CertIssueState {
  switch (event.type) {
    case "OPEN_CONFIRM":
      return state.phase === "idle" ? { phase: "confirming", message: null, issuedCertNo: null } : state;
    case "CANCEL":
      return state.phase === "confirming" ? { phase: "idle", message: null, issuedCertNo: null } : state;
    case "SUBMIT":
      return state.phase === "confirming" ? { phase: "submitting", message: null, issuedCertNo: null } : state;
    case "RESOLVE_SUCCESS":
      return state.phase === "submitting"
        ? { phase: "success", message: null, issuedCertNo: event.certNo }
        : state;
    case "REJECT":
      return state.phase === "submitting"
        ? { phase: "error", message: event.message, issuedCertNo: null }
        : state;
    case "CLOSE":
      return { phase: "idle", message: null, issuedCertNo: null };
    default:
      return state;
  }
}

/* ─── component — ปุ่มออกใบต่อแถวคิว (client) ─── */

const CERTIFICATE_CREATE_PATH = "/api/v1/admin/certificates";

/** หัวข้อโมดัลตาม phase — ภาษาไทยทั้งหมด */
export function issueTitleOf(phase: CertIssuePhase): string {
  if (phase === "success") {
    return "ออกใบสำเร็จ";
  }
  if (phase === "error") {
    return "ออกใบไม่สำเร็จ";
  }
  return "ยืนยันการออกประกาศนียบัตร";
}

/** ป้ายปุ่มยืนยันตาม phase */
export function issueConfirmLabelOf(phase: CertIssuePhase): string {
  if (phase === "success" || phase === "error") {
    return "ปิด";
  }
  if (phase === "submitting") {
    return "กำลังออกใบ...";
  }
  return "ยืนยันออกใบ";
}


export interface IssueCertificateButtonProps {
  readonly enrollmentId: string;
  /** ชื่อผู้มีสิทธิ์ (แสดงใน confirm dialog — ค่าว่างได้ตาม r7-M1) */
  readonly holderName: string;
  readonly courseTitle: string;
  /** certificate:issue — false = ไม่แสดงปุ่ม (ตัดสินที่ BFF เสมอ) */
  readonly canIssue: boolean;
}

export function IssueCertificateButton({
  enrollmentId,
  holderName,
  courseTitle,
  canIssue,
}: IssueCertificateButtonProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(certIssueReducer, {
    phase: "idle",
    message: null,
    issuedCertNo: null,
  });

  /** จุดเดียวที่ map error ของ BFF → ข้อความไทย */
  const describeError = (error: unknown): string => {
    if (error instanceof AdminApiError && error.status === 403) {
      return "คุณไม่มีสิทธิ์ออกประกาศนียบัตร (ERR-RBAC-001)";
    }
    if (error instanceof AdminApiError && error.status === 409) {
      return "ผู้เรียนนี้มีใบ valid อยู่แล้ว — รายการจะรีเฟรชให้อัตโนมัติ";
    }
    if (error instanceof AdminApiError && error.code === "ERR-VAL-001") {
      return `ข้อมูลไม่ถูกต้อง: ${validationFieldLabels(error.fields).join(", ")}`;
    }
    if (error instanceof AdminApiError) {
      return error.message;
    }
    return TRANSPORT_FALLBACK_MESSAGE;
  };

  const handleClose = () => {
    dispatch({ type: "CLOSE" });
  };

  const handleSubmit = async () => {
    dispatch({ type: "SUBMIT" });
    try {
      const { body } = await postAdminJson(CERTIFICATE_CREATE_PATH, { enrollmentId });
      const data = unwrapDataEnvelope(body);
      const view = data === null ? null : parseIssuedCertificateView(data);
      if (view === null) {
        dispatch({
          type: "REJECT",
          message: "ระบบตอบกลับรูปแบบไม่ถูกต้อง กรุณาลองใหม่ (ไม่ได้ออกใบ)",
        });
        return;
      }
      dispatch({ type: "RESOLVE_SUCCESS", certNo: view.certNo });
      router.refresh();
    } catch (error) {
      dispatch({ type: "REJECT", message: describeError(error) });
    }
  };

  if (!canIssue) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="rounded-[10px] bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-200 disabled:text-ink-500"
        disabled={state.phase === "submitting"}
        onClick={() => dispatch({ type: "OPEN_CONFIRM" })}
      >
        ออกใบประกาศนียบัตร
      </button>
      <ConfirmModal
        open={state.phase !== "idle"}
        onClose={handleClose}
        title={issueTitleOf(state.phase)}
        description={
          state.phase === "confirming"
            ? `ยืนยันการออกใบสำหรับ ${holderName || "(ยังไม่ระบุชื่อ)"} — หลักสูตร ${courseTitle} หากออกแล้วจะเข้าทะเบียนทันที`
            : undefined
        }
        confirmLabel={issueConfirmLabelOf(state.phase)}
        confirmDisabled={state.phase === "submitting"}
        confirmDisabledReason={state.phase === "submitting" ? "กำลังออกใบ กรุณารอสักครู่" : undefined}
        cancelLabel={state.phase === "success" || state.phase === "error" ? "ปิด" : "ยกเลิก"}
        onConfirm={() => {
          if (state.phase === "confirming") {
            void handleSubmit();
            return;
          }
          if (state.phase === "success" || state.phase === "error") {
            handleClose();
          }
        }}
      >
        {state.phase === "success" ? (
          <p className="rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
            ออกใบสำเร็จ เลขที่ {state.issuedCertNo ?? "—"} — รายการคิวจะรีเฟรชอัตโนมัติ
          </p>
        ) : null}
        {state.phase === "error" ? (
          <p className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            {state.message ?? "เกิดข้อผิดพลาด กรุณาลองใหม่"}
          </p>
        ) : null}
      </ConfirmModal>
    </>
  );
}


/* ─── state machine ของปุ่มเพิกถอน/ออกใบแทนต่อแถว (pure — test ได้ใน node) ─── */

export type CertRowActionPhase = "idle" | "confirming" | "submitting" | "success" | "error";

/** ชนิด action ของแถว — กำหนดโมดัลที่เปิด (เพิกถอนมีช่องเหตุผล · ออกใบแทนไม่มี) */
export type CertRowActionKind = "revoke" | "reissue";

export interface CertRowActionState {
  readonly phase: CertRowActionPhase;
  readonly actionKind: CertRowActionKind | null;
  /** เหตุผลเพิกถอน — พิมพ์ได้เฉพาะช่วง confirming ของ revoke (ค้างเนื้อความเดิมตอน submitting) */
  readonly reason: string;
  /** ข้อความสำเร็จ/ล้มเหลวที่คงอยู่จนกดปิด (กัน unmount ทิ้งผลลัพธ์) */
  readonly message: string | null;
  /** certNo ของผลลัพธ์ (ใบใหม่ของ reissue) — null จนกว่าจะสำเร็จ */
  readonly resultCertNo: string | null;
}

export const CERT_ROW_ACTION_DEFAULT: CertRowActionState = {
  phase: "idle",
  actionKind: null,
  reason: "",
  message: null,
  resultCertNo: null,
};

export type CertRowActionEvent =
  | { type: "REQUEST_REVOKE" }
  | { type: "REQUEST_REISSUE" }
  | { type: "TYPE_REASON"; value: string }
  | { type: "SUBMIT" }
  | { type: "RESOLVE_SUCCESS"; certNo: string }
  | { type: "REJECT"; message: string }
  | { type: "CLOSE" };

/**
 * reducer ต่อแถว — idle → confirming → submitting → success | error → idle
 * ปุ่มเปิดได้ทีละ action (REQUEST_* ตาม actionKind ห้ามสลับกลางอากาศ)
 */
export function certRowActionReducer(state: CertRowActionState, event: CertRowActionEvent): CertRowActionState {
  switch (event.type) {
    case "REQUEST_REVOKE":
      return state.phase === "idle"
        ? { phase: "confirming", actionKind: "revoke", reason: "", message: null, resultCertNo: null }
        : state;
    case "REQUEST_REISSUE":
      return state.phase === "idle"
        ? { phase: "confirming", actionKind: "reissue", reason: "", message: null, resultCertNo: null }
        : state;
    case "TYPE_REASON":
      return state.phase === "confirming" && state.actionKind === "revoke"
        ? { ...state, reason: event.value }
        : state;
    case "SUBMIT":
      return state.phase === "confirming"
        ? { ...state, phase: "submitting" }
        : state;
    case "RESOLVE_SUCCESS":
      return state.phase === "submitting"
        ? { ...state, phase: "success", message: null, resultCertNo: event.certNo }
        : state;
    case "REJECT":
      return state.phase === "submitting"
        ? { ...state, phase: "error", message: event.message }
        : state;
    case "CLOSE":
      return CERT_ROW_ACTION_DEFAULT;
    default:
      return state;
  }
}

/** หัวข้อโมดัลตาม phase + actionKind — ภาษาไทยทั้งหมด */
export function manageTitleOf(phase: CertRowActionPhase, kind: CertRowActionKind): string {
  if (phase === "success") {
    return kind === "revoke" ? "เพิกถอนสำเร็จ" : "ออกใบแทนสำเร็จ";
  }
  if (phase === "error") {
    return kind === "revoke" ? "เพิกถอนไม่สำเร็จ" : "ออกใบแทนไม่สำเร็จ";
  }
  return kind === "revoke" ? "ยืนยันการเพิกถอนประกาศนียบัตร" : "ยืนยันการออกใบแทน";
}

/** ป้ายปุ่มยืนยันตาม phase + actionKind */
export function manageConfirmLabelOf(phase: CertRowActionPhase, kind: CertRowActionKind): string {
  if (phase === "success" || phase === "error") {
    return "ปิด";
  }
  if (phase === "submitting") {
    return kind === "revoke" ? "กำลังเพิกถอน..." : "กำลังออกใบแทน...";
  }
  return kind === "revoke" ? "ยืนยันเพิกถอน" : "ยืนยันออกใบแทน";
}

/* ─── component — ปุ่มเพิกถอน/ออกใบแทนต่อแถวทะเบียน (client · Wave E PB-20) ─── */

const CERT_REVOKE_PATH_PREFIX = "/api/v1/admin/certificates";

export interface CertificateRowActionsProps {
  /** id ของใบจากแถวตาราง — ใช้แทนการพิมพ์ uuid (ย้ายมาจากแผง uuid เดิม) */
  readonly certificateId: string;
  /** เลขที่ใบ — ใช้ใน confirm dialog + aria-label (ไม่ log ที่ฝั่ง client) */
  readonly certNo: string;
  /** แสดงปุ่มเฉพาะแถว valid — revoked/superseded ไม่มี action ให้ทำ */
  readonly status: "valid" | "revoked" | "superseded";
  /** D55-2 — false = ไม่แสดงปุ่ม (ตัดสินที่ BFF เสมอ) */
  readonly canManage: boolean;
}

export function CertificateRowActions({
  certificateId,
  certNo,
  status,
  canManage,
}: CertificateRowActionsProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(certRowActionReducer, CERT_ROW_ACTION_DEFAULT);
  /** error ของช่องเหตุผล (ตรวจตอนกดยืนยัน — เคลียร์เมื่อแก้/ปิดโมดัล) */
  const [reasonError, setReasonError] = useState<string | null>(null);

  /** จุดเดียวที่ map error ของ BFF → ข้อความไทย (แบบ IssueCertificateButton) */
  const describeError = (error: unknown): string => {
    if (error instanceof AdminApiError && error.status === 403) {
      return "คุณไม่มีสิทธิ์จัดการประกาศนียบัตร (ERR-RBAC-001)";
    }
    if (error instanceof AdminApiError && error.status === 409) {
      return "สถานะของใบเปลี่ยนไปแล้ว — รายการจะรีเฟรชให้อัตโนมัติ";
    }
    if (error instanceof AdminApiError && error.status === 404) {
      return "ไม่พบประกาศนียบัตรนี้ — รายการจะรีเฟรชให้อัตโนมัติ";
    }
    if (error instanceof AdminApiError && error.code === "ERR-VAL-001") {
      return `ข้อมูลไม่ถูกต้อง: ${validationFieldLabels(error.fields).join(", ")}`;
    }
    if (error instanceof AdminApiError) {
      return error.message;
    }
    return TRANSPORT_FALLBACK_MESSAGE;
  };

  const handleClose = () => {
    setReasonError(null);
    dispatch({ type: "CLOSE" });
  };

  /** กดยืนยันในโมดัล — ตรวจเหตุผลของ revoke ที่นี่ (กันยิง BFF ด้วยเหตุผลสั้นเกิน) */
  const handleConfirm = () => {
    if (state.phase === "confirming") {
      if (state.actionKind === "revoke" && !revokeReasonValid(state.reason)) {
        setReasonError(`กรุณาระบุเหตุผลอย่างน้อย ${REVOKE_REASON_MIN_LENGTH} ตัวอักษร`);
        return;
      }
      void performSubmit();
      return;
    }
    if (state.phase === "success" || state.phase === "error") {
      handleClose();
    }
  };

  const performSubmit = async () => {
    const kind = state.actionKind;
    if (kind === null) {
      return;
    }
    dispatch({ type: "SUBMIT" });
    try {
      if (kind === "revoke") {
        const { body } = await postAdminJson(
          `${CERT_REVOKE_PATH_PREFIX}/${certificateId}/revoke`,
          { reason: state.reason.trim() },
        );
        const data = unwrapDataEnvelope(body);
        const view = data === null ? null : parseRevokedCertificateView(data);
        if (view === null) {
          dispatch({
            type: "REJECT",
            message: "ระบบตอบกลับรูปแบบไม่ถูกต้อง กรุณาลองใหม่ (ยังไม่ได้เพิกถอน)",
          });
          return;
        }
        dispatch({ type: "RESOLVE_SUCCESS", certNo: view.certNo });
      } else {
        const { body } = await postAdminJson(
          `${CERT_REVOKE_PATH_PREFIX}/${certificateId}/reissue`,
          {},
        );
        const data = unwrapDataEnvelope(body);
        const view = data === null ? null : parseReissuedCertificateView(data);
        if (view === null) {
          dispatch({
            type: "REJECT",
            message: "ระบบตอบกลับรูปแบบไม่ถูกต้อง กรุณาลองใหม่ (ยังไม่ได้ออกใบแทน)",
          });
          return;
        }
        dispatch({ type: "RESOLVE_SUCCESS", certNo: view.newCertificate.certNo });
      }
      router.refresh();
    } catch (error) {
      dispatch({ type: "REJECT", message: describeError(error) });
    }
  };

  if (!canManage || status !== "valid") {
    return null;
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-[10px] border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-mist-200 disabled:text-ink-500"
          aria-label={`เพิกถอนใบ ${certNo}`}
          disabled={state.phase !== "idle"}
          onClick={() => dispatch({ type: "REQUEST_REVOKE" })}
        >
          เพิกถอน
        </button>
        <button
          type="button"
          className="rounded-[10px] border border-brand-300 px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:bg-mist-200 disabled:text-ink-500"
          aria-label={`ออกใบแทนใบ ${certNo}`}
          disabled={state.phase !== "idle"}
          onClick={() => dispatch({ type: "REQUEST_REISSUE" })}
        >
          ออกใบแทน
        </button>
      </div>
      <ConfirmModal
        open={state.phase !== "idle"}
        onClose={handleClose}
        title={manageTitleOf(state.phase, state.actionKind === "reissue" ? "reissue" : "revoke")}
        description={
          state.phase === "confirming"
            ? state.actionKind === "revoke"
              ? `ยืนยันเพิกถอนใบ ${certNo} — ใบจะไม่สามารถใช้ตรวจสอบสิทธิ์ได้ทันที`
              : `ยืนยันออกใบแทนใบ ${certNo} — ใบเดิมจะถูกแทนด้วยใบใหม่ (สถานะ superseded)`
            : undefined
        }
        confirmLabel={manageConfirmLabelOf(state.phase, state.actionKind === "reissue" ? "reissue" : "revoke")}
        confirmDisabled={state.phase === "submitting"}
        confirmDisabledReason={state.phase === "submitting" ? "กำลังดำเนินการ กรุณารอสักครู่" : undefined}
        cancelLabel={state.phase === "success" || state.phase === "error" ? "ปิด" : "ยกเลิก"}
        onConfirm={handleConfirm}
      >
        {state.phase === "confirming" && state.actionKind === "revoke" ? (
          <div className="space-y-1">
            <label className="block text-sm font-medium text-ink-700" htmlFor="cert-revoke-reason">
              เหตุผลการเพิกถอน <span className="text-red-600">(จำเป็น · อย่างน้อย {REVOKE_REASON_MIN_LENGTH} ตัวอักษร)</span>
            </label>
            <textarea
              id="cert-revoke-reason"
              className="w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              rows={3}
              value={state.reason}
              onChange={(event) => {
                setReasonError(null);
                dispatch({ type: "TYPE_REASON", value: event.target.value });
              }}
            />
            {reasonError === null ? null : (
              <p className="text-sm text-red-700" role="alert">
                {reasonError}
              </p>
            )}
          </div>
        ) : null}
        {state.phase === "success" ? (
          <p className="rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
            {state.actionKind === "reissue"
              ? `ออกใบแทนสำเร็จ เลขที่ใบใหม่ ${state.resultCertNo ?? "—"} — รายการจะรีเฟรชอัตโนมัติ`
              : `เพิกถอนสำเร็จ (ใบ ${state.resultCertNo ?? certNo}) — รายการจะรีเฟรชอัตโนมัติ`}
          </p>
        ) : null}
        {state.phase === "error" ? (
          <p className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            {state.message ?? "เกิดข้อผิดพลาด กรุณาลองใหม่"}
          </p>
        ) : null}
      </ConfirmModal>
    </>
  );
}

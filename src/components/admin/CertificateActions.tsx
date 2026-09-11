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
 * - CertificateManagePanel — จัดการใบที่ออกแล้ว: เพิกถอน (POST .../{id}/revoke
 *   body {reason} ≥10 ตัวอักษร) / ออกใบแทน (POST .../{id}/reissue ไม่มี body → 201)
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

/* ─── state machine ของแผงจัดการใบ (pure — test ได้ใน node) ─── */

export type CertManagePhase =
  | "idle"
  | "revoking"
  | "reissuing"
  | "submitting"
  | "success"
  | "error";

/** ชนิดการดำเนินการที่กำลังรัน — กำหนดว่าโมดัลใดเปิดอยู่ */
export type CertManageActionKind = "revoke" | "reissue";

export interface CertManageState {
  readonly phase: CertManagePhase;
  /** ชนิดการดำเนินการล่าสุด — null ตอน idle · คงอยู่ตลอด submitting/error/success */
  readonly actionKind: CertManageActionKind | null;
  readonly certIdInput: string;
  readonly reasonInput: string;
  readonly message: string | null;
  readonly issuedView: IssuedCertificateView | null;
}

export const CERT_MANAGE_DEFAULT: CertManageState = {
  phase: "idle",
  actionKind: null,
  certIdInput: "",
  reasonInput: "",
  message: null,
  issuedView: null,
};

export type CertManageEvent =
  | { type: "TYPE_CERT_ID" | "TYPE_REASON"; value: string }
  | { type: "REQUEST_REVOKE" | "REQUEST_REISSUE" }
  | { type: "SUBMIT" }
  | {
      type: "RESOLVE_SUCCESS";
      view: IssuedCertificateView | RevokedCertificateView | ReissuedCertificateView | null;
    }
  | { type: "REJECT"; message: string }
  | { type: "CLOSE" };

/** แก้ input ได้ตอน idle และ revoking (กรอกเหตุผลในโมดัล) — กันแก้กลางคันขณะกำลังส่ง */
export function certManageReducer(state: CertManageState, event: CertManageEvent): CertManageState {
  switch (event.type) {
    case "TYPE_CERT_ID":
      return state.phase === "idle" ? { ...state, certIdInput: event.value } : state;
    case "TYPE_REASON":
      return state.phase === "idle" || state.phase === "revoking"
        ? { ...state, reasonInput: event.value }
        : state;
    case "REQUEST_REVOKE":
      return state.phase === "idle"
        ? { ...state, phase: "revoking", actionKind: "revoke", message: null, issuedView: null }
        : state;
    case "REQUEST_REISSUE":
      return state.phase === "idle"
        ? { ...state, phase: "reissuing", actionKind: "reissue", message: null, issuedView: null }
        : state;
    case "SUBMIT":
      return state.phase === "revoking" || state.phase === "reissuing"
        ? { ...state, phase: "submitting" }
        : state;
    case "RESOLVE_SUCCESS":
      return state.phase === "submitting"
        ? {
            ...state,
            phase: "success",
            message: null,
            issuedView:
              event.view !== null && "newCertificate" in event.view
                ? event.view.newCertificate
                : null,
          }
        : state;
    case "REJECT":
      return state.phase === "submitting"
        ? { ...state, phase: "error", message: event.message }
        : state;
    case "CLOSE":
      return CERT_MANAGE_DEFAULT;
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

/* ─── component — แผงจัดการใบที่ออกแล้ว (client) ─── */

const CERTIFICATE_REVOKE_PATH_PREFIX = "/api/v1/admin/certificates/";
const REISSUE_SEGMENT = "/reissue";
const REVOKE_SEGMENT = "/revoke";

const REVOKE_TEXTAREA_CLASS =
  "w-full rounded-[10px] border border-mist-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none";

/** หัวข้อโมดัลของแผงจัดการ — ภาษาไทยตามชนิดการดำเนินการและ phase (pure — test ได้) */
export function manageTitleOf(phase: CertManagePhase, kind: "revoke" | "reissue"): string {
  if (phase === "success") {
    return kind === "revoke" ? "เพิกถอนใบสำเร็จ" : "ออกใบแทนสำเร็จ";
  }
  if (phase === "error") {
    return "ดำเนินการไม่สำเร็จ";
  }
  if (phase === "submitting") {
    return kind === "revoke" ? "กำลังเพิกถอนใบ..." : "กำลังออกใบแทน...";
  }
  return kind === "revoke" ? "ยืนยันการเพิกถอนใบประกาศนียบัตร" : "ยืนยันการออกใบแทน";
}

/** ป้ายปุ่มยืนยันของแผงจัดการตาม phase */
export function manageConfirmLabelOf(phase: CertManagePhase): string {
  if (phase === "success" || phase === "error") {
    return "ปิด";
  }
  if (phase === "submitting") {
    return "กำลังดำเนินการ...";
  }
  return "ยืนยันดำเนินการ";
}

export interface CertificateManagePanelProps {
  /** certificate:revoke — false = ซ่อนแผงทั้งหมด (ตัดสินที่ BFF เสมอ) */
  readonly canRevoke: boolean;
}

export function CertificateManagePanel({ canRevoke }: CertificateManagePanelProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(certManageReducer, CERT_MANAGE_DEFAULT);
  const [inputError, setInputError] = useState<string | null>(null);
  // ข้อความตรวจเหตุผลเพิกถอนในโมดัล (แยกจาก inputError ที่อยู่นอกโมดัล —
  // ผู้ใช้มองไม่เห็น inputError ขณะโมดัลเปิดอยู่)
  const [reasonError, setReasonError] = useState<string | null>(null);

  const describeError = (error: unknown): string => {
    if (error instanceof AdminApiError && error.status === 403) {
      return "คุณไม่มีสิทธิ์จัดการประกาศนียบัตร (ERR-RBAC-001)";
    }
    if (error instanceof AdminApiError && error.status === 409) {
      return "สถานะใบไม่ตรงกับการดำเนินการ (เช่น ใบถูกเพิกถอนไปแล้ว)";
    }
    if (error instanceof AdminApiError && error.code === "ERR-VAL-001") {
      return `ข้อมูลไม่ถูกต้อง: ${validationFieldLabels(error.fields).join(", ")}`;
    }
    if (error instanceof AdminApiError && error.status === 404) {
      return "ไม่พบใบประกาศนียบัตรตามรหัสที่ระบุ";
    }
    if (error instanceof AdminApiError) {
      return error.message;
    }
    return TRANSPORT_FALLBACK_MESSAGE;
  };

  /** เริ่มเพิกถอน — ตรวจ uuid ก่อนเปิดโมดัลยืนยัน (เหตุผลกรอก/ตรวจในโมดัลตอนส่งจริง) */
  const requestRevoke = () => {
    if (!isUuid(state.certIdInput)) {
      setInputError("รหัสอ้างอิงต้องเป็น uuid ที่ถูกต้อง");
      return;
    }
    setInputError(null);
    setReasonError(null);
    dispatch({ type: "REQUEST_REVOKE" });
  };

  /** เริ่มออกใบแทน — ตรวจ uuid ก่อนเปิดโมดัลยืนยัน */
  const requestReissue = () => {
    if (!isUuid(state.certIdInput)) {
      setInputError("รหัสอ้างอิงต้องเป็น uuid ที่ถูกต้อง");
      return;
    }
    setInputError(null);
    dispatch({ type: "REQUEST_REISSUE" });
  };

  /** เพิกถอนจริง — POST .../{id}/revoke body {reason} → 200 RevokedCertificateResource */
  const performRevoke = async () => {
    // ตรวจเหตุผลตรงนี้ (ในโมดัล) เพราะช่องกรอกอยู่ในโมดัล — ห้ามตรวจก่อนเปิดโมดัล
    // ไม่งั้นผู้ใช้ไม่มีทางกรอกได้เลย (วงจรตาย)
    if (!revokeReasonValid(state.reasonInput)) {
      setReasonError(
        `กรุณาระบุเหตุผลอย่างน้อย ${REVOKE_REASON_MIN_LENGTH} ตัวอักษรก่อนยืนยันการเพิกถอน`,
      );
      return;
    }
    setReasonError(null);
    const certId = state.certIdInput.trim();
    dispatch({ type: "SUBMIT" });
    try {
      const { body } = await postAdminJson(
        CERTIFICATE_REVOKE_PATH_PREFIX + encodeURIComponent(certId) + REVOKE_SEGMENT,
        { reason: state.reasonInput.trim() },
      );
      const data = unwrapDataEnvelope(body);
      const view = data === null ? null : parseRevokedCertificateView(data);
      if (view === null) {
        dispatch({ type: "REJECT", message: "ระบบตอบกลับรูปแบบไม่ถูกต้อง ลองใหม่อีกครั้ง" });
        return;
      }
      dispatch({ type: "RESOLVE_SUCCESS", view });
      router.refresh();
    } catch (error) {
      dispatch({ type: "REJECT", message: describeError(error) });
    }
  };

  /** ออกใบแทนจริง — POST .../{id}/reissue ไม่มี body → 201 ReissuedCertificateResource */
  const performReissue = async () => {
    const certId = state.certIdInput.trim();
    dispatch({ type: "SUBMIT" });
    try {
      const { body } = await postAdminJson(
        CERTIFICATE_REVOKE_PATH_PREFIX + encodeURIComponent(certId) + REISSUE_SEGMENT,
      );
      const data = unwrapDataEnvelope(body);
      const view = data === null ? null : parseReissuedCertificateView(data);
      if (view === null) {
        dispatch({ type: "REJECT", message: "ระบบตอบกลับรูปแบบไม่ถูกต้อง ลองใหม่อีกครั้ง" });
        return;
      }
      dispatch({ type: "RESOLVE_SUCCESS", view: view.newCertificate });
      router.refresh();
    } catch (error) {
      dispatch({ type: "REJECT", message: describeError(error) });
    }
  };

  const handleClose = () => {
    setReasonError(null);
    dispatch({ type: "CLOSE" });
  };

  if (!canRevoke) {
    return null;
  }

  return (
    <section className="rounded-[14px] border border-mist-300 bg-white p-4">
      <h2 className="font-heading text-base font-semibold text-ink-900">จัดการใบที่ออกแล้ว</h2>
      <p className="mt-1 text-sm text-ink-600">
        ระบุรหัสอ้างอิงใบประกาศนียบัตร (uuid) จากทะเบียน — ระบบยังไม่มีหน้าค้นรายการใบ
        ให้ดำเนินการตามรหัสเท่านั้น
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label className="block">
            <span className="mb-1 block font-heading text-sm font-semibold text-ink-900">
              รหัสอ้างอิงใบ (uuid)
            </span>
            <input
              type="text"
              className="w-full rounded-[10px] border border-mist-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none"
              value={state.certIdInput}
              disabled={state.phase !== "idle"}
              onChange={(event) => dispatch({ type: "TYPE_CERT_ID", value: event.target.value })}
            />
          </label>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className="rounded-[10px] border border-red-600 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={state.phase !== "idle"}
            onClick={requestRevoke}
          >
            เพิกถอนใบ
          </button>
          <button
            type="button"
            className="rounded-[10px] border border-brand-600 px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={state.phase !== "idle"}
            onClick={requestReissue}
          >
            ออกใบแทน
          </button>
        </div>
      </div>
      {inputError !== null ? (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {inputError}
        </p>
      ) : null}

      <ConfirmModal
        open={state.actionKind === "revoke" && state.phase !== "idle"}
        onClose={handleClose}
        title={manageTitleOf(state.phase, "revoke")}
        description={
          state.phase === "revoking"
            ? "การเพิกถอนมีผลทันที และจะถูกบันทึกเหตุผลไว้ในทะเบียน — ดำเนินการต่อหรือไม่"
            : undefined
        }
        confirmLabel={manageConfirmLabelOf(state.phase)}
        confirmDisabled={state.phase === "submitting"}
        confirmDisabledReason={state.phase === "submitting" ? "กำลังดำเนินการ กรุณารอสักครู่" : undefined}
        cancelLabel={state.phase === "submitting" ? "ปิด" : "ยกเลิก"}
        onConfirm={() => {
          if (state.phase === "revoking") {
            void performRevoke();
            return;
          }
          if (state.phase === "success" || state.phase === "error") {
            handleClose();
          }
        }}
      >
        {state.phase === "revoking" ? (
          <label className="block">
            <span className="mb-1 block font-heading text-sm font-semibold text-ink-900">
              เหตุผลการเพิกถอน (บังคับ อย่างน้อย 10 ตัวอักษร)
            </span>
            <textarea
              className={REVOKE_TEXTAREA_CLASS}
              value={state.reasonInput}
              rows={3}
              onChange={(event) => dispatch({ type: "TYPE_REASON", value: event.target.value })}
            />
            {reasonError !== null ? (
              <span className="mt-1 block text-sm text-red-600" role="alert">
                {reasonError}
              </span>
            ) : null}
          </label>
        ) : null}
        {state.phase === "error" && state.message !== null ? (
          <p className="mt-2 rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            {state.message}
          </p>
        ) : null}
        {state.phase === "success" ? (
          <p className="mt-2 rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
            เพิกถอนใบสำเร็จ — สถานะใบเปลี่ยนเป็น &quot;เพิกถอนแล้ว&quot; ทันที
          </p>
        ) : null}
      </ConfirmModal>

      <ConfirmModal
        open={state.actionKind === "reissue" && state.phase !== "idle"}
        onClose={handleClose}
        title={manageTitleOf(state.phase, "reissue")}
        description={
          state.phase === "reissuing"
            ? "ระบบจะปิดใบเดิมเป็น \"superseded\" และออกใบใหม่แทนทันที — ดำเนินการต่อหรือไม่"
            : undefined
        }
        confirmLabel={manageConfirmLabelOf(state.phase)}
        confirmDisabled={state.phase === "submitting"}
        confirmDisabledReason={state.phase === "submitting" ? "กำลังดำเนินการ กรุณารอสักครู่" : undefined}
        cancelLabel={state.phase === "submitting" ? "ปิด" : "ยกเลิก"}
        onConfirm={() => {
          if (state.phase === "reissuing") {
            void performReissue();
            return;
          }
          if (state.phase === "success" || state.phase === "error") {
            handleClose();
          }
        }}
      >
        {state.phase === "success" ? (
          <p className="rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
            {state.issuedView !== null
              ? `ออกใบแทนสำเร็จ เลขที่ ${state.issuedView.certNo} — ใบใหม่เข้าทะเบียนแล้ว ใบเดิมถูกปิดเป็น "superseded"`
              : "ดำเนินการสำเร็จ — รายการจะรีเฟรชอัตโนมัติ"}
          </p>
        ) : null}
        {state.phase === "error" && state.message !== null ? (
          <p className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            {state.message}
          </p>
        ) : null}
      </ConfirmModal>
    </section>
  );
}

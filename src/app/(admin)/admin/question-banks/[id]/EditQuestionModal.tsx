"use client";

/**
 * EditQuestionModal — ฟอร์มแก้ข้อสอบรายข้อของหน้าคลังรายคลัง (Wave G P2 · lane W2)
 *
 * client lifecycle ตาม D74 (ทุกข้อเป็น acceptance criteria):
 * - เปิด modal แล้วค่อย fetch edit GET ด้วย no-store (getAdminJson — ADMIN_REQUEST_CACHE)
 * - **ห้าม**ใส่ EditQuestionResource ใน RSC props/prefetch/shared store — คอมโพเนนต์รับ
 *   เฉพาะ bankId/qid เป็น props (ids เท่านั้น) แล้วดึงข้อมูลเองตอนเปิด
 * - ล้าง state เมื่อ ปิด modal / เปลี่ยน qid / authorization ล้ม (401/403 → ล้าง + ฟ้อง)
 * - late response ของ qid เก่าต้องไม่แสดงบน modal ข้อใหม่ (guard ด้วย qid + requestId)
 * - เปิดใหม่ทุกครั้ง = fetch ใหม่ (authorize ใหม่ — ไม่ reuse ข้อมูลเดิม)
 *
 * options ตาม D79: เพิ่ม/แก้ได้ ลบไม่ได้ · option เดิมส่ง id เดิมเสมอ (update) ·
 * แถวใหม่ไม่มี id (insert) — UI ไม่สื่อว่า options เป็น replacement array
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { ConfirmModal } from "@/components/admin/ConfirmModal";
import { AdminApiError, TRANSPORT_FALLBACK_MESSAGE } from "@/lib/exam-admin.client";
import {
  QUESTION_DIFFICULTY_LABEL_TH,
  QUESTION_TYPE_LABEL_TH,
  validationFieldLabels,
  type ExamAdminQuestionDifficulty,
  type ExamAdminQuestionType,
} from "@/lib/exam-admin.view";

import { getAdminJson, patchAdminJson, ADMIN_REQUEST_CACHE } from "./api-client";
import {
  bankQuestionEditEndpointOf,
  bankQuestionPatchEndpointOf,
  isQuestionDifficulty,
  isQuestionStatus,
  isQuestionType,
  QUESTION_STATUS_LABEL_TH,
  type ExamAdminQuestionStatus,
} from "./bank-detail.view";

/* ─── EditQuestionResource — DTO ของ edit GET (มี isCorrect เฉพาะเส้นนี้ ตาม D74) ─── */

/** ตัวเลือกของ edit GET — มี isCorrect (EditQuestionResource parse ตรวจรูปก่อนใช้เสมอ) */
export interface EditQuestionOption {
  readonly id: string;
  readonly optionText: string;
  readonly sortOrder: number;
  readonly isCorrect: boolean;
}

/** resource ของ edit GET — QuestionResource + isCorrect ใน options (EditQuestionResource ของ API-SPEC §3.8) */
export interface EditQuestionResource {
  readonly id: string;
  readonly bankId: string;
  readonly type: ExamAdminQuestionType;
  readonly difficulty: ExamAdminQuestionDifficulty;
  readonly questionText: string;
  readonly explanation: string | null;
  readonly points: number;
  readonly status: ExamAdminQuestionStatus;
  readonly tags: readonly string[];
  readonly version: number;
  readonly createdAt: string;
  readonly options: readonly EditQuestionOption[];
}

/* ─── ฟอร์มแก้ไข — state จัดเก็บ input แบบสตริง (points/sortOrder ตรวจตอน build) ─── */

/** ตัวเลือกในฟอร์ม — id = null เฉพาะแถวใหม่ที่ยังไม่มีบนฐานข้อมูล (D79: ส่งเมื่อ insert) */
export interface EditOptionDraft {
  readonly id: string | null;
  readonly optionText: string;
  readonly isCorrect: boolean;
  /** ค่าจาก input — ตรวจเป็น int 0-999 ตอน buildQuestionPatchBody */
  readonly sortOrder: string;
}

/** ค่าฟอร์มที่แก้ได้ — คีย์ตรง QuestionPatchBody (type/difficulty/questionText/explanation/points/tags/options) */
export interface EditQuestionFormState {
  readonly type: ExamAdminQuestionType;
  readonly difficulty: ExamAdminQuestionDifficulty;
  readonly questionText: string;
  readonly explanation: string;
  readonly points: string;
  /** แท็กจาก input คั่นด้วยเครื่องหมาย , — ตัด/กรองตอน build */
  readonly tagsText: string;
  readonly options: readonly EditOptionDraft[];
}

/** hint ประจำปุ่มลบ — D79: ลบตัวเลือกยังไม่รองรับ (RPC update-or-insert ตาม D79) */
export const EDIT_OPTIONS_DELETE_HINT = "ลบตัวเลือกยังไม่รองรับ";

/** ตัวเลือกใน body ของ PATCH — id มี = แก้แถวเดิม · ไม่มี id = เพิ่มใหม่ (D79 — ไม่มีลบ) */
export interface EditQuestionPatchOptionBody {
  readonly id?: string;
  readonly optionText: string;
  readonly isCorrect: boolean;
  readonly sortOrder: number;
}

/** body ของ PATCH .../questions/{qid} — คีย์ตรง QuestionPatchBody เป๊ะ (strict · ไม่มี status) */
export interface EditQuestionPatchBody {
  readonly type: ExamAdminQuestionType;
  readonly difficulty: ExamAdminQuestionDifficulty;
  readonly questionText: string;
  readonly explanation: string | null;
  readonly points: number;
  readonly tags: readonly string[];
  readonly options: readonly EditQuestionPatchOptionBody[];
}

/* ─── parse edit GET — ตรวจรูปทุกฟิลด์ ผิดรูป = null (fail-closed) ─── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** แตก { data } จาก envelope §1.1 — ไม่มี/ไม่ใช่ object → null */
function dataRecordOf(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !("data" in body)) {
    return null;
  }
  const data = body["data"];
  return isRecord(data) ? data : null;
}

/**
 * parseEditQuestionResource — ตรวจรูป envelope { data } ของ edit GET
 * - option ทุกแถวต้องมี isCorrect เป็น boolean (EditQuestionResource — ขาด = contract ผิดรูป)
 * - options เป็น array เปล่าได้ (ข้อร่างที่ยังไม่มีตัวเลือก — schema edit GET ไม่มี min
 *   และ PATCH ก็รับ [] · gate r1 M2: ห้ามทำข้อแบบนี้กลายเป็นแก้ไม่ได้) — จำนวน/ความถูก
 *   ต้องของตัวเลือกตรวจตอนบันทึกที่ buildQuestionPatchBody ตาม schema
 * - ตัดสินไม่ได้ทั้ง resource (null) — ไม่เดาข้อมูล ไม่แสดงฟอร์มจากข้อมูลที่ผิดรูป
 */
export function parseEditQuestionResource(raw: unknown): EditQuestionResource | null {
  const data = dataRecordOf(raw);
  if (data === null) {
    return null;
  }
  const id = requiredString(data, "id");
  const bankId = requiredString(data, "bankId");
  const type = isQuestionType(data["type"]) ? data["type"] : null;
  const difficulty = isQuestionDifficulty(data["difficulty"]) ? data["difficulty"] : null;
  const status = isQuestionStatus(data["status"]) ? data["status"] : null;
  const questionText = typeof data["questionText"] === "string" ? data["questionText"] : null;
  const explanation: string | null | undefined =
    data["explanation"] === null
      ? null
      : typeof data["explanation"] === "string"
        ? data["explanation"]
        : undefined;
  const points = typeof data["points"] === "number" && Number.isInteger(data["points"])
    ? data["points"]
    : null;
  const version =
    typeof data["version"] === "number" &&
    Number.isInteger(data["version"]) &&
    data["version"] >= 1
      ? data["version"]
      : null;
  const createdAtRaw = requiredString(data, "createdAt");
  const createdAt =
    createdAtRaw === null || Number.isNaN(Date.parse(createdAtRaw)) ? null : createdAtRaw;
  if (
    id === null ||
    bankId === null ||
    type === null ||
    difficulty === null ||
    status === null ||
    questionText === null ||
    explanation === undefined ||
    points === null ||
    version === null ||
    createdAt === null ||
    !Array.isArray(data["tags"]) ||
    !Array.isArray(data["options"])
  ) {
    return null;
  }
  const tags: string[] = [];
  for (const tag of data["tags"]) {
    if (typeof tag !== "string") {
      return null;
    }
    tags.push(tag);
  }
  const options: EditQuestionOption[] = [];
  for (const optionRaw of data["options"]) {
    if (!isRecord(optionRaw)) {
      return null;
    }
    const optionId = requiredString(optionRaw, "id");
    const optionText =
      typeof optionRaw["optionText"] === "string" ? optionRaw["optionText"] : null;
    const sortOrder =
      typeof optionRaw["sortOrder"] === "number" &&
      Number.isInteger(optionRaw["sortOrder"]) &&
      optionRaw["sortOrder"] >= 0 &&
      optionRaw["sortOrder"] <= 999
      ? optionRaw["sortOrder"]
      : null;
    const isCorrect =
      typeof optionRaw["isCorrect"] === "boolean" ? optionRaw["isCorrect"] : null;
    if (optionId === null || optionText === null || sortOrder === null || isCorrect === null) {
      return null;
    }
    options.push({ id: optionId, optionText, sortOrder, isCorrect });
  }
  return {
    id,
    bankId,
    type,
    difficulty,
    status,
    questionText,
    explanation,
    points,
    version,
    createdAt,
    tags,
    options,
  };
}

/* ─── ฟอร์มเริ่มต้นจาก resource ─── */

/** แปลง resource → ค่าฟอร์ม (points/sortOrder เป็นสตริงของ input · tags คั่น ,) */
export function editFormFromResource(resource: EditQuestionResource): EditQuestionFormState {
  return {
    type: resource.type,
    difficulty: resource.difficulty,
    questionText: resource.questionText,
    explanation: resource.explanation ?? "",
    points: String(resource.points),
    tagsText: resource.tags.join(", "),
    options: resource.options.map((option) => ({
      id: option.id,
      optionText: option.optionText,
      isCorrect: option.isCorrect,
      sortOrder: String(option.sortOrder),
    })),
  };
}

/** แหล่งค่า id ของ option — ส่ง id เดิมเสมอ (D79) — แถวใหม่ (null) ไม่ส่ง id ขึ้น BFF */
function optionIdOf(option: EditOptionDraft): { readonly id: string } | Record<string, never> {
  return option.id === null ? {} : { id: option.id };
}

/* ─── D79 — ประกอบ body ของ PATCH (QuestionPatchBody strict) ─── */

/** error key = path ของ field เช่น "options.1.optionText" (mirror แบบแผนฟอร์มคลัง) */
export type EditFormErrors = Readonly<Record<string, string>>;

/** ขอบเขตเดียวกับ zod ขาเข้าของ route (admin-exam.ts QuestionPatchBody) */
const EDIT_POINTS_MIN = 1;
const EDIT_POINTS_MAX = 100;
/** PATCH schema รับ options 0-10 แถว (ไม่มี min — [] = ไม่แตะตัวเลือกเดิม) */
const EDIT_OPTIONS_MAX = 10;
const EDIT_SORT_ORDER_MAX = 999;

/**
 * ประกอบ body ของ PATCH .../questions/{qid} — คืน { ok, body } / { ok: false, errors }
 * - **ไม่มี status ใน body เด็ดขาด** (strict schema — เปลี่ยนสถานะผ่าน endpoint แยกของ D75)
 * - options ตาม D79: เดิม (มี id) ส่ง id เดิม = update · ใหม่ (ไม่มี id) = insert — ไม่มีลบ
 * - options เปล่าได้ตาม schema PATCH (แก้ข้อร่างที่ยังไม่มีตัวเลือก — UI ไม่มีทางลบแถว
 *   อยู่แล้วตาม D79) — กติกาความถูกต้องของเฉลยบังคับเฉพาะเมื่อมีตัวเลือก ≥ 1 แถว
 * - originalType = ประเภทเดิมจาก edit GET — เปลี่ยนประเภทเป็นเลือกตอบเดียว/ถูกผิด
 *   ต้องมีเฉลยถูกเพียง 1 ตัวก่อนส่ง (trigger 0005 trg_questions_type_correctness จะ
 *   rollback ถ้าส่งไปโดยไม่ครบ — gate r2 m2: ฟ้องที่ฟอร์ม ไม่ใช่ error กลางที่ปลายทาง)
 */
export function buildQuestionPatchBody(
  form: EditQuestionFormState,
  originalType?: ExamAdminQuestionType,
): { ok: true; body: EditQuestionPatchBody } | { ok: false, errors: EditFormErrors } {
  const errors: Record<string, string> = {};
  const questionText = form.questionText.trim();
  if (questionText.length < 1 || questionText.length > 8000) {
    errors["questionText"] = "โจทย์ต้องมี 1-8,000 ตัวอักษร";
  }
  const explanation = form.explanation.trim();
  if (explanation.length > 4000) {
    errors["explanation"] = "คำอธิบายต้องไม่เกิน 4,000 ตัวอักษร";
  }
  const points = Number(form.points);
  if (
    !/^\d+$/.test(form.points.trim()) ||
    !Number.isInteger(points) ||
    points < EDIT_POINTS_MIN ||
    points > EDIT_POINTS_MAX
  ) {
    errors["points"] = "คะแนนของข้อต้องเป็นตัวเลข 1-100";
  }
  const tags = form.tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length > 20) {
    errors["tags"] = "แท็กได้สูงสุด 20 แท็ก";
  }
  for (const tag of tags) {
    if (tag.length > 50) {
      errors["tags"] = "แต่ละแท็กต้องมี 1-50 ตัวอักษร";
      break;
    }
  }
  if (form.options.length > EDIT_OPTIONS_MAX) {
    errors["options"] = `ตัวเลือกได้สูงสุด ${EDIT_OPTIONS_MAX} ตัว`;
  }
  form.options.forEach((option, optionIndex) => {
    const optionText = option.optionText.trim();
    if (optionText.length < 1 || optionText.length > 2000) {
      errors[`options.${optionIndex}.optionText`] = "ข้อความตัวเลือกต้องมี 1-2,000 ตัวอักษร";
    }
    const sortOrder = Number(option.sortOrder);
    if (
      !/^\d+$/.test(option.sortOrder.trim()) ||
      !Number.isInteger(sortOrder) ||
      sortOrder < 0 ||
      sortOrder > EDIT_SORT_ORDER_MAX
    ) {
      errors[`options.${optionIndex}.sortOrder`] = "ลำดับตัวเลือกต้องเป็นตัวเลข 0-999";
    }
  });
  if (form.options.length > 0) {
    const correctCount = form.options.filter((option) => option.isCorrect).length;
    if (form.type === "multiple_choice") {
      if (correctCount < 1) {
        errors["options"] = errors["options"] ?? "ข้อสอบตอบหลายข้อต้องมีตัวเลือกที่ถูกอย่างน้อย 1 ตัว";
      }
    } else if (correctCount !== 1) {
      errors["options"] = errors["options"] ?? "ข้อสอบเลือกตอบเดียว/ถูกผิด ต้องมีตัวเลือกที่ถูกเพียง 1 ตัว";
    }
  } else if (
    originalType !== undefined &&
    form.type !== originalType &&
    form.type !== "multiple_choice"
  ) {
    // gate r2 m2: ข้อร่างไร้ตัวเลือก (options: []) เปลี่ยนประเภทได้เฉพาะไปหา
    // "ตอบหลายข้อ" — ไปเลือกตอบเดียว/ถูกผิดโดน trigger 0005 rollback ที่ปลายทาง
    // (ต้องมีเฉลยถูก 1 ตัวซึ่งเป็นไปไม่ได้เมื่อไม่มีตัวเลือกเลย) → ฟ้องที่ฟอร์มก่อนส่ง
    errors["options"] =
      errors["options"] ?? "เปลี่ยนประเภทข้อเป็นเลือกตอบเดียว/ถูกผิด ต้องมีตัวเลือกที่ถูกเพียง 1 ตัวก่อนบันทึก";
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const body: EditQuestionPatchBody = {
    type: form.type,
    difficulty: form.difficulty,
    questionText,
    ...(explanation.length > 0 ? { explanation } : { explanation: null }),
    points,
    tags,
    options: form.options.map((option, optionIndex) => ({
      ...optionIdOf(option),
      optionText: option.optionText.trim(),
      isCorrect: option.isCorrect,
      sortOrder: Number(option.sortOrder.trim()),
    })),
  };
  return { ok: true, body };
}

/* ─── client lifecycle ตาม D74 — state machine (pure · ทดสอบได้โดยตรง) ─── */

/** เฟสของ modal — denied/error แสดงข้อความ · saved แสดงผลสำเร็จ · idle = ปิดสนิท */
export type EditModalPhase = "idle" | "loading" | "ready" | "saving" | "saved" | "denied" | "error";

export interface EditModalState {
  /** qid ที่ modal กำลังเปิด — null = ปิดอยู่ */
  readonly qid: string | null;
  /** ลำดับ request — เปิดใหม่ทุกครั้ง +1 (late response ของ request เก่าถูกทิ้ง) */
  readonly requestId: number;
  /** ลำดับรอบบันทึก — +1 ทุกครั้งที่เริ่ม PATCH (late response ของรอบเก่าถูกทิ้ง) */
  readonly saveSeq: number;
  readonly phase: EditModalPhase;
  /** resource จาก edit GET — ล้าง (null) เมื่อ ปิด/เปลี่ยน qid/authorization ล้ม (D74) */
  readonly resource: EditQuestionResource | null;
  readonly form: EditQuestionFormState | null;
  readonly fieldErrors: EditFormErrors;
  readonly apiFieldLabels: readonly string[];
  readonly errorMessage: string | null;
  /** เวอร์ชันหลังบันทึกสำเร็จ — แสดงคู่ข้อความสำเร็จ */
  readonly savedVersion: number | null;
}

/** สถานะปิด — resource/form ทุกอย่างว่างสนิท (ไม่มีข้อมูลข้อค้างหลังปิด modal) */
export const EDIT_MODAL_IDLE: EditModalState = {
  qid: null,
  requestId: 0,
  saveSeq: 0,
  phase: "idle",
  resource: null,
  form: null,
  fieldErrors: {},
  apiFieldLabels: [],
  errorMessage: null,
  savedVersion: null,
};

/** ข้อความไทยของสถานะโหลดล้มเหลว — denied (สิทธิ์) · not-found · server */
export const EDIT_LOAD_MESSAGES = {
  denied:
    "คุณไม่มีสิทธิ์เข้าถึงข้อสอบนี้ หรือสิทธิ์หมดอายุแล้ว — ปิดหน้าต่างแก้ไขแล้วเปิดใหม่เพื่อขอสิทธิ์อีกครั้ง",
  "not-found": "ไม่พบข้อสอบนี้ในคลัง (อาจถูกลบหรือไม่อยู่ในสิทธิ์ของคุณ)",
  server: "โหลดข้อสอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
} as const;

/** ผลของ edit GET — ok = resource ที่ตรวจรูปแล้ว · ล้มเหลว = ชนิดที่ตัดสินจาก status */
export type EditLoadOutcome =
  | { ok: true; resource: EditQuestionResource }
  | { ok: false; kind: "denied" | "not-found" | "server" };

/** แมป response ของ edit GET → outcome (fail-closed — body ผิดรูป = kind "server") */
export function editLoadOutcomeFromResponse(status: number, body: unknown): EditLoadOutcome {
  if (status !== 200) {
    return { ok: false, kind: status === 404 ? "not-found" : "server" };
  }
  const resource = parseEditQuestionResource(body);
  return resource === null
    ? { ok: false, kind: "server" }
    : { ok: true, resource };
}

/**
 * แมป error ที่ขว้างจาก getAdminJson → outcome — transport ฝั่ง BFF โยน AdminApiError
 * ทันทีที่ non-2xx (sendAdminJson ของ api-client) ดังนั้น 401/403 = denied ·
 * 404 = not-found (gate r1 m2: ห้ามกลายเป็นข้อความ server กลาง ๆ) · อื่น = server
 */
export function editLoadOutcomeFromError(error: unknown): EditLoadOutcome {
  if (error instanceof AdminApiError) {
    if (error.status === 401 || error.status === 403) {
      return { ok: false, kind: "denied" };
    }
    if (error.status === 404) {
      return { ok: false, kind: "not-found" };
    }
  }
  return { ok: false, kind: "server" };
}

/** ลำดับขั้น: เปิด (ล้าง+ระบุ request ใหม่) → fetch → resolve · ปิด → idle · auth ล้ม → deny */
export function editModalOpenFor(qid: string, requestId: number): EditModalState {
  return {
    qid,
    requestId,
    saveSeq: 0,
    phase: "loading",
    resource: null,
    form: null,
    fieldErrors: {},
    apiFieldLabels: [],
    errorMessage: null,
    savedVersion: null,
  };
}

/** ปิด modal = ล้างทุกอย่างกลับสู่ idle (ไม่มีข้อมูลข้อค้างหลังปิด — D74) */
export function editModalClose(): EditModalState {
  return EDIT_MODAL_IDLE;
}

/**
 * resolve ผล edit GET — guard สองชั้น: qid ตรงกับ modal ที่เปิดอยู่ **และ** requestId
 * ตรงกับ request ล่าสุด — late response ของข้อก่อนหน้าจึงไม่มีทางแสดงบน modal ข้อใหม่ (D74)
 */
export function editModalResolveLoad(
  state: EditModalState,
  qid: string,
  requestId: number,
  outcome: EditLoadOutcome,
): EditModalState {
  if (state.qid !== qid || state.requestId !== requestId || state.phase !== "loading") {
    return state;
  }
  if (!outcome.ok) {
    return {
      ...state,
      phase: outcome.kind === "denied" ? "denied" : "error",
      resource: null,
      form: null,
      fieldErrors: {},
      apiFieldLabels: [],
      errorMessage: EDIT_LOAD_MESSAGES[outcome.kind],
      savedVersion: null,
    };
  }
  return {
    ...state,
    phase: "ready",
    resource: outcome.resource,
    form: editFormFromResource(outcome.resource),
    fieldErrors: {},
    apiFieldLabels: [],
    errorMessage: null,
    savedVersion: null,
  };
}

/** เริ่มบันทึก — จาก phase "ready" เท่านั้น (ล้าง error เดิม · saveSeq +1 = รอบใหม่) */
export function editModalSaveStart(state: EditModalState): EditModalState {
  if (state.phase !== "ready") {
    return state;
  }
  return {
    ...state,
    phase: "saving",
    saveSeq: state.saveSeq + 1,
    fieldErrors: {},
    apiFieldLabels: [],
    errorMessage: null,
    savedVersion: null,
  };
}

/**
 * ตัวตนของรอบบันทึก — เทียบกับ state ปัจจุบัน (qid + requestId + saveSeq ตรงครบ
 * เป็นรอบเดียวกัน) · gate r2 M1: requestId ของการเปิดต้องเข้าชุดตัวตนด้วย —
 * saveSeq ถูก reset เป็น 0 ทุกครั้งเปิด (editModalOpenFor) การอาศัย qid+saveSeq
 * อย่างเดียวทำให้ "ปิด/เปลี่ยน props กลางคันแล้วเปิดข้อเดิมใหม่" ชนตัวตนกับรอบเก่า
 * late response ของรอบเก่า (บันทึกซ้ำ/ปิดแล้วเปิดใหม่/เปลี่ยนข้อ) จึงถูกทิ้งเสมอ
 */
function saveRoundMatches(
  state: EditModalState,
  qid: string,
  requestId: number,
  saveSeq: number,
): boolean {
  return state.qid === qid && state.requestId === requestId && state.saveSeq === saveSeq;
}

/** บันทึกสำเร็จ — เก็บเวอร์ชันใหม่เพื่อแสดงคู่ข้อความสำเร็จ (last-write-wins จดไว้ใน UI) */
export function editModalSaveSuccess(
  state: EditModalState,
  qid: string,
  requestId: number,
  saveSeq: number,
  version: number,
): EditModalState {
  if (state.phase !== "saving" || !saveRoundMatches(state, qid, requestId, saveSeq)) {
    return state;
  }
  return {
    ...state,
    phase: "saved",
    savedVersion: version,
    errorMessage: null,
  };
}

/**
 * authorization ล้มระหว่างบันทึก (PATCH ตอบ 401/403) — **ล้าง resource+form ทันที**
 * (D74: auth ล้ม = ล้าง state) แล้วแสดงข้อความ — ปิดแล้วเปิดใหม่จะ fetch/authorize ใหม่
 * รับเฉพาะ phase "saving" ของรอบตรงชุด (gate r2 M1: outcome หนึ่งรอบมาถึงครั้งเดียว
 * ตอน saving — ที่มาถึงตอน ready เป็นซ้ำ/ค้างของรอบเก่า ต้องทิ้ง)
 */
export function editModalDeny(
  state: EditModalState,
  qid: string,
  requestId: number,
  saveSeq: number,
): EditModalState {
  if (state.phase !== "saving" || !saveRoundMatches(state, qid, requestId, saveSeq)) {
    return state;
  }
  return {
    ...state,
    phase: "denied",
    resource: null,
    form: null,
    fieldErrors: {},
    apiFieldLabels: [],
    errorMessage: EDIT_LOAD_MESSAGES.denied,
    savedVersion: null,
  };
}

/** error อื่นของ PATCH — คงฟอร์มไว้ให้แก้/ลองใหม่ (phase กลับ ready) */
export function editModalSaveError(
  state: EditModalState,
  qid: string,
  requestId: number,
  saveSeq: number,
  message: string,
): EditModalState {
  if (state.phase !== "saving" || !saveRoundMatches(state, qid, requestId, saveSeq)) {
    return state;
  }
  return {
    ...state,
    phase: "ready",
    errorMessage: message,
  };
}

/** ERR-VAL-001 จาก BFF — แสดงรายการฟิลด์ภาษาไทย (แบบเดียวกับฟอร์มคลัง) */
export function editModalSaveApiValidation(
  state: EditModalState,
  qid: string,
  requestId: number,
  saveSeq: number,
  apiFieldLabels: readonly string[],
): EditModalState {
  if (state.phase !== "saving" || !saveRoundMatches(state, qid, requestId, saveSeq)) {
    return state;
  }
  return {
    ...state,
    phase: "ready",
    errorMessage: "กรุณาตรวจสอบข้อมูลตามรายการต่อไปนี้",
    apiFieldLabels,
  };
}

/** error ตรวจรูปฝั่งฟอร์ม — ผูก error ต่อ path ของ field (phase คง ready) */
export function editModalSaveValidationError(
  state: EditModalState,
  fieldErrors: EditFormErrors,
): EditModalState {
  if (state.phase !== "ready") {
    return state;
  }
  return {
    ...state,
    fieldErrors,
  };
}

/**
 * อ่านเวอร์ชันจาก response ของ PATCH — envelope { data: QuestionResource } (มี version)
 * ไม่ตรงสัญญา → null (caller แสดงข้อความให้ปิดแล้วเปิดใหม่ — fail-closed)
 */
export function parseSavedVersion(body: unknown): number | null {
  const data = dataRecordOf(body);
  if (data === null) {
    return null;
  }
  const version = data["version"];
  return typeof version === "number" && Number.isInteger(version) && version >= 1
    ? version
    : null;
}

/** แก้ค่าฟอร์มระดับบน (type/difficulty/โจทย์/คำอธิบาย/คะแนน/แท็ก) — ไม่มีฟอร์ม = ไม่แตะ */
export function editModalFormPatch(
  state: EditModalState,
  patch: Partial<EditQuestionFormState>,
): EditModalState {
  if (state.form === null) {
    return state;
  }
  return { ...state, form: { ...state.form, ...patch } };
}

/** แก้ตัวเลือกหนึ่งช่อง — ข้อความ/ธงถูก/ลำดับ (D79: แก้ได้ทุกช่อง ลบไม่ได้) */
export function updateEditOption(
  state: EditModalState,
  optionIndex: number,
  patch: { readonly optionText?: string; readonly isCorrect?: boolean; readonly sortOrder?: string },
): EditModalState {
  if (state.form === null) {
    return state;
  }
  return {
    ...state,
    form: {
      ...state.form,
      options: state.form.options.map((option, index) =>
        index === optionIndex
          ? {
              id: option.id,
              optionText: patch.optionText ?? option.optionText,
              isCorrect: patch.isCorrect ?? option.isCorrect,
              sortOrder: patch.sortOrder ?? option.sortOrder,
            }
          : option,
      ),
    },
  };
}

/** เลือก "ถูก" ของข้อเลือกเดียว/ถูกผิด — ปิดตัวอื่นให้เหลือถูกตัวเดียว */
export function markEditSingleCorrect(state: EditModalState, optionIndex: number): EditModalState {
  if (state.form === null || state.form.type === "multiple_choice") {
    return state;
  }
  return {
    ...state,
    form: {
      ...state.form,
      options: state.form.options.map((option, index) => ({
        id: option.id,
        optionText: option.optionText,
        isCorrect: index === optionIndex,
        sortOrder: option.sortOrder,
      })),
    },
  };
}

/**
 * เพิ่มแถวตัวเลือกใหม่ (id = null — D79) — ไม่เกิน 10 แถว
 * sortOrder ของแถวใหม่ = ค่าสูงสุดที่มี +1 (gate r1 m1: ใช้ options.length ชน
 * unique (question_id, sort_order) ของ 0005 เมื่อลำดับเดิมไม่เรียง 0..n-1)
 */
export function addEditOption(state: EditModalState): EditModalState {
  if (state.form === null || state.form.options.length >= 10) {
    return state;
  }
  const maxSortOrder = state.form.options.reduce((max, option) => {
    const parsed = Number(option.sortOrder);
    return Number.isInteger(parsed) && parsed > max ? parsed : max;
  }, -1);
  if (maxSortOrder >= EDIT_SORT_ORDER_MAX) {
    return state;
  }
  return {
    ...state,
    form: {
      ...state.form,
      options: [
        ...state.form.options,
        { id: null, optionText: "", isCorrect: false, sortOrder: String(maxSortOrder + 1) },
      ],
    },
  };
}

/* ─── คอมโพเนนต์ — ปุ่มแก้ไข + โมดัลฟอร์ม (client) ─── */

const EDIT_INPUT_CLASS =
  "w-full rounded-[10px] border border-mist-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none";

/** แถวช่องกรอก — label + ช่อง + ข้อความผิดพลาดใต้ช่อง (mirror BankField ของฟอร์มคลัง) */
function EditField({ label, error, children }: {
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

export interface EditQuestionModalProps {
  /** ids เท่านั้น — ห้ามส่ง EditQuestionResource เข้า props (D74: ข้อมูลมีเฉลย ต้อง fetch ตอนเปิด) */
  readonly bankId: string;
  readonly qid: string;
  /** question_bank:update — false = ไม่แสดงปุ่ม/ฟอร์มเลย (ตัดสินจริงที่ BFF เสมอ) */
  readonly canEdit: boolean;
}

export function EditQuestionModal({ bankId, qid, canEdit }: EditQuestionModalProps) {
  const router = useRouter();
  const [state, setState] = useState<EditModalState>(EDIT_MODAL_IDLE);
  const requestSeqRef = useRef(0);

  // gate r1 M1: qid/canEdit เปลี่ยน = ข้อมูลเดิมใช้ต่อไม่ได้ — ล้างกลับ idle
  // (D74 ต่อเนื่อง: เปลี่ยน qid/สิทธิ์หมด = ไม่มีข้อมูลข้อค้างใน state แม้ return null)
  useEffect(() => {
    setState(editModalClose());
  }, [qid, canEdit]);

  if (!canEdit) {
    return null;
  }

  const startEditLoad = (loadQid: string, requestId: number) => {
    void (async () => {
      let outcome: EditLoadOutcome;
      try {
        const { status, body } = await getAdminJson(bankQuestionEditEndpointOf(bankId, loadQid));
        outcome = editLoadOutcomeFromResponse(status, body);
      } catch (error) {
        outcome = editLoadOutcomeFromError(error);
      }
      setState((previous) => editModalResolveLoad(previous, loadQid, requestId, outcome));
    })();
  };

  /** เปิด modal — ล้าง state เดิม + fetch no-store ทันที (เปิดใหม่ = authorize ใหม่ เสมอ) */
  const openModal = () => {
    requestSeqRef.current += 1;
    const requestId = requestSeqRef.current;
    setState(editModalOpenFor(qid, requestId));
    startEditLoad(qid, requestId);
  };

  const closeAndReset = () => {
    setState(editModalClose());
  };

  const handleSave = async () => {
    if (state.phase !== "ready" || state.form === null || state.qid === null) {
      return;
    }
    const built = buildQuestionPatchBody(state.form, state.resource?.type);
    if (!built.ok) {
      setState(editModalSaveValidationError(state, built.errors));
      return;
    }
    const saveQid = state.qid;
    // ตัวตนของรอบบันทึกนี้ — ผูกทั้ง requestId ของการเปิด (gate r2 M1: กันชนตัวตน
    // กับรอบเก่าเมื่อปิด/เปลี่ยน props กลางคันแล้วเปิดข้อเดิมใหม่ — saveSeq ถูก reset
    // ตอนเปิด) และ saveSeq ที่ editModalSaveStart จะยกให้เอง (gate r1 M1)
    const saveRequest = state.requestId;
    const saveRound = state.saveSeq + 1;
    setState(editModalSaveStart(state));
    try {
      const { body } = await patchAdminJson(
        bankQuestionPatchEndpointOf(bankId, saveQid),
        built.body,
      );
      const version = parseSavedVersion(body);
      if (version === null) {
        setState((previous) =>
          editModalSaveError(
            previous,
            saveQid,
            saveRequest,
            saveRound,
            "บันทึกสำเร็จแต่อ่านเวอร์ชันกลับไม่สำเร็จ — ปิดแล้วเปิดใหม่เพื่อตรวจข้อมูลล่าสุด",
          ),
        );
        return;
      }
      setState((previous) =>
        editModalSaveSuccess(previous, saveQid, saveRequest, saveRound, version),
      );
      router.refresh();
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setState((previous) => editModalDeny(previous, saveQid, saveRequest, saveRound));
        return;
      }
      if (error instanceof AdminApiError && error.code === "ERR-VAL-001") {
        setState((previous) =>
          editModalSaveApiValidation(
            previous,
            saveQid,
            saveRequest,
            saveRound,
            validationFieldLabels(error.fields),
          ),
        );
        return;
      }
      setState((previous) =>
        editModalSaveError(
          previous,
          saveQid,
          saveRequest,
          saveRound,
          error instanceof AdminApiError ? error.message : TRANSPORT_FALLBACK_MESSAGE,
        ),
      );
    }
  };

  const form = state.form;
  const resource = state.resource;
  const saving = state.phase === "saving";
  const formDisabled = state.phase !== "ready" && state.phase !== "saving";

  return (
    <>
      <button
        type="button"
        className="font-semibold text-brand-700 hover:underline disabled:cursor-not-allowed disabled:text-ink-400"
        onClick={openModal}
      >
        แก้ไข
      </button>
      <ConfirmModal
        open={state.phase !== "idle"}
        onClose={closeAndReset}
        cancelDisabled={state.phase === "saving"}
        title="แก้ไขข้อสอบ"
        confirmLabel={
          state.phase === "saved"
            ? "ปิด"
            : state.phase === "error" || state.phase === "loading"
              ? "ลองใหม่"
              : "บันทึกการแก้ไข"
        }
        confirmDisabled={
          state.phase === "loading" || state.phase === "saving" || state.phase === "denied"
        }
        confirmDisabledReason={
          state.phase === "loading"
            ? "กำลังโหลดข้อมูลข้อสอบ"
            : state.phase === "saving"
              ? "กำลังบันทึก กรุณารอสักครู่"
              : state.phase === "denied"
                ? "ไม่มีสิทธิ์บันทึก — ปิดแล้วเปิดใหม่เพื่อขอสิทธิ์อีกครั้ง"
                : undefined
        }
        cancelLabel={
          state.phase === "saved" || state.phase === "denied" || state.phase === "error"
            ? "ปิด"
            : "ยกเลิก"
        }
        onConfirm={() => {
          if (state.phase === "saved" || state.phase === "denied") {
            closeAndReset();
            return;
          }
          if (state.phase === "error" || state.phase === "loading") {
            openModal();
            return;
          }
          void handleSave();
        }}
      >
        {state.phase === "loading" ? (
          <p className="text-sm text-ink-600" role="status">
            กำลังโหลดข้อสอบ กรุณารอสักครู่…
          </p>
        ) : null}
        {state.phase === "denied" || state.phase === "error" ? (
          <div className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
            <p>{state.errorMessage}</p>
          </div>
        ) : null}
        {state.phase === "saved" && state.savedVersion !== null ? (
          <div className="space-y-2">
            <p className="rounded-[10px] bg-green-50 p-3 text-sm text-green-800" role="status">
              บันทึกการแก้ไขเรียบร้อยแล้ว — ข้อสอบเวอร์ชัน {state.savedVersion}
            </p>
            <p className="text-sm text-ink-500">
              หากมีผู้แก้ไขพร้อมกัน การบันทึกล่าสุดจะเป็นตัวตั้ง (last-write-wins)
            </p>
          </div>
        ) : null}
        {form !== null && resource !== null ? (
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <div className="space-y-4">
              {state.errorMessage !== null && state.phase === "ready" ? (
                <div className="rounded-[10px] bg-red-50 p-3 text-sm text-red-700" role="alert">
                  <p>{state.errorMessage}</p>
                  {state.apiFieldLabels.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5">
                      {state.apiFieldLabels.map((label) => (
                        <li key={label}>{label}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <div className="rounded-[10px] bg-mist-50 p-3 text-sm text-ink-600">
                <p>
                  เวอร์ชันปัจจุบัน: <span className="font-semibold text-ink-900">v{resource.version}</span>
                  {" · "}สถานะ: {QUESTION_STATUS_LABEL_TH[resource.status]}
                </p>
                <p className="mt-1 text-ink-500">
                  ทุกการบันทึกเพิ่มเวอร์ชัน +1 — หากมีผู้แก้ไขพร้อมกัน การบันทึกล่าสุดจะมีผลทับของเดิม
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <EditField label="ชนิดข้อสอบ" error={null}>
                  <select
                    className={EDIT_INPUT_CLASS}
                    value={form.type}
                    disabled={saving}
                    onChange={(event) =>
                      setState((previous) =>
                        editModalFormPatch(previous, {
                          type: event.target.value as ExamAdminQuestionType,
                        }),
                      )
                    }
                  >
                    {(Object.keys(QUESTION_TYPE_LABEL_TH) as ExamAdminQuestionType[]).map((type) => (
                      <option key={type} value={type}>
                        {QUESTION_TYPE_LABEL_TH[type]}
                      </option>
                    ))}
                  </select>
                </EditField>
                <EditField label="ระดับความยาก" error={null}>
                  <select
                    className={EDIT_INPUT_CLASS}
                    value={form.difficulty}
                    disabled={saving}
                    onChange={(event) =>
                      setState((previous) =>
                        editModalFormPatch(previous, {
                          difficulty: event.target.value as ExamAdminQuestionDifficulty,
                        }),
                      )
                    }
                  >
                    {(
                      Object.keys(QUESTION_DIFFICULTY_LABEL_TH) as ExamAdminQuestionDifficulty[]
                    ).map((difficulty) => (
                      <option key={difficulty} value={difficulty}>
                        {QUESTION_DIFFICULTY_LABEL_TH[difficulty]}
                      </option>
                    ))}
                  </select>
                </EditField>
              </div>
              <EditField label="โจทย์" error={state.fieldErrors["questionText"] ?? null}>
                <textarea
                  className={EDIT_INPUT_CLASS}
                  value={form.questionText}
                  disabled={saving}
                  rows={3}
                  maxLength={8000}
                  onChange={(event) =>
                    setState((previous) =>
                      editModalFormPatch(previous, { questionText: event.target.value }),
                    )
                  }
                />
              </EditField>
              <EditField label="คำอธิบายหลังตรวจ (ไม่บังคับ)" error={state.fieldErrors["explanation"] ?? null}>
                <input
                  type="text"
                  className={EDIT_INPUT_CLASS}
                  value={form.explanation}
                  disabled={saving}
                  maxLength={4000}
                  onChange={(event) =>
                    setState((previous) =>
                      editModalFormPatch(previous, { explanation: event.target.value }),
                    )
                  }
                />
              </EditField>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <EditField label="คะแนนของข้อ (1-100)" error={state.fieldErrors["points"] ?? null}>
                  <input
                    type="number"
                    className={EDIT_INPUT_CLASS}
                    value={form.points}
                    disabled={saving}
                    min={1}
                    max={100}
                    onChange={(event) =>
                      setState((previous) =>
                        editModalFormPatch(previous, { points: event.target.value }),
                      )
                    }
                  />
                </EditField>
                <EditField
                  label="แท็ก (ไม่บังคับ — คั่นด้วย ,)"
                  error={state.fieldErrors["tags"] ?? null}
                >
                  <input
                    type="text"
                    className={EDIT_INPUT_CLASS}
                    value={form.tagsText}
                    disabled={saving}
                    onChange={(event) =>
                      setState((previous) =>
                        editModalFormPatch(previous, { tagsText: event.target.value }),
                      )
                    }
                  />
                </EditField>
              </div>
              <div className="border-t border-mist-200 pt-4">
                <div className="flex items-center justify-between">
                  <span className="font-heading text-sm font-semibold text-ink-900">
                    ตัวเลือก ({form.options.length}/10 — คลิกช่อง &quot;ถูก&quot; ข้างตัวเลือกที่ถูกต้อง)
                  </span>
                  <button
                    type="button"
                    className="rounded-[10px] border border-brand-600 px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={saving || form.options.length >= 10}
                    onClick={() => setState((previous) => addEditOption(previous))}
                  >
                    + เพิ่มตัวเลือก
                  </button>
                </div>
                <p className="mt-1 text-sm text-ink-500">{EDIT_OPTIONS_DELETE_HINT}</p>
                {form.options.map((option, optionIndex) => (
                  <div key={optionIndex} className="mt-3 flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-2"
                      checked={option.isCorrect}
                      disabled={saving}
                      aria-label={`ตัวเลือกที่ ${optionIndex + 1} ถูกต้อง`}
                      onChange={(event) => {
                        if (form.type === "multiple_choice") {
                          setState((previous) =>
                            updateEditOption(previous, optionIndex, {
                              isCorrect: event.target.checked,
                            }),
                          );
                        } else {
                          setState((previous) => markEditSingleCorrect(previous, optionIndex));
                        }
                      }}
                    />
                    <div className="flex-1">
                      <EditField
                        label={`ตัวเลือกที่ ${optionIndex + 1}`}
                        error={state.fieldErrors[`options.${optionIndex}.optionText`] ?? null}
                      >
                        <input
                          type="text"
                          className={EDIT_INPUT_CLASS}
                          value={option.optionText}
                          disabled={saving}
                          maxLength={2000}
                          onChange={(event) =>
                            setState((previous) =>
                              updateEditOption(previous, optionIndex, {
                                optionText: event.target.value,
                              }),
                            )
                          }
                        />
                      </EditField>
                    </div>
                    <div className="w-24">
                      <EditField
                        label="ลำดับ"
                        error={state.fieldErrors[`options.${optionIndex}.sortOrder`] ?? null}
                      >
                        <input
                          type="number"
                          className={EDIT_INPUT_CLASS}
                          value={option.sortOrder}
                          disabled={saving}
                          min={0}
                          max={999}
                          onChange={(event) =>
                            setState((previous) =>
                              updateEditOption(previous, optionIndex, {
                                sortOrder: event.target.value,
                              }),
                            )
                          }
                        />
                      </EditField>
                    </div>
                    <button
                      type="button"
                      className="mt-8 cursor-not-allowed text-sm text-ink-400"
                      disabled
                      title={EDIT_OPTIONS_DELETE_HINT}
                      aria-label={`ลบตัวเลือกที่ ${optionIndex + 1} — ${EDIT_OPTIONS_DELETE_HINT}`}
                    >
                      ลบ
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </ConfirmModal>
    </>
  );
}
/**
 * bank-detail.view — มุมมอง + กติกาแสดงผลของหน้าคลังข้อสอบรายคลัง (Wave G P2 · lane W2)
 *
 * pure ทั้งไฟล์ (ไม่ fetch / ไม่แตะ server-only / ไม่ import React) — หน้า RSC และ
 * client component (EditQuestionModal · StatusConfirm) ใช้ร่วมกันที่นี่แหล่งเดียว
 *
 * ข้อความทุกชุด = ภาษาไทย (I18N-003) · การตัดสินจริงอยู่ที่ BFF เสมอ — ผู้ช่วยบทบาท
 * ที่นี่ไว้ซ่อนปุ่มที่ผู้ใช้ไม่มีทางใช้ได้เท่านั้น (ไม่ใช่ชั้นความปลอดภัย)
 */

/** สถานะข้อสอบ — enum question_status (0001_extensions L112 · default draft 0005) */
export type ExamAdminQuestionStatus = "draft" | "active" | "retired";

/** ชนิดข้อสอบ — enum question_type (mirror exam-admin.view — คงแหล่งเดิมไว้ ไม่แตะ) */
export type ExamAdminQuestionType = "single_choice" | "multiple_choice" | "true_false";

/** ระดับความยาก — enum question_difficulty */
export type ExamAdminQuestionDifficulty = "easy" | "medium" | "hard";

export const QUESTION_STATUS_VALUES: readonly ExamAdminQuestionStatus[] = [
  "draft",
  "active",
  "retired",
];

/** ตรวจสถานะจาก BFF — ค่านอก enum = drift (parser ต้อง fail-closed) */
export function isQuestionStatus(value: unknown): value is ExamAdminQuestionStatus {
  return value === "draft" || value === "active" || value === "retired";
}

export const QUESTION_TYPE_VALUES: readonly ExamAdminQuestionType[] = [
  "single_choice",
  "multiple_choice",
  "true_false",
];

export function isQuestionType(value: unknown): value is ExamAdminQuestionType {
  return value === "single_choice" || value === "multiple_choice" || value === "true_false";
}

export const QUESTION_DIFFICULTY_VALUES: readonly ExamAdminQuestionDifficulty[] = [
  "easy",
  "medium",
  "hard",
];

export function isQuestionDifficulty(value: unknown): value is ExamAdminQuestionDifficulty {
  return value === "easy" || value === "medium" || value === "hard";
}

/* ─── แถวข้อสอบในตาราง — QuestionResource ของ BFF (ไม่มี is_correct เด็ดขาด) ─── */

/** ตัวเลือกในมุมมองอ่าน — ไม่มี isCorrect (DD §3.4 · แถวรายการห้ามมีเฉลย) */
export interface BankQuestionOptionRow {
  readonly id: string;
  readonly optionText: string;
  readonly sortOrder: number;
}

/** แถวข้อสอบสำหรับตารางหน้า detail (QuestionResource ของ BFF — options ไม่มี isCorrect) */
export interface BankQuestionRow {
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
  readonly options: readonly BankQuestionOptionRow[];
}

/* ─── label ภาษาไทย + โทน badge ของสถานะข้อสอบ (แหล่งเดียวของหน้า detail) ─── */

export const QUESTION_STATUS_LABEL_TH: Record<ExamAdminQuestionStatus, string> = {
  draft: "ร่าง",
  active: "ใช้งาน",
  retired: "ปลดจากการใช้งาน",
};

/** โทน badge ต่อสถานะ (คู่กับ StatusBadge — DESIGN-SYSTEM §5.6) */
export const QUESTION_STATUS_TONE: Record<
  ExamAdminQuestionStatus,
  "success" | "info" | "neutral"
> = {
  draft: "info",
  active: "success",
  retired: "neutral",
};

/* ─── hint ผลกระทบ pool การสุ่มข้อ (D77 — ความเสี่ยง runtime ที่ UI ต้องสื่อ) ─── */

/** hint ประจำหัวคลัง — bank inactive ไม่หยุด selection (start_attempt กรอง q.status เท่านั้น) */
export const BANK_POOL_HINT_TH =
  "ปิดคลังไม่ได้ตัดข้อออกจากการสุ่ม ข้อสถานะใช้งานยังอาจถูกเลือกตามเกณฑ์การสอบ";

/** hint ใน ConfirmModal ตอนปลดข้อ — pool ของผู้เริ่มสอบถัดไปเปลี่ยนทันที */
export const RETIRE_POOL_HINT_TH = "ข้อที่ปลดจะไม่ถูกสุ่มให้การสอบที่เริ่มใหม่";

/** hint ตอนเปิดใช้งานข้อ — กลับเข้า pool ของการสอบที่เริ่มใหม่ */
export const ACTIVATE_POOL_HINT_TH =
  "ข้อจะเข้าระบบสุ่มของการสอบที่เริ่มใหม่ทันที (pool การสอบที่กำลังทำอยู่ไม่เปลี่ยน)";

/* ─── การเปลี่ยนสถานะ — ตาม transition matrix ของ D75 ───
   draft→active · active→retired · retired→active (same-status = BFF ปฏิเสธ) —
   จุดเป้าหมายตัดสินจากสถานะปัจจุบันฝั่งแสดงผล ส่วนการตัดสินจริงอยู่ที่ RPC 0047 */

/** สถานะเป้าหมายของปุ่ม toggle — active → ปลด · draft/retired → เปิดใช้งาน */
export function statusTargetOf(status: ExamAdminQuestionStatus): ExamAdminQuestionStatus {
  return status === "active" ? "retired" : "active";
}

/** ป้ายปุ่ม toggle ภาษาไทยตามสถานะปัจจุบัน */
export function statusActionLabelTh(status: ExamAdminQuestionStatus): string {
  return status === "active" ? "ปลดจากการใช้งาน" : "เปิดใช้งาน";
}

/** ข้อความยืนยัน in ConfirmModal — from→to ไทยชัดเจน + hint ผลกระทบ pool ตาม D77 */
export function statusConfirmDescriptionTh(status: ExamAdminQuestionStatus): string {
  const from = QUESTION_STATUS_LABEL_TH[status];
  const to = QUESTION_STATUS_LABEL_TH[statusTargetOf(status)];
  const hint =
    status === "active" ? RETIRE_POOL_HINT_TH : ACTIVATE_POOL_HINT_TH;
  return `เปลี่ยนสถานะข้อสอบจาก "${from}" เป็น "${to}" — ${hint}`;
}

/* ─── ผู้ช่วยจัดรูป ─── */

/** โจทย์ย่อในตาราง — ยาวเกินกำหนดตัดพร้อมจุดไข่ปลา (แสดงผลเท่านั้น ไม่ตัดสินข้อมูล) */
export function truncateQuestionTextTh(text: string, max = 80): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(max - 1, 1))}…`;
}

/* ─── ประตูบทบาทของหน้าจอ — mirror RBAC §2 (rbac.ts) ฝั่งแสดงผล ─── */

function roleIsAny(roles: readonly string[], allowed: readonly string[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

/** question_bank:update — instructor, staff:exam, super_admin (แสดงปุ่มแก้ข้อ) */
export function canEditQuestionBank(roles: readonly string[]): boolean {
  return roleIsAny(roles, ["instructor", "staff:exam", "super_admin"]);
}

/** toggle สถานะข้อ — staff:exam/super_admin เท่านั้น (D75 · instructor = ERR-RBAC-001) */
export function canToggleQuestionStatus(roles: readonly string[]): boolean {
  return roleIsAny(roles, ["staff:exam", "super_admin"]);
}

/* ─── endpoint ตาม API-SPECIFICATION §3.8 (1.3.0 draft rows) ───
   ทาง UI เรียกผ่าน BFF เท่านั้น — ห้ามเรียกตาราง/PostgREST ตรง */

/** GET .../{id}/questions/{qid} — edit GET (EditQuestionResource มีเฉลย · no-store) */
export function bankQuestionEditEndpointOf(bankId: string, qid: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions/${qid}`;
}

/** PATCH .../{id}/questions/{qid} — แก้เนื้อหาข้อ (QuestionPatchBody) */
export function bankQuestionPatchEndpointOf(bankId: string, qid: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions/${qid}`;
}

/** PATCH .../{id}/questions/{qid}/status — เปลี่ยนสถานะ (D75 · RPC 0047) */
export function bankQuestionStatusEndpointOf(bankId: string, qid: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions/${qid}/status`;
}

/** GET .../{id}/questions?cursor= — รายการข้อ (แถวไม่มีเฉลย) */
export function bankQuestionsListPathOf(bankId: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions`;
}

/** body ของ PATCH status — strict {"status": "active"|"retired"} เท่านั้น */
export function questionStatusBody(status: ExamAdminQuestionStatus): { readonly status: ExamAdminQuestionStatus } {
  return { status };
}

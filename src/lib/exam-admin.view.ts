/**
 * exam-admin.view — มุมมองข้อมูล + กติกาแสดงผลของหลังบ้านสอบ/ประกาศนียบัตร (Wave D · D-7)
 *
 * pure ทั้งไฟล์ (ไม่ fetch / ไม่แตะ server-only) — หน้า RSC ใช้ชนิดข้อมูล + ผู้ช่วยจัดรูป
 * สำหรับตาราง และ client component ใช้ label/validation ร่วมกันที่นี่แหล่งเดียว
 *
 * สัญญาข้อมูลตรง resource ของ BFF จริง (schemas/v1/admin-exam.ts + certificate.ts):
 * - AdminAssessmentResource — rules (passPct แสดงได้ ตาม column grant 0019)
 * - QuestionBankResource — questionCount นับฝั่ง DB
 * - EligibleAttemptResource — คิวผู้มีสิทธิ์ออกใบ (holderName ค่าว่างได้ตาม r7-M1)
 * ข้อความทุกชุด = ภาษาไทย (I18N-003) · ห้าม log ข้อมูลผู้ใช้
 */

/** สถานะชุดข้อสอบ — enum assessment_status (0001_extensions.sql L110-L120) */
export type ExamAdminAssessmentStatus = "draft" | "published" | "closed" | "archived";

/** โหมดระบบคุมการสอบ — enum proctoring_mode (0001_extensions.sql) */
export type ExamAdminProctoringMode = "none" | "basic";

/** ชนิดข้อสอบ — enum question_type (0001_extensions.sql) */
export type ExamAdminQuestionType = "single_choice" | "multiple_choice" | "true_false";

/** ระดับความยาก — enum question_difficulty (0001_extensions.sql) */
export type ExamAdminQuestionDifficulty = "easy" | "medium" | "hard";

/** สรุปกติกาล่าสุดของชุดข้อสอบ (AssessmentRuleSummary ของ BFF — passPct เปิดให้แสดงแล้ว · requireCourseComplete/selection/examReviewMode เพิ่ม GP3-r2 เพื่อ prefill โมดัลกติกา) */
export interface ExamAdminAssessmentRuleSummary {
  readonly version: number;
  readonly passPct: number;
  readonly timeLimitMinutes: number;
  readonly questionCount: number;
  readonly maxAttempts: number;
  readonly cooldownMinutes: number;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly requireCourseComplete: boolean;
  /** ขอบเขตคลังข้อสอบ (jsonb) — ส่งต่อให้ version ใหม่เมื่อแก้กติกา */
  readonly selection: Record<string, unknown>;
  readonly proctoringMode: ExamAdminProctoringMode;
  readonly examReviewMode: "after_final_attempt" | "never";
  readonly effectiveFrom: string;
}

/** แถวชุดข้อสอบสำหรับตารางหลังบ้าน (AdminAssessmentResource ของ BFF) */
export interface ExamAdminAssessment {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly description: string | null;
  readonly courseId: string;
  readonly isFinal: boolean;
  readonly status: ExamAdminAssessmentStatus;
  readonly createdBy: string | null;
  readonly rules: ExamAdminAssessmentRuleSummary | null;
  readonly createdAt: string;
}

/** แถวคลังข้อสอบสำหรับตารางหลังบ้าน (QuestionBankResource ของ BFF) */
export interface ExamAdminQuestionBank {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly courseId: string | null;
  readonly categoryId: string | null;
  readonly isActive: boolean;
  readonly questionCount: number;
  readonly createdAt: string;
}

/** แถวคิวผู้มีสิทธิ์รับประกาศนียบัตร (EligibleAttemptResource ของ BFF — holderName ค่าว่างได้) */
export interface ExamAdminEligibleAttempt {
  readonly attemptId: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderName: string;
  readonly scorePct: number | null;
  readonly submittedAt: string;
}

/* ─── label ภาษาไทยของ enum (แหล่งเดียว — หน้า/ฟอร์มอ้างจากที่นี่) ─── */

export const ASSESSMENT_STATUS_LABEL_TH: Record<ExamAdminAssessmentStatus, string> = {
  draft: "ร่าง",
  published: "เผยแพร่แล้ว",
  closed: "ปิดรับสอบ",
  archived: "เก็บเข้าคลัง",
};

/** โทน badge ต่อสถานะ (คู่กับ StatusBadge ของหลังบ้าน — DESIGN-SYSTEM §5.6) */
export const ASSESSMENT_STATUS_TONE: Record<
  ExamAdminAssessmentStatus,
  "success" | "warning" | "danger" | "info" | "neutral"
> = {
  draft: "info",
  published: "success",
  closed: "warning",
  archived: "neutral",
};

export const QUESTION_TYPE_LABEL_TH: Record<ExamAdminQuestionType, string> = {
  single_choice: "ปรนัย — เลือกตอบเดียว",
  multiple_choice: "ปรนัย — ตอบหลายข้อ",
  true_false: "ถูก / ผิด",
};

export const QUESTION_DIFFICULTY_LABEL_TH: Record<ExamAdminQuestionDifficulty, string> = {
  easy: "ง่าย",
  medium: "ปานกลาง",
  hard: "ยาก",
};

export const PROCTORING_MODE_LABEL_TH: Record<ExamAdminProctoringMode, string> = {
  none: "ไม่ใช้ระบบคุมการสอบ",
  basic: "คุมการสอบขั้นพื้นฐาน",
};

/** ตรวจค่า ?status= จาก URL ก่อนส่งไปกรองที่ BFF (ค่าแปลกปลอม = ไม่กรอง) */
export function isExamAdminAssessmentStatus(value: unknown): value is ExamAdminAssessmentStatus {
  return (
    value === "draft" || value === "published" || value === "closed" || value === "archived"
  );
}

/* ─── ประตูบทบาทของหน้าจอ — mirror RBAC §2 (rbac.ts) ฝั่งแสดงผล ───
   การตัดสินจริงอยู่ที่ BFF (requirePermission) เสมอ — ที่นี่เพื่อซ่อนปุ่ม/ฟอร์มที่
   ผู้ใช้ไม่มีทางใช้ได้ ไม่ใช่ชั้นความปลอดภัย */

function roleIsAny(roles: readonly string[], allowed: readonly string[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

/** assessment:create — instructor (ร่างของหลักสูตรตัวเอง), staff:exam, super_admin */
export function canCreateAssessment(roles: readonly string[]): boolean {
  return roleIsAny(roles, ["instructor", "staff:exam", "super_admin"]);
}

/** เขียน assessment_rules ได้เฉพาะ staff:exam/super_admin (RLS ar_write 0010) */
export function canWriteAssessmentRules(roles: readonly string[]): boolean {
  return roleIsAny(roles, ["staff:exam", "super_admin"]);
}

/** question_bank:create — instructor, staff:exam, super_admin */
export function canCreateQuestionBank(roles: readonly string[]): boolean {
  return roleIsAny(roles, ["instructor", "staff:exam", "super_admin"]);
}

/** certificate:issue — staff:registrar, super_admin เท่านั้น (SoD T9) */
export function canIssueCertificate(roles: readonly string[]): boolean {
  return roleIsAny(roles, ["staff:registrar", "super_admin"]);
}

/** certificate:revoke — staff:registrar, super_admin (reissue ใช้สิทธิ์เดียวกัน) */
export function canRevokeCertificate(roles: readonly string[]): boolean {
  return roleIsAny(roles, ["staff:registrar", "super_admin"]);
}

/* ─── ผู้ช่วยจัดรูปสำหรับตาราง ─── */

const THAI_DATETIME_FORMAT = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** วันเวลาแบบพุทธศักราช (DESIGN-SYSTEM §9 I18N-003) — เช่น "20 สิงหาคม 2569, 13:45" */
export function formatThaiDateTime(iso: string): string {
  return THAI_DATETIME_FORMAT.format(new Date(iso));
}

/** บรรทัดสรุปกติกาในคอลัมน์เดียวของตาราง — ไม่มีกติกา = ข้อความแจ้งชัด ไม่แสดง "—" เปล่า ๆ */
export function assessmentRulesSummaryLine(rules: ExamAdminAssessmentRuleSummary | null): string {
  if (rules === null) {
    return "ยังไม่กำหนดกติกา";
  }
  return (
    `ผ่าน ≥${rules.passPct}% · ${rules.questionCount} ข้อ · ` +
    `${rules.timeLimitMinutes} นาที · สอบได้ ${rules.maxAttempts} ครั้ง`
  );
}

/** ประเภทชุดข้อสอบ — ปลายหลักสูตร/ระหว่างเรียน */
export function assessmentKindLabel(isFinal: boolean): string {
  return isFinal ? "สอบปลายหลักสูตร" : "แบบทดสอบระหว่างเรียน";
}

/** ตัดค่าแรกจาก searchParams แบบ multi-value (string | string[] | undefined) */
export function firstSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/* ─── ผู้ช่วยแปล ERR-VAL-001 details.fields → ภาษาไทยอ่านง่าย (กฎข้อ 3 ของ lane) ───
   คีย์ตรง path ของ field ใน zod schema ขาเข้าของ route จริง (camelCase เป๊ะ) */

const VALIDATION_FIELD_LABEL_TH: Record<string, string> = {
  courseId: "หลักสูตร",
  code: "รหัส",
  title: "ชื่อชุดข้อสอบ",
  name: "ชื่อคลังข้อสอบ",
  description: "คำอธิบาย",
  isFinal: "ประเภทการสอบ",
  categoryId: "หมวดหลักสูตร",
  isActive: "สถานะการใช้งาน",
  rules: "กติกาการสอบ",
  "rules.timeLimitMinutes": "เวลาทำข้อสอบ (นาที)",
  "rules.questionCount": "จำนวนข้อสอบ",
  "rules.passPct": "เกณฑ์ผ่าน (%)",
  "rules.maxAttempts": "จำนวนครั้งที่สอบได้",
  "rules.attemptCooldownMinutes": "ระยะพักก่อนสอบซ้ำ (นาที)",
  "rules.shuffleQuestions": "การสุ่มลำดับข้อสอบ",
  "rules.shuffleOptions": "การสุ่มลำดับตัวเลือก",
  "rules.requireCourseComplete": "เงื่อนไขเรียนจบหลักสูตรก่อนสอบ",
  "rules.proctoringMode": "ระบบคุมการสอบ",
  "rules.effectiveFrom": "วันเริ่มใช้กติกา",
  questions: "รายการข้อสอบ",
  enrollmentId: "รหัสการลงทะเบียน",
  reason: "เหตุผลการเพิกถอน",
  id: "รหัสอ้างอิงประกาศนียบัตร",
  body: "ข้อมูลที่ส่ง",
  query: "เงื่อนไขการค้นหา",
};

/** field path ของ ERR-VAL-001 → ชื่อภาษาไทย (ไม่รู้จัก = ส่ง path เดิมกลับ ไม่เดาความ) */
export function validationFieldLabels(fields: readonly string[]): string[] {
  return fields.map((field) => VALIDATION_FIELD_LABEL_TH[field] ?? field);
}

/* ─── ทะเบียนประกาศนียบัตร (Wave E · PB-20 — GET /admin/certificates) ───
   ส่วนเพิ่มใหม่ล้วน (ไฟล์นี้หน้าอื่นใช้ร่วม — ห้ามแก้ของเดิม) */

/** สถานะประกาศนียบัตร — enum certificate_status (0001_extensions L122) */
export type ExamAdminCertificateStatus = "valid" | "revoked" | "superseded";

/** ตรวจสถานะจาก BFF — ค่านอก enum = drift (parser ต้อง fail-closed) */
export function isExamAdminCertificateStatus(value: unknown): value is ExamAdminCertificateStatus {
  return value === "valid" || value === "revoked" || value === "superseded";
}

/** แถวทะเบียนใบ (CertificateListRowResource ของ BFF — snapshot ของวันออกใบ ไม่ live-join) */
export interface ExamAdminCertificateRow {
  readonly id: string;
  readonly certNo: string;
  readonly verifyCode: string;
  readonly status: ExamAdminCertificateStatus;
  readonly issuedAt: string;
  readonly userId: string;
  readonly holderName: string;
  readonly courseId: string;
  readonly courseTitle: string;
}

/** ป้ายสถานะภาษาไทย (แหล่งเดียว — หน้าอ้างจากที่นี่) */
export const CERT_STATUS_LABEL_TH: Record<ExamAdminCertificateStatus, string> = {
  valid: "ใช้งาน",
  revoked: "เพิกถอนแล้ว",
  superseded: "ถูกแทนด้วยใบใหม่",
};

/** โทน badge ต่อสถานะ (คู่กับ StatusBadge — DESIGN-SYSTEM §5.6) */
export const CERT_STATUS_TONE: Record<ExamAdminCertificateStatus, "success" | "danger" | "neutral"> = {
  valid: "success",
  revoked: "danger",
  superseded: "neutral",
};

/** ตัวเลือกของ select ค้นหาตามสถานะ (ค่าว่าง = ทุกสถานะ) */
export const CERT_STATUS_OPTIONS: ReadonlyArray<{ value: ExamAdminCertificateStatus | ""; label: string }> = [
  { value: "", label: "ทุกสถานะ" },
  { value: "valid", label: "ใช้งาน" },
  { value: "revoked", label: "เพิกถอนแล้ว" },
  { value: "superseded", label: "ถูกแทนด้วยใบใหม่" },
];

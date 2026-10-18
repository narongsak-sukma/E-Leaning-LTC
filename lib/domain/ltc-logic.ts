/**
 * Pure Domain Logic — LTC E-Learning (สภาทนายความแห่งประเทศไทย)
 * Zero React/Next/DOM imports so it can be unit-tested directly via `node:test`.
 * Aligned with:
 * - docs/04-api-security/RBAC-DESIGN.md (8 roles, 41 permissions, MFA enforcement)
 * - docs/04-api-security/API-SPECIFICATION.md (Error registry, PDPA verification contract)
 * - docs/03-design/DATA-DICTIONARY.md (49-table domain invariants, D84 exam review, Credit Bank ledger)
 * - docs/05-ui/DESIGN-SYSTEM.md (§5.4 Credit meter rules, §9 Thai Buddhist Era date formatting)
 */

export const ROLES = [
  "citizen",
  "lawyer",
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
  "super_admin",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS_TH: Record<Role, string> = {
  citizen: "ประชาชนทั่วไป",
  lawyer: "ทนายความ",
  instructor: "วิทยากรผู้สอน",
  "staff:viewer": "เจ้าหน้าที่ (ดูข้อมูล)",
  "staff:content": "เจ้าหน้าที่ฝ่ายเนื้อหาหลักสูตร",
  "staff:exam": "เจ้าหน้าที่ฝ่ายคลังข้อสอบและประเมินผล",
  "staff:registrar": "นายทะเบียนสภาทนายความ",
  super_admin: "ผู้ดูแลระบบสูงสุด (Super Admin)",
};

export const PERMISSIONS = [
  "course:view",
  "course:create",
  "course:update",
  "course:delete",
  "course:publish",
  "lesson:view",
  "lesson:update",
  "enroll:create",
  "question_bank:view",
  "question_bank:create",
  "question_bank:update",
  "question_bank:delete",
  "assessment:view",
  "assessment:create",
  "assessment:update",
  "assessment:approve",
  "attempt:start",
  "attempt:view",
  "attempt:grade_override",
  "certificate:verify",
  "certificate:view",
  "certificate:issue",
  "certificate:revoke",
  "credit_rule:view",
  "credit_rule:create",
  "credit_rule:update",
  "credit_ledger:view",
  "credit_adjustment:create",
  "user:view",
  "user:create",
  "user:update",
  "user:disable",
  "license:verify",
  "role:grant",
  "role:revoke",
  "audit_log:view",
  "audit_log:export",
  "report:view",
  "report:export",
  "notification:view",
  "notification:send",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  citizen: [
    "course:view",
    "lesson:view",
    "enroll:create",
    "assessment:view",
    "attempt:start",
    "attempt:view",
    "certificate:verify",
    "certificate:view",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  lawyer: [
    "course:view",
    "lesson:view",
    "enroll:create",
    "assessment:view",
    "attempt:start",
    "attempt:view",
    "certificate:verify",
    "certificate:view",
    "credit_ledger:view",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  instructor: [
    "course:view",
    "course:create",
    "course:update",
    "lesson:view",
    "lesson:update",
    "enroll:create",
    "question_bank:view",
    "question_bank:create",
    "question_bank:update",
    "assessment:view",
    "assessment:create",
    "assessment:update",
    "attempt:start",
    "attempt:view",
    "certificate:verify",
    "certificate:view",
    "credit_ledger:view",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  "staff:viewer": [
    "course:view",
    "lesson:view",
    "question_bank:view",
    "assessment:view",
    "attempt:view",
    "certificate:verify",
    "credit_rule:view",
    "credit_ledger:view",
    "user:view",
    "audit_log:view",
    "report:view",
    "report:export",
    "notification:view",
  ],
  "staff:content": [
    "course:view",
    "course:create",
    "course:update",
    "course:delete",
    "course:publish",
    "lesson:view",
    "lesson:update",
    "certificate:verify",
    "user:view",
    "audit_log:view",
    "notification:view",
  ],
  "staff:exam": [
    "course:view",
    "lesson:view",
    "question_bank:view",
    "question_bank:create",
    "question_bank:update",
    "question_bank:delete",
    "assessment:view",
    "assessment:create",
    "assessment:update",
    "assessment:approve",
    "attempt:view",
    "attempt:grade_override",
    "certificate:verify",
    "user:view",
    "audit_log:view",
    "report:view",
    "report:export",
    "notification:view",
  ],
  "staff:registrar": [
    "course:view",
    "lesson:view",
    "assessment:view",
    "attempt:view",
    "certificate:verify",
    "certificate:issue",
    "certificate:revoke",
    "credit_rule:view",
    "credit_rule:create",
    "credit_rule:update",
    "credit_ledger:view",
    "credit_adjustment:create",
    "user:view",
    "user:update",
    "license:verify",
    "role:grant",
    "role:revoke",
    "audit_log:view",
    "report:view",
    "report:export",
    "notification:view",
    "notification:send",
  ],
  super_admin: [
    "course:view",
    "course:create",
    "course:update",
    "course:delete",
    "course:publish",
    "lesson:view",
    "lesson:update",
    "enroll:create",
    "question_bank:view",
    "question_bank:create",
    "question_bank:update",
    "question_bank:delete",
    "assessment:view",
    "assessment:create",
    "assessment:update",
    "assessment:approve",
    "attempt:start",
    "attempt:view",
    "attempt:grade_override",
    "certificate:verify",
    "certificate:view",
    "certificate:issue",
    "certificate:revoke",
    "credit_rule:view",
    "credit_rule:create",
    "credit_rule:update",
    "credit_ledger:view",
    "credit_adjustment:create",
    "user:view",
    "user:create",
    "user:update",
    "user:disable",
    "license:verify",
    "role:grant",
    "role:revoke",
    "audit_log:view",
    "audit_log:export",
    "report:view",
    "report:export",
    "notification:view",
    "notification:send",
  ],
};

export const MFA_REQUIRED_ROLES: readonly Role[] = [
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
  "super_admin",
] as const;

export const BACKOFFICE_ROLES: readonly Role[] = [
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
  "super_admin",
] as const;

export const FRONTOFFICE_ROLES: readonly Role[] = ["citizen", "lawyer"] as const;

export type AalLevel = "aal1" | "aal2";

export function requiresMfa(roles: readonly string[]): boolean {
  return roles.some((role) => (MFA_REQUIRED_ROLES as readonly string[]).includes(role));
}

export function hasBackofficeAccess(roles: readonly string[]): boolean {
  return roles.some((role) => (BACKOFFICE_ROLES as readonly string[]).includes(role));
}

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  return roles.some((role) => {
    const perms = ROLE_PERMISSIONS[role as Role];
    return perms !== undefined && perms.includes(permission);
  });
}

export const ERROR_REGISTRY = {
  "ERR-AUTH-001": { httpStatus: 401, message: "ต้องเข้าสู่ระบบก่อนใช้บริการนี้" },
  "ERR-AUTH-002": { httpStatus: 401, message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" },
  "ERR-AUTH-003": { httpStatus: 423, message: "บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ภายหลัง" },
  "ERR-AUTH-004": { httpStatus: 403, message: "กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ" },
  "ERR-AUTH-005": { httpStatus: 400, message: "รหัสยืนยันตัวตนสองชั้น (OTP) ไม่ถูกต้องหรือหมดอายุ" },
  "ERR-RBAC-001": { httpStatus: 403, message: "คุณไม่มีสิทธิ์ดำเนินการนี้" },
  "ERR-VAL-001": { httpStatus: 400, message: "ข้อมูลที่ส่งมาไม่ถูกต้อง" },
  "ERR-NF-001": { httpStatus: 404, message: "ไม่พบข้อมูลที่ต้องการ" },
  "ERR-RATE-001": { httpStatus: 429, message: "มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่" },
  "ERR-SYS-001": { httpStatus: 500, message: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่" },
  "ERR-CRS-001": { httpStatus: 404, message: "ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่" },
  "ERR-ENR-001": { httpStatus: 409, message: "คุณลงทะเบียนหลักสูตรนี้แล้ว" },
  "ERR-ENR-002": { httpStatus: 422, message: "หลักสูตรนี้จำกัดเฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว" },
  "ERR-LRN-001": { httpStatus: 403, message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน" },
  "ERR-LRN-002": { httpStatus: 422, message: "ยังเรียนบทเรียนไม่ครบตามเงื่อนไขก่อนเข้าสอบ" },
  "ERR-ASM-001": { httpStatus: 422, message: "คุณใช้จำนวนครั้งการสอบครบตามกติกาแล้ว" },
  "ERR-ASM-002": { httpStatus: 409, message: "มีการสอบที่ยังไม่จบอยู่แล้ว" },
  "ERR-ASM-004": { httpStatus: 422, message: "หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม" },
  "ERR-ASM-005": { httpStatus: 422, message: "บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว" },
  "ERR-ASM-007": {
    httpStatus: 422,
    message: "ผ่านการสอบนี้แล้ว จึงสอบซ้ำไม่ได้ — ดูผลสอบได้ที่หน้าผลสอบ",
  },
  "ERR-CRD-001": { httpStatus: 422, message: "กฎเครดิตนี้มีผลใช้งานแล้ว แก้ไขต้องสร้างฉบับใหม่" },
  "ERR-CRD-002": { httpStatus: 422, message: "การปรับหน่วยกิตต้องระบุเหตุผลอย่างน้อย 5 ตัวอักษร" },
  "ERR-ADM-001": { httpStatus: 403, message: "บัญชีนี้ไม่มีสิทธิ์เข้าใช้งานพอร์ทัลผู้ดูแลระบบ (Backoffice)" },
} as const;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

export interface AuthorizationCheckInput {
  userId: string | null;
  roles: readonly string[];
  aal: AalLevel;
  permission: Permission;
}

export type AuthorizationOutcome =
  | { allowed: true }
  | { allowed: false; errorCode: ErrorCode; httpStatus: number; message: string };

/**
 * Pure RBAC + MFA authorization decision (RBAC-DESIGN §1.2-4, D25-O4)
 */
export function authorizeAction(input: AuthorizationCheckInput): AuthorizationOutcome {
  if (!input.userId) {
    const def = ERROR_REGISTRY["ERR-AUTH-001"];
    return { allowed: false, errorCode: "ERR-AUTH-001", httpStatus: def.httpStatus, message: def.message };
  }
  if (requiresMfa(input.roles) && input.aal !== "aal2") {
    const def = ERROR_REGISTRY["ERR-AUTH-004"];
    return { allowed: false, errorCode: "ERR-AUTH-004", httpStatus: def.httpStatus, message: def.message };
  }
  if (!hasPermission(input.roles, input.permission)) {
    const def = ERROR_REGISTRY["ERR-RBAC-001"];
    return { allowed: false, errorCode: "ERR-RBAC-001", httpStatus: def.httpStatus, message: def.message };
  }
  return { allowed: true };
}

/* ============================================================================
 * Exam Engine Pure Logic (M4 Assessment & Certification — D84)
 * ============================================================================ */

export interface ExamQuestionItem {
  id: string;
  moduleTitle: string;
  points: number;
  correctOptionId: string;
}

export interface ModuleScoreBreakdown {
  moduleTitle: string;
  earnedPoints: number;
  totalPoints: number;
  percent: number;
}

export interface ExamGradeResult {
  earnedPoints: number;
  totalPoints: number;
  scorePercent: number;
  passed: boolean;
  correctCount: number;
  totalQuestions: number;
  moduleBreakdown: ModuleScoreBreakdown[];
}

export function gradeExamAttempt(
  questions: readonly ExamQuestionItem[],
  selectedOptionByQuestionId: Readonly<Record<string, string | undefined>>,
  passPct: number,
): ExamGradeResult {
  if (questions.length === 0) {
    return {
      earnedPoints: 0,
      totalPoints: 0,
      scorePercent: 0,
      passed: false,
      correctCount: 0,
      totalQuestions: 0,
      moduleBreakdown: [],
    };
  }

  let earnedPoints = 0;
  let totalPoints = 0;
  let correctCount = 0;
  const moduleMap = new Map<string, { earned: number; total: number }>();

  for (const q of questions) {
    const pts = q.points > 0 ? q.points : 1;
    totalPoints += pts;
    const isCorrect = selectedOptionByQuestionId[q.id] === q.correctOptionId;
    if (isCorrect) {
      earnedPoints += pts;
      correctCount += 1;
    }
    const mod = moduleMap.get(q.moduleTitle) ?? { earned: 0, total: 0 };
    mod.total += pts;
    if (isCorrect) {
      mod.earned += pts;
    }
    moduleMap.set(q.moduleTitle, mod);
  }

  const scorePercent = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
  const passed = scorePercent >= passPct;

  const moduleBreakdown: ModuleScoreBreakdown[] = [];
  for (const [moduleTitle, stats] of moduleMap.entries()) {
    moduleBreakdown.push({
      moduleTitle,
      earnedPoints: stats.earned,
      totalPoints: stats.total,
      percent: stats.total > 0 ? Math.round((stats.earned / stats.total) * 100) : 0,
    });
  }

  return {
    earnedPoints,
    totalPoints,
    scorePercent,
    passed,
    correctCount,
    totalQuestions: questions.length,
    moduleBreakdown,
  };
}

/**
 * Invariant D84 (Wave G P3):
 * เฉลยเปิด ⟺ ไม่มี attempt ค้าง (in_progress) ∧ reviewMode ≠ 'never' ∧ (ครบ maxAttempts ∨ passed)
 */
export function canReviewExamAnswers(params: {
  hasInProgressAttempt: boolean;
  reviewMode: "after_final_attempt" | "never";
  attemptsUsed: number;
  maxAttempts: number;
  hasPassedAttempt: boolean;
}): boolean {
  if (params.hasInProgressAttempt) return false;
  if (params.reviewMode === "never") return false;
  return params.hasPassedAttempt || params.attemptsUsed >= params.maxAttempts;
}

/* ============================================================================
 * Credit Bank Pure Logic (M5 Credit Bank — DESIGN-SYSTEM §5.4 & §7.2)
 * ============================================================================ */

export type LedgerEntryType = "accrual" | "adjustment" | "reversal" | "expiry";

export interface CreditLedgerItem {
  id: string;
  entryType: LedgerEntryType;
  creditsDelta: number; // positive for accrual, negative for reversal/expiry, signed for adjustment
}

export function computeNetCredits(entries: readonly CreditLedgerItem[]): number {
  const sum = entries.reduce((acc, item) => acc + item.creditsDelta, 0);
  return Math.max(0, Math.round(sum * 100) / 100);
}

export type CreditMeterTone = "brand" | "success" | "warning";

export interface CreditMeterState {
  earnedCredits: number;
  requiredCredits: number;
  remainingCredits: number;
  percent: number;
  tone: CreditMeterTone;
  badgeText: string | null;
  statusLabel: string;
}

/**
 * DESIGN-SYSTEM §5.4:
 * - < 50% = brand-600 (ปกติ ไม่มีป้ายสถานะพิเศษ)
 * - 50–84% = success-600 (ไม่มีป้ายสถานะพิเศษ)
 * - 85–99% = success-600 + ป้าย "ใกล้ครบเป้า"
 * - >= 100% = success-600 + ป้าย "ครบเป้าหมายรอบ" (ห้ามติดป้าย "ครบ" ก่อนถึง 100% จริง)
 * - ใกล้หมดเวลารอบ (daysLeft <= 30) และยังไม่ครบ = warning-600
 */
export function computeCreditMeterState(
  earnedCredits: number,
  requiredCredits: number = 12,
  daysRemainingInCycle: number = 120,
): CreditMeterState {
  const target = requiredCredits > 0 ? requiredCredits : 12;
  const safeEarned = Math.max(0, Math.round(earnedCredits * 100) / 100);
  const rawPct = Math.floor((safeEarned / target) * 100);
  const percent = Math.min(100, Math.max(0, rawPct));
  const remainingCredits = Math.max(0, Math.round((target - safeEarned) * 100) / 100);

  if (safeEarned >= target) {
    return {
      earnedCredits: safeEarned,
      requiredCredits: target,
      remainingCredits: 0,
      percent: 100,
      tone: "success",
      badgeText: "ครบเป้าหมายรอบ",
      statusLabel: "ครบตามเกณฑ์รอบต่ออายุ",
    };
  }

  if (daysRemainingInCycle <= 30) {
    return {
      earnedCredits: safeEarned,
      requiredCredits: target,
      remainingCredits,
      percent,
      tone: "warning",
      badgeText: "ใกล้สิ้นสุดรอบ",
      statusLabel: "กำลังสะสม (ใกล้สิ้นสุดรอบ)",
    };
  }

  if (percent >= 85) {
    return {
      earnedCredits: safeEarned,
      requiredCredits: target,
      remainingCredits,
      percent,
      tone: "success",
      badgeText: "ใกล้ครบเป้า",
      statusLabel: "ใกล้ครบเป้าหมาย",
    };
  }

  if (percent >= 50) {
    return {
      earnedCredits: safeEarned,
      requiredCredits: target,
      remainingCredits,
      percent,
      tone: "success",
      badgeText: null,
      statusLabel: "กำลังสะสม",
    };
  }

  return {
    earnedCredits: safeEarned,
    requiredCredits: target,
    remainingCredits,
    percent,
    tone: "brand",
    badgeText: null,
    statusLabel: "กำลังสะสม",
  };
}

/* ============================================================================
 * Public Certificate Verification — PDPA Minimal Disclosure (DESIGN-SYSTEM §8/09)
 * ============================================================================ */

export interface InternalCertificateRecord {
  id: string;
  verificationCode: string;
  userId: string;
  recipientName: string;
  recipientEmail: string;
  recipientPhone: string | null;
  recipientLicenseNo: string | null;
  courseId: string;
  courseTitleTh: string;
  creditsAwarded: number;
  issuedAt: string;
  status: "valid" | "revoked" | "superseded";
  revokedReason: string | null;
}

export interface PublicCertificateVerificationView {
  verificationCode: string;
  status: "valid" | "revoked" | "superseded";
  recipientName: string;
  courseTitleTh: string;
  creditsAwarded: number;
  issuedAt: string;
  issuer: string;
}

/**
 * Strips all non-essential PII (email, phone, userId, licenseNo) per PDPA requirement.
 */
export function buildPublicVerificationResponse(
  cert: InternalCertificateRecord,
): PublicCertificateVerificationView {
  return {
    verificationCode: cert.verificationCode,
    status: cert.status,
    recipientName: cert.recipientName,
    courseTitleTh: cert.courseTitleTh,
    creditsAwarded: cert.creditsAwarded,
    issuedAt: cert.issuedAt,
    issuer: "สภาทนายความแห่งประเทศไทย",
  };
}

const THAI_DATE_FORMAT = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const THAI_SHORT_DATE_FORMAT = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

export function formatThaiDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return THAI_DATE_FORMAT.format(d);
}

export function formatThaiShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return THAI_SHORT_DATE_FORMAT.format(d);
}

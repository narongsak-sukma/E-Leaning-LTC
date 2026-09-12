/**
 * credit.view — pure helpers ของหลังบ้าน credit bank (Wave E Phase 3 · Credit Bank)
 *
 * - ใช้ร่วม RSC + client ได้ (ไม่มี "use client" — import จาก admin-credit ที่ isomorphic)
 * - validation ของฟอร์มทั้งสอง mirror zod ขาเข้าของ BFF เป๊ะ (route credit-rules POST +
 *   credits/adjustments POST) เพื่อให้ผู้ใช้เห็น error ต่อฟิลด์ก่อนยิง request —
 *   BFF ยังตรวจซ้ำเสมอ (ไม่เชื่อ client เด็ดขาด)
 * - ป้าย/ฟอร์แมตภาษาไทยทั้งหมดผ่าน admin-credit (จุดเดียว)
 */
import {
  LEDGER_ENTRY_TYPES,
  type CreateCreditRuleInput,
  formatCreditDateThai,
  formatSignedCredit,
  type CreditLedgerRowParsed,
  type CreditRuleParsed,
  type CreditRuleStatusValue,
} from "@/lib/api/admin-credit";

// ——— ป้ายเสริมของหน้า (re-export จุดเดียวกัน) ———

export {
  CREDIT_RULE_STATUSES,
  LEDGER_ENTRY_TYPES,
  creditRuleStatusThai,
  creditRuleStatusTone,
  formatCreditDateThai,
  formatCreditDateTimeThai,
  formatSignedCredit,
  ledgerEntryTone,
  ledgerEntryTypeThai,
} from "@/lib/api/admin-credit";

/** จำนวน credit ในตารางกฎ — เช่น "12", "12.5" (ไม่มีเครื่องหมาย เพราะกฎเป็นบวกเสมอ) */
export function formatRuleCredits(credits: number): string {
  const fixed = (Math.round(credits * 100) / 100).toFixed(2);
  return fixed.endsWith(".00")
    ? fixed.slice(0, -3)
    : fixed.endsWith("0")
      ? fixed.slice(0, -1)
      : fixed;
}

/** ช่วงมีผลของกฎ — "1 ม.ค. 2569 – ไม่กำหนด" (พ.ศ. · DS §9 I18N-003) */
export function ruleWindowThai(rule: CreditRuleParsed): string {
  const from = formatCreditDateThai(rule.effectiveFrom);
  return rule.effectiveTo === null ? `${from} – ไม่กำหนด` : `${from} – ${formatCreditDateThai(rule.effectiveTo)}`;
}

/** ขอบเขตหลักสูตรของกฎ — courseId null = กฎทั่วไป (ตาราง credit_rules 0006) */
export function ruleCourseScopeThai(courseId: string | null): string {
  return courseId === null ? "ทุกหลักสูตร (ทั่วไป)" : "เฉพาะหลักสูตรที่ระบุ";
}

/** ปุ่ม lifecycle ที่ทำได้ต่อสถานะ — draft→active (เผยแพร่) · active→retired (ปลดระวัง) */
export function ruleLifecycleActions(
  status: CreditRuleStatusValue,
): ReadonlyArray<{ readonly status: "active" | "retired"; readonly label: string }> {
  if (status === "draft") {
    return [{ status: "active", label: "เผยแพร่" }];
  }
  if (status === "active") {
    return [{ status: "retired", label: "ปลดระวัง" }];
  }
  return [];
}

// ——— ฟอร์มสร้างกฎเครดิต (mirror CreateCreditRuleBody ของ BFF) ———

/** ช่องกรอกของฟอร์มสร้างกฎ — ตัวเลขเก็บเป็นสตริงจาก input แล้ว validate/แปลงตอน submit */
export interface CreditRuleFormState {
  readonly code: string;
  readonly name: string;
  readonly courseId: string;
  readonly creditType: string;
  readonly credits: string;
  readonly validDays: string;
  readonly carryOver: boolean;
  readonly requiredCreditsPerCycle: string;
  readonly priority: string;
  readonly renewalCycle: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
}

/** ค่าเริ่มต้นตรง default ของ BFF (creditType general · priority 100) */
export const CREDIT_RULE_FORM_DEFAULTS: CreditRuleFormState = {
  code: "",
  name: "",
  courseId: "",
  creditType: "general",
  credits: "",
  validDays: "",
  carryOver: false,
  requiredCreditsPerCycle: "",
  priority: "100",
  renewalCycle: "",
  effectiveFrom: "",
  effectiveTo: "",
};

export type CreditRuleFormField =
  | "code"
  | "name"
  | "courseId"
  | "creditType"
  | "credits"
  | "validDays"
  | "requiredCreditsPerCycle"
  | "priority"
  | "renewalCycle"
  | "effectiveFrom"
  | "effectiveTo";

/** ชื่อฟิลด์ภาษาไทย — แสดงหน้าช่อง + ข้อความ error */
export const CREDIT_RULE_FIELD_LABELS_TH: Record<CreditRuleFormField, string> = {
  code: "รหัสกฎ",
  name: "ชื่อกฎ",
  courseId: "หลักสูตร (uuid)",
  creditType: "ประเภท credit",
  credits: "จำนวน credit",
  validDays: "อายุ (วัน)",
  requiredCreditsPerCycle: "เกณฑ์ต่อรอบ",
  priority: "ลำดับความสำคัญ",
  renewalCycle: "ประเภทรอบ",
  effectiveFrom: "มีผลตั้งแต่",
  effectiveTo: "มีผลถึง",
};

/** รูปแบบรหัสกฎ — CR-LTC-### (สัญญาเดียวกับ BFF) */
const CODE_RE = /^CR-LTC-\d{3}$/;
/** ประเภท/รอบ — identifier ตัวพิมพ์เล็ก (สัญญาเดียวกับ p_credit_type ของ RPC 0031) */
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,49}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** จำนวนทศนิยม ≤2 ตำแหน่ง (numeric(6,2)) — tolerance กัน float */
function isAtMostTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/** แปลงช่องตัวเลข → number ("" = null · ไม่ใช่ตัวเลข = NaN เพื่อให้ validate ตีตกรได้) */
function numberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

/**
 * validate ฟอร์มสร้างกฎ — mirror zod ขาเข้าของ BFF เป๊ะ · คืนชุดฟิลด์ที่ผิด
 * (ว่าง = ผ่านทั้งฟอร์ม)
 */
export function validateCreditRuleForm(
  state: CreditRuleFormState,
): ReadonlySet<CreditRuleFormField> {
  const errors = new Set<CreditRuleFormField>();
  if (!CODE_RE.test(state.code.trim())) {
    errors.add("code");
  }
  const name = state.name.trim();
  if (name.length < 1 || name.length > 200) {
    errors.add("name");
  }
  if (state.courseId.trim().length > 0 && !UUID_RE.test(state.courseId.trim())) {
    errors.add("courseId");
  }
  if (!IDENTIFIER_RE.test(state.creditType.trim())) {
    errors.add("creditType");
  }
  const credits = numberOrNull(state.credits);
  if (
    credits === null ||
    Number.isNaN(credits) ||
    credits <= 0 ||
    credits > 9999.99 ||
    !isAtMostTwoDecimals(credits)
  ) {
    errors.add("credits");
  }
  const validDays = numberOrNull(state.validDays);
  if (
    validDays !== null &&
    (Number.isNaN(validDays) ||
      !Number.isInteger(validDays) ||
      validDays < 1 ||
      validDays > 36500)
  ) {
    errors.add("validDays");
  }
  const required = numberOrNull(state.requiredCreditsPerCycle);
  if (
    required !== null &&
    (Number.isNaN(required) ||
      required <= 0 ||
      required > 9999.99 ||
      !isAtMostTwoDecimals(required))
  ) {
    errors.add("requiredCreditsPerCycle");
  }
  const priority = numberOrNull(state.priority);
  if (
    priority === null ||
    Number.isNaN(priority) ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 2147483647
  ) {
    errors.add("priority");
  }
  if (state.renewalCycle.trim().length > 0 && !IDENTIFIER_RE.test(state.renewalCycle.trim())) {
    errors.add("renewalCycle");
  }
  const from = state.effectiveFrom.trim();
  if (from.length > 0 && !ISO_DATE_RE.test(from)) {
    errors.add("effectiveFrom");
  }
  const to = state.effectiveTo.trim();
  if (to.length > 0 && (!ISO_DATE_RE.test(to) || (from.length > 0 && to <= from))) {
    errors.add("effectiveTo");
  }
  return errors;
}

/** body ของ POST /admin/credit-rules — ใส่เฉพาะ key ที่ผู้ใช้กรอก ("" = ไม่ส่ง/null) */
export function buildCreditRuleCreateBody(state: CreditRuleFormState):
  | { readonly ok: true; readonly body: CreateCreditRuleInput }
  | { readonly ok: false; readonly fields: ReadonlySet<CreditRuleFormField> } {
  const errors = validateCreditRuleForm(state);
  if (errors.size > 0) {
    return { ok: false, fields: errors };
  }
  const credits = numberOrNull(state.credits);
  const priority = numberOrNull(state.priority);
  // validate ผ่านแล้วสองค่านี้ต้องไม่ null — เช็คซ้ำแบบ fail-closed กัน type hole
  if (credits === null || priority === null) {
    return { ok: false, fields: new Set<CreditRuleFormField>(["credits", "priority"]) };
  }
  const courseId = state.courseId.trim();
  const validDays = numberOrNull(state.validDays);
  const required = numberOrNull(state.requiredCreditsPerCycle);
  const renewalCycle = state.renewalCycle.trim();
  const from = state.effectiveFrom.trim();
  const to = state.effectiveTo.trim();
  const body: CreateCreditRuleInput = {
    code: state.code.trim(),
    name: state.name.trim(),
    creditType: state.creditType.trim(),
    credits,
    carryOver: state.carryOver,
    priority,
    ...(courseId.length > 0 ? { courseId } : {}),
    ...(validDays !== null ? { validDays } : {}),
    ...(required !== null ? { requiredCreditsPerCycle: required } : {}),
    ...(renewalCycle.length > 0 ? { renewalCycle } : {}),
    ...(from.length > 0 ? { effectiveFrom: from } : {}),
    ...(to.length > 0 ? { effectiveTo: to } : {}),
  };
  return { ok: true, body };
}

// ——— ฟอร์มปรับ credit (mirror AdjustCreditBody ของ BFF) ———

/** ช่องกรอกของฟอร์มปรับ credit — ตัวเลขเก็บเป็นสตริงจาก input */
export interface CreditAdjustFormState {
  readonly userId: string;
  readonly cycleId: string;
  readonly creditType: string;
  readonly amount: string;
  readonly reason: string;
}

/** ค่าเริ่มต้น — creditType general ตาม default ของ DB/กฎ */
export const CREDIT_ADJUST_FORM_DEFAULTS: CreditAdjustFormState = {
  userId: "",
  cycleId: "",
  creditType: "general",
  amount: "",
  reason: "",
};

export type CreditAdjustFormField = "userId" | "cycleId" | "creditType" | "amount" | "reason";

/** ชื่อฟิลด์ภาษาไทยของฟอร์มปรับ credit */
export const CREDIT_ADJUST_FIELD_LABELS_TH: Record<CreditAdjustFormField, string> = {
  userId: "ผู้ใช้ (uuid)",
  cycleId: "รอบต่ออายุ (uuid)",
  creditType: "ประเภท credit",
  amount: "จำนวนที่ปรับ (+/−)",
  reason: "เหตุผล",
};

/**
 * validate ฟอร์มปรับ credit — mirror zod ขาเข้า BFF: amount ≠ 0 · |amount| ≤ 9999.99 ·
 * ทศนิยม ≤2 · reason 10-500 (ERR-CRD-002) — ข้อความยาวนับตัวอักษรจริง (trim แล้ว)
 */
export function validateAdjustForm(state: CreditAdjustFormState): ReadonlySet<CreditAdjustFormField> {
  const errors = new Set<CreditAdjustFormField>();
  if (!UUID_RE.test(state.userId.trim())) {
    errors.add("userId");
  }
  if (!UUID_RE.test(state.cycleId.trim())) {
    errors.add("cycleId");
  }
  if (!IDENTIFIER_RE.test(state.creditType.trim())) {
    errors.add("creditType");
  }
  const amount = numberOrNull(state.amount);
  if (
    amount === null ||
    Number.isNaN(amount) ||
    amount === 0 ||
    Math.abs(amount) > 9999.99 ||
    !isAtMostTwoDecimals(amount)
  ) {
    errors.add("amount");
  }
  const reason = state.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    errors.add("reason");
  }
  return errors;
}

/** body ของ POST /admin/credits/adjustments (camelCase ตามสัญญา BFF) */
export function buildAdjustBody(state: CreditAdjustFormState):
  | { readonly ok: true; readonly body: { readonly userId: string; readonly cycleId: string; readonly creditType: string; readonly amount: number; readonly reason: string } }
  | { readonly ok: false; readonly fields: ReadonlySet<CreditAdjustFormField> } {
  const errors = validateAdjustForm(state);
  if (errors.size > 0) {
    return { ok: false, fields: errors };
  }
  const amount = numberOrNull(state.amount);
  if (amount === null || Number.isNaN(amount)) {
    return { ok: false, fields: new Set<CreditAdjustFormField>(["amount"]) };
  }
  return {
    ok: true,
    body: {
      userId: state.userId.trim(),
      cycleId: state.cycleId.trim(),
      creditType: state.creditType.trim(),
      amount,
      reason: state.reason.trim(),
    },
  };
}

// ——— แถวตาราง ledger (คอลัมน์สรุป) ———

/** ป้ายผู้บันทึก — createdBy null = ระบบ (accrual/expiry อัตโนมัติ) */
export function ledgerActorThai(createdBy: string | null): string {
  return createdBy === null ? "ระบบ" : "เจ้าหน้าที่";
}

/** ข้อความเหตุผลในตาราง — null = "—" (accrual ไม่มีเหตุผล) */
export function ledgerReasonThai(reason: string | null): string {
  return reason === null || reason.length === 0 ? "—" : reason;
}

/** จำนวน ledger มีเครื่องหมาย (+12 / -3) — re-export รูปทรงเดียวกับ admin-credit */
export function ledgerAmountThai(amount: number): string {
  return formatSignedCredit(amount);
}

/** ตรวจประเภทรายการจากค่า string (guard ก่อนเรียกป้าย) — เผื่อ UI ที่ยังไม่ parse */
export function isLedgerEntryType(value: string): value is CreditLedgerRowParsed["entryType"] {
  return (LEDGER_ENTRY_TYPES as readonly string[]).includes(value);
}

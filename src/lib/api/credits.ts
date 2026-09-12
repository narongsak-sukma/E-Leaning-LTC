/**
 * credits — data layer "หน่วยกิตสะสม + transcript ของตัวเอง" (Wave E Phase 3 · CRB-005/006 ·
 * API-SPECIFICATION 1.1.0 §3 แถว /me/credits + /me/transcript)
 *
 * - GET /api/v1/me/credits — RPC my_credit_summary (0031 §7): รอบปัจจุบัน (lazy สร้างเฉพาะ
 *   ผู้ถือ role lawyer หรือผู้มีรอบเดิม — citizen = current: null) + ประวัติทุกรอบ
 * - GET /api/v1/me/transcript — RPC my_credit_transcript (0031 §8): แถวต่อ enrollment
 *   (ผลสอบ/หน่วยกิตสุทธิ/ใบประกาศฯ) · ?format=json|csv — csv = text/csv มี BOM + กันสูตร
 *   (buildCsv จาก src/lib/reports/csv — จุดเดียวกับรายงานเจ้าหน้าที่) · v1 ไม่มี pdf
 *   (API-SPEC กำหนด csv|json สำหรับ lane นี้ — format อื่น = 400 ERR-VAL-001)
 * - transport ผ่านชั้นกลาง src/lib/api/transport.ts (PB-19) — fetchJson + re-export ApiError
 *   · ขาออกฝั่ง client zod-parse ทุกครั้ง (strict ทุกชั้น) — ผิดสัญญา = ERR-SYS-001
 *   fail-closed แบบเดียวกับ fixtures/certificates.ts
 * - ข้อความผู้ใช้ทั้งหมดเป็นภาษาไทย (pure helpers — ทดสอบได้โดยไม่ต้อง stub อะไร)
 */
import { z } from "zod";

import { buildCsv } from "@/lib/reports/csv";

import { certificateStatusThai } from "@/lib/fixtures/certificates";

import { ApiError, fetchJson, type TransportCallOptions } from "@/lib/api/transport";

export { ApiError };
export type { TransportCallOptions };

// ——— สัญญาข้อมูล (ตรวจขาออกฝั่ง BFF และฝั่ง client ด้วย schema เดียวกัน — strict ทุกชั้น) ———

/** เวลา ISO 8601 (API-SPECIFICATION §1.1 — ยอมทั้ง Z และ +00:00) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** วันที่คอลัมน์ date ของ renewal_cycles ผ่าน jsonb (0031 §7) — รูป "YYYY-MM-DD" */
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** enum cycle_status (0001 L128) */
export const CYCLE_STATUSES = ["open", "closed", "grace"] as const;

const CycleStatus = z.enum(CYCLE_STATUSES);

export type CycleStatusValue = (typeof CYCLE_STATUSES)[number];

/** enum enrollment_status (0001 L100) */
export const ENROLLMENT_STATUSES = ["active", "completed", "expired", "cancelled"] as const;

const EnrollmentStatus = z.enum(ENROLLMENT_STATUSES);

export type EnrollmentStatusValue = (typeof ENROLLMENT_STATUSES)[number];

/**
 * ยอดต่อ credit_type — คู่ของ required_credits (jsonb {"<type>": เกณฑ์}) กับ balances
 * (jsonb_object_agg จาก ledger จริง — มีเฉพาะ type ที่มีรายการ ledger · earned ติดลบได้
 * กรณี adjustment ติดลบ · missing = greatest(required - earned, 0) จึง >= 0 เสมอ)
 */
const CreditBalanceEntry = z
  .object({
    earned: z.number(),
    required: z.number().min(0),
    missing: z.number().min(0),
  })
  .strict();

export type CreditBalanceEntryParsed = z.infer<typeof CreditBalanceEntry>;

/** รอบต่ออายุหนึ่งรอบ — รูปเดียวกันทั้ง "current" และแถว "history" (row_to_json ของ 0031 §7) */
const CreditCycle = z
  .object({
    cycle_id: z.string().uuid(),
    cycle_no: z.number().int().min(1),
    starts_on: IsoDate,
    ends_on: IsoDate,
    status: CycleStatus,
    required_credits: z.record(z.string(), z.number()),
    balances: z.record(z.string(), CreditBalanceEntry),
  })
  .strict();

export type CreditCycleParsed = z.infer<typeof CreditCycle>;

/** ผล RPC my_credit_summary — current = null เมื่อผู้ใช้ไม่มีรอบ (citizen/ยังไม่มีข้อมูล) */
export const CreditSummaryView = z
  .object({
    user_id: z.string().uuid(),
    current: CreditCycle.nullable(),
    history: z.array(CreditCycle),
  })
  .strict();

export type CreditSummaryViewParsed = z.infer<typeof CreditSummaryView>;

/** ใบประกาศฯ ที่ผูกกับ enrollment ในแถว transcript — status ตาม enum certificate_status (0001 L122) */
const TranscriptCertificate = z
  .object({
    cert_no: z.string().min(1),
    status: z.enum(["valid", "revoked", "superseded"]),
    issued_at: IsoTimestamp,
  })
  .strict();

export type TranscriptCertificateParsed = z.infer<typeof TranscriptCertificate>;

/** แถว transcript ต่อ enrollment (0031 §8 — jsonb_build_object ต่อแถว) — หน่วยกิตสุทธิ (accrual − reversal) */
const TranscriptEntry = z
  .object({
    enrollment_id: z.string().uuid(),
    course_id: z.string().uuid(),
    course_title: z.string().min(1),
    enrollment_status: EnrollmentStatus,
    completed_at: IsoTimestamp.nullable(),
    passed: z.boolean().nullable(),
    best_score_pct: z.number().int().min(0).max(100).nullable(),
    passed_at: IsoTimestamp.nullable(),
    credits: z.record(z.string(), z.number()),
    certificates: z.array(TranscriptCertificate),
  })
  .strict();

export type TranscriptEntryParsed = z.infer<typeof TranscriptEntry>;

/** ผล RPC my_credit_transcript — entries เรียงตาม (completed/enrolled) มาก→น้อย ฝั่ง RPC แล้ว */
export const TranscriptView = z
  .object({
    user_id: z.string().uuid(),
    generated_at: IsoTimestamp,
    entries: z.array(TranscriptEntry),
  })
  .strict();

export type TranscriptViewParsed = z.infer<typeof TranscriptView>;

// ——— ทะเบียนข้อความไทย (pure — ทดสอบได้โดยไม่ต้อง stub อะไร) ———

/**
 * ป้าย credit_type — Q1 มีชนิดเดียว (general · credit_cycle_defaults 0031 §1) ·
 * ชนิดอื่นที่เพิ่มทีหลังผ่าน credit_rules = แสดงรหัสเดิม (fallback) จนกว่าจะเพิ่มป้าย
 */
const CREDIT_TYPE_THAI: Record<string, string> = {
  general: "ทั่วไป",
};

export function creditTypeThai(creditType: string): string {
  return CREDIT_TYPE_THAI[creditType] ?? creditType;
}

/** ป้ายสถานะรอบ — enum cycle_status (0001 L128) */
const CYCLE_STATUS_THAI: Record<CycleStatusValue, string> = {
  open: "กำลังดำเนินอยู่",
  closed: "ปิดแล้ว",
  grace: "ช่วงผ่อนผัน",
};

export function cycleStatusThai(status: CycleStatusValue): string {
  return CYCLE_STATUS_THAI[status];
}

/** ป้ายสถานะการลงทะเบียน — enum enrollment_status (0001 L100 · แบบเดียวกับหน้าหลักสูตรของฉัน) */
const ENROLLMENT_STATUS_THAI: Record<EnrollmentStatusValue, string> = {
  active: "กำลังเรียน",
  completed: "เรียนจบแล้ว",
  expired: "สิทธิ์เรียนหมดอายุ",
  cancelled: "ยกเลิก",
};

export function enrollmentStatusThai(status: EnrollmentStatusValue): string {
  return ENROLLMENT_STATUS_THAI[status];
}

/** ป้ายคอลัมน์ "ผ่าน" — passed เป็น null เมื่อยังไม่มีความพยายามสอบเลย (bool_or ของแถวว่าง) */
export function passedLabel(passed: boolean | null): string {
  if (passed === null) {
    return "ยังไม่มีผลสอบ";
  }
  return passed ? "ผ่าน" : "ไม่ผ่าน";
}

/**
 * จำนวนหน่วยกิตแบบอ่านง่าย — จำนวนเต็มตัดจุดทศนิยม (12 → "12") · มีเศษคง 2 ตำแหน่ง
 * (3.5 → "3.50") ตรงคอลัมน์ numeric(6,2) ของ ledger
 */
export function formatCreditAmount(amount: number): string {
  if (Number.isInteger(amount)) {
    return String(amount);
  }
  return amount.toFixed(2);
}

/**
 * หน่วยกิตสุทธิเป็น text — เช่น "general: 3.50" · หลายชนิดคั่น "; " (เรียงตามคีย์ให้นิ่ง
 * สำหรับไฟล์ CSV) · ไม่มีรายการ = "" (เซลล์ว่าง)
 */
export function formatCreditsText(credits: Readonly<Record<string, number>>): string {
  return Object.keys(credits)
    .sort()
    .map((creditType) => `${creditType}: ${formatCreditAmount(credits[creditType] ?? 0)}`)
    .join("; ");
}

/**
 * รายการใบประกาศฯ เป็น text — "LTC-2026-000001 (ใช้งานได้)" คั่น "; " · ไม่มีใบ = ""
 * (ป้ายสถานะภาษาไทยมาจากทะเบียนกลาง fixtures/certificates เดียวกับหน้าประกาศนียบัตร)
 */
export function formatCertificateListText(
  certificates: ReadonlyArray<TranscriptCertificateParsed>,
): string {
  return certificates
    .map((certificate) => `${certificate.cert_no} (${certificateStatusThai(certificate.status)})`)
    .join("; ");
}

/** วันที่รอบแบบพุทธศักราช "1 มกราคม 2569" — DS §9 I18N-003 (แบบเดียวกับ formatIssuedAtThai) */
export function formatCycleDateThai(isoDate: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    calendar: "buddhist",
  }).format(new Date(isoDate));
}

/** วันที่เหตุการณ์การเรียน (completed_at/passed_at) — แสดงเฉพาะวันที่ แบบพุทธศักราชเดียวกัน */
export function formatActivityDateThai(isoTimestamp: string): string {
  return formatCycleDateThai(isoTimestamp);
}

// ——— URL builders (BFF-relative path เท่านั้น — API-SPECIFICATION §3) ———

/** GET /api/v1/me/credits — สรุปหน่วยกิตรายรอบ */
export function myCreditsApiUrl(): string {
  return "/api/v1/me/credits";
}

/** GET /api/v1/me/transcript — transcript (?format=json เป็นค่า default ของ BFF) */
export function myTranscriptApiUrl(): string {
  return "/api/v1/me/transcript";
}

/** GET /api/v1/me/transcript?format=csv — ไฟล์ CSV (BOM + กันสูตร) — ดาวน์โหลดผ่าน <a download> */
export function transcriptCsvApiUrl(): string {
  return "/api/v1/me/transcript?format=csv";
}

// ——— transport — ผ่านชั้นกลาง src/lib/api/transport.ts (PB-19) ———

const CONTRACT_MESSAGE = "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ข้อมูลขาออกของ BFF ผิดรูปตามสัญญา — opaque เหมือน internal error (SDS §6.1) */
function contractViolation(): ApiError {
  return new ApiError("ERR-SYS-001", 500, CONTRACT_MESSAGE);
}

/**
 * GET /api/v1/me/credits — สรุปหน่วยกิตรายรอบของตัวเอง (ต้อง login)
 * · ผิดสัญญา (คีย์เกิน/ขาด/ค่าผิดชนิด — strict) → ERR-SYS-001 fail-closed
 */
export async function getMyCreditSummary(
  options?: TransportCallOptions,
): Promise<CreditSummaryViewParsed> {
  const { body } = await fetchJson(myCreditsApiUrl(), { method: "GET" }, options);
  if (!isRecord(body) || !isRecord(body["data"])) {
    throw contractViolation();
  }
  const parsed = CreditSummaryView.safeParse(body["data"]);
  if (!parsed.success) {
    throw contractViolation();
  }
  return parsed.data;
}

/**
 * GET /api/v1/me/transcript — transcript ของตัวเอง (ต้อง login) เฉพาะรูป JSON —
 * · ผิดสัญญา → ERR-SYS-001 fail-closed (รูป CSV ดาวน์โหลดด้วย <a download> ไม่ fetch
 *   อ่านเป็น text — แบบเดียวกับ PDF ของใบประกาศฯ)
 */
export async function getMyTranscript(
  options?: TransportCallOptions,
): Promise<TranscriptViewParsed> {
  const { body } = await fetchJson(myTranscriptApiUrl(), { method: "GET" }, options);
  if (!isRecord(body) || !isRecord(body["data"])) {
    throw contractViolation();
  }
  const parsed = TranscriptView.safeParse(body["data"]);
  if (!parsed.success) {
    throw contractViolation();
  }
  return parsed.data;
}

// ——— เอกสาร CSV ของ transcript (pure — buildCsv จัด BOM/quote/กันสูตรให้ทั้งหมด) ———

/** หัวตาราง CSV — คอลัมน์ไทยตาม API-SPECIFICATION §3 แถว /me/transcript */
export const TRANSCRIPT_CSV_HEADERS = [
  "ลำดับ",
  "หลักสูตร",
  "สถานะการลงทะเบียน",
  "วันที่เรียนจบ",
  "ผ่าน",
  "คะแนนสูงสุด (%)",
  "วันที่ผ่าน",
  "หน่วยกิต",
  "ใบประกาศณียบัตร",
] as const;

/**
 * ประกอบไฟล์ CSV ทั้งเอกสารจาก transcript ที่ผ่าน schema แล้ว — BOM นำหน้า + CRLF
 * (RFC 4180) + กันสูตร CSV ทุกเซลล์ที่ข้อมูลควบคุมได้ · เรียงแถวตาม entries ที่ RPC
 * จัดลำดับมาแล้ว · คอลัมน์วันที่/คะแนนเป็น "" เมื่อไม่มีค่า
 */
export function transcriptCsvDocument(transcript: TranscriptViewParsed): string {
  const rows = transcript.entries.map((entry, index) => [
    String(index + 1),
    entry.course_title,
    enrollmentStatusThai(entry.enrollment_status),
    entry.completed_at === null ? "" : formatActivityDateThai(entry.completed_at),
    passedLabel(entry.passed),
    entry.best_score_pct === null ? "" : String(entry.best_score_pct),
    entry.passed_at === null ? "" : formatActivityDateThai(entry.passed_at),
    formatCreditsText(entry.credits),
    formatCertificateListText(entry.certificates),
  ]);
  return buildCsv(TRANSCRIPT_CSV_HEADERS, rows);
}

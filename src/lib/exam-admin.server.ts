/**
 * exam-admin.server — loaders ฝั่ง Server Component (RSC) หลังบ้านสอบ/ประกาศนียบัตร
 * (Wave D · D-7)
 *
 * - ดึงข้อมูลฝั่ง server เสมอ (แบบเดียวกับ fixtures/admin.ts + learning.server.ts):
 *   fetch absolute-origin จาก config (PUBLIC_BASE_URL) + forward cookie ของ request เดิม
 *   (session อยู่ที่ httpOnly cookie — SDS §5.1) + cache "no-store" + header
 *   x-ltc-bff-internal (PB-1: middleware ไม่หมุน token บนขาใน)
 * - ผลลัพธ์ผิดรูปตามสัญญา (contract drift) → { ok: false, kind: "server" } — fail-closed
 *   ไม่เดาข้อมูลเอง ไม่แสดงแถวที่ผิดรูป
 * - 401/403 → { ok: false, kind: "forbidden" } — หน้าแสดงแผงไม่มีสิทธิ์ (ไม่ crash)
 * - อ่านเท่านั้น (GET) — การเขียนทั้งหมดทำจาก client component ผ่าน exam-admin.client.ts
 */
import "server-only";

import { headers } from "next/headers";

import { getConfig } from "@/lib/config";

import {
  isExamAdminAssessmentStatus,
  type ExamAdminAssessment,
  type ExamAdminAssessmentRuleSummary,
  type ExamAdminAssessmentStatus,
  type ExamAdminEligibleAttempt,
  type ExamAdminQuestionBank,
} from "./exam-admin.view";

/** ผลลัพธ์ของ loader — สองสถานะล้มเหลว: ไม่มีสิทธิ์ / ระบบขัดข้อง (fail-closed) */
export type ExamAdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "server" | "forbidden" };

/** หน้ารายการของ list endpoint — { data, page } ตาม API-SPECIFICATION §1.2 */
export interface ExamAdminPage<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/** query ของ GET /admin/assessments — ทุกช่องเลือกได้ (undefined = ไม่ส่งพารามิเตอร์) */
export interface AdminAssessmentsQuery {
  readonly status?: ExamAdminAssessmentStatus | undefined;
  readonly courseId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** query ของ GET /admin/question-banks + /admin/certificates/eligible */
export interface AdminListQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/* ─── plumbing — absolute origin + cookie forward + no-store (mirror fixtures/admin.ts) ─── */

type BffOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; kind: "server" | "forbidden" };

/** ตรวจว่าค่าเป็น object (ไม่ใช่ array/null) — ใช้กับ body ของ BFF ทุกชั้น */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET ไปยัง BFF ของตัวเองแบบ absolute origin (จำเป็นเมื่อ fetch จาก server component)
 * - origin จาก config เท่านั้น (PUBLIC_BASE_URL — gate r2 SSRF: ห้ามสร้างปลายทางจาก header
 *   ที่ผู้ใช้ควบคุมได้ เช่น x-forwarded-host)
 * - ส่งต่อ cookie ของ request เดิม — BFF อ่าน session จาก httpOnly cookie เสมอ
 */
async function bffGet(
  path: string,
  query: Readonly<Record<string, string>> = {},
): Promise<BffOutcome> {
  const headerBag = await headers();
  const url = new URL(path, getConfig().publicBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { cookie: headerBag.get("cookie") ?? "", "x-ltc-bff-internal": "1" },
    });
  } catch {
    return { ok: false, kind: "server" };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, kind: "forbidden" };
  }
  if (response.status === 204 || response.status === 304) {
    return { ok: true, status: response.status, body: null };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok) {
      return { ok: false, kind: "server" };
    }
    body = null;
  }
  return { ok: true, status: response.status, body };
}

/* ─── contract parsing — ตรวจรูป body ก่อนใช้งาน (ผิดรูป = fail-closed kind "server") ─── */

/** อ่าน string ที่จำเป็น — ไม่ใช่ string → null (ผิด contract) */
function requiredStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** อ่าน string ที่อนุญาต null — ผิด type → undefined (ผิด contract) */
function nullableStringOf(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** อ่าน boolean ที่จำเป็น — ผิด type → null */
function requiredBooleanOf(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

/** อ่านจำนวนเต็มในช่วง [min, max] — ผิด type/ช่วง → null */
function requiredIntOf(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** เวลา ISO ต้อง parse ได้จริง (กันสตริงปลอม) — ไม่ผ่าน → null */
function isoStringOf(value: string): string | null {
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** proctoringMode นอก enum จริง = drift → null */
function proctoringModeOf(value: unknown): ExamAdminAssessmentRuleSummary["proctoringMode"] | null {
  return value === "none" || value === "basic" ? value : null;
}

/** ตรวจแถวกติกา (AssessmentRuleSummary ของ BFF — passPct เปิดแสดงได้ตาม column grant 0019) */
function parseRuleSummary(raw: unknown): ExamAdminAssessmentRuleSummary | null {
  if (!isRecord(raw)) {
    return null;
  }
  const version = requiredIntOf(raw, "version", 1, 1000000);
  const passPct = requiredIntOf(raw, "passPct", 1, 100);
  const timeLimitMinutes = requiredIntOf(raw, "timeLimitMinutes", 1, 100000);
  const questionCount = requiredIntOf(raw, "questionCount", 0, 100000);
  const maxAttempts = requiredIntOf(raw, "maxAttempts", 1, 100000);
  const cooldownMinutes = requiredIntOf(raw, "cooldownMinutes", 0, 5256000);
  const shuffleQuestions = requiredBooleanOf(raw, "shuffleQuestions");
  const shuffleOptions = requiredBooleanOf(raw, "shuffleOptions");
  const proctoringMode = proctoringModeOf(raw["proctoringMode"]);
  const effectiveFromRaw = requiredStringOf(raw, "effectiveFrom");
  const effectiveFrom = effectiveFromRaw === null ? null : isoStringOf(effectiveFromRaw);
  if (
    version === null ||
    passPct === null ||
    timeLimitMinutes === null ||
    questionCount === null ||
    maxAttempts === null ||
    cooldownMinutes === null ||
    shuffleQuestions === null ||
    shuffleOptions === null ||
    proctoringMode === null ||
    effectiveFrom === null
  ) {
    return null;
  }
  return {
    version,
    passPct,
    timeLimitMinutes,
    questionCount,
    maxAttempts,
    cooldownMinutes,
    shuffleQuestions,
    shuffleOptions,
    proctoringMode,
    effectiveFrom,
  };
}

/** ตรวจแถวชุดข้อสอบ (AdminAssessmentResource ของ BFF) — ผิดรูป → null */
function parseAssessment(raw: unknown): ExamAdminAssessment | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredStringOf(raw, "id");
  const code = requiredStringOf(raw, "code");
  const title = requiredStringOf(raw, "title");
  const description = nullableStringOf(raw, "description");
  const courseId = requiredStringOf(raw, "courseId");
  const isFinal = requiredBooleanOf(raw, "isFinal");
  const createdBy = nullableStringOf(raw, "createdBy");
  const createdAtRaw = requiredStringOf(raw, "createdAt");
  const createdAt = createdAtRaw === null ? null : isoStringOf(createdAtRaw);
  const statusValue = raw["status"];
  const status = isExamAdminAssessmentStatus(statusValue) ? statusValue : null;
  const rulesRaw = raw["rules"];
  const rules =
    rulesRaw === null ? null : rulesRaw === undefined ? undefined : parseRuleSummary(rulesRaw);
  if (
    id === null ||
    code === null ||
    title === null ||
    description === undefined ||
    courseId === null ||
    isFinal === null ||
    status === null ||
    createdAt === null ||
    createdBy === undefined ||
    rules === undefined
  ) {
    return null;
  }
  return { id, code, title, description, courseId, isFinal, status, createdBy, rules, createdAt };
}

/** ตรวจแถวคลังข้อสอบ (QuestionBankResource ของ BFF) — ผิดรูป → null */
function parseBank(raw: unknown): ExamAdminQuestionBank | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredStringOf(raw, "id");
  const code = requiredStringOf(raw, "code");
  const name = requiredStringOf(raw, "name");
  const description = nullableStringOf(raw, "description");
  const courseId = nullableStringOf(raw, "courseId");
  const categoryId = nullableStringOf(raw, "categoryId");
  const isActive = requiredBooleanOf(raw, "isActive");
  const questionCount = requiredIntOf(raw, "questionCount", 0, 1000000);
  const createdAtRaw = requiredStringOf(raw, "createdAt");
  const createdAt = createdAtRaw === null ? null : isoStringOf(createdAtRaw);
  if (
    id === null ||
    code === null ||
    name === null ||
    description === undefined ||
    courseId === undefined ||
    categoryId === undefined ||
    isActive === null ||
    questionCount === null ||
    createdAt === null
  ) {
    return null;
  }
  return {
    id,
    code,
    name,
    description,
    courseId,
    categoryId,
    isActive,
    questionCount,
    createdAt,
  };
}

/** ตรวจแถวคิวผู้มีสิทธิ์รับใบ (EligibleAttemptResource ของ BFF — holderName ค่าว่างได้ตาม r7-M1) */
function parseEligibleAttempt(raw: unknown): ExamAdminEligibleAttempt | null {
  if (!isRecord(raw)) {
    return null;
  }
  const attemptId = requiredStringOf(raw, "attemptId");
  const enrollmentId = requiredStringOf(raw, "enrollmentId");
  const userId = requiredStringOf(raw, "userId");
  const courseId = requiredStringOf(raw, "courseId");
  const holderName = typeof raw["holderName"] === "string" ? raw["holderName"] : null;
  // scorePct เป็น null ได้จริง (attempt ไม่มีคะแนน) — แยก "null จริง" จาก "type ผิด" ให้ชัด
  const scorePctRaw = raw["scorePct"];
  const scorePct =
    scorePctRaw === null ? null : requiredIntOf(raw, "scorePct", 0, 100);
  const submittedAtRaw = requiredStringOf(raw, "submittedAt");
  const submittedAt = submittedAtRaw === null ? null : isoStringOf(submittedAtRaw);
  if (
    attemptId === null ||
    enrollmentId === null ||
    userId === null ||
    courseId === null ||
    holderName === null ||
    (scorePctRaw !== null && scorePct === null) ||
    submittedAt === null
  ) {
    return null;
  }
  return {
    attemptId,
    enrollmentId,
    userId,
    courseId,
    holderName,
    scorePct,
    submittedAt,
  };
}

/* ─── envelope §1.1/§1.2 parsing — ตรวจ { data, page } ก่อนใช้ ─── */

/** แตก { data: [...] } จาก envelope — ไม่มี data / ไม่ใช่ array → null */
function parseDataArray(body: unknown): readonly unknown[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const data = body["data"];
  return Array.isArray(data) ? data : null;
}

/** ตรวจ { nextCursor: string | null, hasMore: boolean } — ผิดรูป → null */
function parsePageEnvelope(body: unknown): ExamAdminPage<never>["page"] | null {
  if (!isRecord(body)) {
    return null;
  }
  const page = body["page"];
  if (!isRecord(page)) {
    return null;
  }
  const nextCursor = page["nextCursor"];
  const hasMore = page["hasMore"];
  if (typeof hasMore !== "boolean") {
    return null;
  }
  if (nextCursor !== null && typeof nextCursor !== "string") {
    return null;
  }
  return { nextCursor, hasMore };
}

/** แปลงผล bffGet → { data: T[], page } ด้วย parser ต่อแถว — แถวใดผิดรูป = ทั้งหน้า fail-closed */
async function loadPageOf<T>(
  outcomePromise: Promise<BffOutcome>,
  parseRow: (raw: unknown) => T | null,
): Promise<ExamAdminResult<ExamAdminPage<T>>> {
  const outcome = await outcomePromise;
  if (!outcome.ok) {
    return outcome;
  }
  if (outcome.status !== 200) {
    return { ok: false, kind: "server" };
  }
  const rows = parseDataArray(outcome.body);
  const page = parsePageEnvelope(outcome.body);
  if (rows === null || page === null) {
    return { ok: false, kind: "server" };
  }
  const data: T[] = [];
  for (const row of rows) {
    const parsed = parseRow(row);
    if (parsed === null) {
      return { ok: false, kind: "server" };
    }
    data.push(parsed);
  }
  return { ok: true, data: { data, page } };
}

/* ─── loaders ที่หน้า RSC เรียกใช้ ─── */

/**
 * GET /api/v1/admin/assessments — ชุดข้อสอบ/กติกาทุกสถานะ
 * (สิทธิ์ assessment:view — ขอบเขตกรองที่ RLS ให้เอง; 401/403 → kind "forbidden")
 */
export async function getAdminAssessments(
  query: AdminAssessmentsQuery = {},
): Promise<ExamAdminResult<ExamAdminPage<ExamAdminAssessment>>> {
  const parameters: Record<string, string> = {};
  if (query.status !== undefined) {
    parameters["status"] = query.status;
  }
  if (query.courseId !== undefined && query.courseId.length > 0) {
    parameters["courseId"] = query.courseId;
  }
  if (query.cursor !== undefined && query.cursor.length > 0) {
    parameters["cursor"] = query.cursor;
  }
  parameters["limit"] = String(query.limit ?? 20);
  return loadPageOf(bffGet("/api/v1/admin/assessments", parameters), parseAssessment);
}

/**
 * GET /api/v1/admin/question-banks — คลังข้อสอบ + จำนวนข้อ (นับฝั่ง DB)
 * (สิทธิ์ question_bank:view; 401/403 → kind "forbidden")
 */
export async function getAdminQuestionBanks(
  query: AdminListQuery = {},
): Promise<ExamAdminResult<ExamAdminPage<ExamAdminQuestionBank>>> {
  const parameters: Record<string, string> = {};
  if (query.cursor !== undefined && query.cursor.length > 0) {
    parameters["cursor"] = query.cursor;
  }
  parameters["limit"] = String(query.limit ?? 20);
  return loadPageOf(bffGet("/api/v1/admin/question-banks", parameters), parseBank);
}

/**
 * GET /api/v1/admin/certificates/eligible — คิวผู้ผ่านเกณฑ์ที่ยังไม่มีใบ valid
 * (สิทธิ์ certificate:issue — staff:registrar/super_admin; BFF บันทึก audit PII_ACCESS ให้เอง)
 */
export async function getEligibleAttempts(
  query: AdminListQuery = {},
): Promise<ExamAdminResult<ExamAdminPage<ExamAdminEligibleAttempt>>> {
  const parameters: Record<string, string> = {};
  if (query.cursor !== undefined && query.cursor.length > 0) {
    parameters["cursor"] = query.cursor;
  }
  parameters["limit"] = String(query.limit ?? 20);
  return loadPageOf(bffGet("/api/v1/admin/certificates/eligible", parameters), parseEligibleAttempt);
}

/**
 * exam-api - ชั้นข้อมูลฝั่ง client (client-safe) ของ UI การสอบ
 *
 * - เรียก BFF เส้นการสอบ: start/answers/submit (ขาขึ้น) + ใช้ร่วมกับ exam.server
 *   (ขาอ่าน RSC) ผ่าน transport เดียวกัน - แนบ cookie ตอนเรียกจาก RSC และประกาศ
 *   x-ltc-bff-internal ตอนเรียกจากฝั่ง server (gate-cleanup r1 M1 - กัน rotation
 *   กลางอากาศ) แบบเดียวกับ src/lib/fixtures/learning.ts
 * - ตรวจข้อมูลขาเข้าแบบ strict fail-closed ด้วย validator ที่เขียนมือ (ไม่ import
 *   schemas/v1/exam เข้า client bundle - กันชื่อคอลัมน์ฝั่งเฉลย/คะแนนรายข้อหลุดเข้า
 *   หลุดเข้า bundle ของห้องสอบ ตามธง lead ข้อ 3)
 * - error = ExamApiError { code, status } อ้างทะเบียน ERR-* ของ src/lib/errors
 *   (ข้อความไทยแสดงที่ชั้น UI - โมดูลนี้ไม่แตะ DOM)
 */

// ─── URL builders (เส้นการสอบตาม API-SPECIFICATION 3.5) ───

export function assessmentDetailUrl(assessmentId: string): string {
  return `/api/v1/assessments/${encodeURIComponent(assessmentId)}`;
}

export function attemptStartUrl(assessmentId: string): string {
  return `/api/v1/assessments/${encodeURIComponent(assessmentId)}/attempts`;
}

export function attemptAnswersUrl(attemptId: string): string {
  return `/api/v1/attempts/${encodeURIComponent(attemptId)}/answers`;
}

export function attemptSubmitUrl(attemptId: string): string {
  return `/api/v1/attempts/${encodeURIComponent(attemptId)}/submit`;
}

export function attemptResultUrl(attemptId: string): string {
  return `/api/v1/attempts/${encodeURIComponent(attemptId)}/result`;
}

export function myAttemptsUrl(cursor: string | undefined): string {
  return cursor === undefined || cursor.length === 0
    ? "/api/v1/me/attempts?limit=100"
    : `/api/v1/me/attempts?limit=100&cursor=${encodeURIComponent(cursor)}`;
}

// ─── transport ───

/** ตัวเลือกการเรียก - ฝั่ง browser ไม่ต้องส่ง; ฝั่ง RSC ต้องส่ง origin + cookieHeader */
export interface ExamCallOptions {
  readonly origin?: string;
  readonly cookieHeader?: string;
}

/** error ฝั่ง client - code อ้างทะเบียน src/lib/errors (API-SPEC 1.3) */
export class ExamApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ExamApiError";
    this.code = code;
    this.status = status;
  }
}

const TRANSPORT_FALLBACK_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ข้อมูลขาออกของ BFF ผิดรูปตามสัญญา - ตอบเหมือน internal error แบบ opaque (SDS 6.1) */
function contractViolation(): ExamApiError {
  return new ExamApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
}

/**
 * เรียก BFF แบบ JSON - คืน body ดิบ · non-2xx / parse ไม่ได้ / network fail =
 * ExamApiError (code/ข้อความจาก error envelope 1.3 ถ้ามี)
 */
export async function examRequest(
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: unknown; readonly headers?: Record<string, string> },
  options?: ExamCallOptions,
): Promise<unknown> {
  const origin = resolveOrigin(options);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.method === "POST") {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
  // gate-cleanup r1 M1: ขาเรียกจาก server (RSC) ประกาศตัวเป็นขาใน - middleware จะไม่
  // หมุน token (Set-Cookie ของขาในไม่มีทางถึง browser) แบบเดียวกับ learning.ts
  if (typeof window === "undefined") {
    headers["x-ltc-bff-internal"] = "1";
  }
  if (init.headers !== undefined) {
    Object.assign(headers, init.headers);
  }
  const requestInit: RequestInit = { method: init.method, headers, credentials: "same-origin", cache: "no-store" };
  if (init.method === "POST" && init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), requestInit);
  } catch {
    throw new ExamApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const envelope = isRecord(body) && isRecord(body["error"]) ? body["error"] : null;
    const code =
      envelope !== null && typeof envelope["code"] === "string" && envelope["code"].length > 0
        ? envelope["code"]
        : `HTTP_${response.status}`;
    const message =
      envelope !== null &&
      typeof envelope["message"] === "string" &&
      envelope["message"].length > 0
        ? envelope["message"]
        : TRANSPORT_FALLBACK_MESSAGE;
    throw new ExamApiError(code, response.status, message);
  }
  return body;
}

function resolveOrigin(options?: ExamCallOptions): string {
  if (options?.origin !== undefined && options.origin.length > 0) {
    return options.origin;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  throw new Error("ต้องระบุ origin ใน ExamCallOptions เมื่อเรียก API จากฝั่ง server (RSC)");
}

// ─── view types ของห้องสอบ (mirror AttemptStartView ของ BFF - ไร้เฉลยทุกทาง) ───

export interface ExamPaperOption {
  readonly id: string;
  readonly text: string;
}

export interface ExamPaperQuestion {
  readonly questionId: string;
  readonly seq: number;
  /** คำตอบที่ server บันทึกไว้แล้ว (null = ยังไม่ตอบ) - ใช้ seed ให้ห้องสอบหลัง takeover */
  readonly selectedOptionIds: readonly string[] | null;
  readonly answeredAt: string | null;
  readonly content: {
    readonly version: number;
    readonly text: string;
    readonly options: readonly ExamPaperOption[];
  };
}

/** หน้าต่างสอบ 201 จาก POST /assessments/{id}/attempts (ไร้เฉลย + timer จาก server) */
export interface ExamPaperSession {
  readonly attemptId: string;
  readonly status: "in_progress";
  readonly deadlineAt: string;
  readonly serverTime: string;
  readonly questionCount: number;
  readonly questions: readonly ExamPaperQuestion[];
  readonly takeover?: true;
}

// ─── validator แบบ strict fail-closed (เขียนมือ - ไม่ดึง schema เฉลยเข้า client bundle) ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isIsoOffset(value: unknown): value is string {
  return typeof value === "string" && ISO_OFFSET_RE.test(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const seen = Object.keys(record);
  return (
    seen.length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
  );
}

const SESSION_KEYS = ["attemptId", "status", "deadlineAt", "serverTime", "questionCount", "questions"] as const;
const SESSION_KEYS_WITH_TAKEOVER = [...SESSION_KEYS, "takeover"];

/** ตรวจ 201 view ของ POST /attempts start - ผิดสัญญาแม้แต่คีย์เดียว = throw fail-closed */
export function parseExamPaperSession(raw: unknown): ExamPaperSession {
  if (
    !isRecord(raw) ||
    hasExactKeys(raw, raw["takeover"] === undefined ? SESSION_KEYS : SESSION_KEYS_WITH_TAKEOVER) === false
  ) {
    throw contractViolation();
  }
  if (raw["attemptId"] === undefined || !isUuid(raw["attemptId"])) {
    throw contractViolation();
  }
  if (raw["status"] !== "in_progress" || !isIsoOffset(raw["deadlineAt"]) || !isIsoOffset(raw["serverTime"])) {
    throw contractViolation();
  }
  const questionCount = raw["questionCount"];
  if (typeof questionCount !== "number" || !Number.isInteger(questionCount) || questionCount < 1) {
    throw contractViolation();
  }
  const rawQuestions = raw["questions"];
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length !== questionCount) {
    throw contractViolation();
  }
  const questions = rawQuestions.map(parseExamPaperQuestion);
  const session: ExamPaperSession = {
    attemptId: raw["attemptId"],
    status: "in_progress",
    deadlineAt: raw["deadlineAt"],
    serverTime: raw["serverTime"],
    questionCount,
    questions,
    ...(raw["takeover"] === true ? { takeover: true as const } : {}),
  };
  if (raw["takeover"] !== undefined && raw["takeover"] !== true) {
    throw contractViolation();
  }
  return session;
}

function parseExamPaperQuestion(raw: unknown): ExamPaperQuestion {
  if (
    !isRecord(raw) ||
    hasExactKeys(raw, ["questionId", "seq", "selectedOptionIds", "answeredAt", "content"]) === false
  ) {
    throw contractViolation();
  }
  if (!isUuid(raw["questionId"])) {
    throw contractViolation();
  }
  const seq = raw["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw contractViolation();
  }
  const selected = raw["selectedOptionIds"];
  if (
    selected !== null &&
    (Array.isArray(selected) === false || selected.every(isUuid) === false)
  ) {
    throw contractViolation();
  }
  const answeredAt = raw["answeredAt"];
  if (answeredAt !== null && isIsoOffset(answeredAt) === false) {
    throw contractViolation();
  }
  const content = raw["content"];
  if (!isRecord(content) || hasExactKeys(content, ["version", "text", "options"]) === false) {
    throw contractViolation();
  }
  const version = content["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw contractViolation();
  }
  if (typeof content["text"] !== "string" || content["text"].length === 0) {
    throw contractViolation();
  }
  const rawOptions = content["options"];
  if (!Array.isArray(rawOptions) || rawOptions.length < 1) {
    throw contractViolation();
  }
  const options = rawOptions.map((rawOption): ExamPaperOption => {
    if (!isRecord(rawOption) || hasExactKeys(rawOption, ["id", "text"]) === false) {
      throw contractViolation();
    }
    if (isUuid(rawOption["id"]) === false || typeof rawOption["text"] !== "string" || rawOption["text"].length === 0) {
      throw contractViolation();
    }
    return { id: rawOption["id"], text: rawOption["text"] };
  });
  return {
    questionId: raw["questionId"],
    seq,
    selectedOptionIds: selected === null ? null : [...selected],
    answeredAt,
    content: { version, text: content["text"], options },
  };
}

// ─── ฟังก์ชันเรียกจริง ───

/** ตรวจ data envelope 1.1 - ไม่มี data = contract ผิดรูป */
function unwrapData(body: unknown): unknown {
  if (!isRecord(body) || Object.hasOwn(body, "data") === false) {
    throw contractViolation();
  }
  return body["data"];
}

/**
 * POST /assessments/{id}/attempts - เริ่มสอบ (201 หน้าต่างสอบ + ชุดข้อไร้เฉลย +
 * serverTime/deadlineAt สำหรับนาฬิกา) - error หลักที่ UI ต้องจัดการ:
 * ERR-ASM-002 (มี attempt ค้าง in_progress - ธง D37-6), ASM-001 (ครบจำนวนครั้ง),
 * ASM-003 (ปิด/ไม่พบ/cooldown), LRN-001/LRN-002 (ต้องลงทะเบียน/เรียนให้ครบ)
 */
export async function startAttempt(
  assessmentId: string,
  options?: ExamCallOptions,
): Promise<ExamPaperSession> {
  const body = await examRequest(
    attemptStartUrl(assessmentId),
    { method: "POST" },
    options,
  );
  return parseExamPaperSession(unwrapData(body));
}

/**
 * POST /attempts/{id}/answers - autosave ทีละข้อ (200 { savedAt } เป็นเวลา server)
 * body ตาม API-SPEC 4 #7 ตัวอักษร: questionId + choiceIds (1-10) + clientSavedAt เท่านั้น
 * (clientSavedAt ใช้เทียบเท่านั้น - เกณฑ์หมดเวลาคือ expires_at ฝั่ง RPC เสมอ)
 */
export async function saveAttemptAnswer(
  attemptId: string,
  questionId: string,
  choiceIds: readonly string[],
  options?: ExamCallOptions,
): Promise<{ readonly savedAt: string }> {
  const body = await examRequest(
    attemptAnswersUrl(attemptId),
    {
      method: "POST",
      body: { questionId, choiceIds: [...choiceIds], clientSavedAt: new Date().toISOString() },
    },
    options,
  );
  const data = unwrapData(body);
  if (
    !isRecord(data) ||
    hasExactKeys(data, ["savedAt"]) === false ||
    isIsoOffset(data["savedAt"]) === false
  ) {
    throw contractViolation();
  }
  return { savedAt: data["savedAt"] };
}

/**
 * POST /attempts/{id}/submit - ส่งข้อสอบ (DCR-6 grading ทันทีฝั่ง server)
 * - ส่ง header Idempotency-Key (uuid) บังคับตาม 3.5 - ใช้คีย์เดียวต่อหน้าต่างสอบเพื่อ
 *   ให้ retry หลัง network fail ได้ผลเดิม (already_submitted) ไม่นับเป็นการสอบใหม่
 * - body = { unansweredQuestionIds } เป็น telemetry เท่านั้น (ไม่ได้ใช้ตรวจ - grading
 *   อ่านจาก attempt_answers ที่ autosave ไว้)
 * - ผลตอบ (คะแนน/ผ่าน-ไม่ผ่าน) ไม่ parse ที่ client - นำทางไปหน้าผลสอบซึ่ง RSC อ่าน
 *   GET /attempts/{id}/result แล้วแสดง "ตามที่ BFF ตอบเท่านั้น" (ธง lead ข้อ 4)
 */
export async function submitAttempt(
  attemptId: string,
  unansweredQuestionIds: readonly string[],
  idempotencyKey: string,
  options?: ExamCallOptions,
): Promise<void> {
  await examRequest(
    attemptSubmitUrl(attemptId),
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: { unansweredQuestionIds: [...unansweredQuestionIds] },
    },
    options,
  );
}

/**
 * admin-credit — data layer หลังบ้าน credit bank สำหรับ UI (Wave E Phase 3 · Credit Bank)
 *
 * - เรียก endpoint /api/v1/admin/credit-rules (GET/POST/PATCH lifecycle) และ
 *   /api/v1/admin/credits/adjustments (POST) + /api/v1/admin/credits/{userId} (GET ledger)
 *   — ตามสัญญา API-SPECIFICATION §3.7 v1.1.0
 * - transport ผ่านชั้นกลาง src/lib/api/transport.ts (PB-19 — absolute-origin + cookie
 *   forward ขา server + error envelope §1.3 → ApiError) — แบบเดียวกับ lib/fixtures/
 *   certificates.ts
 * - ข้อมูลขาออกของ BFF ตรวจ strict ด้วย zod ทุกครั้ง (fail-closed) — แถว/แพ็กเก็ตผิดรูป
 *   = ERR-SYS-001 opaque ไม่แสดงข้อมูลที่ไม่ผ่าน schema
 * - PATCH ยังไม่อยู่ใน TransportRequestInit (GET/POST เท่านั้น) — ชั้นนี้มี patchJson
 *   เฉพาะตนที่ mirror พฤติกรรม transport เป๊ะ (same-origin · no-store · envelope §1.3 →
 *   ApiError) จนกว่า transport จะรองรับ method อื่น
 * - ข้อความผู้ใช้ทั้งหมดเป็นภาษาไทย (ผ่าน pure helpers ที่ทดสอบได้)
 */
import { z } from "zod";

import { ApiError, fetchJson, type TransportCallOptions } from "@/lib/api/transport";

// ——— ป้ายภาษาไทย + โทนสี (pure — ทดสอบได้โดยไม่ต้อง stub อะไร) ———

/** สถานะ lifecycle ของกฎเครดิต (CHECK 0006) */
export const CREDIT_RULE_STATUSES = ["draft", "active", "retired"] as const;

export type CreditRuleStatusValue = (typeof CREDIT_RULE_STATUSES)[number];

/** ป้ายสถานะกฎ — draft/active/retired (ใช้ใน badge + select ของหน้า credit-rules) */
const CREDIT_RULE_STATUS_THAI: Record<CreditRuleStatusValue, string> = {
  draft: "ฉบับร่าง",
  active: "ใช้งาน",
  retired: "ปลดระวัง",
};

export function creditRuleStatusThai(status: CreditRuleStatusValue): string {
  return CREDIT_RULE_STATUS_THAI[status];
}

/** โทน badge ตาม DESIGN-SYSTEM §5.6 — Record ครบทุก enum ให้ tsc บังคับครบ */
const CREDIT_RULE_STATUS_TONE: Record<CreditRuleStatusValue, "success" | "warning" | "danger"> = {
  draft: "warning",
  active: "success",
  retired: "danger",
};

export function creditRuleStatusTone(
  status: CreditRuleStatusValue,
): "success" | "warning" | "danger" {
  return CREDIT_RULE_STATUS_TONE[status];
}

/** ประเภทรายการ ledger — enum ledger_entry_type (0001) ครบ 4 ค่า */
export const LEDGER_ENTRY_TYPES = ["accrual", "adjustment", "reversal", "expiry"] as const;

export type LedgerEntryTypeValue = (typeof LEDGER_ENTRY_TYPES)[number];

/** ป้ายประเภทรายการ ledger (คอลัมน์ "ประเภท" ของตารางบัญชีเครดิต) */
const LEDGER_ENTRY_TYPE_THAI: Record<LedgerEntryTypeValue, string> = {
  accrual: "ได้รับ credit",
  adjustment: "ปรับโดยเจ้าหน้าที่",
  reversal: "ย้อนสถานะ (เพิกถอนใบ)",
  expiry: "หมดอายุ",
};

export function ledgerEntryTypeThai(type: LedgerEntryTypeValue): string {
  return LEDGER_ENTRY_TYPE_THAI[type];
}

/** โทน badge ของรายการ ledger — บวกเขียว ลบแดง กลางเทา (Record ครบทุก enum) */
const LEDGER_ENTRY_TONE: Record<LedgerEntryTypeValue, "success" | "danger" | "neutral" | "warning"> = {
  accrual: "success",
  adjustment: "warning",
  reversal: "danger",
  expiry: "neutral",
};

export function ledgerEntryTone(type: LedgerEntryTypeValue): "success" | "danger" | "neutral" | "warning" {
  return LEDGER_ENTRY_TONE[type];
}

/**
 * จำนวน credit แบบมีเครื่องหมาย "+12.50" / "-3" — จำนวนลบโชว์เครื่องหมายชัดเจน
 * (คอลัมน์ "จำนวน" ของตาราง ledger และสรุปผล adjustment) · ทศนิยมแสดงเท่าที่จำเป็น
 */
export function formatSignedCredit(amount: number): string {
  const fixed = (Math.round(amount * 100) / 100).toFixed(2);
  const trimmed = fixed.endsWith(".00")
    ? fixed.slice(0, -3)
    : fixed.endsWith("0")
      ? fixed.slice(0, -1)
      : fixed;
  return amount > 0 ? `+${trimmed}` : trimmed;
}

/** วันเวลาแบบพุทธศักราช "12 ส.ค. 2569 14:30" — DS §9 I18N-003 (แบบย่อของรายการ) */
export function formatCreditDateTimeThai(iso: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    calendar: "buddhist",
  }).format(new Date(iso));
}

/** วันแบบพุทธศักราช "12 ส.ค. 2569" — ใช้กับ effective_from/to ของกฎ */
export function formatCreditDateThai(iso: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    calendar: "buddhist",
  }).format(new Date(iso));
}

// ——— ข้อความ error กลาง (pure) ———

const CONTRACT_MESSAGE = "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่";

function contractViolation(): ApiError {
  return new ApiError("ERR-SYS-001", 500, CONTRACT_MESSAGE);
}

// ——— zod schema ขาออก (mirror resource ของ BFF — fail-closed) ———

const IsoTimestamp = z.iso.datetime({ offset: true });

/** resource กฎเครดิต — mirror ตรงขาออกของ /admin/credit-rules */
export const CreditRuleResource = z
  .object({
    id: z.string().uuid(),
    code: z.string().min(1),
    name: z.string().min(1),
    courseId: z.string().uuid().nullable(),
    creditType: z.string().min(1),
    credits: z.number().positive(),
    validDays: z.number().int().min(1).nullable(),
    carryOver: z.boolean(),
    requiredCreditsPerCycle: z.number().positive().nullable(),
    priority: z.number().int().min(0),
    renewalCycle: z.string().min(1).nullable(),
    effectiveFrom: IsoTimestamp,
    effectiveTo: IsoTimestamp.nullable(),
    status: z.enum(CREDIT_RULE_STATUSES),
    createdAt: IsoTimestamp,
  })
  .strict();

export type CreditRuleParsed = z.output<typeof CreditRuleResource>;

/** resource รายการ ledger — mirror ตรงขาออกของ /admin/credits/{userId} */
export const CreditLedgerRowResource = z
  .object({
    id: z.string().uuid(),
    cycleNo: z.number().int().min(1),
    entryType: z.enum(LEDGER_ENTRY_TYPES),
    creditType: z.string().min(1),
    amount: z.number(),
    sourceType: z.string().min(1),
    reason: z.string().nullable(),
    createdBy: z.string().uuid().nullable(),
    createdAt: IsoTimestamp,
  })
  .strict();

export type CreditLedgerRowParsed = z.output<typeof CreditLedgerRowResource>;

/** resource ผลปรับ credit — mirror ตรงขาออกของ /admin/credits/adjustments */
export const CreditAdjustmentResource = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    renewalCycleId: z.string().uuid(),
    creditType: z.string().min(1),
    amount: z.number(),
    reason: z.string().min(10),
    createdAt: IsoTimestamp,
  })
  .strict();

export type CreditAdjustmentParsed = z.output<typeof CreditAdjustmentResource>;

// ——— URL builders (BFF-relative path เท่านั้น) ———

/** GET /api/v1/admin/credit-rules — query เลือกได้ status/course_id/limit/cursor */
export function listCreditRulesApiUrl(
  query: {
    readonly status?: CreditRuleStatusValue | undefined;
    readonly courseId?: string | undefined;
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  } = {},
): string {
  const search = new URLSearchParams();
  if (query.status !== undefined) {
    search.set("status", query.status);
  }
  if (query.courseId !== undefined && query.courseId.length > 0) {
    search.set("course_id", query.courseId);
  }
  if (query.cursor !== undefined && query.cursor.length > 0) {
    search.set("cursor", query.cursor);
  }
  search.set("limit", String(query.limit ?? 20));
  const qs = search.toString();
  return qs.length > 0 ? `/api/v1/admin/credit-rules?${qs}` : "/api/v1/admin/credit-rules";
}

/** GET /api/v1/admin/credits/{userId} — ledger keyset (after_* ใช้คู่ ตามสัญญา BFF) */
export function creditLedgerApiUrl(
  userId: string,
  query: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
    readonly afterCreatedAt?: string | undefined;
    readonly afterId?: string | undefined;
  } = {},
): string {
  const search = new URLSearchParams();
  // cursor ชนะ after_* เสมอ (คู่ after_* ใช้เมื่อไม่มี cursor — ตรง XOR check ของ BFF)
  const cursor = query.cursor !== undefined && query.cursor.length > 0 ? query.cursor : undefined;
  if (cursor !== undefined) {
    search.set("cursor", cursor);
  } else if (query.afterCreatedAt !== undefined && query.afterId !== undefined) {
    search.set("after_created_at", query.afterCreatedAt);
    search.set("after_id", query.afterId);
  }
  search.set("limit", String(query.limit ?? 20));
  return `/api/v1/admin/credits/${encodeURIComponent(userId)}?${search.toString()}`;
}

// ——— ตัวเรียกกลาง — envelope §1.1 { data } + page ———

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** แตก { data } จาก envelope §1.1 — ไม่ใช่ object ที่มี data → contract ผิดรูป (throw) */
function dataOf(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw contractViolation();
  }
  return body["data"];
}

/** validate ข้อมูลขาออกของ BFF ด้วย schema — ไม่ผ่าน = contract ผิดรูป → ERR-SYS-001 */
function parseContract<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw contractViolation();
  }
  return parsed.data;
}

/** หน้าของ list endpoint — { data, page: { nextCursor, hasMore } } ตาม §1.2 */
interface PageOf<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** แตก envelope แบบมี page — คีย์ page เพี้ยน = contract ผิดรูป (fail-closed) */
function pageOf<T extends z.ZodType>(schema: T, body: unknown): PageOf<z.output<T>> {
  const dataEnvelope = dataOf(body);
  if (!Array.isArray(dataEnvelope)) {
    throw contractViolation();
  }
  const rawPage = isRecord(body) ? body["page"] : undefined;
  if (!isRecord(rawPage)) {
    throw contractViolation();
  }
  const nextCursor = rawPage["nextCursor"];
  const hasMore = rawPage["hasMore"];
  if (typeof nextCursor !== "string" && nextCursor !== null) {
    throw contractViolation();
  }
  if (typeof hasMore !== "boolean") {
    throw contractViolation();
  }
  return {
    data: dataEnvelope.map((row) => parseContract(schema, row)),
    hasMore,
    nextCursor,
  };
}

/**
 * PATCH JSON — mirror transport เป๊ะ (same-origin · no-store · envelope §1.3 → ApiError)
 * — transport กลางยังรับเฉพาะ GET/POST (TransportRequestInit) จึงมีตัวเรียกเฉพาะตนที่นี่
 * · เมื่อ transport รองรับ PATCH ให้ย้ายไปใช้กลางและลบฟังก์ชันนี้ (จุดเดียวที่ต้องตาม)
 */
async function patchJson(
  path: string,
  body: unknown,
  options?: TransportCallOptions,
): Promise<TransportResultLike> {
  const origin = resolveOriginLike(options);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json; charset=utf-8",
  };
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
  if (typeof window === "undefined") {
    headers["x-ltc-bff-internal"] = "1";
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      method: "PATCH",
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const envelope = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : null;
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
    throw new ApiError(code, response.status, message);
  }
  return { status: response.status, body: parsed };
}

/** รูปผลลัพธ์ของ patchJson — เหมือน TransportResult ของ transport (ไม่ import แทน) */
interface TransportResultLike {
  readonly status: number;
  readonly body: unknown;
}

const TRANSPORT_FALLBACK_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";

/** origin เหมือน transport — option ก่อน แล้ว window.location.origin (server ไม่ส่ง = throw) */
function resolveOriginLike(options?: TransportCallOptions): string {
  if (options?.origin !== undefined && options.origin.length > 0) {
    return options.origin;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  throw new Error("ต้องระบุ origin ใน TransportCallOptions เมื่อเรียก API จากฝั่ง server (RSC)");
}

// ——— data layer credit bank (admin) ———

/** query ของ listCreditRules */
export interface ListCreditRulesQuery {
  readonly status?: CreditRuleStatusValue | undefined;
  readonly courseId?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * GET /api/v1/admin/credit-rules — รายการกฎเครดิต (keyset) · แถวใดผิดสัญญา →
 * ERR-SYS-001 ทั้งหน้า (fail-closed แบบเดียวกับ route ขาออก BFF)
 */
export async function listCreditRules(
  query: ListCreditRulesQuery = {},
  options?: TransportCallOptions,
): Promise<PageOf<CreditRuleParsed>> {
  const { body } = await fetchJson(listCreditRulesApiUrl(query), { method: "GET" }, options);
  return pageOf(CreditRuleResource, body);
}

/** body ของ createCreditRule — mirror zod ขาเข้าของ BFF (strict เท่ากัน) */
export interface CreateCreditRuleInput {
  readonly code: string;
  readonly name: string;
  readonly courseId?: string | null | undefined;
  readonly creditType?: string | undefined;
  readonly credits: number;
  readonly validDays?: number | null | undefined;
  readonly carryOver?: boolean | undefined;
  readonly requiredCreditsPerCycle?: number | null | undefined;
  readonly priority?: number | undefined;
  readonly renewalCycle?: string | null | undefined;
  readonly effectiveFrom?: string | undefined;
  readonly effectiveTo?: string | null | undefined;
}

/**
 * POST /api/v1/admin/credit-rules — สร้างกฎใหม่ (BFF บังคับ status='draft' เอง)
 * · คืนแถวที่สร้าง · ผิดสัญญาขากลับ → ERR-SYS-001 (fail-closed)
 */
export async function createCreditRule(
  input: CreateCreditRuleInput,
  options?: TransportCallOptions,
): Promise<CreditRuleParsed> {
  const { body } = await fetchJson(
    "/api/v1/admin/credit-rules",
    {
      method: "POST",
      body: {
        code: input.code,
        name: input.name,
        ...(input.courseId !== undefined ? { courseId: input.courseId } : {}),
        ...(input.creditType !== undefined ? { creditType: input.creditType } : {}),
        credits: input.credits,
        ...(input.validDays !== undefined ? { validDays: input.validDays } : {}),
        ...(input.carryOver !== undefined ? { carryOver: input.carryOver } : {}),
        ...(input.requiredCreditsPerCycle !== undefined
          ? { requiredCreditsPerCycle: input.requiredCreditsPerCycle }
          : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.renewalCycle !== undefined ? { renewalCycle: input.renewalCycle } : {}),
        ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
        ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
      },
    },
    options,
  );
  return parseContract(CreditRuleResource, dataOf(body));
}

/** PATCH /api/v1/admin/credit-rules/{id} — เปลี่ยนสถานะ lifecycle เท่านั้น (คืนแถวใหม่) */
export async function updateCreditRuleStatus(
  ruleId: string,
  status: "active" | "retired",
  options?: TransportCallOptions,
): Promise<CreditRuleParsed> {
  const { body } = await patchJson(
    `/api/v1/admin/credit-rules/${encodeURIComponent(ruleId)}`,
    { status },
    options,
  );
  return parseContract(CreditRuleResource, dataOf(body));
}

/** input ของ adjustCredit — mirror zod ขาเข้าของ BFF (strict เท่ากัน) */
export interface AdjustCreditInput {
  readonly userId: string;
  readonly cycleId: string;
  readonly creditType: string;
  readonly amount: number;
  readonly reason: string;
}

/**
 * POST /api/v1/admin/credits/adjustments — ปรับ credit มือ (+/−) · คืนแถว ledger ที่
 * สร้าง · error ธุรกิจ (RBAC-001/CRD-002/NF-001/VAL-001) เป็น ApiError พร้อมข้อความไทย
 * จาก BFF แล้ว
 */
export async function adjustCredit(
  input: AdjustCreditInput,
  options?: TransportCallOptions,
): Promise<CreditAdjustmentParsed> {
  const { body } = await fetchJson(
    "/api/v1/admin/credits/adjustments",
    { method: "POST", body: input },
    options,
  );
  return parseContract(CreditAdjustmentResource, dataOf(body));
}

/** query ของ listCreditLedger */
export interface ListCreditLedgerQuery {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly afterCreatedAt?: string | undefined;
  readonly afterId?: string | undefined;
}

/** GET /api/v1/admin/credits/{userId} — บัญชีเครดิต (ledger) ของผู้ใช้รายคน (keyset) */
export async function listCreditLedger(
  userId: string,
  query: ListCreditLedgerQuery = {},
  options?: TransportCallOptions,
): Promise<PageOf<CreditLedgerRowParsed>> {
  const { body } = await fetchJson(
    creditLedgerApiUrl(userId, query),
    { method: "GET" },
    options,
  );
  return pageOf(CreditLedgerRowResource, body);
}

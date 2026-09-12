/**
 * /api/v1/admin/credit-rules (Wave E Phase 3 · Credit Bank · API-SPECIFICATION §3.7 v1.1.0)
 *
 * GET — รายการกฎเครดิต (endpoint §3.7 แถว 198) — keyset pagination แบบเดียวกับ admin list อื่น
 * - requirePermission("credit_rule:view") — staff:viewer / staff:registrar / super_admin
 *   (ตรงตาราง §3.7 · permission ถือครองตรงชุดเดียวกันใน RBAC §2.3 — ไม่ต้อง role-scope ซ้ำ)
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method — เรียกเองใน handler)
 * - query strict-zod: status (draft/active/retired) · course_id · limit (1..100 default 20) ·
 *   cursor (signed) — ผิดรูป → 400 ERR-VAL-001 (รูปแบบ fields เดียวกับ certificates GET)
 * - 200 { data: CreditRuleResource[], page: { nextCursor, hasMore } } — keyset
 *   (created_at, id) DESC ใน SQL · cursor encode/decode ผ่าน lib/api/pagination
 * - อ่านผ่าน user-JWT client — RLS cr_read (0010) เป็นชั้นที่สองเสมอ
 *
 * POST — สร้างกฎใหม่ สถานะเริ่ม 'draft' (§3.7 แถว 199)
 * - requirePermission("credit_rule:create") — staff:registrar / super_admin
 * - body strict zod — code CR-LTC-### · credits >0 ทศนิยม ≤2 (numeric(6,2)) ·
 *   credit_type identifier ตัวพิมพ์เล็ก (สัญญาเดียวกับ p_credit_type ของ admin_credit_adjust
 *   0031 §6) · priority int ≥0 · effective_from เป็น ISO date (DB cast เป็น timestamptz) ·
 *   ฟิลด์อื่น optional — ผิดรูป → 400 ERR-VAL-001 (รายชื่อ field)
 * - INSERT ผ่าน user-JWT client — RLS cr_insert บังคับ staff:registrar/super_admin ซ้ำ ·
 *   status ไม่รับจาก client เด็ดขาด (DB default 'draft')
 * - 23505 (code ซ้ำ) → 400 ERR-VAL-001 field code · 23503 (course_id ไม่มีจริง) →
 *   400 ERR-VAL-001 field course_id
 * - audit CREDIT_RULE_CREATE — 0006/0010 ไม่มี DB trigger audit บน credit_rules (ตรวจแล้ว)
 *   จึงเขียนฝั่ง BFF ตามแบบแผน ADMIN_EXPORT (0025 — reports/export): best-effort ผ่าน
 *   RPC append_audit_event — allowlist เปิดแล้วโดย migration 0032 (service_role บันทึก
 *   CREDIT_RULE_* ได้จริง · strict keys ตรง p_context ที่ส่ง) · ล้มจริง (เช่น strict-key
 *   reject 22023 / DB ล่ม) → WARN tripwire ไม่ล้ม mutation
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import {
  jsonCreated,
  jsonErrorResponse,
  jsonPageOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** รูปแบบรหัสกฎ — CR-LTC-### (ตามสัญญา endpoint ของ Wave E Phase 3) */
const CREDIT_RULE_CODE_RE = /^CR-LTC-\d{3}$/;

/**
 * ประเภท credit — identifier ตัวพิมพ์เล็ก 1-50 อักขระ สัญญาเดียวกับ p_credit_type ของ
 * RPC admin_credit_adjust (0031 §6) — credit_type ใน DB เป็น text config ไม่ใช่ enum
 */
const CREDIT_TYPE_RE = /^[a-z][a-z0-9_]{0,49}$/;

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** สถานะ lifecycle ของกฎ (CHECK 0006) */
const CreditRuleStatus = z.enum(["draft", "active", "retired"]);

/** select คอลัมน์แคบของ credit_rules (0006) — คอลัมน์เดียวกับที่ resource ตอบ */
const CREDIT_RULE_COLUMNS =
  "id,code,name,course_id,credit_type,credits,valid_days,carry_over," +
  "required_credits_per_cycle,priority,renewal_cycle,effective_from,effective_to,status,created_at";

/** แถวดิบจาก DB — ตรวจชนิดก่อน map (untyped client ตามแบบแผน repo) */
interface CreditRuleDbRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly course_id: string | null;
  readonly credit_type: string;
  readonly credits: number;
  readonly valid_days: number | null;
  readonly carry_over: boolean;
  readonly required_credits_per_cycle: number | null;
  readonly priority: number;
  readonly renewal_cycle: string | null;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly status: "draft" | "active" | "retired";
  readonly created_at: string;
}

/** resource ขาออก (camelCase · strict) — drift ของแถวใดแถวหนึ่ง = 503 ทั้ง response */
const CreditRuleResource = z
  .object({
    id: z.string().uuid(),
    code: z.string().min(1).max(32),
    name: z.string().min(1),
    courseId: z.string().uuid().nullable(),
    creditType: z.string().min(1).max(50),
    credits: z.number().positive().max(9999.99),
    validDays: z.number().int().min(1).nullable(),
    carryOver: z.boolean(),
    requiredCreditsPerCycle: z.number().positive().max(9999.99).nullable(),
    priority: z.number().int().min(0),
    renewalCycle: z.string().min(1).max(50).nullable(),
    effectiveFrom: IsoTimestamp,
    effectiveTo: IsoTimestamp.nullable(),
    status: CreditRuleStatus,
    createdAt: IsoTimestamp,
  })
  .strict();

type CreditRuleResourceParsed = z.infer<typeof CreditRuleResource>;

/** จำนวนเงิน/คะแนนทศนิยม ≤2 ตำแหน่ง (numeric(6,2)) — tolerance กัน float error ของ JS */
function isAtMostTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/** query ของ GET — strict (key แปลกปลอม → 400 ERR-VAL-001) */
const ListCreditRulesQuerySchema = z
  .object({
    status: CreditRuleStatus.optional(),
    course_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** query → parsed (ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ parsePageQuery §4 #12) */
function parseListQuery(searchParams: URLSearchParams): {
  status?: "draft" | "active" | "retired" | undefined;
  courseId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
} {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  // ค่าว่าง = "ไม่ระบุ" (ฟอร์ม GET ของหน้า admin ส่งช่องว่างเมื่อไม่เลือก) — ตัดก่อน parse
  for (const key of Object.keys(raw)) {
    if (raw[key] === "") {
      delete raw[key];
    }
  }
  const parsed = ListCreditRulesQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : "query";
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return {
    status: parsed.data.status,
    courseId: parsed.data.course_id,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  };
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** แถว DB → resource (map ตรง ไม่ fabricate ค่า) */
function toCreditRuleResource(row: CreditRuleDbRow): CreditRuleResourceParsed {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    courseId: row.course_id,
    creditType: row.credit_type,
    credits: row.credits,
    validDays: row.valid_days,
    carryOver: row.carry_over,
    requiredCreditsPerCycle: row.required_credits_per_cycle,
    priority: row.priority,
    renewalCycle: row.renewal_cycle,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** or-filter เลื่อน cursor แบบ row-wise (created_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  return `created_at.lt.${payload.sortKey},and(created_at.eq.${payload.sortKey},id.lt.${payload.id})`;
}

/** GET — รายการกฎเครดิต (200 + keyset page) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — credit_rule:view (staff:viewer / staff:registrar / super_admin)
    const { userId } = await requirePermission("credit_rule:view");
    // 2) rate STAFF_WRITE — กลุ่ม canonical ของ /admin/* (§5) หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict — ผิดรูป → 400 ERR-VAL-001
    const query = parseListQuery(new URL(request.url).searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    // 4) อ่านผ่าน user-JWT client — RLS cr_read (0010) เป็นชั้นที่สอง
    const supabase = await createSupabaseSsrClient();
    let builder = supabase
      .from("credit_rules")
      .select(CREDIT_RULE_COLUMNS)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit + 1);
    if (query.status !== undefined) {
      builder = builder.eq("status", query.status);
    }
    if (query.courseId !== undefined) {
      builder = builder.eq("course_id", query.courseId);
    }
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "credit_rules_query_failed" } });
    }
    const rows = (data ?? []) as unknown as readonly CreditRuleDbRow[];
    // 5) หน้า + ขาออก strict ทุกแถว (r6-L1) — drift แถวเดียว = 503 ไม่ strip เงียบ
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => row.created_at,
      idOf: (row) => row.id,
    });
    return jsonPageOk(
      {
        data: page.data.map((row) =>
          parseOutgoingView(CreditRuleResource, toCreditRuleResource(row), "credit_rule_row_drift"),
        ),
        page: page.page,
      },
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/** body ของ POST — strict ตามสไตล์ schema กลางของ repo (status ไม่รับจาก client) */
const CreateCreditRuleBody = z
  .object({
    code: z.string().trim().regex(CREDIT_RULE_CODE_RE),
    name: z.string().trim().min(1).max(200),
    courseId: z.uuid().nullish(),
    creditType: z.string().trim().regex(CREDIT_TYPE_RE).default("general"),
    credits: z
      .number()
      .positive()
      .max(9999.99)
      .refine(isAtMostTwoDecimals),
    validDays: z.number().int().min(1).max(36500).nullish(),
    carryOver: z.boolean().default(false),
    requiredCreditsPerCycle: z
      .number()
      .positive()
      .max(9999.99)
      .refine(isAtMostTwoDecimals)
      .nullish(),
    priority: z.number().int().min(0).max(2147483647).default(100),
    renewalCycle: z.string().trim().regex(CREDIT_TYPE_RE).nullish(),
    effectiveFrom: z.iso.date().optional(),
    effectiveTo: z.iso.date().nullish(),
  })
  .strict();

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseCreateBody(request: Request): Promise<z.infer<typeof CreateCreditRuleBody>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = CreateCreditRuleBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  // cross-field: effective_to ต้องหลัง effective_from เมื่อระบุทั้งคู่ (DB ไม่มี CHECK คู่นี้ — กั้นที่ BFF)
  if (
    parsed.data.effectiveFrom !== undefined &&
    parsed.data.effectiveTo != null &&
    parsed.data.effectiveTo <= parsed.data.effectiveFrom
  ) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["effective_to"] } });
  }
  return parsed.data;
}

/**
 * audit CREDIT_RULE_CREATE/UPDATE — best-effort แบบเดียวกับ ADMIN_EXPORT ของ reports/export
 * (0025): 0006/0010 ไม่มี DB trigger audit บน credit_rules — allowlist เปิดแล้วโดย
 * migration 0032 จึงเขียนแถว audit จริงหลัง mutation สำเร็จ · ล้มจริง (strict-key
 * reject 22023 / DB ล่ม) = WARN tripwire ไม่ล้ม mutation · context.user_id ถูก RPC
 * ยกเป็น actor แล้ว strip ออกก่อนเก็บ
 */
async function auditCreditRuleEvent(input: {
  readonly action: "CREDIT_RULE_CREATE" | "CREDIT_RULE_UPDATE";
  readonly ruleId: string;
  readonly context: Record<string, string>;
  readonly actorId: string;
  readonly requestId: string | null;
}): Promise<void> {
  const service = createSupabaseServiceRoleClient();
  const { error } = await service.rpc("append_audit_event", {
    p_action: input.action,
    p_entity_type: "credit_rule",
    p_entity_id: input.ruleId,
    p_before: null,
    p_after: null,
    p_context: { ...input.context, user_id: input.actorId },
    p_actor_roles: null,
    p_ip_hash: null,
    p_user_agent: null,
    p_request_id: input.requestId,
  });
  if (error !== null) {
    const logger = createLogger(getConfig().logLevel);
    logger.warn("credit_rule_audit_rpc_denied", {
      route: `credit-rules:${input.action}`,
      user_id: input.actorId,
    });
  }
}

/** POST — สร้างกฎใหม่ สถานะ 'draft' (201) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — credit_rule:create (staff:registrar / super_admin)
    const { userId } = await requirePermission("credit_rule:create");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) body strict — ผิดรูป → 400 ERR-VAL-001
    const body = await parseCreateBody(request);
    // 4) INSERT ผ่าน user-JWT client — RLS cr_insert (0010) บังคับ staff ซ้ำ ·
    //    status ไม่ส่ง = DB default 'draft'
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase
      .from("credit_rules")
      .insert({
        code: body.code,
        name: body.name,
        course_id: body.courseId ?? null,
        credit_type: body.creditType,
        credits: body.credits,
        valid_days: body.validDays ?? null,
        carry_over: body.carryOver,
        required_credits_per_cycle: body.requiredCreditsPerCycle ?? null,
        priority: body.priority,
        renewal_cycle: body.renewalCycle ?? null,
        ...(body.effectiveFrom === undefined ? {} : { effective_from: body.effectiveFrom }),
        effective_to: body.effectiveTo ?? null,
      })
      .select(CREDIT_RULE_COLUMNS)
      .single();
    if (error !== null) {
      // 23505 = code ซ้ำ (uq_credit_rules_code) · 23503 = course_id ไม่มีจริง (FK)
      if (error.code === "23505") {
        throw new AppError("ERR-VAL-001", {
          details: { field: "code", reason: "duplicate" },
        });
      }
      if (error.code === "23503") {
        throw new AppError("ERR-VAL-001", { details: { field: "courseId" } });
      }
      throw new AppError("ERR-SYS-002", { details: { reason: "credit_rule_insert_failed" } });
    }
    if (data === null || typeof data !== "object") {
      throw new AppError("ERR-SYS-002", { details: { reason: "credit_rule_created_row_drift" } });
    }
    const created = toCreditRuleResource(data as unknown as CreditRuleDbRow);
    // r6-L1: ขาออกตรวจ strict ก่อนตอบ — drift → 503 ไม่ strip เงียบ
    const resource = parseOutgoingView(CreditRuleResource, created, "credit_rule_created_drift");
    // 5) audit best-effort (0032 เปิด allowlist แล้ว — ล้มจริง = WARN tripwire ดูหัวไฟล์)
    await auditCreditRuleEvent({
      action: "CREDIT_RULE_CREATE",
      ruleId: resource.id,
      context: {
        rule_id: resource.id,
        code: resource.code,
        credit_type: resource.creditType,
        credits: String(resource.credits),
        effective_from: resource.effectiveFrom,
      },
      actorId: userId,
      requestId: options.requestId ?? null,
    });
    return jsonCreated(resource, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

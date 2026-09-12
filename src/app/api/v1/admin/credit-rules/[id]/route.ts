/**
 * PATCH /api/v1/admin/credit-rules/{id} — lifecycle เท่านั้น (Wave E Phase 3 · Credit Bank
 * · API-SPECIFICATION §3.7 แถว 200 v1.1.0)
 *
 * - requirePermission("credit_rule:update") — staff:registrar / super_admin
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method)
 * - body strict { status: "active" | "retired" } เท่านั้น — ห้ามแก้ฟิลด์อื่นผ่าน PATCH
 *   (semantic immutability — แก้กฎที่ใช้งาน = สร้างฉบับใหม่ DD §3.5/F17 · DB บังคับด้วย
 *   trigger guard_credit_rule_versioning 0010 B6 — BFF รับแค่ status อยู่แล้ว)
 * - transition ที่อนุญาต (ตรง trigger 0010): draft→active · active→retired — ตรวจซ้ำฝั่ง
 *   BFF ก่อน UPDATE เพื่อข้อความไทยเจาะจง (400 ERR-VAL-001) ก่อนถึง guard ของ DB
 * - 404 ERR-NF-001 เมื่อไม่พบกฎ · 200 { data: CreditRuleResource } หลัง UPDATE สำเร็จ
 * - audit CREDIT_RULE_UPDATE — 0010 ไม่มี DB trigger audit บน credit_rules (ตรวจแล้ว)
 *   จึงเขียนฝั่ง BFF best-effort ตามแบบแผน ADMIN_EXPORT (0025 — reports/export):
 *   allowlist เปิดแล้วโดย migration 0032 — เขียนแถว audit จริงหลัง mutation สำเร็จ ·
 *   ล้มจริง (strict-key reject 22023 / DB ล่ม) → WARN tripwire ไม่ล้ม mutation
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  jsonErrorResponse,
  jsonOk,
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

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** สถานะ lifecycle ของกฎ (CHECK 0006) */
const CreditRuleStatus = z.enum(["draft", "active", "retired"]);

/** รูปแบบ uuid ของ :id — ผิดรูป → 400 ก่อนแตะ DB (แบบเดียวกับ reissue) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** select คอลัมน์แคบของ credit_rules (0006) — คอลัมน์เดียวกับ resource ที่ตอบกลับ */
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

/** resource ขาออก (camelCase · strict) — drift = 503 ทั้ง response (r6-L1) */
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

/**
 * transition ที่อนุญาต (mirror trigger guard_rule_semantics 0010) — draft→active และ
 * active→retired · คู่อื่นทั้งหมด = invalid
 */
function isAllowedTransition(
  from: "draft" | "active" | "retired",
  to: "active" | "retired",
): boolean {
  return (from === "draft" && to === "active") || (from === "active" && to === "retired");
}

/** ข้อความไทยเจาะจงของ transition ที่ผิดกติกา (AppError ปรับข้อความตามบริบทได้) */
const INVALID_TRANSITION_MESSAGE =
  "เปลี่ยนสถานะกฎเครดิตไม่ได้: ทำได้เฉพาะเผยแพร่จากฉบับร่าง (ร่าง→ใช้งาน) หรือปลดระวัง (ใช้งาน→ปลดระวัง)";

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB (แบบเดียวกับ reissue) */
function parseRuleId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new AppError("ERR-VAL-001", { details: { field: "id" } });
  }
  return raw;
}

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseStatusBody(request: Request): Promise<{ status: "active" | "retired" }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = UpdateCreditRuleStatusBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** body ของ PATCH — strict { status } เท่านั้น (active|retired) */
const UpdateCreditRuleStatusBody = z
  .object({ status: z.enum(["active", "retired"]) })
  .strict();

/**
 * audit CREDIT_RULE_UPDATE — best-effort แบบเดียวกับ ADMIN_EXPORT (0025 — reports/export):
 * allowlist เปิดแล้วโดย migration 0032 — เขียนแถว audit จริงหลัง mutation สำเร็จ ·
 * ล้มจริง (strict-key reject 22023 / DB ล่ม) = WARN tripwire ไม่ล้ม mutation ·
 * context.user_id ถูก RPC ยกเป็น actor แล้ว strip ออกจาก context ที่เก็บจริง (0008/0019)
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

/** PATCH — เปลี่ยนสถานะ lifecycle เท่านั้น (200) */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — credit_rule:update (staff:registrar / super_admin)
    const { userId } = await requirePermission("credit_rule:update");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) :id ผิดรูป uuid → 400 ก่อนแตะ DB (แบบเดียวกับ reissue)
    const ruleId = parseRuleId((await context.params).id);
    // 4) body strict — { status } เท่านั้น ห้ามฟิลด์อื่น
    const body = await parseStatusBody(request);
    // 5) อ่านสถานะปัจจุบันเพื่อตรวจ transition ฝั่ง BFF (ข้อความไทยก่อนถึง trigger 0010)
    const supabase = await createSupabaseSsrClient();
    const current = await supabase
      .from("credit_rules")
      .select("id, status")
      .eq("id", ruleId)
      .maybeSingle();
    if (current.error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "credit_rule_query_failed" } });
    }
    const currentRow = current.data as { id: string; status: "draft" | "active" | "retired" } | null;
    if (currentRow === null) {
      throw new AppError("ERR-NF-001", { details: { field: "id" } });
    }
    // 6) transition check ฝั่ง BFF — draft→active / active→retired เท่านั้น (400 เมื่อผิด)
    if (!isAllowedTransition(currentRow.status, body.status)) {
      throw new AppError("ERR-VAL-001", {
        message: INVALID_TRANSITION_MESSAGE,
        details: { field: "status", reason: "invalid_transition" },
      });
    }
    // 7) UPDATE เฉพาะ status — semantic columns อื่นแก้ไม่ได้ทั้งที่ BFF และ DB (0010 B6)
    const updated = await supabase
      .from("credit_rules")
      .update({ status: body.status })
      .eq("id", ruleId)
      .select(CREDIT_RULE_COLUMNS)
      .single();
    if (updated.error !== null) {
      // P0001 = trigger guard_credit_rule_versioning ปฏิเสธ (race กับผู้ใช้อื่น) —
      // ข้อความ SQL ห้ามออก client (SDS §6.1) — ตอบข้อความไทยเดียวกับที่ BFF ตรวจเอง
      if (updated.error.code === "P0001") {
        throw new AppError("ERR-VAL-001", {
          message: INVALID_TRANSITION_MESSAGE,
          details: { field: "status", reason: "invalid_transition" },
        });
      }
      throw new AppError("ERR-SYS-002", { details: { reason: "credit_rule_update_failed" } });
    }
    const updatedRow = updated.data as unknown as CreditRuleDbRow | null;
    if (updatedRow === null) {
      // แถวหายระหว่าง read/update — ไม่เดา ตอบ 404
      throw new AppError("ERR-NF-001", { details: { field: "id" } });
    }
    const resource = parseOutgoingView(
      CreditRuleResource,
      toCreditRuleResource(updatedRow),
      "credit_rule_updated_drift",
    );
    // 8) audit best-effort (0032 เปิด allowlist แล้ว — ล้มจริง = WARN tripwire ดูหัวไฟล์)
    await auditCreditRuleEvent({
      action: "CREDIT_RULE_UPDATE",
      ruleId: resource.id,
      context: {
        rule_id: resource.id,
        code: resource.code,
        status_from: currentRow.status,
        status_to: resource.status,
      },
      actorId: userId,
      requestId: options.requestId ?? null,
    });
    return jsonOk(resource, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

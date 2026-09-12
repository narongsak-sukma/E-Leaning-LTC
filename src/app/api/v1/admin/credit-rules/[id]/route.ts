/**
 * PATCH /api/v1/admin/credit-rules/{id} — lifecycle เท่านั้น (Wave E Phase 3 · Credit Bank
 * · API-SPECIFICATION §3.7 แถว 200 v1.1.1)
 *
 * - requirePermission("credit_rule:update") — staff:registrar / super_admin
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method)
 * - body strict { status: "active" | "retired" } เท่านั้น — ห้ามแก้ฟิลด์อื่นผ่าน PATCH
 *   (semantic immutability — แก้กฎที่ใช้งาน = สร้างฉบับใหม่ DD §3.5/F17 · DB บังคับด้วย
 *   trigger guard_credit_rule_versioning 0010 B6)
 * - เขียนผ่าน RPC atomic admin_update_credit_rule_status (0032) ด้วย user-JWT client —
 *   guard (auth.uid + has_any_role + aal2) + transition ตรวจ (draft→active / active→retired
 *   เท่านั้น) + UPDATE + audit CREDIT_RULE_UPDATE อยู่ใน TX เดียว · คืนแถวเต็ม (jsonb) ·
 *   direct UPDATE บน credit_rules ถูก REVOKE แล้ว
 * - error จาก RPC ฝังป้าย "(ERR-XXX-NNN|tag)" ท้ายข้อความ — แกะผ่าน lib/api/rpc-errors
 *   แล้ว map เป็น AppError: ERR-NF-001 rule_not_found → 404 · ERR-VAL-001
 *   invalid_transition/status_value → 400 · ไม่มีป้าย / code นอกทะเบียน = ERR-SYS-002
 *   opaque (ห้าม leak ข้อความ SQL — SDS §6.1)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** สถานะ lifecycle ของกฎ (CHECK 0006) */
const CreditRuleStatus = z.enum(["draft", "active", "retired"]);

/** รูปแบบ uuid ของ :id — ผิดรูป → 400 ก่อนแตะ DB (แบบเดียวกับ reissue) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * error ของ RPC → AppError — มีป้าย "(ERR-XXX-NNN|tag)" ที่อยู่ในทะเบียน = map ตรง
 * (สถานะ + ข้อความไทยจากทะเบียน lib/errors) · ไม่มีป้าย / code นอกทะเบียน =
 * ERR-SYS-002 opaque (ไม่ leak ข้อความ SQL ออก client — SDS §6.1) — pattern เดียวกับ
 * /admin/credits/adjustments
 */
function mapRpcError(error: RpcErrorLike, fallbackReason: string): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: fallbackReason } });
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
    // 5) RPC atomic admin_update_credit_rule_status (0032) ด้วย user-JWT client —
    //    guard + transition (draft→active / active→retired) + UPDATE + audit ใน TX เดียว
    const supabase = await createSupabaseSsrClient();
    const rpc = await supabase.rpc("admin_update_credit_rule_status", {
      p_rule_id: ruleId,
      p_status: body.status,
      p_request_id: options.requestId ?? null,
    });
    if (rpc.error !== null) {
      throw mapRpcError(rpc.error as RpcErrorLike, "credit_rule_update_failed");
    }
    // 6) แถว jsonb ที่ RPC คืน — PostgREST อาจ wrap scalar เป็น array หลักเดียว (r8-N2)
    const rawRow: unknown = Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
    if (rawRow === null || typeof rawRow !== "object") {
      throw new AppError("ERR-SYS-002", { details: { reason: "credit_rule_updated_drift" } });
    }
    // 7) ขาออก strict ก่อนตอบ — drift → 503 ไม่ strip เงียบ (r6-L1)
    const resource = parseOutgoingView(
      CreditRuleResource,
      toCreditRuleResource(rawRow as unknown as CreditRuleDbRow),
      "credit_rule_updated_drift",
    );
    return jsonOk(resource, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

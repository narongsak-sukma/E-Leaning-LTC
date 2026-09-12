/**
 * POST /api/v1/admin/credits/adjustments — ปรับ credit มือ (+/−) (Wave E Phase 3 ·
 * Credit Bank · CRB-007 · API-SPECIFICATION §3.7 แถว 202 v1.1.0)
 *
 * - requirePermission("credit_adjustment:create") — staff:registrar / super_admin
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method)
 * - body strict zod: userId/cycleId uuid · creditType identifier (สัญญาเดียวกับ RPC) ·
 *   amount ±9999.99 ทศนิยมไม่เกิน 2 ตำแหน่ง และห้าม 0 · reason 10-500 ตัวอักษร —
 *   ตรวจฝั่ง BFF ก่อน (ข้อความไทยจากทะเบียน lib/errors) แล้วจึงเรียก RPC
 * - เรียก RPC `admin_credit_adjust(p_user_id, p_cycle_id, p_credit_type, p_amount,
 *   p_reason, p_request_id)` ด้วย **user-JWT client เท่านั้น — ห้าม service_role
 *   (D68 C-9)** — RPC เป็น SECURITY DEFINER ตรวจสิทธิ์ staff:registrar/super_admin เอง
 *   + เขียน audit CREDIT_ADJUST เองใน TX เดียวกับ INSERT ledger (0031 §6)
 * - error จาก RPC ฝัง code ท้ายข้อความ "(ERR-XXX-NNN|reason)" — แกะผ่าน
 *   lib/api/rpc-errors แล้ว map เป็น AppError (สถานะ + ข้อความไทยจากทะเบียน) ·
 *   ไม่มีป้าย / code นอกทะเบียน = ERR-SYS-002 opaque (ห้าม leak ข้อความ SQL — SDS §6.1)
 * - สำเร็จ → 201 { data: AdjustmentResource } — แถวที่ RPC คืน (jsonb เดี่ยว) ตรวจ
 *   strict ขาเข้าและขาออก (แถวเพี้ยน = 503 fail-closed — r6-L1)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import {
  jsonCreated,
  jsonErrorResponse,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/**
 * ประเภท credit — identifier ตัวพิมพ์เล็ก 1-50 อักขระ ตรง regex ใน RPC
 * admin_credit_adjust (0031 §6 — adjust_credit_type) เป๊ะ
 */
const CREDIT_TYPE_RE = /^[a-z][a-z0-9_]{0,49}$/;

/** จำนวนทศนิยมไม่เกิน 2 ตำแหน่ง (numeric(6,2)) — tolerance กัน float error ของ JS */
function isAtMostTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/** body ของ POST — strict ตามสไตล์ schema กลางของ repo */
const AdjustCreditBody = z
  .object({
    userId: z.uuid(),
    cycleId: z.uuid(),
    creditType: z.string().trim().regex(CREDIT_TYPE_RE),
    amount: z
      .number()
      .refine((value) => value !== 0)
      .refine((value) => Math.abs(value) <= 9999.99)
      .refine(isAtMostTwoDecimals),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

/** แถว jsonb ที่ RPC admin_credit_adjust คืน (0031 §6 — returns jsonb 7 คีย์) */
const AdjustmentRowSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    renewal_cycle_id: z.string().uuid(),
    credit_type: z.string().min(1).max(50),
    amount: z.number().refine((value) => value !== 0),
    reason: z.string().min(10),
    created_at: IsoTimestamp,
  })
  .strict();

/** resource ขาออก (camelCase · strict) — drift = 503 ทั้ง response (r6-L1) */
const AdjustmentResource = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    renewalCycleId: z.string().uuid(),
    creditType: z.string().min(1).max(50),
    amount: z.number().refine((value) => value !== 0),
    reason: z.string().min(10),
    createdAt: IsoTimestamp,
  })
  .strict();

type AdjustmentResourceParsed = z.infer<typeof AdjustmentResource>;

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseAdjustBody(request: Request): Promise<z.infer<typeof AdjustCreditBody>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = AdjustCreditBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** แถว jsonb ของ RPC (snake_case) → resource (camelCase) — map ตรง ไม่ fabricate ค่า */
function toAdjustmentResource(row: z.infer<typeof AdjustmentRowSchema>): AdjustmentResourceParsed {
  return {
    id: row.id,
    userId: row.user_id,
    renewalCycleId: row.renewal_cycle_id,
    creditType: row.credit_type,
    amount: row.amount,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/**
 * error ของ RPC → AppError — มีป้าย "(ERR-XXX-NNN|reason)" ที่อยู่ในทะเบียน = map ตรง
 * (สถานะ + ข้อความไทยจากทะเบียน lib/errors) · ไม่มีป้าย / code นอกทะเบียน =
 * ERR-SYS-002 opaque (ไม่ leak SQL ออก client — SDS §6.1)
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

/** POST — ปรับ credit มือ (201 + แถว ledger ที่สร้าง) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — credit_adjustment:create (staff:registrar / super_admin)
    const { userId } = await requirePermission("credit_adjustment:create");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) body strict — ผิดรูป → 400 ERR-VAL-001 (กั้นที่ BFF ก่อน RPC)
    const body = await parseAdjustBody(request);
    // 4) RPC ด้วย user-JWT client เท่านั้น (D68 C-9 — ห้าม service_role):
    //    RPC ตรวจสิทธิ์ has_any_role ผ่าน auth.uid() เอง + audit CREDIT_ADJUST ใน TX เดียว
    const supabase = await createSupabaseSsrClient();
    const rpc = await supabase.rpc("admin_credit_adjust", {
      p_user_id: body.userId,
      p_cycle_id: body.cycleId,
      p_credit_type: body.creditType,
      p_amount: body.amount,
      p_reason: body.reason.trim(),
      p_request_id: options.requestId ?? null,
    });
    if (rpc.error !== null) {
      throw mapRpcError(rpc.error as RpcErrorLike, "admin_credit_adjust_failed");
    }
    // 5) แถว jsonb ที่ RPC คืน — PostgREST อาจ wrap scalar เป็น array หลักเดียว (r8-N2)
    const rawRow: unknown = Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
    const row = AdjustmentRowSchema.safeParse(rawRow);
    if (!row.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "adjustment_row_drift" } });
    }
    // 6) ขาออก strict ก่อนตอบ — drift → 503 ไม่ strip เงียบ (r6-L1)
    return jsonCreated(
      parseOutgoingView(AdjustmentResource, toAdjustmentResource(row.data), "adjustment_resource_drift"),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/**
 * PATCH /api/v1/admin/question-banks/{id}/questions/{qid}/status — เปิด/ปิดใช้ข้อสอบ
 * (Wave G P2 · D75 · API-SPECIFICATION §3.8 แถว 222 · v1.3.0)
 *
 * - requirePermission("question_bank:update") ที่ BFF — instructor เจ้าของ/staff:exam/
 *   super_admin ผ่านเข้ามาได้ แล้ว RPC admin_set_question_status (0047) เป็นผู้ตัดสินจริง
 *   อีกชั้น (has_any_role(['staff:exam','super_admin']) — instructor เจ้าของก็ตายที่ RPC
 *   เป็น ERR-RBAC-001 → 403 ตาม D75 ที่สิทธิ์ toggle เป็นของ staff:exam เท่านั้น)
 * - body strict { status: "active" | "retired" } เท่านั้น — transition matrix อยู่ฝั่ง DB:
 *   draft→active · active→retired · retired→active (อื่น ๆ/same-status = ERR-VAL-001
 *   question_status_transition จาก RPC)
 * - p_request_id จาก header x-request-id (middleware สร้าง — ไฟล์นี้ไม่ fabricate) →
 *   `options.requestId ?? null` ส่งลง RPC เพื่อลงช่อง request_id ของ audit_logs จริง
 * - error จาก RPC ฝังป้าย "(ERR-XXX-NNN|tag)" ท้ายข้อความ — แกะผ่าน lib/api/rpc-errors
 *   แล้ว map เป็น AppError ตามทะเบียน: ERR-VAL-001 → 400 · ERR-RBAC-001/ERR-AUTH-004 →
 *   403 · ERR-NF-001 → 404 · ไม่มีป้าย / code นอกทะเบียน = ERR-SYS-002 opaque (ห้าม leak
 *   ข้อความ SQL — SDS §6.1)
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import {
  parseAdminExam,
  parseQuestionStatusRpcRow,
  QuestionStatusBody,
  type QuestionStatusBodyParsed,
  QuestionStatusParams,
  QuestionStatusResult,
  toQuestionStatusResult,
} from "@/lib/schemas/v1/admin-exam";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/**
 * JSON body → parsed — JSON เสีย/ชนิดผิด/คีย์แปลกปลอม = ERR-VAL-001 400 (strict —
 * ฟิลด์อื่นนอกจาก status เข้าไมได้เด็ดขาด)
 */
async function parseStatusBody(request: Request): Promise<QuestionStatusBodyParsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
  }
  return parseAdminExam(QuestionStatusBody, raw);
}

/**
 * error ของ RPC → AppError — มีป้าย "(ERR-XXX-NNN|tag)" ที่อยู่ในทะเบียน = map ตรง
 * (สถานะ + ข้อความไทยจากทะเบียน lib/errors) · ไม่มีป้าย / code นอกทะเบียน =
 * ERR-SYS-002 opaque (ไม่ leak ข้อความ SQL ออก client — SDS §6.1) — pattern เดียวกับ
 * /admin/credit-rules/{id} ของ Wave E
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

/** PATCH — เปลี่ยนสถานะข้อสอบ (draft→active · active→retired · retired→active) → 200 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; qid: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — question_bank:update (instructor เจ้าของ/staff:exam/super_admin ผ่าน BFF;
    //    RPC ตัดสินจริง — instructor ตายที่ RPC เป็น ERR-RBAC-001 → 403)
    const { userId } = await requirePermission("question_bank:update");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) path params — ผิดรูปแบบ = ERR-VAL-001 400 ก่อนแตะ DB
    const { id, qid } = await context.params;
    const { bankId, questionId } = parseAdminExam(QuestionStatusParams, {
      bankId: id,
      questionId: qid,
    });
    // 4) body strict { status } — อื่น ๆ = 400
    const body = await parseStatusBody(request);
    // 5) RPC 0047 ด้วย user-JWT client — aal2 + has_any_role + FOR UPDATE + matrix +
    //    pre-check options + UPDATE version+1 + audit (request_id ลงช่องจริง) ใน TX เดียว
    const supabase = await createSupabaseSsrClient();
    const rpc = await supabase.rpc("admin_set_question_status", {
      p_question_id: questionId,
      p_bank_id: bankId,
      p_status: body.status,
      p_request_id: options.requestId ?? null,
    });
    if (rpc.error !== null) {
      throw mapRpcError(rpc.error as RpcErrorLike, "question_status_update_failed");
    }
    // 6) แถว jsonb ที่ RPC คืน — PostgREST อาจ wrap scalar เป็น array หลักเดียว (r8-N2)
    const rawRow: unknown = Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
    if (rawRow === null || typeof rawRow !== "object") {
      throw new AppError("ERR-SYS-002", { details: { reason: "question_status_rpc_drift" } });
    }
    // 7) ขาเข้า/ขาออก strict — drift → 503 ไม่ strip เงียบ (r4-H2a/r6-L1)
    const row = parseQuestionStatusRpcRow(rawRow);
    return jsonOk(
      parseOutgoingView(
        QuestionStatusResult,
        toQuestionStatusResult(row),
        "question_status_result_drift",
      ),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

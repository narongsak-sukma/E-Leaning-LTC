/**
 * POST /api/v1/attempts/[id]/answers — บันทึกคำตอบทีละข้อ (API-SPEC 1.0.3 §3.5 · §4 #7)
 *
 * autosave เรียกบ่อย — idempotent ต่อข้อโดย RPC save_answer + UNIQUE (attempt_id, question_id);
 * เขียนผ่าน RPC SECURITY DEFINER เท่านั้น (DD §4.7) — ห้าม UPDATE attempt_answers ตรง
 * (aa_owner_update ให้ app_owner เท่านั้น — 0010 L777)
 *
 * session binding (D20-B5 — สำคัญสุด): p_session_id อ่านจาก claim `session_id` ของ access
 * token ใน session store — **ห้ามรับจาก request body เด็ดขาด** (body ตาม §4 #7 มีแต่
 * questionId/choiceIds/clientSavedAt) · clientSavedAt ใช้บันทึก/เทียบเท่านั้น — เกณฑ์ตัดสิน
 * หมดเวลาคือ expires_at ฝั่ง RPC (now() > expires_at → ASM-004)
 *
 * permission = attempt:start (ตัวเอง — RBAC-DESIGN §2.3 L70) · rate = EXAM (§5)
 *
 * Errors: VAL-001 (id/body ไม่ผ่าน) · AUTH-001/RBAC-001/AUTH-004 · RATE-001 · จาก RPC:
 * NF-001 (ไม่พบ attempt/ข้อ) · RBAC-001 (session ไม่ตรง ASM-011) · ASM-005 (ส่งแล้ว) ·
 * ASM-004 (หมดเวลา) · VAL-001 (ตัวเลือกไม่อยู่ในข้อนี้) · SYS-002 (RPC ล้มเหลว opaque)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { parseRpcErrorCode } from "@/lib/api/rpc-errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  parseAnswerSaveBody,
  parseAttemptIdParams,
  readJwtSessionClaim,
} from "@/lib/schemas/v1/exam";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** อ่าน body เป็น JSON — parse ไม่ได้ → ERR-VAL-001 (§1: JSON เท่านั้น) */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
  }
}

/** POST — 200 { savedAt } (server time) */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) path param — ไม่ใช่ uuid → VAL-001 400
    const parsed = parseAttemptIdParams({ id: (await context.params).id });
    // 2) session + permission (attempt:start — สิทธิ์ "สอบของตัวเอง")
    const { userId } = await requirePermission("attempt:start");
    // 3) rate EXAM (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "EXAM", secondaryKey: userId });
    // 4) body §4 #7 — ไม่มี field session_id ใด ๆ (session binding อยู่ฝั่ง server ล้วน)
    const body = parseAnswerSaveBody(await readJsonBody(request));
    const supabase = await createSupabaseSsrClient();
    // 5) D20-B5: session_id จาก claim ของ access token ใน session store — ไม่มาจาก body
    const sessionId = await readJwtSessionClaim(supabase);
    // 6) RPC — p_selected_option_ids = choiceIds (RPC dedup + ตรวจ ⊆ snapshot เอง)
    const { error } = await supabase.rpc("save_answer", {
      p_attempt_id: parsed.id,
      p_question_id: body.questionId,
      p_selected_option_ids: body.choiceIds,
      p_session_id: sessionId,
    });
    if (error !== null) {
      const code = parseRpcErrorCode(error);
      throw code === undefined
        ? new AppError("ERR-SYS-002", { details: { reason: "save_answer_failed" } })
        : new AppError(code);
    }
    return jsonOk({ savedAt: new Date().toISOString() }, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

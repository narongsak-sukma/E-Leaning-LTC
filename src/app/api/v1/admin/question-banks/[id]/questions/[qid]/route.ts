/**
 * PATCH /api/v1/admin/question-banks/{id}/questions/{qid} — แก้ข้อสอบ (Wave D · D-3 ·
 * API-SPECIFICATION §3.8 L214 "แก้ข้อสอบ (version ใหม่ — ข้อที่ใช้แล้วอ่านอย่างเดียว)")
 *
 * version mechanism ที่เลือก: แก้ในแถวเดิม + bump version เสมอ — อ้าง DD §3.4
 * (DATA-DICTIONARY L391: questions.version "bump เมื่อแก้โจทย์/ตัวเลือก —
 * attempt_answers.question_snapshot อ้างเวอร์ชันนี้ — F13/D12")
 * เหตุผลที่ไม่ insert แถวใหม่แบบ manual:
 * (1) คอลัมน์ questions.used_at ไม่มีอยู่จริงใน contract (0005 L20-L33 · DD L380-L392)
 * (2) 0010/0011 ไม่มี trigger จัดการ versioning ข้อสอบให้
 * (3) 0011 start_attempt (L562-L655) snapshot ข้อสอบลง attempt_answers.question_snapshot
 *     ณ วินาทีเริ่มสอบ ประวัติจึงไม่เปลี่ยนแม้แก้ในแถวเดิม
 *
 * 0019-r1 (gate r1 B6): เดิม route แก้ questions แล้ววนเขียน question_options
 * ทีละแถวใน TX แยกของแต่ละ option — เลื่อน sort_order ทับกันระหว่างสลับตำแหน่งชน
 * uq_question_options_sort, และ trigger "ต้องมีคำตอบถูกเพียงหนึ่งเดียว" แบบ
 * DEFERRABLE INITIALLY DEFERRED ตรวจตอน commit ทั้ง TX — แต่ TX แยกต่อ option
 * ทำให้ state กลางคันถูกตรวจแทน state ปลายทาง ตอนนี้ยุบเป็น RPC
 * `admin_update_question` TX เดียว (0019): ตรวจสิทธิ์เจ้าของ/active-readonly +
 * patch keys + version bump + เลื่อน sort_order แบบสองเฟส (−1000000 กันชน)
 * + update-or-insert ต่อ option ทั้งหมดในมุมเดียว — BFF ส่ง patch/options เป็น
 * jsonb แล้ว reload อ่านผลจริงตอบกลับ
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
  parseQuestionRow,
  QuestionPatchBody,
  type QuestionPatchBodyParsed,
  QuestionPatchParams,
  QuestionResource,
  toQuestionResource,
} from "@/lib/schemas/v1/admin-exam";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** select ของ reload — ตัด is_correct ตั้งแต่ query (ไม่ปรากฏใน response เด็ดขาด) */
const QUESTION_SELECT =
  "id,bank_id,type,difficulty,question_text,explanation,points,status,tags,version,created_at," +
  "question_options(id,option_text,sort_order)";

/**
 * payload ของ p_patch (jsonb) — เฉพาะฟิลด์ที่ส่งมาเท่านั้น (undefined = คงเดิม) ·
 * explanation เป็น null ได้ (มีคีย์ = เซ็ตค่า รวม null — RPC ใช้ ? operator แยก
 * "เคลียร์ค่า" ออกจาก "ไม่แตะ") · version ห้ามอยู่ที่นี่ — RPC เป็นคน bump (DD §3.4)
 */
function questionPatchPayloadOf(body: QuestionPatchBodyParsed): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (body.type !== undefined) payload["type"] = body.type;
  if (body.difficulty !== undefined) payload["difficulty"] = body.difficulty;
  if (body.questionText !== undefined) payload["question_text"] = body.questionText;
  if (body.explanation !== undefined) payload["explanation"] = body.explanation;
  if (body.points !== undefined) payload["points"] = body.points;
  if (body.tags !== undefined) payload["tags"] = body.tags;
  return payload;
}

/**
 * p_options (jsonb) — แถวต่อตัวเลือกที่ระบุ: มี id = update แถวเดิม / ไม่มี = insert ·
 * null เมื่อ body ไม่แนบ options (ไม่แตะตัวเลือกเลย) · ไม่มี DELETE (ตาม grant 0010)
 */
function optionChangesOf(
  options: QuestionPatchBodyParsed["options"],
): Array<Record<string, unknown>> | null {
  if (options === undefined) {
    return null;
  }
  return options.map((option) => {
    const row: Record<string, unknown> = {
      option_text: option.optionText,
      is_correct: option.isCorrect,
      sort_order: option.sortOrder,
    };
    if (option.id !== undefined) {
      row["id"] = option.id;
    }
    return row;
  });
}

/** RPC error มีป้าย "(ERR-XXX-NNN|reason)" → AppError ตามทะเบียน + เหตุผล · ไม่มีป้าย = ERR-SYS-002 opaque */
function mapQuestionRpcError(error: RpcErrorLike): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    return parsed.reason !== null
      ? new AppError(parsed.code, { details: { reason: parsed.reason } })
      : new AppError(parsed.code);
  }
  return new AppError("ERR-SYS-002", { details: { reason: "admin_question_rpc_failed" } });
}

/** อ่านแถวข้อสอบหลังแก้ (RLS กรองขอบเขตให้ — ไม่เจอ = ผลแปลก ปฏิเสธ fail-closed) */
async function selectQuestion(
  supabase: Awaited<ReturnType<typeof createSupabaseSsrClient>>,
  bankId: string,
  questionId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("questions")
    .select(QUESTION_SELECT)
    .eq("id", questionId)
    .eq("bank_id", bankId)
    .maybeSingle();
  if (error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "admin_question_query_failed" } });
  }
  return (data ?? null) as Record<string, unknown> | null;
}

/** PATCH — แก้ข้อสอบ → 200 (version ใหม่เสมอ · response ไม่มี is_correct) */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; qid: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) path params — ผิดรูปแบบ = ERR-VAL-001 400
    const { id, qid } = await context.params;
    const { bankId, questionId } = parseAdminExam(QuestionPatchParams, {
      bankId: id,
      questionId: qid,
    });
    // 2) RBAC — instructor (เจ้าของ)/staff:exam/super_admin (question_bank:update)
    const session = await requirePermission("question_bank:update");
    // 3) rate STAFF_WRITE
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: session.userId });
    // 4) body strict — ไม่มี status (การเปิด/ปิดใช้เป็นสิทธิ์ staff:exam ที่ RPC บังคับเช่นเดียวกัน)
    const body = parseAdminExam(QuestionPatchBody, await request.json());
    const supabase = await createSupabaseSsrClient();
    // 5) RPC TX เดียว (B6): ตรวจเจ้าของ/active-readonly + patch keys + version bump +
    //    เลื่อน sort_order สองเฟส + update-or-insert ต่อ option — error มีป้ายทะเบียน
    const rpc = await supabase.rpc("admin_update_question", {
      p_question_id: questionId,
      p_bank_id: bankId,
      p_patch: questionPatchPayloadOf(body),
      p_options: optionChangesOf(body.options),
    });
    if (rpc.error !== null) {
      throw mapQuestionRpcError(rpc.error);
    }
    // 6) reload แล้วตอบ 200 — select ไม่รวม is_correct (ตัดตั้งแต่ query)
    // r4-H2b: reload fail → ERR-SYS-002 503 (ไม่ใช่ ERR-SYS-001 500 — G3 แบบเดียวกัน)
    // และตรวจแถวขาเข้าก่อน map — drift (เช่น tags null) เคยโดน mapper TypeError → 500
    const reloaded = await selectQuestion(supabase, bankId, questionId);
    if (reloaded === null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "question_reload_failed" } });
    }
    const row = parseQuestionRow(reloaded);
    return jsonOk(
      parseOutgoingView(QuestionResource, toQuestionResource(row), "question_resource_drift"),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

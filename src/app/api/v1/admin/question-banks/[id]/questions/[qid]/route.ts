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
 */
import { NextResponse } from "next/server";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import {
  mapAdminExamDbError,
  parseAdminExam,
  QuestionPatchBody,
  type QuestionPatchBodyParsed,
  QuestionPatchParams,
  QuestionResource,
  toQuestionResource,
  type QuestionRow,
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

/** select ของแถวปัจจุบันก่อนแก้ — คอลัมน์ที่ต้องรู้เพื่อกติกา version + SoD */
const PATCH_COLUMNS =
  "id,bank_id,version,status,type,difficulty,question_text,explanation,points,tags";

/** payload ของ UPDATE questions — version เพิ่มเสมอ (bump ตาม DD §3.4 — ดูหัวไฟล์) */
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

/** อ่านแถวข้อสอบปัจจุบัน (RLS กรองขอบเขตให้ — ไม่เจอ = 404 ERR-NF-001) */
async function selectQuestion(
  supabase: Awaited<ReturnType<typeof createSupabaseSsrClient>>,
  bankId: string,
  questionId: string,
  select: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("questions")
    .select(select)
    .eq("id", questionId)
    .eq("bank_id", bankId)
    .maybeSingle();
  if (error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "admin_question_query_failed" } });
  }
  return (data ?? null) as Record<string, unknown> | null;
}

/** options: id มี = UPDATE แถวเดิม / ไม่มี = INSERT (question_options ไม่มี grant DELETE — 0010 L638-L640) */
async function applyOptionChanges(
  supabase: Awaited<ReturnType<typeof createSupabaseSsrClient>>,
  questionId: string,
  options: QuestionPatchBodyParsed["options"],
): Promise<void> {
  if (options === undefined) {
    return;
  }
  for (const option of options) {
    if (option.id !== undefined) {
      const { error } = await supabase
        .from("question_options")
        .update({
          option_text: option.optionText,
          is_correct: option.isCorrect,
          sort_order: option.sortOrder,
        })
        .eq("id", option.id)
        .eq("question_id", questionId);
      if (error !== null) {
        throw mapAdminExamDbError(error);
      }
    } else {
      const { error } = await supabase
        .from("question_options")
        .insert({
          question_id: questionId,
          option_text: option.optionText,
          is_correct: option.isCorrect,
          sort_order: option.sortOrder,
        });
      if (error !== null) {
        throw mapAdminExamDbError(error);
      }
    }
  }
}

/** PATCH — แก้ข้อสอบ → 200 (version เพิ่มเสมอ · response ไม่มี is_correct) */
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
    // 4) body strict — ไม่มี status (การเปิด/ปิดใช้เป็นสิทธิ์ staff:exam ที่ DB guard บังคับ)
    const body = parseAdminExam(QuestionPatchBody, await request.json());
    const supabase = await createSupabaseSsrClient();
    // 5) อ่านแถวปัจจุบัน — ไม่เจอ = 404 ERR-NF-001
    const existing = await selectQuestion(supabase, bankId, questionId, PATCH_COLUMNS);
    if (existing === null) {
      throw new AppError("ERR-NF-001", { details: { reason: "question_not_found" } });
    }
    // 6) ข้อ "ใช้แล้ว" (active) — instructor แก้ไม่ได้ (RBAC) · staff:exam/sa แก้ได้ (version ใหม่)
    //    ตรวจก่อนเขียนเพื่อให้ error code ถูกเรื่อง — DB guard_question_activation บังคับเช่นเดียวกัน
    const isExamStaff = session.roles.some(
      (role) => role === "staff:exam" || role === "super_admin",
    );
    if (existing["status"] === "active" && !isExamStaff) {
      throw new AppError("ERR-RBAC-001", {
        details: { reason: "question_active_readonly_for_instructor" },
      });
    }
    // 7) UPDATE ในแถวเดิม + version ใหม่เสมอ (bump ตาม DD §3.4 — ดูหัวไฟล์)
    const patch = questionPatchPayloadOf(body);
    patch["version"] = Number(existing["version"]) + 1;
    const { error: updateError } = await supabase
      .from("questions")
      .update(patch)
      .eq("id", questionId)
      .eq("bank_id", bankId);
    if (updateError !== null) {
      // instructor แก้นอก bank ตัวเอง → RLS q_update 42501 → ERR-RBAC-001 403
      throw mapAdminExamDbError(updateError);
    }
    // 8) options (ถ้าแนบมา) — UPDATE/INSERT เฉพาะตัวเลือกที่ระบุ (ไม่มี DELETE grant)
    await applyOptionChanges(supabase, questionId, body.options);
    // 9) reload แล้วตอบ 200 — select ไม่รวม is_correct (ตัดตั้งแต่ query)
    const reloaded = await selectQuestion(supabase, bankId, questionId, QUESTION_SELECT);
    if (reloaded === null) {
      throw new AppError("ERR-SYS-001", { details: { reason: "question_reload_failed" } });
    }
    return jsonOk(
      QuestionResource.parse(toQuestionResource(reloaded as unknown as QuestionRow)),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/**
 * POST /api/v1/lessons/{id}/quiz/submit — ส่งแบบทดสอบย่อย (API-SPECIFICATION §3.4 + §4 #6)
 *
 * - {id} = lesson id (ชนิด quiz) — BFF หา quiz_id จาก lessons แล้วส่งให้ RPC
 *   record_quiz_attempt(p_quiz_id, p_answers) (F2/D12: เขียน quiz_attempts ผ่าน
 *   RPC SECURITY DEFINER เท่านั้น)
 * - grading = server ล้วน (M1 — 0011_functions.sql): ห้ามรับคะแนน/is_correct จาก client;
 *   schema §4 #6 รับเฉพาะ questionId + choiceIds — response คืนเฉพาะผลที่ RPC เปิดเผย
 *   ({ attempt_id, score_pct, passed } — คะแนน+ผ่าน/ไม่ผ่าน ตาม pass_pct ของ quiz)
 * - ต้อง login — requirePermission("lesson:view"); อ่านเฉพาะของตัวเองตาม RLS
 * - rate: LEARN_WRITE (§5) เรียกเองใน handler — key user_id + ip (D12-11)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { parseRpcErrorCode } from "@/lib/api/rpc-errors";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import {
  QuizSubmitView,
  parseLessonIdParams,
  parseQuizSubmitBody,
  RecordQuizAttemptResult,
} from "@/lib/schemas/v1/progress";

function jsonOptions(requestId: string | null): JsonResponseOptions {
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id");
  try {
    const { userId } = await requirePermission("lesson:view");
    enforceRateLimit(request, { group: "LEARN_WRITE", secondaryKey: userId });
    const { id: lessonId } = parseLessonIdParams({ id: (await context.params).id });
    const body = parseQuizSubmitBody(await readJsonBody(request));
    const supabase = await createSupabaseSsrClient();

    // 1) บทเรียนชนิด quiz ที่ RLS ให้เห็น → quiz_id (lessons_read — ผู้ลงทะเบียน)
    const { data: lessonRow, error: lessonError } = await supabase
      .from("lessons")
      .select("id, quiz_id, type")
      .eq("id", lessonId)
      .is("deleted_at", null) // gate r2: lessons_read ไม่กรอง soft-delete — บทเรียนที่ลบแล้วเหมือนไม่มีจริง
      .maybeSingle();
    if (lessonError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lessons_read_failed" } });
    }
    if (
      lessonRow === null ||
      lessonRow["type"] !== "quiz" ||
      typeof lessonRow["quiz_id"] !== "string"
    ) {
      // มองบทเรียนไม่เห็น = ไม่ลงทะเบียน/ไม่มีจริง → §3.4 LRN-001 (ตอบเหมือนกันทุกกรณี);
      // เห็นแต่ไม่ใช่บท quiz → ไม่มี quiz ให้ส่ง → ERR-NF-001 (404 generic)
      if (lessonRow === null) {
        throw new AppError("ERR-LRN-001");
      }
      throw new AppError("ERR-NF-001");
    }

    // 2) ส่งให้ RPC — answers แปลงเป็น contract ของ RPC (question_id + selected_option_ids);
    //    ห้ามส่ง is_correct/คะแนน (RPC ตรวจเองจาก quiz_options — M1, 0011_functions.sql)
    const { data, error: rpcError } = await supabase.rpc("record_quiz_attempt", {
      p_quiz_id: lessonRow["quiz_id"],
      p_answers: body.answers.map((a) => ({
        question_id: a.questionId,
        selected_option_ids: a.choiceIds,
      })),
    });
    if (rpcError) {
      // code ทะเบียนท้ายข้อความ RPC (parser กลาง) — ไม่รู้จัก → ERR-SYS-001 opaque (ไม่ leak SQL)
      const code = parseRpcErrorCode(rpcError);
      throw code === undefined ? new AppError("ERR-SYS-001") : new AppError(code);
    }

    // 3) ผลจาก RPC (jsonb) ตรวจด้วย zod ก่อนใช้ แล้วแปลงเป็นขาออก camelCase (§1-4)
    const result = RecordQuizAttemptResult.safeParse(data);
    if (!result.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "record_quiz_attempt_bad_contract" } });
    }
    const view = {
      attemptId: result.data.attempt_id,
      scorePct: result.data.score_pct,
      passed: result.data.passed,
    };
    const parsed = QuizSubmitView.safeParse(view);
    if (!parsed.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "quiz_submit_bad_contract" } });
    }
    return jsonOk(parsed.data, jsonOptions(requestId));
  } catch (err: unknown) {
    return jsonErrorResponse(err, jsonOptions(requestId));
  }
}

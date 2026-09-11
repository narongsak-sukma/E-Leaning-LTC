/**
 * POST /api/v1/assessments/[id]/attempts — เริ่มสอบ (API-SPEC 1.0.3 §3.5 · DCR-6)
 *
 * ลำดับ: path param → session+permission → rate EXAM → RPC start_attempt (DD §4.7 —
 * เขียนผ่าน SECURITY DEFINER เท่านั้น) → อ่านโจทย์จาก learner_attempt_paper_view
 * (0019 — PB-16: เจ้าของ + in_progress เท่านั้น · question_paper ตัด points/is_correct
 * ทุกชั้นที่ view เอง) → 201 หน้าต่างสอบ + ชุดโจทย์ไร้เฉลย + serverTime
 *
 * RPC ไม่คืนชุดข้อ — BFF อ่านเองหลัง start; ตัวเลือกเป็น {id,text} เท่านั้นและ
 * mapper toExamPaperQuestion whitelist ต่อ + validate strict (ผิด contract →
 * SYS-002) จึงไม่มีช่องทางรั่วเฉลยระหว่างสอบ (D19-B1)
 *
 * permission = attempt:start (citizen/lawyer — RBAC-DESIGN §2.3 L70 "attempt:start
 * (ตัวเอง)") · ธงให้ lead: ชื่อ perm ในใบงาน "assessment:attempt" ไม่มีจริงใน rbac.ts
 *
 * Errors: VAL-001 (id ไม่ใช่ uuid) · AUTH-001/RBAC-001/AUTH-004 · RATE-001 ·
 * จาก RPC: ASM-001 (ครบจำนวนครั้ง) · ASM-002 (มี attempt ค้าง) · ASM-003 (ปิด/ไม่พบ/
 * คลังข้อไม่พอ/cooldown) · LRN-001/LRN-002 (ต้องลงทะเบียน/เรียนให้ครบ) · VAL-001
 * (token ไม่มี session_id claim) · SYS-002 (RPC/query ล้มเหลว · contract ผิด)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonCreated, jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { parseRpcErrorCode } from "@/lib/api/rpc-errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  AttemptPaperRowSchema,
  AttemptStartView,
  StartAttemptResult,
  type StartAttemptResultParsed,
  parseAssessmentIdParams,
  parseInboundRow,
  toExamPaperQuestion,
  type LearnerAttemptPaperViewRow,
} from "@/lib/schemas/v1/exam";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** ตรวจ jsonb ของ RPC start_attempt แบบ fail-closed — ผิด contract → SYS-002 */
function parseStartAttemptResult(data: unknown): StartAttemptResultParsed {
  const parsed = StartAttemptResult.safeParse(data);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "start_attempt_bad_contract" } });
  }
  return parsed.data;
}

/** POST — 201 หน้าต่างสอบ + ชุดข้อไร้เฉลย (+ takeover เมื่อ ASM-011 lease หมด) */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) path param — ไม่ใช่ uuid → VAL-001 400
    const parsed = parseAssessmentIdParams({ id: (await context.params).id });
    // 2) session + permission (attempt:start — citizen/lawyer มี; ธง: "assessment:attempt" ไม่มีจริง)
    const { userId } = await requirePermission("attempt:start");
    // 3) rate EXAM (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "EXAM", secondaryKey: userId });
    const supabase = await createSupabaseSsrClient();

    // 4) เริ่ม/takeover ผ่าน RPC — session ผูกจาก claim ฝั่ง RPC เอง (D20-B5)
    const { data, error } = await supabase.rpc("start_attempt", { p_assessment_id: parsed.id });
    if (error !== null) {
      const code = parseRpcErrorCode(error);
      throw code === undefined
        ? new AppError("ERR-SYS-002", { details: { reason: "start_attempt_failed" } })
        : new AppError(code);
    }
    const start = parseStartAttemptResult(data);

    // 5) อ่านโจทย์ของ attempt นี้จาก learner_attempt_paper_view (0019 — WHERE
    //    auth.uid()+status='in_progress' ในตัว view; question_paper ตัดเฉลยแล้ว)
    const { data: rows, error: qError } = await supabase
      .from("learner_attempt_paper_view")
      .select("question_id, seq, selected_option_ids, answered_at, question_paper")
      .eq("attempt_id", start.attempt_id)
      .order("seq", { ascending: true });
    if (qError !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_questions_read_failed" } });
    }
    // r9-O2: ความสำเร็จแต่ container ไม่ใช่ array (null/object ปลอม) = drift → 503
    // ไม่ใช่ `?? []` กลืนเป็น 201 หน้าว่าง หรือ TypeError → 500
    if (!Array.isArray(rows)) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_paper_rows_not_array" } });
    }
    // แถวละ schema strict 5 คีย์ตาม select — คีย์เกิน/ขาด/แถว null = drift → 503
    const viewRows: LearnerAttemptPaperViewRow[] = rows.map((raw) =>
      parseInboundRow(AttemptPaperRowSchema, raw, "attempt_paper_row_drift"),
    );
    if (viewRows.length !== start.question_count) {
      // start เขียน attempt_answers ครบทุกข้อใน TX เดียว — เหลื่อม = contract ผิด fail-closed
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_questions_bad_contract" } });
    }
    const view = {
      attemptId: start.attempt_id,
      status: "in_progress" as const,
      deadlineAt: start.expires_at,
      serverTime: new Date().toISOString(),
      questionCount: start.question_count,
      questions: viewRows.map(toExamPaperQuestion),
      ...(start.takeover !== undefined ? { takeover: start.takeover } : {}),
    };
    const parsedView = AttemptStartView.safeParse(view);
    if (!parsedView.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_start_view_bad_contract" } });
    }
    return jsonCreated(parsedView.data, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

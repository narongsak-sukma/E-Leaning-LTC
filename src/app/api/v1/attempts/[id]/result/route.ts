/**
 * GET /api/v1/attempts/[id]/result — ผลสอบ + เฉลย (API-SPEC 1.0.3 §3.5 · DCR-6)
 *
 * อ่านผ่าน learner_attempt_view เท่านั้น — view เปิดเฉลยเองตามเงื่อนไข after_final_attempt
 * (0009_views.sql L23-77: is_correct/points_earned/question_snapshot/explanation เปิดเมื่อ
 * "ส่งแล้ว + ครบครั้งสุดท้ายตามกติกา") — **BFF ห้าม filter/เปิดเฉลยเอง ส่งตาม view เป๊ะ**
 * (ยังไม่เปิด = คอลัมน์เฉลย null ตาม view · content จาก question_snapshot ว่าง)
 *
 * ขอบเขต: view กรอง at.user_id = auth.uid() ในตัว (ผู้เรียนเห็นเฉพาะของตัวเอง) —
 * ไม่พบ/ไม่ใช่เจ้าของตอบเหมือนกัน NF-001 404 (ไม่เปิดเผยความมีอยู่ของ attempt ผู้อื่น —
 * user-JWT ไม่มีทางแยกสองกรณีนี้ได้ ธงให้ lead: ASM-006 จึงไปไม่ถึงจากเส้นทางนี้)
 *
 * permission = attempt:view (ตัวเอง — RBAC-DESIGN §2.3 L71) · rate = READ (§5)
 *
 * Errors: VAL-001 (id ไม่ใช่ uuid) · AUTH-001/RBAC-001/AUTH-004 · RATE-001 ·
 * NF-001 (ไม่พบ/ไม่ใช่เจ้าของ) · SYS-002 (query ล้มเหลว/contract ผิด)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  AttemptResultRowSchema,
  AttemptResultView,
  parseAttemptIdParams,
  parseInboundRow,
  toAttemptResultView,
} from "@/lib/schemas/v1/exam";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — 200 { data: AttemptResult } · 404 NF-001 (ไม่พบ/ไม่ใช่เจ้าของ — ตอบเหมือนกัน) */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) path param — ไม่ใช่ uuid → VAL-001 400
    const parsed = parseAttemptIdParams({ id: (await context.params).id });
    // 2) session + permission (ไม่ login → 401 · ไม่มี attempt:view → 403 RBAC-001)
    const { userId } = await requirePermission("attempt:view");
    // 3) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: userId });
    const supabase = await createSupabaseSsrClient();
    // 4) อ่านทุกคอลัมน์ที่ view เปิด ของ attempt นี้ (WHERE auth.uid() ในตัว view —
    //    เฉลยเปิด/ไม่เปิดตัดสินฝั่ง view ล้วน BFF ส่งตามเป๊ะ)
    const { data, error } = await supabase
      .from("learner_attempt_view")
      .select(
        "attempt_id, user_id, assessment_id, attempt_no, status, started_at, expires_at, "
        + "submitted_at, score_pct, passed, question_id, seq, selected_option_ids, answered_at, "
        + "is_correct, points_earned, question_snapshot, explanation",
      )
      .eq("attempt_id", parsed.id)
      .order("seq", { ascending: true });
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_result_read_failed" } });
    }
    // r8-N1: container + แถวต้องตรงสัญญา — success แต่ data ไม่ใช่ array = drift
    // (ไม่ใช่ `?? []` กลืนเป็น 404) · แต่ละแถว strict 18 คีย์ก่อน mapper
    // (คีย์ question_snapshot หาย = drift ไม่ใช่ content:null เงียบ ๆ)
    if (!Array.isArray(data)) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_result_rows_not_array" } });
    }
    const rows = data.map((raw) =>
      parseInboundRow(AttemptResultRowSchema, raw, "attempt_result_row_drift"),
    );
    if (rows.length === 0) {
      // ไม่พบ หรือ ไม่ใช่เจ้าของ (view กรองเอง) — ตอบเหมือนกัน ไม่เปิดเผยความมีอยู่
      throw new AppError("ERR-NF-001");
    }
    const view = toAttemptResultView(rows);
    const parsedView = AttemptResultView.safeParse(view);
    if (!parsedView.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_result_bad_contract" } });
    }
    return jsonOk(parsedView.data, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/**
 * GET /api/v1/assessments/[id] — ข้อมูลการสอบ + กติกา (API-SPEC 1.0.3 §3.5 · DCR-6)
 *
 * read-only เสมอ ไม่สร้าง attempt (B-10) — อ่าน assessments + assessment_rules effective
 * ล่าสุด (effective_from <= now เรียงหามากสุด — F21) ผ่าน user-JWT + RLS:
 * asm_read (ผู้เรียนเห็นเฉพาะ published ของหลักสูตรที่ลงทะเบียน active — 0010 L643) ·
 * ar_read (0010 L692) + column grant รวม pass_pct แล้ว (0019 — selection ยังซ่อน
 * ตาม 0010 L709-713)
 *
 * 200 · ไม่เห็น assessment (ไม่ published/ไม่ลงทะเบียน/ไม่มีจริง) → ASM-003 404 ·
 * เห็นแต่ไม่มีกติกา effective → NF-001 404 · id ไม่ใช่ uuid → VAL-001 400 ·
 * rate = READ (§5)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  parseAssessmentIdParams,
  toAssessmentDetail,
  type AssessmentRow,
  type AssessmentRulesRow,
} from "@/lib/schemas/v1/exam";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — 200 { data: AssessmentDetail } · 404 ASM-003 (ไม่เห็น) / NF-001 (ไม่มีกติกา effective) */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) path param — ไม่ใช่ uuid → ข้อมูลส่งมาไม่ถูกต้อง (VAL-001 400)
    const parsed = parseAssessmentIdParams({ id: (await context.params).id });
    // 2) session + permission (ไม่ login → 401 AUTH-001 · ไม่มี assessment:view → 403 RBAC-001)
    const { userId } = await requirePermission("assessment:view");
    // 3) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: userId });
    const supabase = await createSupabaseSsrClient();

    // 4) assessment ผ่าน RLS asm_read — ไม่เห็น = ไม่ published/ไม่ใช่ผู้ลงทะเบียน/ไม่มีจริง
    //    (ตอบเหมือนกันทุกกรณี ASM-003 — ไม่เปิดเผยสถานะความมีอยู่)
    const { data: assessment, error: aError } = await supabase
      .from("assessments")
      .select("id, course_id, code, title, description, is_final, status, published_at")
      .eq("id", parsed.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (aError !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "assessment_read_failed" } });
    }
    if (assessment === null) {
      throw new AppError("ERR-ASM-003");
    }
    const row = assessment as unknown as AssessmentRow;
    if (row.status !== "published") {
      // staff เห็น draft/closed/archived ได้ตาม RLS แต่ endpoint ผู้เรียนอ่านเฉพาะ published
      throw new AppError("ERR-ASM-003");
    }

    // 5) กติกาเวอร์ชัน effective ล่าสุด (effective_from <= now → มากสุด) — คอลัมน์ที่ได้
    //    GRANT SELECT ให้ authenticated (pass_pct เพิ่มใน 0019 · selection ยังซ่อน)
    const { data: rules, error: rError } = await supabase
      .from("assessment_rules")
      .select(
        "id, assessment_id, version, pass_pct, time_limit_minutes, question_count, max_attempts, "
        + "attempt_cooldown_minutes, shuffle_questions, shuffle_options, "
        + "require_course_complete, proctoring_mode, effective_from",
      )
      .eq("assessment_id", parsed.id)
      .lte("effective_from", new Date().toISOString())
      .order("effective_from", { ascending: false })
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rError !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "assessment_rules_read_failed" } });
    }
    if (rules === null) {
      throw new AppError("ERR-NF-001", { details: { fields: ["rules"] } });
    }
    return jsonOk(toAssessmentDetail(row, rules as unknown as AssessmentRulesRow), options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

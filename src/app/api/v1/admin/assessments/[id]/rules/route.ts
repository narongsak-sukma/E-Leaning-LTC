/**
 * POST /api/v1/admin/assessments/{id}/rules — เพิ่มกติกา version ใหม่ (Wave G P3 · D87 ·
 * API-SPECIFICATION §3.8 แถว POST /admin/assessments/{id}/rules)
 *
 * แก้กติกา = version ใหม่เสมอ (UPDATE ของ semantic columns ถูก trigger guard_rule_semantics
 * 0010 L721-L749 ปิด) — version = max+1 คำนวณ server-side ใน INSERT...SELECT เดียว (RPC
 * admin_add_assessment_rules 0049 · สอง TX ชน uq_assessment_rules_version = retry ×3 ภายใน
 * RPC หมดแล้ว ERR-SYS-002|rules_version_conflict) · audit ASSESSMENT_CONFIG_CHANGE ยิงโดย DB
 * trigger (0049 ข้อ 5) ทุก INSERT ของ assessment_rules — ปิด 3 ทาง รวม POST v1 เดิม
 *
 * POST — requirePermission("assessment:update") แต่เขียนกติกาได้เฉพาะ staff:exam/super_admin
 * (ar_write 0010 L703-L704) — role pre-check canWriteRules "ก่อน" เรียก RPC ตาม route เดิม
 * (route.ts:203-211) · ชั้น DB ตรวจซ้ำใน RPC (auth → aal2 → role — defense in depth)
 *
 * rate = STAFF_WRITE (§5 — /api/v1/admin/* · ROUTE_RULES lib/rate-limit L151) — เรียกเองใน
 * handler (middleware ไม่ wire ให้)
 */
import { z } from "zod";
import { NextResponse } from "next/server";
import {
  jsonCreated,
  jsonErrorResponse,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import {
  AssessmentRuleInput,
  AssessmentRuleResource,
  parseAdminExam,
  parseAssessmentRuleRpcRow,
  toAssessmentRuleResource,
  type AssessmentRuleInputParsed,
} from "@/lib/schemas/v1/admin-exam";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** path params — segment เดียว [id] = assessment id (uuid ตามคอลัมน์ assessments.id) */
const RulePathParams = z
  .object({ id: z.uuid() })
  .strict();

/** แปลง body ดิบจาก request — JSON พัง = ERR-VAL-001 fields ["body"] (แบบเดียวกับ status route) */
async function parseRuleBody(request: Request): Promise<AssessmentRuleInputParsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
  }
  return parseAdminExam(AssessmentRuleInput, raw);
}

/**
 * error ของ RPC → AppError — มีป้าย "(ERR-XXX-NNN|tag)" ที่อยู่ในทะเบียน = map ตรง
 * (สถานะ + ข้อความไทยจากทะเบียน lib/errors) · ไม่มีป้าย / code นอกทะเบียน =
 * ERR-SYS-002 opaque (ไม่ leak ข้อความ SQL ออก client — SDS §6.1) — pattern เดียวกับ
 * /admin/credit-rules และ .../questions/{qid}/status ของ Wave E/G-P2
 */
function mapRpcError(error: RpcErrorLike): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: "assessment_rules_add_failed" } });
}

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/**
 * POST — เพิ่มกติกา version ใหม่ของชุดข้อสอบ (เฉพาะ staff:exam/super_admin) → 201 +
 * AssessmentRuleResource (แถวที่แทรก — version = max+1 server-side)
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — assessment:update (aal1 → 403 ERR-AUTH-004 ที่ชั้น RBAC)
    const session = await requirePermission("assessment:update");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: session.userId });
    // 3) path params — ไม่ใช่ uuid → ERR-VAL-001 400 ก่อนแตะ DB
    const { id } = await context.params;
    const { id: assessmentId } = parseAdminExam(RulePathParams, { id });
    // 4) body strict AssessmentRuleInput — ห้ามส่ง version/effective_to (schema strict ไม่มี
    //    คีย์นี้ → ERR-VAL-001) · ผิดรูป → ERR-VAL-001 + fields
    const body = await parseRuleBody(request);
    // 5) pre-check สิทธิ์เขียนกติกา (ar_write เฉพาะ staff:exam/super_admin) ก่อนเรียก RPC —
    //    instructor ตายที่นี่ 403 ERR-RBAC-001 ไม่แตะ DB (route.ts:203-211)
    const canWriteRules = session.roles.some(
      (role) => role === "staff:exam" || role === "super_admin",
    );
    if (!canWriteRules) {
      throw new AppError("ERR-RBAC-001", {
        details: { reason: "assessment_rules_write_requires_staff_exam" },
      });
    }
    // 6) RPC 0049 — guards ตามลำดับ (auth → aal2 → role → ค่ากติกา → NF) +
    //    version=max+1 ใน INSERT...SELECT เดียว + retry ชน unique ×3 + audit โดย trigger
    const supabase = await createSupabaseSsrClient();
    const rpc = await supabase.rpc("admin_add_assessment_rules", {
      p_assessment_id: assessmentId,
      p_time_limit_minutes: body.timeLimitMinutes,
      p_question_count: body.questionCount,
      p_pass_pct: body.passPct,
      p_max_attempts: body.maxAttempts,
      p_attempt_cooldown_minutes: body.attemptCooldownMinutes,
      p_shuffle_questions: body.shuffleQuestions,
      p_shuffle_options: body.shuffleOptions,
      p_require_course_complete: body.requireCourseComplete,
      p_proctoring_mode: body.proctoringMode,
      p_selection: body.selection ?? null,
      p_effective_from: body.effectiveFrom ?? null,
      p_exam_review_mode: body.examReviewMode,
    });
    // 7) error ของ RPC → AppError ตามป้าย "(ERR-XXX-NNN|tag)" ใน message (สถานะจากทะเบียน)
    if (rpc.error !== null) {
      throw mapRpcError(rpc.error as RpcErrorLike);
    }
    // 8) แถว jsonb ที่ RPC คืน — PostgREST อาจ wrap scalar เป็น array หลักเดียว (r8-N2)
    const rawRow: unknown = Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
    if (rawRow === null || typeof rawRow !== "object") {
      throw new AppError("ERR-SYS-002", { details: { reason: "assessment_rule_rpc_drift" } });
    }
    // zod-ตรวจแถวขาเข้า (r4-H2a) ก่อน map + ตรวจ view ขาออก (B4) — drift → 503 ERR-SYS-002
    return jsonCreated(
      parseOutgoingView(
        AssessmentRuleResource,
        toAssessmentRuleResource(parseAssessmentRuleRpcRow(rawRow)),
        "assessment_rule_contract_drift",
      ),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

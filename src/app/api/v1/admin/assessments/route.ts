/**
 * GET/POST /api/v1/admin/assessments — ชุดข้อสอบ/กติกาสำหรับหลังบ้าน (Wave D · D-3 ·
 * API-SPECIFICATION §3.8 L215-L216)
 *
 * GET — requirePermission("assessment:view") (matrix rbac.ts L90-L253 — instructor/staff:viewer/
 * staff:exam/staff:registrar/super_admin มี permission นี้; ขอบเขตกรองที่ RLS asm_read
 * 0010 L643-L651 ให้เอง) · สรุปกติกาล่าสุดจาก embed assessment_rules (เรียง effective_from desc
 * + limit 1 ที่ embed) — select เฉพาะคอลัมน์ที่ **column grant ของ authenticated** ครอบ
 * (pass_pct ได้ grant เพิ่มใน 0019 · selection ยังไม่เปิดตาม 0010 L711-L714)
 *
 * POST — requirePermission("assessment:create") (instructor/staff:exam/super_admin):
 * - status = 'draft' เสมอ — server-controlled ห้ามรับจาก body (schema strict ไม่มี status);
 *   RLS asm_insert (0010 L652-L658) บังคับ instructor สร้างได้เฉพาะ status='draft' ของหลักสูตร
 *   ตัวเอง (WITH CHECK) — BFF ไม่เลียน logic ซ้ำ แต่ map 42501 → ERR-RBAC-001
 * - rules: ar_write (0010 L703-L704) ให้ INSERT assessment_rules เฉพาะ staff:exam/super_admin —
 *   instructor ที่แนบ rules → ERR-RBAC-001 "ก่อน" เขียน DB เพื่อไม่เกิด partial write
 *   (PostgREST คนละ request ยุบ transaction หลายตารางไม่ได้)
 * - แก้กฎภายหลัง = สร้าง version ใหม่ (guard_rule_semantics 0010 L721-L749) — POST แค่ insert v1
 *
 * rate = STAFF_WRITE ทุก method (§5 — /api/v1/admin/* = 60/min ต่อบัญชี + ip · ROUTE_RULES
 * lib/rate-limit L151) — เรียกเองใน handler (middleware ไม่ wire ให้)
 */
import { NextResponse } from "next/server";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import {
  jsonCreated,
  jsonErrorResponse,
  jsonPageOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission, type RequirePermissionResult } from "@/lib/rbac";
import {
  AdminAssessmentResource,
  AssessmentCreateBody,
  type AssessmentCreateBodyParsed,
  type AssessmentRuleInputParsed,
  mapAdminExamDbError,
  parseAdminAssessmentRow,
  parseAdminAssessmentsQuery,
  parseAdminExam,
  toAdminAssessmentResource,
} from "@/lib/schemas/v1/admin-exam";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/**
 * select ของ GET/POST — course = เจ้าของหลักสูตร (assessments ไม่มีคอลัมน์ created_by —
 * 0005 L50-L61) ผูก !left กันแถวหายเมื่อ RLS ฝั่ง courses บัง; assessment_rules embed เรียง
 * effective_from ล่าสุดก่อน + limit 1
 */
const ADMIN_ASSESSMENT_SELECT =
  "id,code,title,description,is_final,status,course_id,created_at," +
  "course:courses!left(id,created_by)," +
  "assessment_rules(version,pass_pct,time_limit_minutes,question_count,max_attempts," +
  "attempt_cooldown_minutes,shuffle_questions,shuffle_options,proctoring_mode,effective_from)";

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** or-filter เลื่อน cursor แบบ row-wise (created_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  const sortKey = payload.sortKey.replace(/[,()]/g, " "); // ตัดอักขระ PostgREST or-syntax (เหมือน q ของ /admin/courses)
  return `created_at.lt.${sortKey},and(created_at.eq.${sortKey},id.lt.${payload.id})`;
}

/** โครง insert ของ assessments — status ตายตัว 'draft' (server-controlled — ดูหัวไฟล์) */
function assessmentInsertPayloadOf(
  body: Pick<
    AssessmentCreateBodyParsed,
    "courseId" | "code" | "title" | "description" | "isFinal"
  >,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    course_id: body.courseId,
    code: body.code,
    title: body.title,
    status: "draft",
  };
  if (body.description !== undefined) {
    payload["description"] = body.description;
  }
  if (body.isFinal !== undefined) {
    payload["is_final"] = body.isFinal;
  }
  return payload;
}

/** insert ของ assessment_rules — คอลัมน์ตรง 0005 L66-L82 (version/effective_from ให้ DB default ได้) */
function ruleInsertPayloadOf(
  assessmentId: string,
  rules: AssessmentRuleInputParsed,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    assessment_id: assessmentId,
    version: 1,
    time_limit_minutes: rules.timeLimitMinutes,
    question_count: rules.questionCount,
    pass_pct: rules.passPct,
    max_attempts: rules.maxAttempts,
    attempt_cooldown_minutes: rules.attemptCooldownMinutes,
    shuffle_questions: rules.shuffleQuestions,
    shuffle_options: rules.shuffleOptions,
    require_course_complete: rules.requireCourseComplete,
    proctoring_mode: rules.proctoringMode,
  };
  if (rules.selection !== undefined) {
    payload["selection"] = rules.selection;
  }
  if (rules.effectiveFrom !== undefined) {
    payload["effective_from"] = rules.effectiveFrom;
  }
  return payload;
}

/** GET — รายการชุดข้อสอบทุกสถานะ (RLS กรองตามบทบาท) เรียง created_at ล่าสุดก่อน + cursor */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — ไม่ login → 401 ERR-AUTH-001 · บทบาทบังคับ MFA ยัง aal1 → 403 ERR-AUTH-004 ·
    //    ไม่มี assessment:view → 403 ERR-RBAC-001
    const { userId } = await requirePermission("assessment:view");
    // 2) rate STAFF_WRITE (§5 — /admin/* · user_id + ip — D12-11) — หลัง RBAC เพื่อไม่นับ
    //    คำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query กลาง (limit default 20 max 100 — strict)
    const url = new URL(request.url);
    const query = parseAdminAssessmentsQuery(url.searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const supabase = await createSupabaseSsrClient();
    let builder = supabase
      .from("assessments")
      .select(ADMIN_ASSESSMENT_SELECT)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      // embed กติกา: effective ล่าสุดก่อน + 1 แถว (limit เฉพาะ embed — ไม่กระทบหน้าหลัก)
      .order("effective_from", { referencedTable: "assessment_rules", ascending: false })
      .limit(1, { referencedTable: "assessment_rules" })
      .limit(query.limit + 1);
    if (query.status !== undefined) {
      builder = builder.eq("status", query.status);
    }
    if (query.courseId !== undefined) {
      builder = builder.eq("course_id", query.courseId);
    }
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "admin_assessments_query_failed" } });
    }
    const rows = ((data ?? []) as unknown[]).map(parseAdminAssessmentRow);
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => row.created_at,
      idOf: (row) => row.id,
    });
    // zod-ตรวจทุกแถวขาออก (B4) — แถวไหน drift (เช่น กติกา embed เพี้ยน) → 503 ERR-SYS-002
    return jsonPageOk(
      {
        data: page.data.map((row) =>
          parseOutgoingView(
            AdminAssessmentResource,
            toAdminAssessmentResource(row),
            "admin_assessment_contract_drift",
          ),
        ),
        page: page.page,
      },
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/**
 * POST — สร้างชุดข้อสอบเริ่มสถานะ 'draft' + กติกาเริ่มต้น (เฉพาะ staff:exam/super_admin —
 * ข้อจำกัด INSERT ของ assessment_rules เอง) → 201
 */
export async function POST(
  request: Request,
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — instructor/staff:exam/super_admin (assessment:create)
    const session: RequirePermissionResult = await requirePermission("assessment:create");
    // 2) rate STAFF_WRITE
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: session.userId });
    // 3) body (strict — ไม่มี status; ผิดรูป → ERR-VAL-001 400)
    const body = parseAdminExam(AssessmentCreateBody, await request.json());
    // 4) rules ต้องเป็น staff:exam/super_admin (ar_write 0010 L703-L704) — ตรวจ "ก่อน" เขียน
    //    assessments เพื่อไม่ทิ้ง partial write (assessment ที่สร้างแล้วแต่ไม่มีกติกา)
    const canWriteRules = session.roles.some(
      (role) => role === "staff:exam" || role === "super_admin",
    );
    if (body.rules !== undefined && !canWriteRules) {
      throw new AppError("ERR-RBAC-001", {
        details: { reason: "assessment_rules_write_requires_staff_exam" },
      });
    }
    const supabase = await createSupabaseSsrClient();
    // 5) insert assessments — status 'draft' เสมอ (instructor สร้างนอกหลักสูตรตัวเอง →
    //    RLS asm_insert 42501 → ERR-RBAC-001 403)
    const { data: created, error } = await supabase
      .from("assessments")
      .insert(assessmentInsertPayloadOf(body))
      .select(ADMIN_ASSESSMENT_SELECT)
      .single();
    if (error !== null) {
      throw mapAdminExamDbError(error);
    }
    if (created === null || typeof created !== "object") {
      throw new AppError("ERR-SYS-002", { details: { reason: "assessment_create_bad_contract" } });
    }
    // zod-ตรวจแถวที่ INSERT คืนขาเข้าก่อนหยิบ id ใช้ (0019-r3 G3) — drift
    // (id หาย/ผิดชนิด) ต้องตายที่นี่ 503 ERR-SYS-002 ก่อนแตะ rules
    // insert/reload ด้วย id ที่ไม่ผ่าน validation
    const createdRow = parseAdminAssessmentRow(created);
    // 6) insert กติกา v1 (เฉพาะเมื่อแนบ rules มา — staff:exam/super_admin เท่านั้น ข้อ 4)
    if (body.rules !== undefined) {
      const { error: ruleError } = await supabase
        .from("assessment_rules")
        .insert(ruleInsertPayloadOf(createdRow.id, body.rules));
      if (ruleError !== null) {
        throw mapAdminExamDbError(ruleError);
      }
    }
    // 7) ตอบด้วยแถวที่สร้าง (RLS asm_read ให้อ่านกลับเอง) — rules ที่เพิ่ง insert ยังไม่ติด
    //    ในแถวที่ returning คืน จึง reload เพื่อให้ summary ตรงกับที่เพิ่งเขียน
    const assessmentId = createdRow.id;
    const { data: reloaded, error: reloadError } = await supabase
      .from("assessments")
      .select(ADMIN_ASSESSMENT_SELECT)
      .eq("id", assessmentId)
      .maybeSingle();
    if (reloadError !== null || reloaded === null) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "assessment_reload_failed" },
      });
    }
    // zod-ตรวจแถว DB ขาเข้า (F5) ก่อน map + ตรวจ view ขาออก (B4) — drift → 503 ERR-SYS-002
    return jsonCreated(
      parseOutgoingView(
        AdminAssessmentResource,
        toAdminAssessmentResource(parseAdminAssessmentRow(reloaded)),
        "admin_assessment_contract_drift",
      ),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

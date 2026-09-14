/**
 * GET/POST /api/v1/admin/assessments — ชุดข้อสอบ/กติกาสำหรับหลังบ้าน (Wave D · D-3 ·
 * API-SPECIFICATION §3.8 L215-L216)
 *
 * GET — requirePermission("assessment:view") (matrix rbac.ts L90-L253 — instructor/staff:viewer/
 * staff:exam/staff:registrar/super_admin มี permission นี้; ขอบเขตกรองที่ RLS asm_read
 * 0010 L643-L651 ให้เอง) · สรุปกติกาล่าสุดจาก **RPC admin_latest_assessment_rules (0051)**
 * ไม่ใช่ embed ตารางอีกต่อไป — 0050 เปิด column grant selection ให้ authenticated แล้วพบว่า
 * ar_read (0010 L694-L702) ให้ "ผู้เรียนที่ลงทะเรียน active" เห็นแถว assessment_rules ด้วย =
 * ผู้เรียนอ่าน selection ทางตรง PostgREST ได้ (gate GP3 r2 R2-M3) → 0051 revoke คืน + เจ้าหน้าที่
 * อ่านผ่าน RPC ที่คุมบทบาทในตัว (staff:exam/staff:viewer/super_admin + aal2 · "ล่าสุด" =
 * version สูงสุดต่อ assessment — เกณฑ์เดียวกับ max+1 ของ RPC 0049)
 * และ 0052 (gate GP3 r3 R3-M2): audience ของ RPC ขยายเป็น 2 สายแรกของ ar_read จริง — staff เต็ม (viewer/exam/registrar/super_admin) + instructor แบบ row-filter (เจ้าของหลักสูตรเท่านั้น) — instructor POST กลับมาเป็น 201 และ GET ของ instructor/registrar กลับมาเป็น 200 (เดิม 0051 กรอบ instructor จน 503 หลัง INSERT สำเร็จ)
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
  AssessmentRuleRowSchema,
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
 * 0005 L50-L61) ผูก !left กันแถวหายเมื่อ RLS ฝั่ง courses บัง · **ไม่มี assessment_rules
 * embed อีกต่อไป** — กติกาล่าสุด (รวม selection) อ่านผ่าน RPC admin_latest_assessment_rules
 * (0051) ที่คุมบทบาทในตัว แล้ว merge ที่ BFF (ดู latestRulesByAssessment — gate GP3 r2 R2-M3)
 */
const ADMIN_ASSESSMENT_SELECT =
  "id,code,title,description,is_final,status,course_id,created_at," +
  "course:courses!left(id,created_by)";

/** UUID v4 lowercase/uppercase ตรงรูปแบบ z.uuid() ของ query (R3-m1 — ตรวจ id ที่ RPC คืนก่อนเชื่อ) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * กติกา version ล่าสุดต่อ assessment จาก RPC 0051/0052 — คืน map assessment_id → แถวรูป
 * เดียวกับ embed เดิม (คอลัมน์ 14 ตัวตาม AssessmentRuleRow) เพื่อให้ parseAdminAssessmentRow
 * ตรวจ strict ต่อได้เหมือนเดิม · หน้าว่าง (ids เปล่า) = map เปล่า ไม่ยิง RPC
 * · RPC ล้ม/คืนไม่ใช่ array = 503 ERR-SYS-002 fail-closed (ไม่กลืนเป็น "ไม่มีกติกา")
 * · **R3-m1 (gate GP3 r3)**: ตรวจ drift ต่อแถวก่อนเชื่อ — id ต้องเป็น UUID จริง · เป็น id
 * ที่เราขอเท่านั้น (membership) · ไม่ซ้ำต่อ assessment (uniqueness — ซ้ำคือ criteria
 * "ล่าสุด" พัง = แถวที่กลืนกันจะ override กันเงียบ ๆ) · แถวที่โปรเจกต์แล้วต้องผ่าน
 * AssessmentRuleRowSchema strict — ใด ๆ พัง = 503 drift ไม่ปล่อย `rules: null` เงียบ
 */
async function latestRulesByAssessment(
  supabase: Awaited<ReturnType<typeof createSupabaseSsrClient>>,
  assessmentIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (assessmentIds.length === 0) {
    return map;
  }
  const requested = new Set(assessmentIds);
  const drift = (): AppError =>
    new AppError("ERR-SYS-002", {
      details: { reason: "admin_assessments_rules_rpc_drift" },
    });
  const { data, error } = await supabase.rpc("admin_latest_assessment_rules", {
    p_assessment_ids: assessmentIds,
  });
  if (error !== null) {
    throw new AppError("ERR-SYS-002", {
      details: { reason: "admin_assessments_rules_rpc_failed" },
    });
  }
  if (!Array.isArray(data)) {
    throw drift();
  }
  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      throw drift();
    }
    const record = row as Record<string, unknown>;
    const id = record["assessment_id"];
    if (
      typeof id !== "string" ||
      !UUID_PATTERN.test(id) ||
      !requested.has(id) ||
      map.has(id)
    ) {
      throw drift();
    }
    // โปรเจกต์เฉพาะคอลัมน์ของ embed เดิม — คีย์อื่น (เช่น assessment_id ของ RPC) ห้าม
    // ไหลเข้า AssessmentRuleRowSchema ที่ strict
    const projected: Record<string, unknown> = {
      version: record["version"],
      pass_pct: record["pass_pct"],
      time_limit_minutes: record["time_limit_minutes"],
      question_count: record["question_count"],
      max_attempts: record["max_attempts"],
      attempt_cooldown_minutes: record["attempt_cooldown_minutes"],
      shuffle_questions: record["shuffle_questions"],
      shuffle_options: record["shuffle_options"],
      require_course_complete: record["require_course_complete"],
      selection: record["selection"],
      proctoring_mode: record["proctoring_mode"],
      exam_review_mode: record["exam_review_mode"],
      effective_from: record["effective_from"],
    };
    if (!AssessmentRuleRowSchema.safeParse(projected).success) {
      throw drift();
    }
    map.set(id, projected);
  }
  return map;
}

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

/** insert ของ assessment_rules — คอลัมน์ตรง 0005 L66-L82 + exam_review_mode (0049) (version/effective_from ให้ DB default ได้) */
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
    exam_review_mode: rules.examReviewMode,
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
      .limit(query.limit + 1);
    if (query.status !== undefined) {
      builder = builder.eq("status", query.status);
    }
    if (query.courseId !== undefined) {
      builder = builder.eq("course_id", query.courseId);
    }
    // R3-M1 read-back: โมดัลกติกาขอแถวเดียวด้วย id (cache:"no-store") เพื่อตัดสินผล
    // ที่ค้าง "ไม่แน่นอน" — แถวที่ไม่มี/ไม่เข้าถึง = หน้าว่าง data:[] (เหมือน list ปกติ)
    if (query.id !== undefined) {
      builder = builder.eq("id", query.id);
    }
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "admin_assessments_query_failed" } });
    }
    // r8-N1: success แต่ data ไม่ใช่ array = drift (ไม่ใช่ `?? []` กลืนเป็นหน้าว่าง) —
    // แต่ละแถว strict ต่อ AdminAssessmentRowSchema อยู่แล้วที่ parseAdminAssessmentRow
    if (!Array.isArray(data)) {
      throw new AppError("ERR-SYS-002", { details: { reason: "admin_assessments_rows_not_array" } });
    }
    // กติกาล่าสุดจาก RPC 0051 (คุมบทบาทในตัว — ไม่ใช่ embed ตารางอีกต่อไป) แล้ว merge
    // เป็นรูป embed เดิมก่อน parse — AssessmentRuleRowSchema strict ตรวจทุกคอลัมน์เหมือนเดิม
    const latestRules = await latestRulesByAssessment(
      supabase,
      data.map((row) => {
        if (typeof row !== "object" || row === null || typeof (row as Record<string, unknown>)["id"] !== "string") {
          throw new AppError("ERR-SYS-002", { details: { reason: "admin_assessments_rows_not_array" } });
        }
        return (row as Record<string, unknown>)["id"] as string;
      }),
    );
    const rows = data.map((row) => {
      const record = row as unknown as Record<string, unknown>;
      const embedded = latestRules.get(record["id"] as string);
      return parseAdminAssessmentRow({
        ...record,
        assessment_rules: embedded === undefined ? [] : [embedded],
      });
    });
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
    // insert/reload ด้วย id ที่ไม่ผ่าน validation · select ไม่มี embed อีกแล้ว (0051)
    // จึงแนบ assessment_rules เปล่าให้ strict schema ก่อน parse
    const createdRecord = created as unknown as Record<string, unknown>;
    const createdRow = parseAdminAssessmentRow({
      ...createdRecord,
      assessment_rules: [],
    });
    // 6) insert กติกา v1 (เฉพาะเมื่อแนบ rules มา — staff:exam/super_admin เท่านั้น ข้อ 4)
    if (body.rules !== undefined) {
      const { error: ruleError } = await supabase
        .from("assessment_rules")
        .insert(ruleInsertPayloadOf(createdRow.id, body.rules));
      if (ruleError !== null) {
        throw mapAdminExamDbError(ruleError);
      }
    }
    // 7) ตอบด้วยแถวที่สร้าง (RLS asm_read ให้อ่านกลับเอง) — rules ที่เพิ่ง insert ไม่ติด
    //    ในแถวที่ reload คืน (select ไม่มี embed อีกแล้ว) จึงดึงกติกาล่าสุดจาก RPC 0051
    //    แล้ว merge เป็นรูป embed เดิมก่อน parse
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
    const reloadedRules = await latestRulesByAssessment(supabase, [assessmentId]);
    const reloadedRecord = reloaded as unknown as Record<string, unknown>;
    const reloadedEmbedded = reloadedRules.get(assessmentId);
    // zod-ตรวจแถว DB ขาเข้า (F5) ก่อน map + ตรวจ view ขาออก (B4) — drift → 503 ERR-SYS-002
    return jsonCreated(
      parseOutgoingView(
        AdminAssessmentResource,
        toAdminAssessmentResource(
          parseAdminAssessmentRow({
            ...reloadedRecord,
            assessment_rules: reloadedEmbedded === undefined ? [] : [reloadedEmbedded],
          }),
        ),
        "admin_assessment_contract_drift",
      ),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

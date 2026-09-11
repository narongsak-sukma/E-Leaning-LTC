/**
 * GET/POST /api/v1/admin/question-banks — ธนาคารข้อสอบสำหรับหลังบ้าน (Wave D · D-3 ·
 * API-SPECIFICATION §3.8 L212-L213)
 *
 * GET — requirePermission("question_bank:view") (rbac.ts L90-L253: instructor เจ้าของ/
 * staff:viewer/staff:exam/super_admin; ขอบเขตกรองที่ RLS qb_read 0010 L539-L542 ให้เอง) +
 * จำนวนข้อต่อ bank นับที่ DB (embed `questions(count)` — PostgREST aggregation; RLS q_read
 * 0010 L559-L563 กรองข้อตามบทบาทให้เอง)
 *
 * POST — requirePermission("question_bank:create") (instructor/staff:exam/super_admin):
 * - created_by = ผู้ใช้ปัจจุบันเสมอ — RLS qb_insert (0010 L543-L546) บังคับ instructor ต้องเป็น
 *   เจ้าของ (created_by = auth.uid()); staff:exam/sa สร้างได้อิสระ
 * - ข้อสอบเริ่มต้น "ถ้ากำหนด" — questions.status ตายตัว 'draft' (เปิดใช้ = สิทธิ์ staff:exam/sa —
 *   guard_question_activation 0010 L587-L608; BFF ไม่รับ status จาก body)
 * - options รับ is_correct ได้ (request ฝั่งผู้แต่ง — DD §3.4) แต่ห้ามปรากฏใน response ทุกกรณี
 *
 * ข้อจำกัดที่ยอมรับ: bank + ข้อ + ตัวเลือก = PostgREST หลาย request (ไม่มี transaction ครอบ
 * หลายตาราง) — ล้มกลางทางอาจได้ bank/ข้อบางส่วน (ธงให้ lead ทราบ)
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
import { requirePermission } from "@/lib/rbac";
import {
  mapAdminExamDbError,
  parseAdminExam,
  parseQuestionBankRow,
  parseQuestionCreatedRow,
  QuestionBankCreateBody,
  type QuestionBankCreateBodyParsed,
  QuestionBankCreateResult,
  QuestionBankResource,
  type QuestionCreatedRefParsed,
  type QuestionCreateInputParsed,
  type QuestionOptionInputParsed,
  toQuestionBankResource,
} from "@/lib/schemas/v1/admin-exam";
import { parsePageQuery } from "@/lib/schemas/v1/common";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select ของ GET — embed นับจำนวนข้อ (PostgREST aggregation) ไม่มี options/is_correct */
const BANK_LIST_SELECT =
  "id,code,name,description,course_id,category_id,is_active,created_at,questions(count)";

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** or-filter เลื่อน cursor แบบ row-wise (created_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  const sortKey = payload.sortKey.replace(/[,()]/g, " "); // ตัดอักขระ PostgREST or-syntax
  return `created_at.lt.${sortKey},and(created_at.eq.${sortKey},id.lt.${payload.id})`;
}

/** GET — รายการ bank (RLS กรองตามบทบาท) เรียง created_at ล่าสุดก่อน + cursor + จำนวนข้อ */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — ไม่มี question_bank:view → 403 ERR-RBAC-001
    const { userId } = await requirePermission("question_bank:view");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query กลาง (limit default 20 max 100 — strict)
    const url = new URL(request.url);
    const query = parsePageQuery(url.searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const supabase = await createSupabaseSsrClient();
    let builder = supabase
      .from("question_banks")
      .select(BANK_LIST_SELECT)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit + 1);
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "admin_question_banks_query_failed" },
      });
    }
    // r4-H2a: ตรวจแถว DB ขาเข้าก่อน map (drift → ERR-SYS-002 503) + ขาออกผ่าน zod อีกชั้น
    // (parseOutgoingView — drift ของ mapper เองก็ 503 ไม่ใช่ 200 ที่ payload เพี้ยน)
    // r8-N1: success แต่ data ไม่ใช่ array = drift (ไม่ใช่ `?? []` กลืนเป็นหน้าว่าง) —
    // แต่ละแถว strict ต่อ QuestionBankRowSchema อยู่แล้วที่ parseQuestionBankRow
    if (!Array.isArray(data)) {
      throw new AppError("ERR-SYS-002", { details: { reason: "question_banks_rows_not_array" } });
    }
    const rows = data.map(parseQuestionBankRow);
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => row.created_at,
      idOf: (row) => row.id,
    });
    return jsonPageOk(
      {
        data: page.data.map((row) =>
          parseOutgoingView(QuestionBankResource, toQuestionBankResource(row), "question_bank_resource_drift"),
        ),
        page: page.page,
      },
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}


/** โครง insert ของ question_banks — created_by = ผู้ใช้ปัจจุบัน (RLS qb_insert — ดูหัวไฟล์) */
function bankInsertPayloadOf(
  body: Pick<
    QuestionBankCreateBodyParsed,
    "code" | "name" | "courseId" | "categoryId" | "description" | "isActive"
  >,
  userId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    code: body.code,
    name: body.name,
    created_by: userId,
  };
  if (body.courseId !== undefined) payload["course_id"] = body.courseId;
  if (body.categoryId !== undefined) payload["category_id"] = body.categoryId;
  if (body.description !== undefined) payload["description"] = body.description;
  if (body.isActive !== undefined) payload["is_active"] = body.isActive;
  return payload;
}

/** insert ของ questions — status ตายตัว 'draft' (เปิดใช้ = สิทธิ์ staff:exam — ดูหัวไฟล์) */
function questionInsertPayloadOf(
  bankId: string,
  input: QuestionCreateInputParsed,
  userId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    bank_id: bankId,
    type: input.type,
    difficulty: input.difficulty,
    question_text: input.questionText,
    points: input.points,
    tags: input.tags,
    status: "draft",
    created_by: userId,
  };
  if (input.explanation !== undefined) payload["explanation"] = input.explanation;
  return payload;
}

/** insert ของ question_options — is_correct รับจากผู้แต่ง (request) ไม่เคยอยู่ใน response */
function optionInsertRowsOf(
  questionId: string,
  options: readonly QuestionOptionInputParsed[],
): Record<string, unknown>[] {
  return options.map((option) => ({
    question_id: questionId,
    option_text: option.optionText,
    is_correct: option.isCorrect,
    sort_order: option.sortOrder,
  }));
}

/** POST — สร้าง bank + ข้อสอบเริ่มต้น (ถ้ากำหนด) → 201 */
export async function POST(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — instructor/staff:exam/super_admin (question_bank:create)
    const { userId } = await requirePermission("question_bank:create");
    // 2) rate STAFF_WRITE
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) body (strict — ไม่รับ status ของข้อสอบ; ผิดรูป → ERR-VAL-001 400)
    const body = parseAdminExam(QuestionBankCreateBody, await request.json());
    const supabase = await createSupabaseSsrClient();
    // 4) insert bank (instructor สร้างแทนคนอื่น → RLS qb_insert 42501 → ERR-RBAC-001 403)
    const { data: bankRow, error: bankError } = await supabase
      .from("question_banks")
      .insert(bankInsertPayloadOf(body, userId))
      .select(BANK_LIST_SELECT)
      .single();
    if (bankError !== null) {
      throw mapAdminExamDbError(bankError);
    }
    // r4-H2a: null/รูปไม่ตรง contract ขาเข้า = ERR-SYS-002 503 (เดิม cast ตรง + ERR-SYS-001)
    const bank = parseQuestionBankRow(bankRow);
    // 5) ข้อสอบเริ่มต้น (ถ้ากำหนด) — insert ข้อ + ตัวเลือกทีละข้อ (มี id กลับมาเพื่อผูก options)
    const createdQuestions: QuestionCreatedRefParsed[] = [];
    if (body.questions !== undefined) {
      for (const input of body.questions) {
        const { data: questionRow, error: questionError } = await supabase
          .from("questions")
          .insert(questionInsertPayloadOf(bank.id, input, userId))
          .select("id,type,question_text,points")
          .single();
        if (questionError !== null) {
          throw mapAdminExamDbError(questionError);
        }
        // r4-H2a: ตรวจแถวข้อใหม่ก่อนหยิบ id ไปผูก options (drift → 503 ไม่ insert option ให้ข้อหลอก)
        const created = parseQuestionCreatedRow(questionRow);
        const { error: optionsError } = await supabase
          .from("question_options")
          .insert(optionInsertRowsOf(created.id, input.options));
        if (optionsError !== null) {
          throw mapAdminExamDbError(optionsError);
        }
        createdQuestions.push({
          id: created.id,
          type: created.type as QuestionCreatedRefParsed["type"],
          questionText: created.question_text,
          points: created.points,
        });
      }
    }
    // 6) 201 — resource ผ่าน zod contract ก่อนตอบ (ไม่มี is_correct ทุกฟิลด์; drift → 503 ไม่ใช่ 500)
    return jsonCreated(
      parseOutgoingView(
        QuestionBankCreateResult,
        {
          ...toQuestionBankResource(bank),
          // r11-Q1: นับจากข้อที่สร้างจริงรอบนี้ — aggregate ตอน insert bank ยังเป็น 0 เสมอ
          questionCount: createdQuestions.length,
          questions: createdQuestions,
        },
        "question_bank_create_drift",
      ),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

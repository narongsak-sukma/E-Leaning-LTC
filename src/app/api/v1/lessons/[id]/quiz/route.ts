/**
 * GET /api/v1/lessons/{id}/quiz — อ่านโจทย์แบบทดสอบย่อยก่อนทำ (DCR-5 · API-SPEC 1.0.2 §3.4)
 *
 * - {id} = lesson id ชนิด quiz — response คืนเฉพาะโจทย์+ตัวเลือก (id/text/sortOrder) —
 *   **ห้ามมี is_correct/explanation ทุกชั้น** (ตาราง quiz_questions/quiz_options มีคอลัมน์เฉลย —
 *   DD §3.3 ไม่มี RLS SELECT ให้ผู้เรียน จึงอ่านผ่าน service path แล้วตัดคอลัมน์เฉลยที่ต้นทางด้วย
 *   select เฉพาะคอลัมน์โจทย์; grading = RPC record_quiz_attempt ฝั่ง server ล้วน)
 * - ต้อง login + lesson:view (requirePermission — ไม่ login → AUTH-001 · staff ยังไม่ MFA → AUTH-004
 *   · ไม่มี permission → RBAC-001)
 * - enrollment ตรวจที่ handler (lessons_read ให้บทเรียน is_preview ผ่านได้แม้ไม่ลงทะเบียน —
 *   service path ข้าม RLS จึงตรวจ enrollment เอง): ไม่มี → LRN-001
 * - ไม่พบ lesson/quiz (ไม่ใช่บท quiz / quiz ไม่ active / ไม่มีโจทย์ active) → CRS-001 (404)
 * - rate = READ (default ของ resolver สำหรับ GET /lessons/* — pattern เดียวกับ GET progress:
 *   เรียก enforceRateLimit เองใน handler, key user_id + ip — D12-11)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { parseLessonIdParams } from "@/lib/schemas/v1/progress";

function jsonOptions(requestId: string | null): JsonResponseOptions {
  return requestId === null ? {} : { requestId };
}

/** แถวดิบจาก Supabase (untyped client — ตรวจชนิดเองก่อนใช้) */
type Row = Record<string, unknown>;

// ─── ขาออก (DCR-5 — โจทย์+ตัวเลือกเท่านั้น; ไม่มี is_correct/explanation ใน schema เลย) ───
const QuizOptionView = z.object({
  id: z.string().uuid(),
  text: z.string(),
  sortOrder: z.number().int(),
});

const QuizQuestionView = z.object({
  id: z.string().uuid(),
  text: z.string(),
  type: z.enum(["single_choice", "multiple_choice", "true_false"]),
  points: z.number().int().min(1),
  options: z.array(QuizOptionView),
});

const QuizView = z.object({
  title: z.string(),
  passPct: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).nullable(),
  shuffleQuestions: z.boolean(),
  questions: z.array(QuizQuestionView),
});

/** สุ่มลำดับข้อ (Fisher-Yates) เมื่อ shuffle_questions=true — ตัดสินคำตอบด้วย id ที่ submit จึงไม่กระทบ */
function shuffledQuestions(questions: Row[]): Row[] {
  const out = [...questions];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) {
      continue; // index อยู่ในช่วงเสมอ — กัน noUncheckedIndexedAccess
    }
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id");
  try {
    // 1) session + permission (ไม่ login → 401 AUTH-001 · staff ยังไม่ MFA → 403 AUTH-004)
    const { userId } = await requirePermission("lesson:view");
    // 2) rate READ (default ของ resolver สำหรับ GET /lessons/* — pattern เดียวกับ GET progress)
    enforceRateLimit(request, { secondaryKey: userId });
    // 3) path param — ผิดรูปแบบ = ข้อมูลส่งมาไม่ถูกต้อง (ERR-VAL-001 400)
    const { id: lessonId } = parseLessonIdParams({ id: (await context.params).id });
    const supabase = await createSupabaseSsrClient();

    // 4) บทเรียนที่ RLS ให้เห็น (lessons_read) + หา course_id เพื่อตรวจ enrollment ต่อ
    const { data: lessonData, error: lessonError } = await supabase
      .from("lessons")
      .select("id, quiz_id, type, course_modules(course_id)")
      .eq("id", lessonId)
      .is("deleted_at", null) // gate r2: lessons_read ไม่กรอง soft-delete — บทเรียนที่ลบแล้วต้องเหมือนไม่มีจริงก่อนเข้า service path
      .maybeSingle();
    if (lessonError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lessons_read_failed" } });
    }
    const lessonRow = (lessonData ?? null) as Row | null;
    if (lessonRow === null) {
      // มองบทเรียนไม่เห็น = ไม่ลงทะเบียน/ไม่มีจริง — ตอบเหมือนกันทุกกรณี (§3.4 LRN-001)
      throw new AppError("ERR-LRN-001");
    }
    const embed: unknown = lessonRow["course_modules"];
    const embedRow = Array.isArray(embed) ? (embed[0] as Row | undefined) : (embed as Row | null);
    const courseId = typeof embedRow?.["course_id"] === "string" ? embedRow["course_id"] : null;
    const quizId = typeof lessonRow["quiz_id"] === "string" ? lessonRow["quiz_id"] : null;
    if (courseId === null) {
      throw new AppError("ERR-LRN-001"); // โครงสร้างขาด (เช่น soft-delete) — เหมือนไม่มีจริง
    }
    if (lessonRow["type"] !== "quiz" || quizId === null) {
      // บทเรียนที่เห็นไม่ใช่บท quiz = ไม่มีข้อสอบย่อยให้อ่าน → CRS-001 (404 ตามตาราง §3.4)
      throw new AppError("ERR-CRS-001");
    }

    // 5) enrollment active ของตัวเอง (บทเรียน preview ก็ต้องลงทะเบียนก่อนทำ quiz)
    const { data: enrollmentData, error: enrollmentError } = await supabase
      .from("enrollments")
      .select("id")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
    if (enrollmentError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "enrollments_read_failed" } });
    }
    if (enrollmentData === null) {
      // ไม่มี enrollment active (ไม่ลงทะเบียน/หมดอายุ/ยกเลิก) → §3.4 LRN-001
      throw new AppError("ERR-LRN-001");
    }

    // 6) อ่านข้อสอบผ่าน service path (DCR-5): quiz_questions/quiz_options ไม่มี RLS SELECT
    //    ให้ผู้เรียน (DD §3.3 — ตารางมีคอลัมน์เฉลย) — เหตุผลที่ใช้ service-role: ผู้เรียนต้องอ่าน
    //    โจทย์ผ่าน BFF เท่านั้น; scope แคบ: quiz_id ของบทเรียนที่ตัวเองลงทะเบียนแล้ว + is_active
    //    + เลือกเฉพาะคอลัมน์โจทย์ (ไม่มี explanation/is_correct ใน select ตั้งแต่ต้นทาง)
    const service = createSupabaseServiceRoleClient();
    const { data: quizData, error: quizError } = await service
      .from("lesson_quizzes")
      .select("title, pass_pct, max_attempts, shuffle_questions, status")
      .eq("id", quizId)
      .maybeSingle();
    if (quizError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lesson_quizzes_read_failed" } });
    }
    const quizRow = (quizData ?? null) as Row | null;
    if (quizRow === null || quizRow["status"] !== "active") {
      // ไม่พบ quiz / ยัง draft / archived → CRS-001 (ตาราง §3.4 ของ endpoint นี้)
      throw new AppError("ERR-CRS-001");
    }

    // 7) โจทย์ active เรียง sort_order — คอลัมน์โจทย์เท่านั้น (ไม่มี explanation)
    const { data: questionData, error: questionError } = await service
      .from("quiz_questions")
      .select("id, question_text, type, points, sort_order")
      .eq("quiz_id", quizId)
      .eq("is_active", true)
      .order("sort_order");
    if (questionError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "quiz_questions_read_failed" } });
    }
    const questionRows = (Array.isArray(questionData) ? questionData : []) as Row[];
    if (questionRows.length === 0) {
      throw new AppError("ERR-CRS-001"); // quiz ไม่มีโจทย์ active = ไม่มีข้อสอบให้อ่าน
    }

    // 8) ตัวเลือกของทุกข้อ — คอลัมน์โจทย์เท่านั้น (ไม่มี is_correct)
    const questionIds = questionRows.map((row) => String(row["id"]));
    const { data: optionData, error: optionError } = await service
      .from("quiz_options")
      .select("id, question_id, option_text, sort_order")
      .in("question_id", questionIds)
      .order("sort_order");
    if (optionError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "quiz_options_read_failed" } });
    }
    const optionRows = (Array.isArray(optionData) ? optionData : []) as Row[];
    const optionsByQuestion = new Map<string, Row[]>();
    for (const row of optionRows) {
      const questionId = row["question_id"];
      if (typeof questionId !== "string") {
        continue;
      }
      const existing = optionsByQuestion.get(questionId);
      if (existing === undefined) {
        optionsByQuestion.set(questionId, [row]);
      } else {
        existing.push(row);
      }
    }

    // 9) ประกอบขาออก (camelCase) — shuffle ฝั่ง server เฉพาะเมื่อ quiz สั่ง · zod ตรวจก่อนส่ง (§1-4)
    const shouldShuffle = quizRow["shuffle_questions"] === true;
    const view = {
      title: String(quizRow["title"]),
      passPct: Number(quizRow["pass_pct"]),
      maxAttempts: typeof quizRow["max_attempts"] === "number" ? quizRow["max_attempts"] : null,
      shuffleQuestions: shouldShuffle,
      questions: (shouldShuffle ? shuffledQuestions(questionRows) : questionRows).map((row) => {
        const id = String(row["id"]);
        const options = optionsByQuestion.get(id) ?? [];
        return {
          id,
          text: String(row["question_text"]),
          type: String(row["type"]),
          points: Number(row["points"] ?? 1),
          options: options.map((option) => ({
            id: String(option["id"]),
            text: String(option["option_text"]),
            sortOrder: Number(option["sort_order"] ?? 0),
          })),
        };
      }),
    };
    const parsed = QuizView.safeParse(view);
    if (!parsed.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "quiz_read_bad_contract" } });
    }
    return jsonOk(parsed.data, jsonOptions(requestId));
  } catch (err: unknown) {
    return jsonErrorResponse(err, jsonOptions(requestId));
  }
}
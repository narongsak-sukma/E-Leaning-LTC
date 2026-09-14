/**
 * GET /api/v1/courses/{id}/progress — สรุปความคืบหน้าของตัวเองในหลักสูตร (API-SPECIFICATION §3.4)
 *
 * - ต้อง login — requirePermission("lesson:view"): ไม่มี session → ERR-AUTH-001 (401),
 *   ไม่มี permission → ERR-RBAC-001 (403) (RBAC §1.2-4 — ตรวจระดับ permission ไม่ใช่ชื่อบทบาท)
 * - อ่านเฉพาะของตัวเอง — RLS enrollments_owner_read / lp_owner_read (0010_security.sql) + BFF
 *   กรอง user_id ซ้ำอีกชั้น (defense in depth)
 * - ไม่มี enrollment ของตัวเองในหลักสูตรนี้ → ERR-LRN-001 (403) ตามตาราง §3.4
 * - rate: PUBLIC_READ ตามตาราง §5 (GET /courses/*) — เรียก enforceRateLimit เองใน handler;
 *   ส่ง secondaryKey = user_id (ใช้ผลจริงเมื่อกลุ่มของ path นี้เปลี่ยนเป็น READ)
 * - อ่านอย่างเดียว — ไม่มีการเขียน lesson_progress ที่นี่ (F2/D12-1: เขียนผ่าน
 *   record_lesson_progress SECURITY DEFINER เท่านั้น)
 * - ส่ง video_max_position_sec ต่อบทเรียนออกเสมอ (D85/LRN-009 — ตำแหน่งสูงสุดที่เคย
 *   บันทึก, วินาที): แถวไหนไม่มีค่า/ไม่มีแถวความคืบหน้า = null (แถว legacy ก่อนมีคอลัมน์)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { CourseProgressView, parseCourseProgressParams } from "@/lib/schemas/v1/progress";

/** requestId เป็น string | null จาก header — exactOptionalPropertyTypes ต้องยอมรับเฉพาะค่าที่มีจริง */
function jsonOptions(requestId: string | null): JsonResponseOptions {
  return requestId === null ? {} : { requestId };
}

/** สัดส่วน 0-100 ปัดเศษ — สูตรเดียวกับ v_enrollment_progress (0009_views.sql) */
function pct(completed: number, total: number): number {
  return total === 0 ? 0 : Math.round((100 * completed) / total);
}

/** แถวดิบจาก Supabase (untyped client — ตรวจชนิดเองก่อนใช้) */
type Row = Record<string, unknown>;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id");
  try {
    const { userId } = await requirePermission("lesson:view");
    enforceRateLimit(request, { secondaryKey: userId });
    const { id } = await context.params;
    const { courseId } = parseCourseProgressParams({ courseId: id });
    const supabase = await createSupabaseSsrClient();

    // 1) enrollment ของตัวเองในหลักสูตรนี้ (แถวเดียว — UNIQUE(user_id, course_id))
    const { data: enrollment, error: enrollmentError } = await supabase
      .from("enrollments")
      .select("id, status, enrolled_at")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (enrollmentError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "enrollments_read_failed" } });
    }
    if (enrollment === null) {
      throw new AppError("ERR-LRN-001");
    }

    // 2) โมดูล/บทเรียนที่ RLS ให้เห็น (lessons_read ต้องการ enrollment active ยกเว้น preview)
    const { data: modules, error: modulesError } = await supabase
      .from("course_modules")
      .select("id, title_th, sort_order")
      .eq("course_id", courseId)
      .is("deleted_at", null)
      .order("sort_order");
    if (modulesError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "modules_read_failed" } });
    }
    const moduleList: Row[] = Array.isArray(modules) ? modules : [];
    const moduleIds = moduleList.map((m) => String(m["id"]));

    const lessonList: Row[] = [];
    if (moduleIds.length > 0) {
      const { data: lessons, error: lessonsError } = await supabase
        .from("lessons")
        .select("id, module_id, type, sort_order")
        .in("module_id", moduleIds)
        .is("deleted_at", null)
        .order("sort_order");
      if (lessonsError) {
        throw new AppError("ERR-SYS-002", { details: { reason: "lessons_read_failed" } });
      }
      if (Array.isArray(lessons)) {
        lessonList.push(...lessons);
      }
    }

    // 3) แถวความคืบหน้าของ enrollment ตัวเอง (lp_owner_read — เห็นเฉพาะของตัวเอง)
    const { data: progressRows, error: progressError } = await supabase
      .from("lesson_progress")
      .select("lesson_id, status, watch_pct, video_max_position_sec, quiz_score_pct, completed_at")
      .eq("enrollment_id", String(enrollment["id"]));
    if (progressError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lesson_progress_read_failed" } });
    }
    const progressByLesson = new Map<string, Row>();
    for (const row of Array.isArray(progressRows) ? progressRows : []) {
      if (typeof row?.["lesson_id"] === "string") {
        progressByLesson.set(row["lesson_id"] as string, row);
      }
    }

    // 4) ประกอบ summary — นับเฉพาะบทเรียนที่เห็นได้จริง (ความคืบหน้าของบทที่ RLS ซ่อนไม่นับ)
    const modulesView = moduleList.map((m) => {
      const lessons = lessonList
        .filter((l) => l["module_id"] === m["id"])
        .map((l) => {
          const lessonId = String(l["id"]);
          const p = progressByLesson.get(lessonId);
          return {
            lessonId,
            lessonType: String(l["type"]),
            status: typeof p?.["status"] === "string" ? p["status"] : "not_started",
            watchPct: typeof p?.["watch_pct"] === "number" ? p["watch_pct"] : 0,
            videoMaxPositionSec:
              typeof p?.["video_max_position_sec"] === "number" ? p["video_max_position_sec"] : null,
            quizScorePct: typeof p?.["quiz_score_pct"] === "number" ? p["quiz_score_pct"] : null,
            completedAt: typeof p?.["completed_at"] === "string" ? p["completed_at"] : null,
          };
        });
      const completed = lessons.filter((l) => l["status"] === "completed").length;
      return {
        moduleId: String(m["id"]),
        title: String(m["title_th"] ?? ""),
        sortOrder: Number(m["sort_order"] ?? 0),
        lessonTotal: lessons.length,
        lessonCompleted: completed,
        progressPct: pct(completed, lessons.length),
        lessons,
      };
    });
    const lessonTotal = modulesView.reduce((sum, m) => sum + m.lessonTotal, 0);
    const lessonCompleted = modulesView.reduce((sum, m) => sum + m.lessonCompleted, 0);

    const view = {
      courseId,
      enrollmentId: String(enrollment["id"]),
      enrollmentStatus: String(enrollment["status"]),
      lessonTotal,
      lessonCompleted,
      progressPct: pct(lessonCompleted, lessonTotal),
      modules: modulesView,
    };
    const parsed = CourseProgressView.safeParse(view);
    if (!parsed.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "course_progress_bad_contract" } });
    }
    return jsonOk(parsed.data, jsonOptions(requestId));
  } catch (err: unknown) {
    return jsonErrorResponse(err, jsonOptions(requestId));
  }
}

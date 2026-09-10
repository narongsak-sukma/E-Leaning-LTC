/**
 * POST /api/v1/lessons/{id}/progress — บันทึกความคืบหน้าบทเรียน (API-SPECIFICATION §3.4 + §4 #5)
 *
 * กติกา O-2 (D25) — client ส่ง positionSeconds เป็นค่าสัมบูรณ์ แต่ RPC record_lesson_progress
 * รับ delta: BFF อ่านแถว lesson_progress เดิมของตัวเองก่อน (SELECT ผ่าน SSR client — RLS
 * lp_owner_read) แล้วคำนวณ p_watch_sec_delta = max(0, positionSeconds − video_max_position_sec
 * เดิม) ฝั่ง server เสมอ (แถวยังไม่มี = heartbeat แรก → delta เต็มจาก position; position ไม่เพิ่ม
 * → delta 0 — ห้ามติดลบ)
 *
 * - วิดีโอ (positionSeconds): p_video_max_position_sec = positionSeconds + watch delta, dwell = 0
 * - เอกสาร (documentRead — attestation D12-12): position = null + ส่ง dwell เท่านั้น — dwell delta
 *   คำนวณจากเวลาจริงนับแต่ heartbeat ก่อน (telemetry ฝั่ง server — D14-F9) ตัดที่ 900 วิ/ครั้ง
 *   ตาม clamp ต่อ call ของ RPC (0011_functions.sql)
 * - XOR ตาม schema §4 #5 — ทั้งคู่หรือไม่มีเลย → ERR-VAL-001 (400)
 * - ห้ามรับ/เชื่อ field `completed` จาก client (D12-12) — สถานะจบบทตัดสินใน RPC เท่านั้น
 * - เขียนผ่าน RPC SECURITY DEFINER เท่านั้น (F2/D12-1) — ไม่มี INSERT/UPDATE ตรงที่นี่
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
  LessonProgressView,
  parseLessonIdParams,
  parseLessonProgressBody,
} from "@/lib/schemas/v1/progress";

/** เพดาน delta ต่อ call ของ RPC (0011_functions.sql — clamp 900 วิ) — BFF ตัดเองก่อนส่งด้วย */
const RPC_DELTA_CAP_SEC = 900;

function jsonOptions(requestId: string | null): JsonResponseOptions {
  return requestId === null ? {} : { requestId };
}

/** แถวดิบจาก Supabase (untyped client — ตรวจชนิดเองก่อนใช้) */
type Row = Record<string, unknown>;

/** dwell delta จากเวลาจริงนับแต่ heartbeat ก่อน (updated_at ของแถวเดิม) — ตัดที่เพดาน RPC */
function dwellDeltaSec(priorUpdatedAt: unknown): number {
  if (typeof priorUpdatedAt !== "string") {
    return 0; // heartbeat แรก — ไม่มีตัวตั้งเวลาจริงให้อ้าง
  }
  const elapsed = (Date.now() - new Date(priorUpdatedAt).getTime()) / 1000;
  if (!Number.isFinite(elapsed)) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(elapsed), 0), RPC_DELTA_CAP_SEC);
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
    const { id } = await context.params;
    const { id: lessonId } = parseLessonIdParams({ id });
    const body = parseLessonProgressBody(await readJsonBody(request));
    const supabase = await createSupabaseSsrClient();

    // 1) บทเรียนที่ RLS ให้เห็น → หลักสูตร (lessons_read ต้องการ enrollment ของตัวเอง)
    const { data: lessonRow, error: lessonError } = await supabase
      .from("lessons")
      .select("id, type, course_modules(course_id)")
      .eq("id", lessonId)
      .maybeSingle();
    if (lessonError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lessons_read_failed" } });
    }
    const embed: unknown = lessonRow?.["course_modules"];
    const embedRow = Array.isArray(embed) ? (embed[0] as Row | undefined) : (embed as Row | null);
    const courseId = typeof embedRow?.["course_id"] === "string" ? embedRow["course_id"] : null;
    if (lessonRow === null || typeof courseId !== "string") {
      // มองบทเรียนไม่เห็น = ไม่ลงทะเบียน/ไม่มีจริง — ตอบเหมือนกันทุกกรณี (§3.4 LRN-001)
      throw new AppError("ERR-LRN-001");
    }
    const lessonType = String(lessonRow["type"]);

    // 2) ชนิดบทเรียนต้องตรงกับช่องทางที่ client ส่ง (video ↔ positionSeconds, document ↔ documentRead)
    if (body.positionSeconds !== undefined && lessonType !== "video") {
      throw new AppError("ERR-VAL-001", {
        details: { fields: ["positionSeconds"], rule: "lesson_type_mismatch" },
      });
    }
    if (body.documentRead !== undefined && lessonType !== "document") {
      throw new AppError("ERR-VAL-001", {
        details: { fields: ["documentRead"], rule: "lesson_type_mismatch" },
      });
    }
    if (lessonType === "quiz") {
      // บท quiz จบด้วย record_quiz_attempt เท่านั้น — heartbeat ไม่มีผลกับบทชนิดนี้
      throw new AppError("ERR-VAL-001", {
        details: { fields: ["lessonId"], rule: "quiz_progress_not_allowed" },
      });
    }

    // 3) enrollment active ของตัวเองในหลักสูตรของบทเรียนนี้ (หมดอายุ/ยกเลิก = ไม่พบ)
    const { data: enrollmentRow, error: enrollmentError } = await supabase
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
    if (enrollmentRow === null) {
      throw new AppError("ERR-LRN-001");
    }

    // 4) O-2: อ่านแถวเดิมเพื่อคำนวณ delta ฝั่ง server (RLS lp_owner_read — แถวตัวเองเท่านั้น)
    const { data: prior, error: priorError } = await supabase
      .from("lesson_progress")
      .select("video_max_position_sec, updated_at")
      .eq("enrollment_id", String(enrollmentRow["id"]))
      .eq("lesson_id", lessonId)
      .maybeSingle();
    if (priorError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lesson_progress_read_failed" } });
    }

    // 5) คำนวณ delta ฝั่ง server แล้วเรียก RPC SECURITY DEFINER (F2/D12-1)
    let rpcArgs: {
      p_enrollment_id: string;
      p_lesson_id: string;
      p_video_max_position_sec: number | null;
      p_watch_sec_delta: number;
      p_dwell_sec_delta: number;
    };
    if (body.positionSeconds !== undefined) {
      // วิดีโอ — delta = max(0, position ใหม่ − position สูงสุดเดิม) (O-2; ไม่มีทางติดลบ)
      const priorMax =
        typeof prior?.["video_max_position_sec"] === "number"
          ? prior["video_max_position_sec"]
          : 0;
      const watchDelta = Math.max(0, body.positionSeconds - (priorMax as number));
      rpcArgs = {
        p_enrollment_id: String(enrollmentRow["id"]),
        p_lesson_id: lessonId,
        p_video_max_position_sec: body.positionSeconds,
        p_watch_sec_delta: watchDelta,
        p_dwell_sec_delta: 0,
      };
    } else {
      // เอกสาร — position เป็น null + dwell เท่านั้น (D12-12 attestation + D14-F9 telemetry)
      rpcArgs = {
        p_enrollment_id: String(enrollmentRow["id"]),
        p_lesson_id: lessonId,
        p_video_max_position_sec: null,
        p_watch_sec_delta: 0,
        p_dwell_sec_delta: dwellDeltaSec(prior?.["updated_at"]),
      };
    }
    const { error: rpcError } = await supabase.rpc("record_lesson_progress", rpcArgs);
    if (rpcError) {
      // code ทะเบียนท้ายข้อความ RPC (parser กลาง) — ไม่รู้จัก → ERR-SYS-001 opaque (ไม่ leak SQL)
      const code = parseRpcErrorCode(rpcError);
      throw code === undefined ? new AppError("ERR-SYS-001") : new AppError(code);
    }

    // 6) อ่านสถานะจริงหลัง RPC เพื่อตอบ (สถานะจบบท = ตัดสินใน RPC เท่านั้น — D12-12)
    const { data: after, error: afterError } = await supabase
      .from("lesson_progress")
      .select("status, watch_pct, video_max_position_sec, dwell_sec, quiz_score_pct, completed_at")
      .eq("enrollment_id", String(enrollmentRow["id"]))
      .eq("lesson_id", lessonId)
      .maybeSingle();
    if (afterError) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lesson_progress_read_failed" } });
    }
    if (after === null) {
      // RPC สำเร็จแต่แถวไม่พบ = สถานะไม่สอดคล้อง — ตอบ opaque (ไม่ leak รายละเอียด)
      throw new AppError("ERR-SYS-001");
    }
    const view = {
      lessonId,
      status: String(after["status"]),
      watchPct: typeof after["watch_pct"] === "number" ? after["watch_pct"] : 0,
      videoMaxPositionSec:
        typeof after["video_max_position_sec"] === "number" ? after["video_max_position_sec"] : null,
      dwellSec: typeof after["dwell_sec"] === "number" ? after["dwell_sec"] : 0,
      quizScorePct: typeof after["quiz_score_pct"] === "number" ? after["quiz_score_pct"] : null,
      completedAt: typeof after["completed_at"] === "string" ? after["completed_at"] : null,
    };
    const parsed = LessonProgressView.safeParse(view);
    if (!parsed.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lesson_progress_bad_contract" } });
    }
    return jsonOk(parsed.data, jsonOptions(requestId));
  } catch (err: unknown) {
    return jsonErrorResponse(err, jsonOptions(requestId));
  }
}

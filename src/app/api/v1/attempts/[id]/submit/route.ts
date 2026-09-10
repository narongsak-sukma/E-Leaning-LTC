/**
 * POST /api/v1/attempts/[id]/submit — ส่งข้อสอบ (API-SPEC 1.0.3 §3.5 · DCR-6)
 *
 * ต้องมี header `Idempotency-Key` (uuid) — รูปแปลก/ไม่มี → ERR-VAL-002 400 · BFF ไม่
 * cache/store key (idempotency อยู่ที่ RPC submit_attempt ตาม DCR-6 — ส่งซ้ำหลังส่งแล้ว
 * คืนผลเดิม + already_submitted:true ไม่ error) — key ใช้ระบุคำขอฝั่ง client เท่านั้น
 *
 * grading = synchronous ใน RPC (0011_functions.sql) → 200 ผลตรวจทันที:
 * {attemptId, status: passed|failed, scorePct, passed, correctCount?, questionCount?,
 * alreadySubmitted?} (camelCase)
 *
 * session binding (D20-B5): p_session_id จาก claim `session_id` ของ access token ใน
 * session store — ห้ามรับจาก body เด็ดขาด · body §4 #8 strict-parse (DCR-6):
 * unansweredQuestionIds เป็น telemetry เท่านั้น (ไม่ส่งต่อ RPC) และคีย์แปลกปลอม
 * รวม session_id → ERR-VAL-001 400 (fail ชัด ไม่เพิกเฉยเงียบ)
 *
 * permission = attempt:start (ตัวเอง — RBAC-DESIGN §2.3 L70) · rate = EXAM (§5)
 *
 * Errors: VAL-001 (id ไม่ใช่ uuid · body ผิด §4 #8 รวมคีย์แปลกปลอม/JSON เสีย) ·
 * VAL-002 (Idempotency-Key ไม่ใช่ uuid) ·
 * AUTH-001/RBAC-001/AUTH-004 · RATE-001 · จาก RPC: NF-001 · RBAC-001 (session ไม่ตรง) ·
 * ASM-005 (ส่งแล้วแต่ RPC ไม่ให้ replay — ผิดปกติ) · ASM-004 (เกิน deadline+grace 5 นาที) ·
 * SYS-002 (RPC ล้มเหลว/contract ผิด opaque)
 */
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { parseRpcErrorCode } from "@/lib/api/rpc-errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  AttemptSubmitView,
  SubmitAttemptResult,
  parseAttemptIdParams,
  parseAttemptSubmitBody,
  readJwtSessionClaim,
  toSubmitView,
  type SubmitAttemptResultParsed,
} from "@/lib/schemas/v1/exam";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ตรวจ jsonb ของ RPC submit_attempt แบบ fail-closed — ผิด contract → SYS-002 */
function parseSubmitAttemptResult(data: unknown): SubmitAttemptResultParsed {
  const parsed = SubmitAttemptResult.safeParse(data);
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "submit_attempt_bad_contract" } });
  }
  return parsed.data;
}

/** POST — 200 ผลตรวจทันที (ส่งซ้ำ = ผลเดิม + alreadySubmitted:true — DCR-6) */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) path param — ไม่ใช่ uuid → VAL-001 400
    const parsed = parseAttemptIdParams({ id: (await context.params).id });
    // 2) session + permission (attempt:start — สิทธิ์ "สอบของตัวเอง")
    const { userId } = await requirePermission("attempt:start");
    // 3) rate EXAM (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "EXAM", secondaryKey: userId });
    // 4) Idempotency-Key บังคับรูป uuid (§3.5) — ขาด/รูปแปลก → VAL-002 400;
    //    BFF ไม่ cache key — idempotency อยู่ที่ RPC (DCR-6)
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey === null || UUID_RE.test(idempotencyKey) === false) {
      throw new AppError("ERR-VAL-002");
    }
    // 4b) body §4 #8 — strict-parse: คีย์แปลกปลอม (รวม session_id) → VAL-001 fail ชัด;
    //     ยอมรับ body ว่างเปล่าเป็น {} · unansweredQuestionIds = telemetry ไม่ส่งต่อ RPC
    const rawBody = await request.text();
    let bodyJson: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        bodyJson = JSON.parse(rawBody) as unknown;
      } catch {
        throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
      }
    }
    parseAttemptSubmitBody(bodyJson);
    const supabase = await createSupabaseSsrClient();
    // 5) D20-B5: session_id จาก claim ของ access token ใน session store เท่านั้น
    const sessionId = await readJwtSessionClaim(supabase);
    // 6) RPC — synchronous grading (คะแนน/ผ่าน-ไม่ผ่านตัดสินฝั่ง DB ล้วน)
    const { data, error } = await supabase.rpc("submit_attempt", {
      p_attempt_id: parsed.id,
      p_session_id: sessionId,
    });
    if (error !== null) {
      const code = parseRpcErrorCode(error);
      throw code === undefined
        ? new AppError("ERR-SYS-002", { details: { reason: "submit_attempt_failed" } })
        : new AppError(code);
    }
    const result = parseSubmitAttemptResult(data);
    const view = toSubmitView(result);
    const parsedView = AttemptSubmitView.safeParse(view);
    if (!parsedView.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "attempt_submit_view_bad_contract" } });
    }
    return jsonOk(parsedView.data, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

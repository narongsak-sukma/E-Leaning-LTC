/**
 * POST /api/v1/courses/[id]/enroll — ลงทะเบียนเรียน (Wave C-3 · API-SPEC 1.0.1 §3.3)
 *
 * ลำดับ: path param → session+permission (401/403) → rate LEARN_WRITE (429)
 * → RPC enroll() (DD §4.7 — ห้าม INSERT enrollments ตรงจาก BFF, D12-1) → SELECT แถวที่สร้าง
 * กลับผ่าน RLS เจ้าของ เพื่อตอบ resource ตาม §3.3
 *
 * DCR-3/D25 (ผูกมัด): enroll ซ้ำ = 200 idempotent + enrollment เดิม (ไม่ใช่ 409) —
 * BFF จับ ERR-ENR-001 ที่ RPC โยน (raise exception '... (ERR-XXX-NNN)' — 0011_functions.sql
 * L16-L63) แล้ว SELECT แถวเดิมมาตอบ: ซ้ำ→200 · ไม่ published→CRS-001 404 ·
 * is_public=false และไม่ใช่ lawyer→ENR-002 422 · ไม่ login→AUTH-001 401
 *
 * rate = LEARN_WRITE (คำตัดสิน lead — batch C-1; endpoint นี้ไม่อยู่ใน §5 matrix)
 * MFA ไม่บังคับ (citizen/lawyer ไม่อยู่ MFA_REQUIRED_ROLES) · ห้าม log PII — อ้าง user_id
 */
import { NextResponse } from "next/server";
import { AppError, ERROR_REGISTRY, type ErrorCode } from "@/lib/errors";
import {
  jsonCreated,
  jsonError,
  jsonErrorResponse,
  jsonOk,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { EnrollParams, toEnrollmentResource, type EnrollmentRow } from "@/lib/schemas/v1/enrollment";

/** x-request-id จาก middleware (SDS §5.4) → options ของ envelope (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * แกะ error code ที่ RPC `enroll()` ฝังท้ายข้อความ exception (raise exception '... (ERR-XXX-NNN)')
 * ใช้ token สุดท้าย และต้องอยู่ในทะเบียนเท่านั้น — ไม่เข้าเงื่อนไข = ความล้มเหลวระบบ (ไม่ leak SQL)
 */
function errorCodeFromMessage(message: string): ErrorCode | null {
  const matches = message.match(/ERR-[A-Z]{3}-\d{3}/g);
  const last = matches === null ? undefined : matches.at(-1);
  if (last === undefined) {
    return null;
  }
  return (Object.keys(ERROR_REGISTRY) as readonly string[]).includes(last)
    ? (last as ErrorCode)
    : null;
}

/** อ่านแถว enrollment ของตัวเองจาก course_id (RLS เจ้าของ — DD §3.2; อ่านผ่าน SELECT ปกติ) */
async function selectOwnEnrollment(
  supabase: Awaited<ReturnType<typeof createSupabaseSsrClient>>,
  userId: string,
  courseId: string,
): Promise<EnrollmentRow | null> {
  const { data, error } = await supabase
    .from("enrollments")
    .select("id, course_id, status, enrolled_at, expires_at, completed_at")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .maybeSingle();
  if (error !== null) {
    throw new AppError("ERR-SYS-002");
  }
  return (data ?? null) as EnrollmentRow | null;
}

/** POST — 201 (ลงทะเบียนใหม่) · 200 (ซ้ำ — DCR-3 idempotent คืน enrollment เดิม) */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) path param — ผิดรูปแบบ = ข้อมูลส่งมาไม่ถูกต้อง (ERR-VAL-001 400)
    const { id } = await context.params;
    const parsed = EnrollParams.safeParse({ courseId: id });
    if (!parsed.success) {
      return jsonError("ERR-VAL-001", { ...options, details: { fields: ["courseId"] } });
    }
    // 2) session + permission (ไม่ login → 401 · ไม่มี enroll:create → 403)
    const session = await requirePermission("enroll:create");
    // 3) rate limit กลุ่ม LEARN_WRITE (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "LEARN_WRITE", secondaryKey: session.userId });
    // 4) เขียนผ่าน SECURITY DEFINER function เท่านั้น (DD §4.7 — D12-1)
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("enroll", { p_course_id: parsed.data.courseId });
    if (error !== null) {
      const code = errorCodeFromMessage(error.message);
      if (code === null) {
        throw new AppError("ERR-SYS-002"); // RPC ล้มเหลวอื่น — opaque ตามแบบ rbac.ts (ไม่ leak SQL)
      }
      if (code === "ERR-ENR-001") {
        // DCR-3: ซ้ำ → คืน enrollment เดิม 200 (idempotent — SRS LRN-001)
        const existing = await selectOwnEnrollment(supabase, session.userId, parsed.data.courseId);
        if (existing === null) {
          throw new AppError("ERR-ENR-001"); // หาแถวเดิมไม่เจอ (ผิดปกติ) → 409 ตามทะเบียน
        }
        return jsonOk(toEnrollmentResource(existing), options);
      }
      return jsonError(code, options); // CRS-001 → 404 · ENR-002 → 422 · RBAC-001 → 403
    }
    // 5) RPC สำเร็จ (คืน id) → อ่านแถวที่สร้างมาตอบ 201
    if (typeof data !== "string" || !UUID_RE.test(data)) {
      throw new AppError("ERR-SYS-001"); // contract ผิด → fail-closed
    }
    const row = await selectOwnEnrollment(supabase, session.userId, parsed.data.courseId);
    if (row === null) {
      throw new AppError("ERR-SYS-001"); // สร้างสำเร็จแต่อ่านไม่เจอ (ผิดปกติ) → fail-closed
    }
    return jsonCreated(toEnrollmentResource(row), options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

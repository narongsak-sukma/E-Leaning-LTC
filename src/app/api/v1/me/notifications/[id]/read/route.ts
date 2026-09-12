/**
 * POST /api/v1/me/notifications/{id}/read — ทำเครื่องหมายอ่านแล้ว (Wave E Phase 4 · NTF-001 ·
 * API-SPECIFICATION §3.9 — 204 idempotent)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (เส้นข้อมูลของตัวเอง — aal1 ใช้ได้)
 * - ไม่มี permission gate — RPC my_notification_read ทำ owner-check เองใน DB (auth.uid()) —
 *   handler ไม่ส่ง user_id ใด ๆ เข้าไป · เรียกด้วย user JWT ผ่าน PostgREST (ห้าม service key)
 * - :id ต้องเป็น uuid — ผิดรูป → 400 ERR-VAL-001 (fields: ["id"]) ก่อนแตะ DB (แบบ parseRuleId)
 * - สำเร็จ → 204 ว่าง (idempotent — อ่านซ้ำก็ 204 ตาม spec §3.9) — jsonNoContent (ไม่มี body)
 * - ไม่ใช่เจ้าของ/ไม่พบ → RPC โยน '... (ERR-NF-001)' → แกะผ่าน parser กลาง (lib/api/rpc-errors)
 *   → 404 ERR-NF-001 envelope · error อื่น/ไม่มีป้าย → 503 ERR-SYS-002 opaque ไม่ leak SQL
 * - rate = READ (§5: /me* → ทุก method — เดียวกับเพื่อนบ้าน /me/*)
 */
import { NextResponse } from "next/server";

import { z } from "zod";

import { parseRpcErrorCode } from "@/lib/api/rpc-errors";
import { jsonErrorResponse, jsonNoContent, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** :id ผิดรูป uuid → 400 ก่อนแตะ DB — zod ตามสัญญา §4 (EnrollParams แบบเดียวกัน) */
const NotificationIdParams = z.object({ id: z.string().uuid() });

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session (ไม่มี MFA gate) → 401 ERR-AUTH-001
    const user = await requireUser();
    // 2) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) :id ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB
    const { id } = await context.params;
    const parsed = NotificationIdParams.safeParse({ id });
    if (!parsed.success) {
      return jsonErrorResponse(
        new AppError("ERR-VAL-001", { details: { fields: ["id"] } }),
        options,
      );
    }
    // 4) RPC my_notification_read ด้วย user JWT — idempotent + owner-check ใน DB
    const supabase = await createSupabaseSsrClient();
    const { error } = await supabase.rpc("my_notification_read", {
      p_notification_id: parsed.data.id,
    });
    if (error !== null) {
      // ไม่ใช่เจ้าของ/ไม่พบ → 404 · ไม่มีป้าย / code นอกทะเบียน → 503 opaque (ไม่ leak SQL)
      const code = parseRpcErrorCode(error);
      if (code === undefined) {
        throw new AppError("ERR-SYS-002");
      }
      return jsonErrorResponse(new AppError(code), options);
    }
    // 5) สำเร็จ (รวมกรณีอ่านซ้ำ) → 204 ว่าง — ไม่มี body
    return jsonNoContent(options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

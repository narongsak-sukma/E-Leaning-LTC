/**
 * POST /api/v1/me/mfa/disable — ปิดใช้งาน MFA ของตัวเอง (Wave F · D-f-1)
 *
 * - ต้อง login · บทบาทบังคับ MFA ห้ามปิด → 403 ERR-RBAC-001 (ข้อความไทยมีคำ MFA)
 * - ต้อง recent-MFA ≤ 15 นาที (aal2 + amr mfa/* ภายในหน้าต่าง) ไม่ผ่าน → 403 ERR-AUTH-004
 * - สำเร็จ = unenroll ทุก factor TOTP verified + RPC invalidate (audit โดย DB RPC)
 * - rate: MFA group
 */
import { NextResponse } from "next/server";

import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import {
  assertMfaDisableAllowed,
  sessionHasRecentMfa,
} from "@/lib/auth/mfa";
import { requireUser, getMyRoles } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { DisableView } from "../schema";

/** x-request-id → envelope options */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** POST — guard ตามลำดับ: role → recent-MFA → unenroll ทุก factor verified + invalidate */
export async function POST(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    const user = await requireUser();
    enforceRateLimit(request, { group: "MFA", secondaryKey: user.userId });
    const supabase = await createSupabaseSsrClient();
    // 1) บทบาทบังคับ MFA ห้ามปิด (ERR-RBAC-001 — ข้อความไทยมีคำ MFA)
    assertMfaDisableAllowed(await getMyRoles());
    // 2) recent-MFA ≤ 15 นาที — ไม่ผ่าน = 403 ERR-AUTH-004
    if (!(await sessionHasRecentMfa(supabase))) {
      throw new AppError("ERR-AUTH-004");
    }
    // 3) unenroll ทุก factor TOTP ที่ verified
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_disable_list_failed" } });
    }
    let unenrolledAny = false;
    for (const factor of factorsData?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status === "verified") {
        const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
        if (error !== null) {
          throw new AppError("ERR-SYS-002", { details: { reason: "mfa_disable_unenroll_failed" } });
        }
        unenrolledAny = true;
      }
    }
    if (!unenrolledAny) {
      throw new AppError("ERR-NF-001");
    }
    // 4) ล้างโค้ดสำรองทั้งชุด (audit AUTH_MFA_BACKUPS_INVALIDATED โดย RPC)
    const invalidate = await supabase.rpc("mfa_backup_codes_invalidate");
    if (invalidate.error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_disable_invalidate_failed" } });
    }
    const view = parseOutgoingView(DisableView, { disabled: true }, "mfa_disable_drift");
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

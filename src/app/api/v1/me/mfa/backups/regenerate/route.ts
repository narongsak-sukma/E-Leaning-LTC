/**
 * POST /api/v1/me/mfa/backups/regenerate — ออกชุดโค้ดสำรองใหม่ (Wave F · D-f-1)
 *
 * - ต้อง login + recent-MFA ≤ 15 นาที (ไม่ผ่าน → 403 ERR-AUTH-004)
 * - ต้องมี factor TOTP verified อย่างน้อยหนึ่งตัว (ไม่มี → 400 ERR-VAL-001|no_verified_factor)
 * - RPC mfa_backup_codes_replace — replace แบบ atomic (audit โดย DB RPC) ·
 *   ชุดเก่าใช้ไม่ได้ทันที · โค้ดตอบกลับ "ครั้งเดียว" — Cache-Control: no-store
 * - rate: MFA group
 */
import { NextResponse } from "next/server";

import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import {
  BACKUP_CODE_COUNT,
  firstVerifiedTotpFactor,
  generateBackupCodes,
  sessionHasRecentMfa,
} from "@/lib/auth/mfa";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { BackupCodesView } from "../../schema";

/** x-request-id → envelope options */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** POST — สร้างและเก็บ hash ของชุดโค้ดสำรองใหม่ · ตอบโค้ดล้วน no-store */
export async function POST(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    const user = await requireUser();
    enforceRateLimit(request, { group: "MFA", secondaryKey: user.userId });
    const supabase = await createSupabaseSsrClient();
    // recent-MFA ≤ 15 นาที — ไม่ผ่าน = 403 ERR-AUTH-004
    if (!(await sessionHasRecentMfa(supabase))) {
      throw new AppError("ERR-AUTH-004");
    }
    // ต้องมี factor TOTP verified — ไม่มี = 400 no_verified_factor
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_backups_list_failed" } });
    }
    if (firstVerifiedTotpFactor(factorsData?.all ?? []) === null) {
      throw new AppError("ERR-VAL-001", {
        details: { fields: ["factor"], reason: "no_verified_factor" },
      });
    }
    // สร้างโค้ด → เก็บ hash ล้วน (atomic replace โดย RPC)
    const generated = generateBackupCodes(BACKUP_CODE_COUNT);
    const replace = await supabase.rpc("mfa_backup_codes_replace", {
      p_hashes: [...generated.hashes],
    });
    if (replace.error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "mfa_backups_replace_failed" } });
    }
    const view = parseOutgoingView(BackupCodesView, { codes: [...generated.codes] }, "mfa_backups_regenerate_drift");
    const res = jsonOk(view, options);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

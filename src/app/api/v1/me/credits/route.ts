/**
 * GET /api/v1/me/credits — สรุปหน่วยกิตสะสมรายรอบของตัวเอง (Wave E Phase 3 · CRB-005 ·
 * API-SPECIFICATION 1.1.0 §3 แถว /me/credits)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 (error เดียวที่ตาราง §3 ระบุของแถวนี้)
 *   · ไม่มี MFA gate — ผู้ใช้เป้าหมายคือผู้เรียน (citizen/lawyer) เหมือน /me (allowlist AUTH-007)
 *   · ไม่มี permission gate — RPC my_credit_summary ผ่าน grant `authenticated` และจัดการขอบเขต
 *     เองภายใน (lazy: lawyer/ผู้มีรอบเดิม = สร้างรอบให้ · citizen = current: null — UI อธิบาย
 *     เป็นข้อความไทย ไม่ error) — แถว §3 ระบุ lawyer เป็นกลุ่มเป้าหมายหลัก
 * - ขอบเขต "ของตัวเอง" อยู่ใน RPC เอง (auth.uid() — security definer · owner-check ภายใน) —
 *   handler ไม่ส่ง user_id ใด ๆ เข้าไป (ห้ามยอมรับ user_id จาก query)
 * - rate = READ (ตาราง §5: /me* → READ 120/min ต่อ user_id + ip — เรียกเองใน handler)
 * - ขาออก zod strict ทุกชั้น — RPC คืน drift → 503 ERR-SYS-002 (parseOutgoingView)
 */
import { NextResponse } from "next/server";

import { AppError } from "@/lib/errors";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { CreditSummaryView } from "@/lib/api/credits";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** แถวดิบจาก Supabase (untyped client — ตรวจชนิดเองก่อนใช้) */
type Row = Record<string, unknown>;

export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session (ไม่มี MFA gate — allowlist AUTH-007 เหมือน /me) → 401 ERR-AUTH-001
    const user = await requireUser();
    // 2) rate READ (user_id + ip — D12-11) — หลังตรวจ session
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) RPC my_credit_summary ด้วย user JWT (ขอบเขตของตัวเองอยู่ใน RPC — auth.uid())
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("my_credit_summary");
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    // 4) ขาออก zod strict — แถว drift (คีย์เกิน/ขาด/ค่าผิดชนิด) → 503 fail-closed ไม่ส่ง payload เพี้ยน
    if (!isRecord(data)) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "credit_summary_contract_drift" },
      });
    }
    const view = parseOutgoingView(CreditSummaryView, data, "credit_summary_contract_drift");
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/** ตรวจชนิดแบบมือ — RPC คืน jsonb ผ่าน untyped client (ต้องเป็น object ไม่ใช่ array/null) */
function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


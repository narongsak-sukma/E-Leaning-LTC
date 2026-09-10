/**
 * GET /api/v1/me — โปรไฟล์ + บทบาทของตัวเอง (Wave C Phase 1 · API-SPEC 1.0.2 §3.2)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 (ตาราง §3.2 Errors)
 * - **อยู่ใน allowlist ของ AUTH-007 (D27): ใช้ requireUser() ตรง ๆ ไม่ผ่าน MFA gate**
 *   — staff/instructor ที่ยัง aal1 (session enrollment-only) ต้องอ่านตัวตนของตัวเองได้
 *   เพื่อให้ UI บอกบทบาทและพาไปต่อ MFA ได้ (RBAC §4.2 + SRS AUTH-007)
 * - ขอบเขต "ของตัวเอง" บังคับสองชั้น: `.eq(id, userId)` + RLS SELECT เจ้าของแถว (DD §3.1)
 * - roles จาก RPC `my_roles()` ด้วย user JWT (helper canonical เดียวกับ RLS — RBAC §3.1)
 * - mfaVerified = aal2 ณ ตอนอ่าน (สะท้อนสถานะ MFA ปัจจุบันของ session ให้หลังบ้านแสดงธง)
 * - rate = READ (§5 ตาราง /me* → 120/min ต่อ user_id + ip — เรียกเองใน handler)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { requireUser, getMyRoles } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** ขาออก (§3.2) — zod ตรวจก่อนส่งเสมอ (§1-4); ไม่มีฟิลด์ sensitive (ไม่มี phone/ชื่อจริง) */
const MeResource = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string().min(1),
  roles: z.array(z.string()),
  mfaVerified: z.boolean(),
});

/** แถวดิบจาก Supabase (untyped client — ตรวจชนิดเองก่อนใช้) */
type Row = Record<string, unknown>;

export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session (allowlist AUTH-007 — ไม่มี MFA gate ที่นี่) → 401 ERR-AUTH-001
    const user = await requireUser();
    // 2) rate READ (user_id + ip — D12-11) — หลังตรวจ session เพื่อไม่นับคำขอที่ยังไม่ผ่าน
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) บทบาทผ่าน RPC canonical
    const roles = await getMyRoles();
    // 4) โปรไฟล์แถวตัวเอง (RLS เจ้าของแถว) — requireUser เพิ่งตรวจว่าแถว active อยู่
    //    อ่านแล้วหายกลางคัน = สถานะไม่สอดคล้อง → fail-closed
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, display_name")
      .eq("id", user.userId)
      .maybeSingle();
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "profile_read_failed" } });
    }
    const row = (data ?? null) as Row | null;
    const profileId = typeof row?.["id"] === "string" ? row["id"] : null;
    const email = typeof row?.["email"] === "string" ? row["email"] : null;
    const displayName = typeof row?.["display_name"] === "string" ? row["display_name"] : null;
    if (row === null || profileId !== user.userId || email === null || displayName === null) {
      throw new AppError("ERR-SYS-001", { details: { reason: "profile_inconsistent" } });
    }
    // 5) ประกอบขาออก (camelCase) — zod ตรวจก่อนส่ง
    const parsed = MeResource.safeParse({
      id: profileId,
      email,
      displayName,
      roles: [...roles],
      mfaVerified: user.aal === "aal2",
    });
    if (!parsed.success) {
      throw new AppError("ERR-SYS-001", { details: { reason: "me_bad_contract" } });
    }
    return jsonOk(parsed.data, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

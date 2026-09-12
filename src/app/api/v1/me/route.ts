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

/**
 * PATCH /api/v1/me — แก้โปรไฟล์ตนเอง (Wave E Phase 5 · IDENT-001 · API-SPEC §3.2 แถว 125)
 *
 * - เขต display_name/phone/preferred_locale เท่านั้น (guard 0010 trigger D20-M2) —
 *   first_name/last_name เป็นข้อมูลนิติบุคคล แก้ผ่านเจ้าหน้าที่ (D-p5-13) ·
 *   pdpa_consented_at ไม่รับที่นี่ (จัดผ่าน /profile/consents · ห้ามแตะ)
 * - strict body (key แปลกปลอม/first_name/last_name/pdpa_consented_at → 400 ERR-VAL-001)
 * - ต้องส่งอย่างน้อย 1 ฟิลด์ — ว่างเปล่า = 400
 * - phone = E.164 (CHECK profiles_phone_e164_check) · preferred_locale = th|en (CHECK)
 * - rate = READ ตาม §5 แถว /me* (ทุก method) — แก้โปรไฟล์ความถี่ต่ำ
 * - เขียนผ่าน user-JWT — RLS profiles_update_owner (0010) คุมแถวตัวเอง + trigger guard
 *   คอลัมน์คุมขอบเขต (defense in depth — BFF ส่งเฉพาะ key ที่ยอมเสมอ)
 * - 200 { data: { id, email, displayName, phone, preferredLocale } } — strict ขาออก
 */

/** phone E.164 (CHECK profiles_phone_e164_check 0003) */
const PATCH_PHONE_E164 = /^\+[1-9]\d{1,14}$/;

/** body ของ PATCH — strict (first_name/last_name/pdpa_consented_at ไม่อยู่ในชุด = 400) */
const MePatchBody = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().regex(PATCH_PHONE_E164).nullish(),
    preferredLocale: z.enum(["th", "en"]).optional(),
  })
  .strict();

/** ขาออก — แถวโปรไฟล์หลังแก้ (strict) */
const MeUpdatedResource = z
  .object({
    id: z.string().uuid(),
    email: z.string().min(1),
    displayName: z.string().min(1),
    phone: z.string().nullable(),
    preferredLocale: z.enum(["th", "en"]).nullable(),
  })
  .strict();

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด / key แปลกปลอม → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parsePatchBody(request: Request): Promise<z.infer<typeof MePatchBody>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = MePatchBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** PATCH — แก้โปรไฟล์ตนเอง (200) */
export async function PATCH(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session (allowlist AUTH-007 เดียวกับ GET — แก้โปรไฟล์ของตัวเองไม่บังคับ MFA)
    const user = await requireUser();
    // 2) rate READ (§5 /me* — ทุก method)
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) body strict — ผิดรูป/key แปลกปลอม → 400 ERR-VAL-001
    const body = await parsePatchBody(request);
    // 4) ต้องมีอย่างน้อย 1 ฟิลด์ — ว่างเปล่า = 400 (ไม่มีอะไรให้แก้)
    const payload: Record<string, string | null> = {};
    if (body.displayName !== undefined) {
      payload["display_name"] = body.displayName;
    }
    if (body.phone !== undefined) {
      payload["phone"] = body.phone ?? null;
    }
    if (body.preferredLocale !== undefined) {
      payload["preferred_locale"] = body.preferredLocale;
    }
    if (Object.keys(payload).length === 0) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
    }
    // 5) เขียนผ่าน user-JWT — RLS profiles_update_owner + guard 0010 คุมคอลัมน์ (แถวตัวเอง)
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase
      .from("profiles")
      .update(payload)
      .eq("id", user.userId)
      .select("id, email, display_name, phone, preferred_locale")
      .single();
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "profile_update_failed" } });
    }
    const row = (data ?? null) as Row | null;
    const updatedId = typeof row?.["id"] === "string" ? row["id"] : null;
    const updatedEmail = typeof row?.["email"] === "string" ? row["email"] : null;
    const updatedDisplayName =
      typeof row?.["display_name"] === "string" ? row["display_name"] : null;
    const updatedPhone = row?.["phone"] === null || typeof row?.["phone"] === "string" ? (row?.["phone"] as string | null) : null;
    const updatedLocale =
      row?.["preferred_locale"] === "th" || row?.["preferred_locale"] === "en"
        ? row["preferred_locale"]
        : null;
    if (row === null || updatedId !== user.userId || updatedEmail === null || updatedDisplayName === null) {
      throw new AppError("ERR-SYS-001", { details: { reason: "profile_update_inconsistent" } });
    }
    // 6) ประกอบขาออก — zod ตรวจก่อนส่ง (drift → 503)
    const parsedView = MeUpdatedResource.safeParse({
      id: updatedId,
      email: updatedEmail,
      displayName: updatedDisplayName,
      phone: updatedPhone,
      preferredLocale: updatedLocale,
    });
    if (!parsedView.success) {
      throw new AppError("ERR-SYS-002", { details: { reason: "me_patch_bad_contract" } });
    }
    return jsonOk(parsedView.data, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/**
 * POST /api/v1/auth/logout — ออกจากระบบ (Wave C-0 · API-SPECIFICATION §3.1)
 *
 * - ใช้ **buffered client** (createSupabaseSsrClientBuffered): SDK เคลียร์ cookie
 *   ทันทีที่เรียก signOut แม้การ revoke ฝั่ง auth server จะล้ม — ต้องไม่ commit
 *   การลบ cookie ลงเครื่องผู้ใช้จนกว่าการเพิกถอนจะสำเร็จ ไม่งั้นกดซ้ำจะกลายเป็น
 *   "ไม่มี session" (204) ทั้งที่ refresh token ยังไม่ถูก revoke (gate r4+r5)
 * - signOut สำเร็จ หรือ auth server ยืนยันว่า session ใช้ไม่ได้ (401 / ไม่มี session
 *   เหลืออยู่) → commit การลบ cookie + 204 (idempotent — spec §3.1 ตอบ 204)
 * - signOut ล้มจาก upstream (network/5xx) → 503 ERR-SYS-002 และ **ไม่ commit** —
 *   cookie session ยังอยู่ ผู้ใช้กดลองใหม่ได้ด้วย refresh token เดิม (UI อยู่หน้าเดิม
 *   และแจ้งว่าออกไม่สำเร็จ)
 * - scope: "local" = ยกเลิกเฉพาะ session นี้ (logout-all เป็น endpoint แยกของ Wave F)
 */
import { NextResponse } from "next/server";
import { createSupabaseSsrClientBuffered } from "@/lib/supabase/ssr";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";

export async function POST(): Promise<NextResponse> {
  try {
    const { client, commit } = await createSupabaseSsrClientBuffered();
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error !== null && error.status !== 401 && error.name !== "AuthSessionMissingError") {
      // upstream ล้ม (network/5xx) — ห้าม commit การลบ cookie ที่ SDK ทำไว้ใน buffer
      throw new AppError("ERR-SYS-002");
    }
    // สำเร็จ หรือ auth server ยืนยันเองว่าไม่มี session จริง — ยืนยันการลบทั้งหมด
    commit();
    return new NextResponse(null, { status: 204 });
  } catch (err: unknown) {
    const appError = fromUnknown(err);
    return NextResponse.json(toErrorBody(appError), { status: appError.httpStatus ?? 500 });
  }
}

/**
 * POST /api/v1/auth/logout — ออกจากระบบ (Wave C-0 · API-SPECIFICATION §3.1)
 *
 * - เรียก signOut(scope "local") ตรง ๆ **โดยไม่ผ่าน getUser** — getUser คืน null เหมือนกัน
 *   ทั้ง "ไม่มี session" และ "auth server ล่ม" ทำให้ route เดิมตอบ 401 แม้ session
 *   ยังไม่ถูกเพิกถอน แล้ว UI เดินหน้าไป /login เหมือนออกสำเร็จ (gate r4 MAJOR-1)
 * - signOut สำเร็จ หรือ auth server ยืนยันว่า session ใช้ไม่ได้ (401 / ไม่มี session
 *   เหลืออยู่) → 204: ปลายทาง logout บรรลุแล้ว (idempotent — spec §3.1 ตอบ 204)
 * - signOut ล้มจาก upstream (network/5xx) → 503 ERR-SYS-002 — ห้ามตอบ 204/401
 *   เพราะ token ยังใช้ได้อยู่ (UI จะอยู่หน้าเดิมและแจ้งว่าออกไม่สำเร็จ)
 * - scope: "local" = ยกเลิกเฉพาะ session นี้ (logout-all เป็น endpoint แยกของ Wave F)
 */
import { NextResponse } from "next/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";

export async function POST(): Promise<NextResponse> {
  try {
    const supabase = await createSupabaseSsrClient();
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error !== null) {
      // auth server ตอบกลับมาเองว่า session นี้ใช้ไม่ได้/ไม่มีเหลือ = ไม่มีอะไรให้เพิกถอน
      // (AuthSessionMissingError ไม่มี status — ดูที่ name)
      if (error.status === 401 || error.name === "AuthSessionMissingError") {
        return new NextResponse(null, { status: 204 });
      }
      // upstream ล้ม (network/5xx) — session อาจยังใช้ได้ ห้ามรายงานว่าออกสำเร็จ
      throw new AppError("ERR-SYS-002");
    }
    return new NextResponse(null, { status: 204 });
  } catch (err: unknown) {
    const appError = fromUnknown(err);
    return NextResponse.json(toErrorBody(appError), { status: appError.httpStatus ?? 500 });
  }
}

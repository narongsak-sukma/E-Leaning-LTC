/**
 * POST /api/v1/auth/logout — ออกจากระบบ (Wave C-0 · API-SPEC §3.1)
 *
 * - ไม่มี session → 401 (envelope จากทะเบียน error เดียวกัน — API-SPEC §2)
 * - มี session → signOut() แล้วตอบ 204 No Content
 * - scope: "local" = ยกเลิกเฉพาะ session นี้ (logout-all เป็น endpoint แยกของ Wave F)
 */
import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/session";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";

/** POST — ต้องมี session จึงออกจากระบบได้ (ไม่มี = 401 ตาม API-SPEC §3.1) */
export async function POST(): Promise<NextResponse> {
  try {
    const user = await getUser();
    if (user === null) {
      return NextResponse.json(toErrorBody(new AppError("ERR-AUTH-001")), { status: 401 });
    }
    const supabase = await createSupabaseSsrClient();
    await supabase.auth.signOut({ scope: "local" });
    return new NextResponse(null, { status: 204 });
  } catch (err: unknown) {
    const appError = fromUnknown(err);
    return NextResponse.json(toErrorBody(appError), { status: appError.httpStatus ?? 500 });
  }
}

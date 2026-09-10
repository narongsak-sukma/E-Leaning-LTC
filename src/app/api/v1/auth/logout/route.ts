/**
 * POST /api/v1/auth/logout — ออกจากระบบ (Wave C-0 · API-SPECIFICATION §3.1)
 *
 * - ใช้ **buffered client** (createSupabaseSsrClientBuffered): SDK เคลียร์ cookie
 *   ทันทีที่เรียก signOut แม้การ revoke ฝั่ง auth server จะล้ม — ต้องไม่ commit
 *   การลบ cookie ลงเครื่องผู้ใช้จนกว่าการเพิกถอนจะสำเร็จ ไม่งั้นกดซ้ำจะกลายเป็น
 *   "ไม่มี session" (204) ทั้งที่ refresh token ยังไม่ถูก revoke (gate r4+r5)
 * - gate r6: SDK กลืน 401/403/404 จาก logout endpoint เป็น error:null — โดยเฉพาะ
 *   bad_jwt (access token หมดอายุ) GoTrue ปฏิเสธก่อนเพิกถอน refresh token —
 *   route จึงอ่าน session ก่อน: ถ้า access token หมดอายุให้ refresh 1 ครั้งแล้ว
 *   ค่อย revoke ด้วย token ใหม่ (refresh โดนปฏิเสธชัด ๆ = session ตายจริง → 204)
 * - signOut สำเร็จ หรือ auth server ยืนยันว่า session ใช้ไม่ได้ (401 / ไม่มี session
 *   เหลืออยู่) → commit การลบ cookie + 204 (idempotent — spec §3.1 ตอบ 204)
 * - upstream ล้ม (network/5xx) → 503 ERR-SYS-002 และ **ไม่ commit** —
 *   cookie session ยังอยู่ ผู้ใช้กดลองใหม่ได้ด้วย refresh token เดิม
 * - scope: "local" = ยกเลิกเฉพาะ session นี้ (logout-all เป็น endpoint แยกของ Wave F)
 */
import { NextResponse } from "next/server";
import { createSupabaseSsrClientBuffered } from "@/lib/supabase/ssr";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";

export async function POST(): Promise<NextResponse> {
  try {
    const { client, commit } = await createSupabaseSsrClientBuffered();

    // access token หมดอายุ → refresh ก่อน ไม่งั้น GoTrue ตอบ bad_jwt ที่ SDK กลืนทิ้ง
    const { data: sessionData } = await client.auth.getSession();
    const expiresAt = sessionData.session?.expires_at;
    if (
      sessionData.session !== null &&
      expiresAt !== undefined &&
      expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      const { error: refreshError } = await client.auth.refreshSession();
      if (refreshError !== null) {
        if (
          refreshError.status === 400 || // GoTrue ปฏิเสธ refresh token ด้วย 400 invalid_grant (token ตาย/ใช้ไปแล้ว)
          refreshError.status === 401 ||
          refreshError.status === 403 ||
          refreshError.name === "AuthSessionMissingError"
        ) {
          // refresh token ถูกปฏิเสธชัด ๆ = session นี้ใช้ไม่ได้จริง — ล้าง cookie ได้
          commit();
          return new NextResponse(null, { status: 204 });
        }
        // network/5xx — SDK จะ retry พร้อม backoff ภายในแล้วคืน error เดิม:
        // ยังไม่แตะ cookie ให้ผู้ใช้กด logout ใหม่ภายหลังได้
        throw new AppError("ERR-SYS-002");
      }
    }

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

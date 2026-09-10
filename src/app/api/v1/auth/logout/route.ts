/**
 * POST /api/v1/auth/logout — ออกจากระบบ (Wave C-0 · API-SPECIFICATION §3.1)
 *
 * หลัก (สะสมจาก gate r4→r7): **ไม่มีทางจบ "เหมือนสำเร็จ" (204 + ล้าง cookie) จนกว่า
 * refresh token จะถูก revoke จริง หรือ auth server ยืนยันเองว่า session ตายแล้ว**
 * - buffered client (r5): การเขียน/ลบ cookie ทั้งหมดอยู่ใน memory จนกว่า commit()
 * - อ่าน session พร้อม**ตรวจ error ของ getSession** (r7 M1): token หมดอายุ → SDK
 *   refresh ภายในเอง; refresh โดนปฏิเสธชัด (400/401/403) พร้อม token หมดอายุจริง →
 *   SDK คืน {session:null, error} = ตายจริง · แต่ 429/5xx/network ก็คืน error เหมือน
 *   กัน — ต้องแยก: อันหลังตอบ 503 และ**ไม่ commit** (deletion ที่ SDK ทำไว้ใน buffer
 *   ถูกทิ้ง) ไม่ใช่ 204 เหมือนสำเร็จ · middleware ก็ไม่ refresh เส้นนี้ให้แล้ว (r7 M1)
 * - **revoke ด้วย fetch ตรงเอง** (r7 M2): _signOut ของ SDK กลืน 401/403/404 เป็น
 *   error:null (bad_jwt) — ทางเดียวที่รู้ผล revoke จริงคืออ่าน status เอง
 * - revoke โดน 401/403 ทั้งที่ token ยังไม่หมดอายุตามเครื่องเรา (clock skew / ถูกเพิกถอน
 *   ฝั่ง server) → หมุน token ใหม่ 1 ครั้งแล้วลอง revoke ซ้ำอีกครั้งเดียว — ยังโดนปฏิเสธ
 *   = ตายจริง → ล้าง cookie + 204
 * - upstream ล้ม (429/5xx/network) → 503 ERR-SYS-002 ไม่ commit — ผู้ใช้กดลองใหม่ได้;
 *   ยกเว้นถ้าหมุน token ไปแล้ว commit เก็บ refresh token ใหม่ไว้ก่อน (ตัวเก่าถูกใช้
 *   ไปในการหมุน — ทิ้งการเขียน = ทิ้ง credential ที่ยังมีชีวิตฝั่ง server ให้กลายเป็นเศษ)
 * - scope: "local" = ยกเลิกเฉพาะ session นี้ (logout-all เป็น endpoint แยกของ Wave F)
 */
import { NextResponse } from "next/server";
import { createSupabaseSsrClientBuffered } from "@/lib/supabase/ssr";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";
import { getConfig } from "@/lib/config";

/** 400/401/403 จาก GoTrue = ปฏิเสธชัด ๆ (invalid_grant / bad_jwt) — ต่างจาก 429/5xx ที่ลองใหม่ได้ */
function isRejected(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

interface AuthApiErrorLike extends Error {
  readonly status?: number;
}

/**
 * error ของ SDK ที่ยืนยันว่า session ตายจริง (auth server ปฏิเสธชัด ๆ) —
 * ที่เหลือ (429/5xx/network) คือ upstream ล้มชั่วคราว: ยังไม่แตะ cookie
 * (ใช้ name แทน instanceof — คลาสของ auth-js ไม่พร้อม type ให้ import โดยตรง)
 */
function isDefinitiveAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AuthSessionMissingError") {
    return true;
  }
  return error.name === "AuthApiError" && isRejected((error as AuthApiErrorLike).status ?? 0);
}

/** เรียก GoTrue /auth/v1/logout เอง (scope=local) — network ล้ม/ค้าง = upstream ล้ม (503) */
async function revokeSession(url: string, apiKey: string, accessToken: string): Promise<Response> {
  try {
    return await fetch(`${url}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: apiKey, authorization: `Bearer ${accessToken}` },
      // หมดเวลาแบบกำหนด — connection ค้าง (ไม่ error แต่ไม่ตอบ) กลายเป็น transient
      // แทนที่จะค้าง request เปิดไว้ไม่รู้จบ (เช่นเดียวกับ retry window ของ SDK)
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError("ERR-SYS-002");
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const { supabaseUrl, supabaseAnonKey } = getConfig();
    const { client, commit, clearAuthCookies } = await createSupabaseSsrClientBuffered();

    /** session จบแล้ว (revoke สำเร็จ / ยืนยันตายจริง) — ล้าง cookie ทั้งชุด + 204 */
    const dead = (): NextResponse => {
      clearAuthCookies();
      commit();
      return new NextResponse(null, { status: 204 });
    };

    // อ่าน session — ห้ามกลืน error (gate r7 M1)
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError !== null) {
      if (isDefinitiveAuthError(sessionError)) {
        return dead();
      }
      // 429/5xx/network — SDK อาจเก็บ deletion ไว้ใน buffer แล้ว แต่เราไม่ commit
      // จึงเท่ากับทิ้ง: cookie session ยังอยู่ ให้ลอง logout ใหม่ภายหลัง
      throw new AppError("ERR-SYS-002");
    }
    if (sessionData.session === null) {
      // ไม่มี session ที่ใช้ได้เหลือในเครื่อง (jar ว่าง หรือ cookie เสีย) — idempotent
      return dead();
    }

    let accessToken = sessionData.session.access_token;
    let rotated = false;
    let revoke = await revokeSession(supabaseUrl, supabaseAnonKey, accessToken);

    if (isRejected(revoke.status)) {
      const { data: refreshData, error: refreshError } = await client.auth.refreshSession();
      if (refreshError !== null) {
        if (isDefinitiveAuthError(refreshError)) {
          return dead();
        }
        throw new AppError("ERR-SYS-002"); // upstream ล้มระหว่าง refresh — ไม่ commit
      }
      const refreshed = refreshData.session;
      if (refreshed === null) {
        return dead();
      }
      accessToken = refreshed.access_token;
      rotated = true;
      try {
        revoke = await revokeSession(supabaseUrl, supabaseAnonKey, accessToken);
      } catch {
        // network ล้มหลังหมุน token — เก็บ refresh token ใหม่ไว้ก่อนคืน 503
        commit();
        throw new AppError("ERR-SYS-002");
      }
    }

    if (revoke.ok || isRejected(revoke.status)) {
      // revoke สำเร็จ หรือปฏิเสธซ้ำด้วย token ที่เพิ่งออกใหม่ = session ตายจริง
      return dead();
    }
    if (rotated) {
      // transient (429/5xx) หลังหมุน token — ไม่มีอะไรให้ revoke ด้วยตัวเก่าอีก:
      // commit เก็บ session หมุนแล้วไว้ แล้วให้ลองใหม่ (ครั้งหน้าต่อจาก token ใหม่)
      commit();
    }
    throw new AppError("ERR-SYS-002");
  } catch (err: unknown) {
    const appError = fromUnknown(err);
    return NextResponse.json(toErrorBody(appError), { status: appError.httpStatus ?? 500 });
  }
}

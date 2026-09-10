/**
 * POST /api/v1/auth/logout — ออกจากระบบ (Wave C-0 · API-SPECIFICATION §3.1)
 *
 * หลัก (สะสมจาก gate r4→r8): **ไม่มีทางจบ "เหมือนสำเร็จ" (204 + ล้าง cookie) จนกว่า
 * refresh token จะถูก revoke จริง หรือ auth server ยืนยันเองว่า session ตายแล้ว**
 * - buffered client (r5): การเขียน/ลบ cookie ทั้งหมดอยู่ใน memory จนกว่า commit()
 * - อ่าน session พร้อม**ตรวจ error ของ getSession** (r7 M1 · r9 M1 · r10 M1): token
 *   หมดอายุ → SDK refresh ภายในเอง; refresh ตอบ code ที่พิสูจน์ token ตายจริง
 *   (refresh_token_not_found / refresh_token_already_used / session_expired /
 *   invalid_grant / AuthSessionMissingError) → SDK คืน {session:null, error} =
 *   ตายจริง · error อื่นทุกชนิด (รวม 401 จากชั้น key-auth ของ gateway ที่ไม่มี
 *   code — ไม่ได้แตะ session ฝั่ง server) และ 429/5xx/network → 503 และ**ไม่
 *   commit** (deletion ที่ SDK ทำไว้ใน buffer ถูกทิ้ง)
 *   ไม่ใช่ 204 เหมือนสำเร็จ · middleware ก็ไม่ refresh เส้นนี้ให้แล้ว (r7 M1)
 * - **revoke ด้วย fetch ตรงเอง** (r7 M2): _signOut ของ SDK กลืน 401/403/404 เป็น
 *   error:null (bad_jwt) — ทางเดียวที่รู้ผล revoke จริงคืออ่าน status เอง
 * - revoke โดน 401/403 ทั้งที่ token ยังไม่หมดอายุตามเครื่องเรา (clock skew / ถูกเพิกถอน
 *   ฝั่ง server) → หมุน token ใหม่ 1 ครั้งแล้วลอง revoke ซ้ำอีกครั้งเดียว — ซ้ำแล้วผ่าน
 *   = revoke สำเร็จ → ล้าง cookie + 204 · **ซ้ำแล้วยังโดนปฏิเสธ ≠ ตายจริง** (r8 M1):
 *   refresh เพิ่งสำเร็จ = session ยังมีชีวิตแน่นอน ส่วน bad_jwt กับ token ที่เพิ่งออก
 *   ใหม่คือปัญหาฝั่งตรวจ JWT (เช่น signing key ของ auth instances ไม่ตรงกัน) ไม่ใช่
 *   หลักฐานว่า session สิ้นสภาพ — ต้อง commit เก็บ session ใหม่แล้วตอบ 503 (ลองใหม่
 *   ภายหลัง ไม่วน retry ต่อ) ห้ามล้าง cookie แกล้งว่าสำเร็จ
 * - upstream ล้ม (429/5xx/network) → 503 ERR-SYS-002 — ผู้ใช้กดลองใหม่ได้; ถ้ามี
 *   rotation ค้างอยู่ ( getSession หมุนภายในเอง — r8 m1 — หรือ refreshSession สำเร็จ)
 *   ต้อง commit เก็บ refresh token ใหม่ไว้ก่อนทุกครั้ง (ตัวเก่าถูกใช้ไปในการหมุนแล้ว —
 *   ทิ้งการเขียน = ทิ้ง credential ที่ยังมีชีวิตฝั่ง server ให้กลายเป็นเศษ)
 * - scope: "local" = ยกเลิกเฉพาะ session นี้ (logout-all เป็น endpoint แยกของ Wave F)
 */
import { NextResponse } from "next/server";
import { createSupabaseSsrClientBuffered } from "@/lib/supabase/ssr";
import { isDefinitiveAuthError } from "@/lib/supabase/auth-errors";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";
import { getConfig } from "@/lib/config";

/** 400/401/403 จาก GoTrue = ปฏิเสธชัด ๆ (invalid_grant / bad_jwt) — ต่างจาก 429/5xx ที่ลองใหม่ได้ */
function isRejected(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
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
    const { client, commit, clearAuthCookies, hasPendingAuthWrite } =
      await createSupabaseSsrClientBuffered();

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
    // r8 m1: getSession อาจหมุน token ภายในเอง (access หมดอายุ → SDK refresh แล้ว
    // เขียน session ใหม่ลง buffer) — นับเป็น rotation ตั้งแต่ต้น ไม่งั้น transient
    // ถัดไปทิ้ง refresh token ที่เพิ่งออกใหม่ให้กลายเป็นเศษ
    let rotated = hasPendingAuthWrite();

    let revoke: Response;
    try {
      revoke = await revokeSession(supabaseUrl, supabaseAnonKey, accessToken);
    } catch {
      // network ล้ม/ค้างตั้งแต่ revoke แรก — เก็บ rotation ที่เกิดไปแล้ว (ถ้ามี) ก่อน 503
      if (rotated) {
        commit();
      }
      throw new AppError("ERR-SYS-002");
    }

    if (isRejected(revoke.status)) {
      const { data: refreshData, error: refreshError } = await client.auth.refreshSession();
      if (refreshError !== null) {
        if (isDefinitiveAuthError(refreshError)) {
          return dead();
        }
        if (rotated) {
          commit(); // upstream ล้มระหว่าง refresh — เก็บ rotation เดิมไว้ก่อน 503
        }
        throw new AppError("ERR-SYS-002");
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

    if (revoke.ok) {
      return dead();
    }
    // ถึงตรงนี้ = transient (429/5xx) หรือถูกปฏิเสธซ้ำ — ทั้งคู่เกิดหลัง (r8 M1)
    // refresh สำเร็จแล้วเท่านั้น แปลว่า session ยังมีชีวิตแน่นอน จึงห้ามล้าง cookie
    // แกล้งว่าสำเร็จ: commit เก็บ session ใหม่ไว้ (ถ้าหมุนแล้ว) แล้วตอบ 503 ให้ลอง
    // ใหม่ภายหลัง — ไม่วน retry เพิ่มใน request เดียวกัน
    if (rotated) {
      commit();
    }
    throw new AppError("ERR-SYS-002");
  } catch (err: unknown) {
    const appError = fromUnknown(err);
    return NextResponse.json(toErrorBody(appError), { status: appError.httpStatus ?? 500 });
  }
}

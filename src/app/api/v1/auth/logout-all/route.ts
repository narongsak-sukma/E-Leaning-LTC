/**
 * POST /api/v1/auth/logout-all — ออกจากระบบทุกเครื่อง (AUTH-010 · Wave G P1)
 *
 * เลียนแบบ logout เดิม (src/app/api/v1/auth/logout/route.ts · gate r4→r10) ทั้งหมด
 * ยกเว้นสามจุด: (1) revoke ด้วย `scope=global` = ยกเลิกทุกเซสชันของผู้ใช้ ไม่ใช่
 * เฉพาะ session นี้ · (2) มี `enforceRateLimit` group AUTH ก่อนทุกอย่าง ·
 * (3) revoke ยืนยันสำเร็จ = audit `AUTH_SESSION_REVOKE` ผ่าน service-role RPC
 * ก่อนล้าง cookie — หลัก fail-closed เดิมคงเดิม: **ไม่มีทางจบ "เหมือนสำเร็จ"
 * (204 + ล้าง cookie) จนกว่า GoTrue จะยืนยันว่า token ตายจริง**
 * - buffered client: การเขียน/ลบ cookie ทั้งหมดอยู่ใน memory จนกว่า commit()
 * - อ่าน session พร้อมตรวจ error ของ getSession — token หมดอายุ → SDK refresh ภายใน
 *   เอง; error ตายจริง (allowlist ของ auth-errors) = SDK คืน {session:null} = ตายจริง
 *   → จบแบบ idempotent (ล้าง cookie + 204) โดยไม่ audit (ไม่มีอะไรถูก revoke ตอนนี้)
 * - revoke โดน 401/403 (bad_jwt / clock skew) → หมุน token ใหม่ 1 ครั้งแล้ว revoke
 *   ซ้ำเดียว — ผ่าน = ล้าง cookie + 204 · ซ้ำแล้วยังโดนปฏิเสธ ≠ ตายจริง (refresh
 *   เพิ่งสำเร็จ = session ยังมีชีวิตแน่นอน) → commit เก็บ session ใหม่แล้วตอบ 503
 * - upstream ล้ม (429/5xx/network) → 503 ERR-SYS-002 — ถ้ามี rotation ค้าง
 *   (getSession/refreshSession หมุนภายใน) ต้อง commit เก็บ refresh token ใหม่ก่อน
 *   ทุกครั้ง (ตัวเก่าถูกใช้ไปแล้ว — ทิ้ง = ทำ credential ที่ยังมีชีวิตให้เป็นเศษ)
 * - audit ล้ม (หลัง revoke สำเร็จ) → 503 ERR-SYS-002 **ไม่ล้าง cookie** — session
 *   ที่ GoTrue ตายแล้ว กดซ้ำจะได้ 204 ทาง idempotent (getSession error ตายจริง)
 */
import { NextResponse } from "next/server";
import { createSupabaseSsrClientBuffered } from "@/lib/supabase/ssr";
import { isDefinitiveAuthError } from "@/lib/supabase/auth-errors";
import { AppError, fromUnknown, toErrorBody } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import {
  auditSessionRevokeFailClosed,
  revokeAllSessions,
  sessionIdFromAccessToken,
} from "@/lib/auth/logout-all";
import { subFromAccessToken } from "@/lib/auth/token-claims";

/** 400/401/403 จาก GoTrue = ปฏิเสธชัด ๆ (invalid_grant / bad_jwt) — ต่างจาก 429/5xx ที่ลองใหม่ได้ */
function isRejected(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { supabaseUrl, supabaseAnonKey } = getConfig();
    // rate limit ก่อนทุกอย่าง (รวมก่อนแตะ GoTrue) — group AUTH ตาม ROUTE_RULES
    // ของ /api/v1/auth/* · คีย์รอง mirror IP (gate r1 M1: ไม่ใส่ = bucket `g:AUTH:`
    // เดียวรวมทุก IP — request นี้ยังไม่มี user id ที่พิสูจน์แล้วให้ใช้ตอนนับ)
    enforceRateLimit(request, { group: "AUTH", secondaryKey: clientIpFrom(request) });
    const { client, commit, clearAuthCookies, hasPendingAuthWrite } =
      await createSupabaseSsrClientBuffered();

    /** session จบแล้ว (revoke สำเร็จ / ยืนยันตายจริง) — ล้าง cookie ทั้งชุด + 204 */
    const dead = (): NextResponse => {
      clearAuthCookies();
      commit();
      return new NextResponse(null, { status: 204 });
    };

    // อ่าน session — ห้ามกลืน error (แบบเดียวกับ logout เดิม)
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError !== null) {
      if (isDefinitiveAuthError(sessionError)) {
        return dead();
      }
      // 429/5xx/network — SDK อาจเก็บ deletion ไว้ใน buffer แล้ว แต่เราไม่ commit:
      // cookie session ยังอยู่ ให้ลองใหม่ภายหลัง
      throw new AppError("ERR-SYS-002");
    }
    if (sessionData.session === null) {
      // ไม่มี session ที่ใช้ได้เหลือในเครื่อง (jar ว่าง หรือ cookie เสีย) — idempotent
      return dead();
    }

    let accessToken = sessionData.session.access_token;
    // getSession อาจหมุน token ภายในเอง (access หมดอายุ → SDK refresh แล้วเขียน
    // session ใหม่ลง buffer) — นับเป็น rotation ตั้งแต่ต้น ไม่งั้น transient ถัดไป
    // ทิ้ง refresh token ที่เพิ่งออกใหม่ให้กลายเป็นเศษ
    let rotated = hasPendingAuthWrite();

    let revoke: Response;
    try {
      revoke = await revokeAllSessions(supabaseUrl, supabaseAnonKey, accessToken);
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
        revoke = await revokeAllSessions(supabaseUrl, supabaseAnonKey, accessToken);
      } catch {
        // network ล้มหลังหมุน token — เก็บ refresh token ใหม่ไว้ก่อนคืน 503
        commit();
        throw new AppError("ERR-SYS-002");
      }
    }

    if (revoke.ok) {
      // ยืนยัน revoke ทุกเซสชันแล้ว — เผยแพร่ rotation ที่เกิดไปแล้วก่อนเข้าชั้น audit
      // (gate r1 MINOR-3: audit ล้ม = 503 โดย rotation ต้องไม่หายไปกับ response —
      // claim "commit ก่อน 503 เสมอ" ต้องจริงทุกสายรวมสายนี้) แล้ว audit ก่อนล้าง
      // cookie: audit ล้ม = 503 ไม่ล้าง (ดูหัวไฟล์) · sessionId = claim ของ token
      // ที่ใช้ revoke (rotation คง session เดิม)
      if (rotated) {
        commit();
      }
      // gate r1 M4: actor ของ audit จาก claim sub ของ token ที่เพิ่งใช้ revoke ผ่าน
      // GoTrue ใน request เดียวกัน — user object ใน cookie เป็น JSON ฝังตัวปลอมได้
      const actorId = subFromAccessToken(accessToken);
      if (actorId === null) {
        throw new AppError("ERR-SYS-002");
      }
      await auditSessionRevokeFailClosed({
        userId: actorId,
        sessionId: sessionIdFromAccessToken(accessToken),
        requestId: request.headers.get("x-request-id"),
      });
      return dead();
    }
    // ถึงตรงนี้ = transient (429/5xx) หรือถูกปฏิเสธซ้ำหลัง refresh สำเร็จ — session
    // ยังมีชีวิตแน่นอน ห้ามล้าง cookie แกล้งว่าสำเร็จ: commit เก็บ session ใหม่ไว้
    // (ถ้าหมุนแล้ว) แล้วตอบ 503 ให้ลองใหม่ภายหลัง — ไม่วน retry เพิ่มใน request เดียวกัน
    if (rotated) {
      commit();
    }
    throw new AppError("ERR-SYS-002");
  } catch (err: unknown) {
    const appError = fromUnknown(err);
    return NextResponse.json(toErrorBody(appError), { status: appError.httpStatus ?? 500 });
  }
}

/**
 * middleware — ชั้นกลางของทุก request /api/v1/* (SDS §5.4 + §5.1)
 *
 * ขอบเขต (Wave C — C-1 + codex-gate-c01 รอบแก้):
 * 1. request-id: สร้างใหม่ทุก request (crypto.randomUUID) — ใส่ request header x-request-id
 *    ให้ handler ใช้ต่อ (audit/log อ้างตัวเลขนี้) และสะท้อนกลับใน response header
 * 2. CSRF (เฉพาะ /api/v1 — SDS §5.4): ทุก method ที่ไม่ใช่ safe (GET/HEAD/
 *    OPTIONS) ต้องพิสูจน์ origin ได้ — Origin ตรง host / Sec-Fetch-Site เป็น
 *    same-origin|same-site|none · ไม่มีทั้งคู่ → 403 (fail-closed — เครื่องมือ dev
 *    ต้องส่ง Origin เอง เช่น `curl -H "Origin: http://localhost:3000"`)
 *    หน้าเว็บ (รวม server actions) ไม่อยู่ในขอบเขตนี้ — Next ตรวจ origin ของ
 *    server action เองอยู่แล้ว
 * 3. session refresh (SDS §5.1 + gate r10 M2): หมุน Supabase token **ก่อน render**
 *    ทั้ง handler /api/v1 และหน้า RSC — เขียน cookie ทั้งฝั่ง request (ต่อไปยัง
 *    handler/render) และ response (กลับ browser) ด้วย flags บังคับของ
 *    hardenedCookieOptions (httpOnly — library default เป็น false)
 *    เหตุผล r10 M2: loader ของหน้า RSC (admin.ts / learning.server.ts /
 *    catalog.server.ts) เรียก BFF ภายในด้วย cookie ที่ forward ไป — token หมดอายุ
 *    ตรงนั้น BFF หมุนแล้วตอบ Set-Cookie กลับ แต่ RSC ตั้ง cookie เองไม่ได้ (ข้อ
 *    จำกัดของ Next) rotation จึงหายกลางทางทุกครั้ง — browser ถือ refresh token
 *    เก่าไปเรื่อย ๆ จนโดนตรวจ reuse และ session ขาด · หมุนใน middleware ก่อน
 *    render ทำให้ render (และ loader ใต้มัน) เห็น token ใหม่ตั้งแต่ต้น และ
 *    browser ได้รับ cookie ใหม่จริง (รูปแบบทางการของ Supabase SSR/Next.js)
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { jsonError } from "./lib/api/response";
import { hardenedCookieOptions } from "./lib/supabase/cookies";
import { isDefinitiveAuthError } from "./lib/supabase/auth-errors";
import { getConfig } from "./lib/config";

/** safe methods ตาม RFC 9110 §9.2.1 — ทุกอย่างอื่นเป็น mutation และต้องผ่าน CSRF check */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * ตรวจ CSRF เชิงโครงสร้าง (SDS §5.4 — "ต่าง origin = ปฏิเสธ") — ทุก mutating request
 * - มี Origin → เทียบ origin เต็ม (scheme+host+port) กับ origin ของ request —
 *   เทียบเฉพาะ host ไม่พอ: Origin: http://x ต่อ request https://x เป็นคนละ origin
 * - ไม่มี Origin → Sec-Fetch-Site ต้องเป็น same-origin / none เท่านั้น —
 *   same-site คือ subdomain อื่นของ site เดียวกัน = ต่าง origin ตาม §5.4 → ปฏิเสธ
 * - ไม่มีทั้งคู่ → ปฏิเสธ (fail-closed — พิสูจน์ไม่ได้ว่ามาจาก origin เดียวกัน)
 */
export function isCsrfAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      return new URL(origin).origin === request.nextUrl.origin;
    } catch {
      return false;
    }
  }
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite !== null) {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  return false;
}

/** จุดเข้า middleware ของ Next — ใช้กับทุก request ใต้ /api/v1 และทุกหน้าเว็บ (r10 M2) */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  // CSRF คุมเฉพาะ API (SDS §5.4) — หน้าเว็บ/server action มีการตรวจ origin ของ
  // Next เอง (การขยาย matcher ไปหน้าเว็บใน r10 M2 เป็นการเพิ่ม session refresh
  // เท่านั้น ไม่ใช่ขยายขอบเขต CSRF)
  const isApi = request.nextUrl.pathname.startsWith("/api/v1/");
  if (isApi && !SAFE_METHODS.has(request.method) && !isCsrfAllowed(request)) {
    return jsonError("ERR-RBAC-001", {
      requestId,
      details: { reason: "csrf_origin_mismatch" },
    });
  }

  // session refresh (SDS §5.1) — token หมุนแล้วเดินต่อทั้งสองทิศทาง:
  // request cookie (handler/render เห็น token ใหม่) + response cookie (browser เก็บถาวร)
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  // gate r7 M1: ข้าม refresh สำหรับ POST /api/v1/auth/logout — logout route ตัดสิน
  // เองแบบ buffered และเขียนการลบเฉพาะเมื่อ revoke สำเร็จ/ยืนยันตายจริงเท่านั้น ·
  // gate r11 M1: ทุกเส้นอื่น (API + หน้าเว็บ) ก็ต้องระวังการลบแบบเดียวกัน — getUser
  // ของ SDK เจอ refresh โดนปฏิเสธแบบ non-retryable (รวม 401 จากชั้น key-auth ของ
  // gateway ที่ไม่มี code — ไม่ได้แตะ session ฝั่ง server) จะ _removeSession ทันที
  // ถ้า propagate การลบตรง ๆ หน้าเว็บ/API เส้นหนึ่งก็ล้าง credential ที่ยังมีชีวิต
  // แล้ว logout ถัดมาตอบ 204 โดยไม่เคย revoke — จึง buffer ไว้ก่อนแล้วตัดสินจากผล
  // auth: "การลบ" เผยแพร่เฉพาะเมื่อยืนยันตายจริง (allowlist เดียวกับ logout route),
  // "การเขียน" (rotation) เผยแพร่เสมอ
  const isLogoutPath =
    request.method === "POST" && request.nextUrl.pathname === "/api/v1/auth/logout";
  if (!isLogoutPath) {
    try {
      const { supabaseUrl, supabaseAnonKey } = getConfig();
      const pending = new Map<string, { value: string; options?: CookieOptions }>();
      const isDeletion = (value: string, options?: CookieOptions): boolean =>
        value === "" || options?.maxAge === 0;
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          // มุมมองของ SDK = cookie ของ request + การเขียนล่าสุดใน buffer (merged view
          // แบบเดียวกับ buffered client ของ ssr.ts) — ไม่แตะ request.cookies จริง
          // จนกว่าจะตัดสินว่าจะเผยแพร่อะไร
          getAll: () => {
            const view = new Map(request.cookies.getAll().map((c) => [c.name, c.value] as const));
            for (const [name, { value }] of pending) {
              if (value === "") {
                view.delete(name);
              } else {
                view.set(name, value);
              }
            }
            return [...view].map(([name, value]) => ({ name, value }));
          },
          setAll: (cookiesToSet) => {
            for (const { name, value, options } of cookiesToSet) {
              pending.set(name, options === undefined ? { value } : { value, options });
            }
          },
        },
      });
      // ตรวจ + หมุน token ถ้าใกล้หมดอายุ — ผล error ใช้ตัดสินว่าจะเผยแพร่การลบได้ไหม
      // (authorization เองเป็นของ handler/rbac ต่อไป)
      const { error: authError } = await supabase.auth.getUser();
      const deathConfirmed = authError !== null && isDefinitiveAuthError(authError);
      const published: Array<{ name: string; value: string; options?: CookieOptions }> = [];
      for (const [name, entry] of pending) {
        if (isDeletion(entry.value, entry.options) && !deathConfirmed) {
          continue; // ไม่ยืนยันว่าตายจริง — ทิ้งการลบ รักษา credential ล่าสุดทั้งสองฝั่ง
        }
        published.push({ name, ...entry });
      }
      if (published.length > 0) {
        for (const { name, value, options } of published) {
          if (isDeletion(value, options)) {
            request.cookies.delete(name);
          } else {
            request.cookies.set(name, value);
          }
        }
        // cookie ใหม่ต้องเดินต่อถึง handler/render ด้วย — sync เข้า header ของ request
        // ที่จะถูก forward แล้วสร้าง response ใหม่ (Next จับค่า headers ณ จุดสร้าง)
        requestHeaders.set("cookie", request.cookies.toString());
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of published) {
          response.cookies.set(name, value, hardenedCookieOptions(options));
        }
      }
    } catch {
      // Auth server ล้มชั่วคราว — ไม่ block ที่นี่ (handler/rbac ตัดสิน fail-closed ต่อ)
    }
  }

  response.headers.set("x-request-id", requestId);
  return response;
}

/**
 * matcher (gate r10 M2): ครอบทุกหน้าเว็บเพื่อ session refresh ก่อน render — ยกเว้น
 * ของที่ refresh ไม่มีความหมายและเปลืองทุก request: static assets (_next/static,
 * _next/image), favicon และไฟล์ภาพ (รูปแบบเดียวกับคู่มือทางการของ Supabase SSR
 * สำหรับ Next.js) · /api/v1/:path* ระบุไว้ตรง ๆ เป็นหลักประกันว่า API ยังถูกคุม
 * CSRF + request-id + refresh เหมือนเดิมแม้ catch-all จะถูกแก้ในอนาคต
 */
export const config = {
  matcher: [
    "/api/v1/:path*",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

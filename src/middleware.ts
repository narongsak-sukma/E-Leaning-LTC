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
import {
  authCookieBaseName,
  isDefinitiveAuthError,
  selectPublishableAuthCookies,
} from "./lib/supabase/auth-errors";
import { getConfig } from "./lib/config";

/** safe methods ตาม RFC 9110 §9.2.1 — ทุกอย่างอื่นเป็น mutation และต้องผ่าน CSRF check */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * สร้าง nonce ต่อ request (base64 — ตามแบบแผบคู่มือ Next.js เรื่อง CSP)
 * crypto.randomUUID ของ Edge runtime = CSPRNG · btoa → 24 อักขระ (≥16 ตาม OWASP)
 */
export function generateCspNonce(): string {
  return btoa(crypto.randomUUID());
}

/**
 * CSP แบบ nonce (gate r1 F8 — เดิม script-src 'unsafe-inline' ทุก environment):
 * - script-src 'self' 'nonce-…' 'strict-dynamic' — Next.js อ่าน CSP จาก request
 *   header แล้วปัก nonce ให้ inline bootstrap script ของมันเองโดยอัตโนมัติ ·
 *   'strict-dynamic' ให้ script ที่ nonce แล้วโหลด dependency ต่อได้ (chunk ของ
 *   Next) · 'self' เหลือเป็น fallback ของ browser รุ่นเก่าที่ไม่รู้จัก strict-dynamic
 * - style-src 'unsafe-inline' ยังจำเป็น (Next/Tailwind ฝัง <style> ที่ไม่มี nonce —
 *   เวกเตอร์ของ style ไม่รันสคริปต์ ต่างจาก script-src · บันทึกไว้ใน VA-PENTEST)
 * - dev เท่านั้น: +'unsafe-eval' (React Refresh) + media/img เปิด localhost:8000
 *   (สื่อ+signed URL ของ Kong ตอนพัฒนา) — production ไม่มีทั้งคู่
 */
export function buildContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const devMediaSources = isDev ? ["http://localhost:8000", "http://127.0.0.1:8000"] : [];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${devMediaSources.join(" ")}`,
    `media-src 'self' blob: data:${devMediaSources.join(" ")}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

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

  // nonce CSP (gate r1 F8) — ต้อง set "ก่อน" NextResponse.next ทั้งสองจุด: Next
  // อ่าน CSP จาก request header เพื่อดึง nonce ไปปักให้ inline script ของมันเอง
  // (คู่มือทางการ "Content Security Policy" ของ Next.js) · nonce เปลี่ยนทุก
  // request — ห้าม cache HTML ที่บรรจุ nonce (matcher ไม่แตะ _next/static อยู่แล้ว)
  const nonce = generateCspNonce();
  const csp = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  // CSRF คุมเฉพาะ API (SDS §5.4) — หน้าเว็บ/server action มีการตรวจ origin ของ
  // Next เอง (การขยาย matcher ไปหน้าเว็บใน r10 M2 เป็นการเพิ่ม session refresh
  // เท่านั้น ไม่ใช่ขยายขอบเขต CSRF)
  const isApi = request.nextUrl.pathname.startsWith("/api/v1/");
  if (isApi && !SAFE_METHODS.has(request.method) && !isCsrfAllowed(request)) {
    const rejected = jsonError("ERR-RBAC-001", {
      requestId,
      details: { reason: "csrf_origin_mismatch" },
    });
    rejected.headers.set("content-security-policy", csp);
    rejected.headers.set("x-request-id", requestId);
    return rejected;
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
  // gate g-p1-r3 MAJOR + r4 MINOR-2: POST /api/v1/me/password สัญญา "นับ quota
  // AUTH ก่อน network แรกของ request" — middleware ต้องไม่หมุน token
  // (getSession/refreshSession = network) ก่อน route นับ · rotation ของ browser
  // เกิดที่ request ก่อนหน้าแล้ว (เช่น GET /my/security ที่เปิดฟอร์ม) · ถ้า
  // access token หมดอายุจริงตอนนี้ getUser ของ SDK จะ refresh เอง **หลังนับ
  // แล้ว** (สำเร็จ = เดินต่อ · พลาด = 401) — quota ถูกนับก่อนเสมอไม่ว่าอย่างไร
  const isPreCountPasswordChangePath =
    request.method === "POST" && request.nextUrl.pathname === "/api/v1/me/password";
  // gate-cleanup r1 M1: ขาในของ server component (RSC loader เรียก BFF ของตัวเอง —
  // catalog/learning/admin ใส่ header x-ltc-bff-internal: 1 ฝั่ง server เท่านั้น)
  // ต้องไม่หมุน token: Set-Cookie ของขาในไม่มีทางถึง browser (RSC ตั้ง cookie เอง
  // ไม่ได้) — ถ้าปล่อยหมุนที่นี่ rotation ตกอยู่ใน response ภายในอย่างเดียว = ทิ้ง
  // กลางอากาศ (race ที่ PB-1 เดิมเพียงย้ายจากหน้าต่าง margin 90 → LEAD 180 วินาที)
  // ขานอก (browser) เป็นเจ้าของ rotation คนเดียวตาม PB-1 · browser ปลอม header นี้
  // เองได้ แต่ผลมีแค่ "request นั้นไม่ถูกหมุน" — ไม่ข้าม CSRF/authorization ใด ๆ
  // (ไม่ใช่ช่องรั่ว) และ request ถัดไปที่ไม่ปลอมก็หมุนตาม LEAD ปกติ
  const isInternalBffLeg = request.headers.get("x-ltc-bff-internal") === "1";
  if (!isLogoutPath && !isPreCountPasswordChangePath && !isInternalBffLeg) {
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
      //
      // PB-1 (refresh-ownership race): middleware เป็นเจ้าของ rotation คนเดียว
      // โดยหมุน "ล่วงหน้า" — margin ของ SDK เอง (EXPIRY_MARGIN_MS = 3 ticks × 30s
      // = 90 วิ ใน @supabase/auth-js ที่ติดตั้ง) แคบกว่าของเรา ทำให้เกิดหน้าต่างแข่ง:
      // middleware เห็นเหลือ >90 วิ ไม่หมุน → ระหว่าง render ผ่านขอบ 90 วิ → BFF
      // call ใน loader หมุนเอง → RSC ตั้ง cookie ไม่ได้ rotation หายกลางอากาศ →
      // browser ถือ refresh token เก่าจนโดน reuse — หมุนที่นี่ด้วย LEAD 180 วิ
      // ทำให้ทุก call ใต้ render เห็น token ที่ยังห่าง margin ของ SDK อยู่ จึงไม่
      // มีใครหมุนซ้ำ
      //
      // ตัดสิน death จาก error ของ getSession เอง (PB-1): getSession → __loadSession
      // หมุน refresh อยู่ในตัวเมื่อ token เข้า margin — refresh พลาดแต่ token จริง
      // ยังไม่หมด → คืน session เดิม error:null (preserve); refresh พลาดและ token
      // หมดจริง → คืน {session:null, error ของ refresh} — error นั้นแหละที่ใช้ตัดสิน
      // ตายจริง · **ห้าม**เรียก getUser ต่อหลัง session เป็น null (ทางเดิม): SDK จะ
      // โยน AuthSessionMissingError ซึ่ง definitive ตามชื่อ → ล้าง credential ที่
      // โดน gateway 401/429 แบบ non-retryable ทั้งที่ยังมีชีวิต (r11 เรียกคืน)
      const LEAD_SECONDS = 180;
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const session = sessionData?.session ?? null;
      let authError: Error | null = sessionError ?? null;
      if (
        session !== null &&
        typeof session.expires_at === "number" &&
        session.expires_at - Math.floor(Date.now() / 1000) < LEAD_SECONDS
      ) {
        // หมุนล่วงหน้า (เจ้าของ rotation คนเดียว) — refreshSession ไม่ผ่านทาง
        // preserve fallback ของ __loadSession: error ของมันคือคำตอบตรง ๆ ของ
        // auth server สำหรับ token นี้
        const { error: refreshError } = await supabase.auth.refreshSession();
        authError = refreshError ?? authError;
      }
      const deathConfirmed = authError !== null && isDefinitiveAuthError(authError);
      // นโยบายเดียวกับ commitAuthWrites ของ SSR client (gate r12 M2): การลบสองความ
      // หมายต้องแยก — "ล้าง session" เผยแพร่เฉพาะเมื่อยืนยันตายจริง · "เก็บกวาด chunk
      // เก่าระหว่าง rotation" (SDK ลบชื่อ base/.N ที่ไม่อยู่ในชุดใหม่ ใน setAll เดียว
      // กับการเขียนชุดใหม่) ต้องเผยแพร่พร้อม rotation เสมอ ไม่งั้น base เก่าค้างทั้ง
      // browser และ render แล้ว combineChunks (อ่าน base ก่อน) ยังใช้ token เก่า
      const base = authCookieBaseName(supabaseUrl);
      const isAuthCookieName = (name: string): boolean =>
        name === base || name.startsWith(`${base}.`);
      const published = selectPublishableAuthCookies(
        [...pending].map(([name, entry]) => ({ name, ...entry })),
        deathConfirmed,
        isAuthCookieName,
      );
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
  response.headers.set("content-security-policy", csp);
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

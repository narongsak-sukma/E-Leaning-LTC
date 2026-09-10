/**
 * middleware — ชั้นกลางของทุก request /api/v1/* (SDS §5.4 + §5.1)
 *
 * ขอบเขต (Wave C — C-1 + codex-gate-c01 รอบแก้):
 * 1. request-id: สร้างใหม่ทุก request (crypto.randomUUID) — ใส่ request header x-request-id
 *    ให้ handler ใช้ต่อ (audit/log อ้างตัวเลขนี้) และสะท้อนกลับใน response header
 * 2. CSRF: ทุก method ที่ไม่ใช่ safe (GET/HEAD/OPTIONS) ต้องพิสูจน์ origin ได้ —
 *    Origin ตรง host / Sec-Fetch-Site เป็น same-origin|same-site|none ·
 *    ไม่มีทั้งคู่ → 403 (fail-closed — เครื่องมือ dev ต้องส่ง Origin เอง เช่น
 *    `curl -H "Origin: http://localhost:3000"`)
 * 3. session refresh (SDS §5.1): หมุน Supabase token ก่อนถึง handler — เขียน cookie
 *    ทั้งฝั่ง request (ต่อไปยัง handler) และ response (กลับ browser) ด้วย flags
 *    บังคับของ hardenedCookieOptions (httpOnly — library default เป็น false)
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { jsonError } from "./lib/api/response";
import { hardenedCookieOptions } from "./lib/supabase/cookies";
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

/** จุดเข้า middleware ของ Next — ใช้กับทุก request ใต้ /api/v1 เท่านั้น */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  if (!SAFE_METHODS.has(request.method) && !isCsrfAllowed(request)) {
    return jsonError("ERR-RBAC-001", {
      requestId,
      details: { reason: "csrf_origin_mismatch" },
    });
  }

  // session refresh (SDS §5.1) — token หมุนแล้วเดินต่อทั้งสองทิศทาง:
  // request cookie (handler เห็น token ใหม่) + response cookie (browser เก็บลงถาวร)
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  // gate r7 M1: ข้าม refresh สำหรับ POST /api/v1/auth/logout — getUser ของ SDK อาจ
  // เจอ 429 ระหว่าง refresh ภายในแล้วเขียนการลบ session cookie ตรงลง response กลับ
  // browser ก่อน handler จะเริ่มทำงาน (SDK _removeSession เมื่อ token หมดอายุจริง +
  // refresh โดนปฏิเสธแบบ non-retryable) — logout route ตัดสินเองแบบ buffered และเขียน
  // การลบเฉพาะเมื่อ revoke สำเร็จ/ยืนยันตายจริงเท่านั้น · CSRF ข้างบนยังบังคับอยู่
  const isLogoutPath =
    request.method === "POST" && request.nextUrl.pathname === "/api/v1/auth/logout";
  if (!isLogoutPath) {
    try {
      const { supabaseUrl, supabaseAnonKey } = getConfig();
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (cookiesToSet) => {
            // cookie ที่สะสมไว้จากรอบก่อน (ชื่อซ้ำ = ใช้ค่ารอบใหม่)
            const carried = new Map(response.cookies.getAll().map((c) => [c.name, c] as const));
            for (const { name, value } of cookiesToSet) {
              request.cookies.set(name, value);
              carried.delete(name);
            }
            // cookie ใหม่ต้องเดินต่อถึง handler ด้วย — sync เข้า header ของ request
            // ที่จะถูก forward (ไม่ใช่แค่ response กลับ browser)
            requestHeaders.set("cookie", request.cookies.toString());
            // Next จับค่า headers ณ จุดสร้าง response — แก้ cookie header แล้วต้องสร้าง
            // response ใหม่ (แบบเดียวกับ pattern ทางการของ @supabase/ssr) แล้วจึงเขียน
            // cookie ที่สะสมไว้ทั้งหมด (เก่า + ใหม่) ลง response ล่าสุด
            response = NextResponse.next({ request: { headers: requestHeaders } });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, hardenedCookieOptions(options));
            }
            for (const cookie of carried.values()) {
              response.cookies.set(cookie);
            }
          },
        },
      });
      // ตรวจ + หมุน token ถ้าใกล้หมดอายุ (ไม่ใช้ผลลัพธ์ — authorization เป็นของ handler/rbac)
      await supabase.auth.getUser();
    } catch {
      // Auth server ล้มชั่วคราว — ไม่ block ที่นี่ (handler/rbac ตัดสิน fail-closed ต่อ)
    }
  }

  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = { matcher: ["/api/v1/:path*"] };

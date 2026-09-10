/**
 * middleware — ชั้นกลางของทุก request /api/v1/* (SDS §5.4)
 *
 * ขอบเขต (Wave C — C-1):
 * 1. request-id: สร้างใหม่ทุก request (crypto.randomUUID) — ใส่ request header x-request-id
 *    ให้ handler ใช้ต่อ (audit/log อ้างตัวเลขนี้) และสะท้อนกลับใน response header
 * 2. CSRF: mutating methods (POST/PUT/PATCH/DELETE) ตรวจ Origin / Sec-Fetch-Site ตรง host ตัวเอง
 *    — mismatch → 403 envelope ERR-RBAC-001 (code เดียวในทะเบียนที่เป็น 403 ทั่วไป — API-SPEC §2)
 *
 * ห้ามใส่ session logic ในไฟล์นี้ (ของ C-0/Phase 1 ตามแผน Wave C)
 */
import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "./lib/api/response";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * ตรวจ CSRF เชิงโครงสร้าง (SDS §5.4) — ใช้ได้กับทุก mutating request
 * - มี Origin → host ต้องตรง host ของ request เท่านั้น
 * - ไม่มี Origin → Sec-Fetch-Site ต้องเป็น same-origin / same-site / none
 * - ไม่มีทั้งคู่ → ผ่าน (client ไม่ใช่ browser — CSRF เป็นภัยเฉพาะเบราว์เซอร์; cookie เป็น SameSite=Lax คู่กัน)
 */
export function isCsrfAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      return new URL(origin).host === request.nextUrl.host;
    } catch {
      return false;
    }
  }
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite !== null) {
    return secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none";
  }
  return true;
}

/** จุดเข้า middleware ของ Next — ใช้กับทุก request ใต้ /api/v1 เท่านั้น */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  if (MUTATING_METHODS.has(request.method) && !isCsrfAllowed(request)) {
    return jsonError("ERR-RBAC-001", {
      requestId,
      details: { reason: "csrf_origin_mismatch" },
    });
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = { matcher: ["/api/v1/:path*"] };

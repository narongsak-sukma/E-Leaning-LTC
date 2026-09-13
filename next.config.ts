import type { NextConfig } from "next";

/**
 * next.config.ts — การตั้งค่าพื้นฐาน (Wave B task B-01 · security headers เพิ่ม Wave F [#91])
 *
 * - productionBrowserSourceMaps: false — ไม่ต้องมี source map ของ browser bundle
 *   ใน production (ลดขนาด artifact + ไม่เปิดเผย source ดิบ — SDS §6.1 "ไม่ leak ออกนอกเครื่อง")
 * - reactStrictMode: true — จับ side effect ที่ไม่ clean ตั้งแต่ dev
 * - securityHeaders (Wave F VA Phase-1 finding: หัวความปลอดภัยหายทั้งชุด) —
 *   CSP/XFO/nosniff/Referrer-Policy/Permissions-Policy/HSTS + poweredByHeader:false
 *   · 'unsafe-inline' ของ script/style = ข้อจำกัด v1 ของ Next.js App Router (ไม่มี
 *     nonce middleware แล้ว hydration ต้อง inline script) — บันทึกไว้ใน
 *     PROD-CHECKLIST ว่าการขึ้น nonce-based CSP เป็นงาน hardening ถัดไป
 *   · 'unsafe-eval' เฉพาะ development (React Refresh) — production ไม่ใส่
 *   · dev เปิด localhost:8000/127.0.0.1:8000 ใน img/media เพราะสื่อ+signed URL
 *     ของ Kong ใช้ตอนพัฒนา (SUPABASE_PUBLIC_URL) — prod ไม่มีค่าเหล่านี้
 *   · HSTS ส่งทุก environment (ค่า http จะโดนเพิกเฉยโดย browser เอง — ไม่ทำอันตราย dev)
 */

const isDev = process.env.NODE_ENV === "development";

const devMediaSources = isDev ? ["http://localhost:8000", "http://127.0.0.1:8000"] : [];

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js ต้องการ inline script ตอน hydration (ไม่มี nonce ใน v1) + eval เฉพาะ dev
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
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

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // ทุก route รวม API — หัวเหล่านี้ปลอดภัยต่อ JSON response เช่นกัน
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

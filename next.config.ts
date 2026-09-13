import type { NextConfig } from "next";

/**
 * next.config.ts — การตั้งค่าพื้นฐาน (Wave B task B-01 · security headers เพิ่ม Wave F [#91])
 *
 * - productionBrowserSourceMaps: false — ไม่ต้องมี source map ของ browser bundle
 *   ใน production (ลดขนาด artifact + ไม่เปิดเผย source ดิบ — SDS §6.1 "ไม่ leak ออกนอกเครื่อง")
 * - reactStrictMode: true — จับ side effect ที่ไม่ clean ตั้งแต่ dev
 * - securityHeaders (Wave F VA Phase-1 finding: หัวความปลอดภัยหายทั้งชุด) —
 *   XFO/nosniff/Referrer-Policy/Permissions-Policy/HSTS + poweredByHeader:false
 *   · **CSP ย้ายไป middleware.ts เป็นแบบ nonce ต่อ request** (gate r1 F8 —
 *     ห้ามตั้ง CSP ซ้ำที่นี่: header ซ้ำ = browser ใช้ตัวแรกที่เจอแบบไม่
 *     คาดเดาได้) — script-src 'self' 'nonce-…' 'strict-dynamic' · Next อ่าน
 *     CSP จาก request header แล้วปัก nonce ให้ inline script ของมันเอง
 *   · HSTS ส่งทุก environment (ค่า http จะโดนเพิกเฉยโดย browser เอง — ไม่ทำอันตราย dev)
 */

const securityHeaders = [
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

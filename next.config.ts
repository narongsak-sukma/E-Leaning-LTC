import type { NextConfig } from "next";

/**
 * next.config.ts — การตั้งค่าพื้นฐาน (Wave B task B-01)
 *
 * - productionBrowserSourceMaps: false — ไม่ต้องมี source map ของ browser bundle
 *   ใน production (ลดขนาด artifact + ไม่เปิดเผย source ดิบ — SDS §6.1 "ไม่ leak ออกนอกเครื่อง")
 * - reactStrictMode: true — จับ side effect ที่ไม่ clean ตั้งแต่ dev
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
};

export default nextConfig;

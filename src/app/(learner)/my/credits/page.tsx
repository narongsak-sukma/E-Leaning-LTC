/**
 * หน้า "หน่วยกิตสะสมของฉัน" (/my/credits) — Wave E Phase 3 · CRB-005
 *
 * - RSC โหลดผ่าน delegate src/lib/api/credits.ts (GET /api/v1/me/credits — origin จาก
 *   PUBLIC_BASE_URL + forward cookie ของ request — แบบเดียวกับ certificates.server.ts;
 *   loader อยู่ในหน้าเพราะไฟล์ server-loader แยกไม่อยู่ในกรรมสิทธิ์ของ lane นี้)
 * - สถานะหน้า: ยังไม่เข้าสู่ระบบ / ระบบขัดข้อง / ผู้ไม่มีรอบ (ข้อความอธิบาย ไม่ error) / พร้อมแสดง
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CreditsView, type CreditsPageData } from "@/components/credit/credits-view";
import { ApiError, getMyCreditSummary, type TransportCallOptions } from "@/lib/api/credits";
import { getConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: "หน่วยกิตสะสมของฉัน — ระบบฝึกอบรมออนไลน์",
  description:
    "สรุปหน่วยกิตสะสมรายรอบต่ออายุใบอนุญาตว่าความ พร้อมประวัติรายรอบของท่าน",
};

/** context ของ delegate ฝั่ง server — origin สัมบูรณ์ + forward cookie (RSC ไม่แนบ cookie ให้เอง) */
async function serverCallContext(): Promise<TransportCallOptions> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const origin = getConfig().publicBaseUrl;
  return cookieHeader.length > 0 ? { origin, cookieHeader } : { origin };
}

/** โหลดข้อมูลหน้า — แผนที่ error เป็นสถานะหน้า (ไม่ throw ออกนอก RSC · ข้อความไทยอยู่ที่ view) */
async function loadCreditsPageData(): Promise<CreditsPageData> {
  let summary;
  try {
    summary = await getMyCreditSummary(await serverCallContext());
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: "unauthenticated" };
    }
    return { kind: "error" };
  }
  return summary.current === null
    ? { kind: "no-cycle", summary }
    : { kind: "ready", summary };
}

export default async function MyCreditsPage() {
  const data = await loadCreditsPageData();
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">หน่วยกิตสะสมของฉัน</h1>
      <p className="mt-1 text-sm text-ink-600">
        หน่วยกิตสะสมสำหรับการต่ออายุใบอนุญาตว่าความของท่าน แยกตามรอบต่ออายุ
      </p>
      <CreditsView data={data} />
    </div>
  );
}

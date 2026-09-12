/**
 * หน้า "Transcript ของฉัน" (/my/transcript) — Wave E Phase 3 · CRB-006
 *
 * - RSC โหลดผ่าน delegate src/lib/api/credits.ts (GET /api/v1/me/transcript — origin จาก
 *   PUBLIC_BASE_URL + forward cookie — แบบเดียวกับหน้า /my/credits)
 * - สถานะหน้า: ยังไม่เข้าสู่ระบบ / ระบบขัดข้อง / ว่าง / พร้อมแสดง (ตาราง + ปุ่มดาวน์โหลด CSV)
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { TranscriptView, type TranscriptPageData } from "@/components/credit/transcript-view";
import { ApiError, getMyTranscript, type TransportCallOptions } from "@/lib/api/credits";
import { getConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: "Transcript ของฉัน — ระบบฝึกอบรมออนไลน์",
  description: "ผลการเรียน ผลสอบ หน่วยกิตสุทธิ และใบประกาศณียบัตรของท่าน พร้อมดาวน์โหลด CSV",
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
async function loadTranscriptPageData(): Promise<TranscriptPageData> {
  let transcript;
  try {
    transcript = await getMyTranscript(await serverCallContext());
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: "unauthenticated" };
    }
    return { kind: "error" };
  }
  return transcript.entries.length === 0
    ? { kind: "empty" }
    : { kind: "ready", transcript };
}

export default async function MyTranscriptPage() {
  const data = await loadTranscriptPageData();
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">Transcript ของฉัน</h1>
      <p className="mt-1 text-sm text-ink-600">
        ผลการเรียน ผลสอบ หน่วยกิตสุทธิ และใบประกาศณียบัตรของท่าน — ดาวน์โหลดเป็นไฟล์ CSV ได้
      </p>
      <TranscriptView data={data} />
    </div>
  );
}

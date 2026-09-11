/**
 * certificates.server — loader ฝั่ง Server Component (RSC) ของหน้า "ประกาศนียบัตรของฉัน"
 * (Wave D-6)
 *
 * - ผูก origin จาก config (PUBLIC_BASE_URL) + forward cookie ของ request ให้ BFF เสมอ
 *   (fetch จาก RSC ไม่แนบ cookie ให้เอง) — แบบเดียวกับ learning.server.ts / catalog.server.ts
 * - server-only: ห้าม import เข้า Client Component (ป้องกัน config/cookie เข้า browser bundle)
 * - แผนที่ error เป็นสถานะหน้าเว็บ (ข้อความไทยอยู่ที่หน้า): 401 = ยังไม่เข้าสู่ระบบ ·
 *   อื่น ๆ (503/500/network) = ระบบขัดข้อง → fail-closed ภาษาไทย ไม่แสดง error ดิบ
 */
import "server-only";

import { cookies } from "next/headers";

import { getConfig } from "@/lib/config";

import { getMyCertificates } from "./certificates";
import { ApiError } from "./learning";
import type { MyCertificateResourceParsed } from "@/lib/schemas/v1/certificate";

/** ข้อมูลหน้า "ประกาศนียบัตรของฉัน" — สถานะว่าง/ยังไม่ login/ระบบขัดข้อง/พร้อมแสดง */
export type MyCertificatesPageData =
  | { kind: "unauthenticated" }
  | { kind: "empty" }
  | { kind: "error" }
  | {
      kind: "ready";
      certificates: readonly MyCertificateResourceParsed[];
      hasMore: boolean;
    };

/**
 * GET /api/v1/me/certificates ผ่าน BFF — คืนสถานะหน้า (ไม่ throw ออกนอก RSC)
 *
 * - 401 → "unauthenticated" (ผู้เรียนยังไม่ login — หน้าแสดงปุ่มไปหน้าเข้าสู่ระบบ)
 * - ข้อผิดพลาดอื่นใด → "error" (fail-closed — ไม่มีรายการแสดงเมื่อระบบไม่น่าเชื่อถือ)
 */
export async function loadMyCertificatesPageData(): Promise<MyCertificatesPageData> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const context =
    cookieHeader.length > 0
      ? { origin: getConfig().publicBaseUrl, cookieHeader }
      : { origin: getConfig().publicBaseUrl };
  let page: Awaited<ReturnType<typeof getMyCertificates>>;
  try {
    page = await getMyCertificates(context);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: "unauthenticated" };
    }
    return { kind: "error" };
  }
  if (page.certificates.length === 0) {
    return { kind: "empty" };
  }
  return {
    kind: "ready",
    certificates: page.certificates,
    hasMore: page.hasMore,
  };
}

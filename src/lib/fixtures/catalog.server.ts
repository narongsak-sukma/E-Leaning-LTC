/**
 * catalog.server — loaders ฝั่ง Server Component (RSC) ของแคตตาล็อก (C-6 Phase 1)
 *
 * - ผูก origin จาก config (PUBLIC_BASE_URL) และ forward cookie ของ request ให้ BFF เสมอ
 *   (fetch จาก RSC ไม่แนบ cookie ให้เอง) — แบบเดียวกับ learning.server.ts
 * - server-only: ห้าม import เข้า Client Component (ป้องกัน config/cookie เข้า browser bundle)
 * - ชื่อฟังก์ชันเหมือน catalog.ts เป๊ะ — หน้า RSC เปลี่ยนแค่ที่มาของ import
 */
import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { getConfig } from "@/lib/config";

import {
  findPublishedCourse as fetchPublishedCourse,
  getCategories as fetchCategories,
  getPublishedCourses as fetchPublishedCourses,
  type CatalogCategory,
  type CatalogFetchOptions,
  type CourseDetail,
  type CourseListResponse,
} from "./catalog";

/** บริบทการเรียก BFF จาก RSC — origin จาก config + forward cookie session ของ request ปัจจุบัน */
async function catalogContext(): Promise<CatalogFetchOptions> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return cookieHeader.length > 0
    ? { origin: getConfig().publicBaseUrl, cookieHeader }
    : { origin: getConfig().publicBaseUrl };
}

/** GET /api/v1/courses → { data, page } — สำหรับหน้า RSC (หน้าแรก/แคตตาล็อก) */
export async function getPublishedCourses(): Promise<CourseListResponse> {
  return fetchPublishedCourses(await catalogContext());
}

/** GET /api/v1/categories → { data } — สำหรับหน้า RSC แคตตาล็อก */
export async function getCategories(): Promise<CatalogCategory[]> {
  return fetchCategories(await catalogContext());
}

/**
 * GET /api/v1/courses/{id} → { data } | undefined (404) — สำหรับหน้า RSC รายละเอียดหลักสูตร
 * ครอบด้วย cache() (PB-3): หน้าเดียวเรียกซ้ำใน request เดียว — generateMetadata + ตัวหน้า
 * (src/app/(public)/courses/[id]/page.tsx) → dedupe ให้ยิง BFF ครั้งเดียวต่อ request (pure read)
 * ลายเซ็นจากมุมมองผู้เรียกเหมือนเดิม (cache() คืนฟังก์ชันที่เรียก/await ได้เหมือนเดิม)
 */
export const findPublishedCourse = cache(
  async (id: string): Promise<CourseDetail | undefined> =>
    fetchPublishedCourse(id, await catalogContext()),
);

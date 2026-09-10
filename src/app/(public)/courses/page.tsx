/**
 * หน้าแคตตาล็อกหลักสูตร — CAT-002 (รายการ published แก่ guest) + CAT-003 (ค้นหา/กรอง AND)
 * ข้อมูล: fixture (src/lib/fixtures/catalog.ts) — Phase 1 สลับเป็น BFF GET /courses, /categories
 * โครงหน้า: Public Shell (DS §6.1) · Skeleton loading state (DS §5.13) ผ่าน Suspense streaming
 */

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { CourseCardGridSkeleton, SkeletonBlock } from "@/components/course/Skeleton";
import { getCategories, getPublishedCourses } from "@/lib/fixtures/catalog";

import { CourseCatalogView } from "@/components/course/CourseCatalogView";

export const metadata: Metadata = {
  title: "หลักสูตรทั้งหมด · ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
  description:
    "ค้นหาและกรองหลักสูตรอบรมที่เปิดรับลงทะเบียนของสภาทนายความแห่งประเทศไทย แยกตามหมวดหลักสูตรและกลุ่มเป้าหมาย พร้อมจำนวนบทเรียน ชั่วโมงเรียน และหน่วยกิต",
};

export default function CoursesPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:py-12">
      <nav aria-label="เส้นทาง" className="text-sm text-ink-500">
        <ol className="flex items-center gap-1.5">
          <li>
            <Link className="hover:text-brand-700 hover:underline" href="/">
              หน้าแรก
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="font-medium text-ink-700">
            หลักสูตรทั้งหมด
          </li>
        </ol>
      </nav>

      <header className="mt-4 mb-8 max-w-2xl">
        <h1 className="font-heading text-2xl font-bold text-ink-900 sm:text-3xl">
          หลักสูตรฝึกอบรมทั้งหมด
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500 sm:text-base">
          หลักสูตรที่เผยแพร่และเปิดรับลงทะเบียน เรียนได้ทันทีหลังลงทะเบียน
          โดยไม่ต้องเข้าสู่ระบบก่อนก็เลือกดูได้ทุกหลักสูตร
        </p>
      </header>

      <Suspense fallback={<CoursesLoadingFallback />}>
        <CourseCatalogSection />
      </Suspense>
    </div>
  );
}

/** Loading state ของหน้า — Skeleton การ์ดหลักสูตร (DS §5.13) */
function CoursesLoadingFallback() {
  return (
    <div aria-busy="true">
      <SkeletonBlock className="mb-4 h-5 w-44" />
      <CourseCardGridSkeleton count={6} />
    </div>
  );
}

/** ส่วนข้อมูล (async) — Phase 1: จุดเดียวที่เปลี่ยนเป็นเรียก BFF จริง */
async function CourseCatalogSection() {
  const [list, categories] = await Promise.all([getPublishedCourses(), getCategories()]);
  return <CourseCatalogView categories={categories} list={list} />;
}

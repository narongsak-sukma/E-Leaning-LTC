/**
 * หน้าแรก — hero + หลักสูตรแนะนำ (BFF GET /api/v1/courses — เฉพาะ published ตาม RLS) + ลิงก์ไป /courses
 * หลักสูตรแนะนำดึงผ่าน getPublishedCourses() (src/lib/fixtures/catalog.ts — fetch BFF จริง Phase 1)
 * หมายเหตุ: หน้านี้อยู่นอก route group (public) (สืบทอดจาก B-01) จึงมีโครง header/footer ของตัวเอง
 */

import type { Metadata } from "next";
import Link from "next/link";

import { CourseCard } from "@/components/course/CourseCard";
import { getPublishedCourses } from "@/lib/fixtures/catalog.server";

export const metadata: Metadata = {
  title: "ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
  description:
    "หลักสูตรออนไลน์เพื่อรักษาใบอนุญาตทนายความ — เลือกหลักสูตรที่เปิดรับลงทะเบียน เรียนตามจังหวะของคุณ สอบออนไลน์ และสะสมหน่วยกิตเข้า Credit Bank",
};

const NAV_ITEMS = [
  { href: "/", label: "หน้าแรก" },
  { href: "/courses", label: "หลักสูตรฝึกอบรม" },
  { href: "/login", label: "เข้าสู่ระบบ" },
] as const;

export default async function HomePage() {
  const courseList = await getPublishedCourses();
  const featuredCourses = courseList.data.slice(0, 3);

  return (
    <div className="min-h-dvh bg-mist-50">
      <a className="skip-link" href="#main">
        ข้ามไปยังเนื้อหาหลัก
      </a>
      <div className="bg-brand-900 text-center text-xs text-mist-100 sm:text-sm">
        <div className="mx-auto max-w-5xl px-4 py-2">
          สภาทนายความแห่งประเทศไทย · โทร 0 2351 1128
        </div>
      </div>
      <header className="border-b border-mist-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <p className="font-heading text-base font-semibold text-brand-900 sm:text-lg">
            ระบบฝึกอบรมออนไลน์
          </p>
          <nav aria-label="เมนูหลัก">
            <ul className="flex items-center gap-5 text-sm font-medium text-ink-600">
              {NAV_ITEMS.map((item) => (
                <li key={item.href}>
                  <Link className="hover:text-brand-700" href={item.href}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main">
        <section className="bg-brand-800 text-mist-50">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:py-20">
            <p className="mb-3 text-sm font-medium text-gold-300">
              ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
            </p>
            <h1 className="max-w-2xl font-heading text-2xl font-bold leading-snug sm:text-4xl">
              หลักสูตรออนไลน์เพื่อรักษาใบอนุญาตทนายความ
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-mist-100 sm:text-base">
              เรียนรู้ด้วยตนเองตามเวลาที่สะดวก บันทึกหน่วยกิตอัตโนมัติ (Credit Bank)
              และสอบออนไลน์อย่างเป็นทางการ ตั้งแต่ลงทะเบียนจนออกประกาศนียบัตรในระบบเดียว
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                className="rounded-lg bg-gold-500 px-6 py-3 font-heading text-sm font-semibold text-brand-900 shadow-pop hover:bg-gold-300"
                href="/courses"
              >
                ดูหลักสูตรที่เปิดรับ
              </Link>
              <Link
                className="rounded-lg border border-mist-100 px-6 py-3 font-heading text-sm font-semibold text-mist-50 hover:bg-brand-700"
                href="/login"
              >
                เข้าสู่ระบบเพื่อเรียน
              </Link>
            </div>
          </div>
        </section>

        <section aria-labelledby="featured-heading" className="mx-auto max-w-5xl px-4 py-14">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-heading text-xl font-bold text-brand-900 sm:text-2xl" id="featured-heading">
                หลักสูตรแนะนำ
              </h2>
              <p className="mt-1 text-sm text-ink-500">
                เปิดรับลงทะเบียน เรียนได้ทันทีตามจังหวะของคุณ
              </p>
            </div>
            <Link
              className="font-heading text-sm font-semibold text-brand-600 hover:text-brand-700 hover:underline"
              href="/courses"
            >
              ดูหลักสูตรทั้งหมด →
            </Link>
          </div>
          <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {featuredCourses.map((course) => (
              <li key={course.id}>
                <CourseCard course={course} />
              </li>
            ))}
          </ul>
        </section>

        <section className="mx-auto max-w-5xl px-4 pb-14">
          <h2 className="font-heading text-xl font-bold text-brand-900 sm:text-2xl">
            บริการหลักของระบบ
          </h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li className="rounded-xl border border-mist-200 bg-white p-5 shadow-card" key={f.title}>
                <p className="font-heading text-base font-semibold text-brand-900">{f.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="border-t border-gold-200 bg-gold-50">
          <div className="mx-auto max-w-5xl px-4 py-6">
            <p className="text-sm leading-relaxed text-ink-600">
              <strong className="font-semibold text-ink-700">หมายเหตุ:</strong>{" "}
              ระบบอยู่ระหว่างการพัฒนา (Wave C — แคตตาล็อก/ลงทะเบียน/ความคืบหน้า)
              ข้อมูลหลักสูตรดึงจากระบบโดยตรง — หากยังไม่มีหลักสูตรเผยแพร่ ส่วนนี้จะว่าง
              ติดต่อสอบถามได้ที่สำนักงานสภาทนายความแห่งประเทศไทย โทร 0 2351 1128
            </p>
          </div>
        </section>
      </main>
      <footer className="bg-brand-900 text-mist-200">
        <div className="mx-auto max-w-5xl px-4 py-6 text-xs leading-relaxed sm:text-sm">
          <p className="font-heading font-semibold text-mist-50">
            ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
          </p>
          <p className="mt-1">สอบถามเพิ่มเติม โทร 0 2351 1128 ในวันและเวลาราชการ</p>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  {
    title: "หลักสูตรออนไลน์",
    body: "เรียนบทวิดีโอและเอกสารตามหลักสูตรที่สภาทนายความรับรอง ตรวจสอบความคืบหน้าได้ทุกขั้นตอน",
  },
  {
    title: "การสอบออนไลน์",
    body: "สอบรับประกาศนียบัตรตามรอบที่กำหนด พร้อมกติกาจำนวนครั้งและเวลาสอบที่ชัดเจน",
  },
  {
    title: "ธนาคารหน่วยกิต",
    body: "สะสมหน่วยกิตอบรมการฝึกอบรมเพื่อขอต่ออายุใบอนุญาตทนายความ ตรวจสถานะได้ตลอดเวลา",
  },
] as const;

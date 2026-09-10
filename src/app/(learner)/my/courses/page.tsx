/**
 * หน้า "หลักสูตรของฉัน" (/my/courses) — LRN-002/009
 *
 * Phase 1: โหลดจาก BFF จริงผ่าน learning.server (GET /me/enrollments +
 * GET /courses/{id} + GET /courses/{id}/progress ต่อหลักสูตร)
 * สถานะว่าง/ผิดพลาดแสดงข้อความไทยสุภาพตาม DESIGN-SYSTEM §5.12 (ห้ามพื้นที่ว่างเปล่า)
 */
import type { Metadata } from "next";
import Link from "next/link";

import { ContinueCard } from "@/components/learner/continue-card";
import { ProgressBar } from "@/components/learner/progress-bar";
import { loadMyCoursesPageData } from "@/lib/fixtures/learning.server";

export const metadata: Metadata = {
  title: "หลักสูตรของฉัน — ระบบฝึกอบรมออนไลน์",
  description: "หลักสูตรที่ลงทะเบียนและความคืบหน้าการเรียนของท่าน",
};

/** ป้ายสถานะการลงทะเบียน (active ไม่แสดงป้าย) */
const ENROLLMENT_STATUS_TEXT: Record<string, string> = {
  completed: "เรียนจบหลักสูตรแล้ว",
  expired: "สิทธิ์เรียนหมดอายุ — กรุณาติดต่อเจ้าหน้าที่สภาทนายความฯ",
  cancelled: "การลงทะเบียนถูกยกเลิก — กรุณาติดต่อเจ้าหน้าที่สภาทนายความฯ",
};

export default async function MyCoursesPage() {
  const data = await loadMyCoursesPageData();

  if (data.kind === "error") {
    return (
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink-900">หลักสูตรของฉัน</h1>
        <div
          role="alert"
          className="mt-5 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center shadow-card"
        >
          <p className="font-heading text-base font-semibold text-danger-700">
            โหลดข้อมูลหลักสูตรของท่านไม่สำเร็จ
          </p>
          <p className="mt-1 text-sm text-danger-600">
            กรุณารีเฟรชหน้าเว็บเพื่อลองใหม่อีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่
          </p>
        </div>
      </div>
    );
  }

  if (data.kind === "empty") {
    return (
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink-900">หลักสูตรของฉัน</h1>
        <section
          aria-labelledby="my-courses-empty-heading"
          className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
        >
          <h2 id="my-courses-empty-heading" className="font-heading text-lg font-bold text-ink-900">
            ยังไม่มีหลักสูตรที่ลงทะเบียน
          </h2>
          <p className="mt-2 text-sm text-ink-600">
            ท่านยังไม่ได้ลงทะเบียนหลักสูตรใด สามารถเลือกชมหลักสูตรที่เปิดให้เรียนได้จากหน้าแคตตาล็อก
          </p>
          <Link
            href="/courses"
            className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
          >
            เลือกชมหลักสูตร
          </Link>
        </section>
      </div>
    );
  }

  const courses = data.courses;
  const continueCourse = courses.find((course) => course.continueLesson !== null) ?? null;
  const hasUnloaded = courses.some((course) => !course.isLoaded);

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">หลักสูตรของฉัน</h1>
      <p className="mt-1 text-sm text-ink-600">
        หลักสูตรที่ท่านลงทะเบียน {courses.length} หลักสูตร
        {data.hasMore ? " (แสดงเฉพาะรายการล่าสุด)" : ""}
      </p>

      {continueCourse !== null && continueCourse.continueLesson !== null ? (
        <div className="mt-5">
          <ContinueCard
            courseId={continueCourse.id}
            courseTitle={continueCourse.title}
            lesson={continueCourse.continueLesson}
          />
        </div>
      ) : null}

      {hasUnloaded ? (
        <p
          role="note"
          className="mt-4 rounded-[10px] border border-gold-200 bg-gold-50 px-4 py-3 text-sm text-ink-700"
        >
          บางหลักสูตรโหลดความคืบหน้าไม่สำเร็จ — กรุณารีเฟรชหน้าเว็บเพื่อลองใหม่อีกครั้ง
        </p>
      ) : null}

      <section aria-labelledby="my-course-list-heading" className="mt-6">
        <h2 id="my-course-list-heading" className="font-heading text-lg font-bold text-ink-900">
          หลักสูตรที่ลงทะเบียน
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          {courses.map((course) => {
            const statusText = ENROLLMENT_STATUS_TEXT[course.enrollmentStatus];
            return (
              <li
                key={course.id}
                className="flex flex-col rounded-[14px] border border-mist-200 bg-white p-5 shadow-card"
              >
                <p className="text-xs font-semibold text-brand-600">{course.category}</p>
                <h3 className="mt-1 font-heading text-base font-bold text-ink-900">{course.title}</h3>
                {statusText !== undefined ? (
                  <p className="mt-1 text-sm font-semibold text-danger-600">{statusText}</p>
                ) : null}
                <p className="mt-1 text-sm text-ink-600 tabular-nums">
                  เรียนแล้ว {course.completedCount} จาก {course.lessonCount} บทเรียน
                </p>
                <div className="mt-3">
                  <ProgressBar percent={course.progressPercent} label="ความคืบหน้าหลักสูตร" />
                </div>
                <div className="mt-auto pt-4">
                  <Link
                    href={`/courses/${encodeURIComponent(course.id)}/learn`}
                    className="text-sm font-semibold text-brand-700 hover:text-brand-800"
                  >
                    {course.continueLesson !== null
                      ? `เรียนต่อ: ${course.continueLesson.title}`
                      : "เริ่มเรียนที่บทเรียนแรก"}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

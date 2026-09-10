/**
 * หน้า "หลักสูตรของฉัน" (/my/courses) — LRN-002/009
 * การ์ดเรียนต่อจากที่ค้าง (≤2 คลิก) + รายการหลักสูตรที่ลงทะเบียน (fixture — Phase 0)
 */
import type { Metadata } from "next";
import Link from "next/link";

import { ContinueCard } from "@/components/learner/continue-card";
import { ProgressBar } from "@/components/learner/progress-bar";
import { getMyEnrolledCourses } from "@/lib/fixtures/learning";

export const metadata: Metadata = {
  title: "หลักสูตรของฉัน — ระบบฝึกอบรมออนไลน์",
  description: "หลักสูตรที่ลงทะเบียนและความคืบหน้าการเรียนของท่าน",
};

export default function MyCoursesPage() {
  const courses = getMyEnrolledCourses();
  const continueCourse = courses.find((course) => course.continueLesson !== null) ?? null;

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">หลักสูตรของฉัน</h1>
      <p className="mt-1 text-sm text-ink-600">
        หลักสูตรที่ท่านลงทะเบียน {courses.length} หลักสูตร
        <span className="sr-only"> (ที่มีข้อมูลในระบบปัจจุบัน)</span>
      </p>

      {continueCourse?.continueLesson ? (
        <div className="mt-5">
          <ContinueCard
            courseId={continueCourse.id}
            courseTitle={continueCourse.title}
            lesson={continueCourse.continueLesson}
          />
        </div>
      ) : null}

      <section aria-labelledby="my-course-list-heading" className="mt-6">
        <h2 id="my-course-list-heading" className="font-heading text-lg font-bold text-ink-900">
          หลักสูตรที่ลงทะเบียน
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          {courses.map((course) => (
            <li
              key={course.id}
              className="flex flex-col rounded-[14px] border border-mist-200 bg-white p-5 shadow-card"
            >
              <p className="text-xs font-semibold text-brand-600">{course.category}</p>
              <h3 className="mt-1 font-heading text-base font-bold text-ink-900">{course.title}</h3>
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
                  {course.continueLesson
                    ? `เรียนต่อ: ${course.continueLesson.title}`
                    : "เริ่มเรียนที่บทเรียนแรก"}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

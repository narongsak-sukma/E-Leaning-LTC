/**
 * CourseOutlineNav — sidebar โครงสร้างหลักสูตร (DESIGN-SYSTEM §6.2)
 * พื้น brand-800 · บทที่เรียนจบแล้วมีเครื่องหมาย ✓ · บทปัจจุบันขอบทอง 3px + aria-current="page"
 * Server Component — รับ outline จาก fixture แล้วแสดงเป็นลิงก์นำทางรายบทเรียน
 */
import Link from "next/link";

import { ProgressBar } from "./progress-bar";
import type { CourseOutline } from "@/lib/fixtures/learning";

const STATUS_TEXT: Record<string, string> = {
  completed: "เรียนจบแล้ว",
  in_progress: "กำลังเรียน",
  not_started: "ยังไม่เริ่มเรียน",
};

export function CourseOutlineNav({
  outline,
  currentLessonId,
}: {
  outline: CourseOutline;
  currentLessonId: string | null;
}) {
  return (
    <aside aria-label="โครงสร้างหลักสูตร" className="rounded-[14px] bg-brand-800 p-5 shadow-card">
      <p className="text-xs font-semibold text-brand-300">หลักสูตร</p>
      <h2 className="mt-1 font-heading text-base font-bold text-white">{outline.title}</h2>
      <p className="mt-0.5 text-xs text-brand-200">{outline.category}</p>
      <div className="mt-3">
        <ProgressBar onDark label="ความคืบหน้าหลักสูตร" percent={outline.progressPercent} />
      </div>
      <nav aria-label="รายชื่อบทเรียน" className="mt-4 space-y-4">
        {outline.modules.map((module) => (
          <div key={module.id}>
            <p className="text-xs font-semibold text-brand-200">{module.title}</p>
            <ul className="mt-1 space-y-1">
              {module.lessons.map((lesson) => {
                const isCurrent = lesson.id === currentLessonId;
                return (
                  <li key={lesson.id}>
                    <Link
                      href={`/courses/${encodeURIComponent(outline.id)}/learn/${encodeURIComponent(lesson.id)}`}
                      aria-current={isCurrent ? "page" : undefined}
                      className={`flex items-start gap-2 rounded-[8px] border-l-[3px] px-3 py-2 text-sm ${
                        isCurrent
                          ? "border-gold-300 bg-white/10 font-semibold text-white"
                          : "border-transparent text-brand-100 hover:bg-white/5"
                      }`}
                    >
                      {lesson.status === "completed" ? (
                        <span aria-hidden="true" className="text-success-600">
                          ✓
                        </span>
                      ) : (
                        <span aria-hidden="true" className="text-brand-300">
                          •
                        </span>
                      )}
                      <span className="flex-1">
                        {lesson.title}
                        <span className="sr-only"> — {STATUS_TEXT[lesson.status] ?? "ยังไม่เริ่มเรียน"}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

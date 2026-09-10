/**
 * ContinueCard — DESIGN-SYSTEM §7.3 (เรียนต่อจากที่ค้าง) + LRN-002/009
 *
 * การ์ดแรกของ "หลักสูตรของฉัน": ชื่อบทที่ค้าง + % ความคืบหน้า + ปุ่มเดียว
 * "เรียนต่อจากที่ค้าง" — จากหน้ารวมถึงบทเรียน = 1 คลิก (LRN-009 AC: ภายใน 2 คลิก)
 * ลิงก์บอกชื่อบทที่ค้างในข้อความ (a11y — DS §8 หน้า 07)
 */
import Link from "next/link";

import { ProgressBar } from "./progress-bar";
import type { ContinueLessonInfo } from "@/lib/fixtures/learning";

export function ContinueCard({
  courseId,
  courseTitle,
  lesson,
}: {
  courseId: string;
  courseTitle: string; // ชื่อหลักสูตร — แสดงเหนือป้ายบทเรียน
  lesson: ContinueLessonInfo;
}) {
  const positionPercent =
    lesson.positionSeconds !== null && lesson.durationSeconds !== null && lesson.durationSeconds > 0
      ? Math.round((lesson.positionSeconds / lesson.durationSeconds) * 100)
      : null;
  const href = `/courses/${encodeURIComponent(courseId)}/learn/${encodeURIComponent(lesson.id)}`;
  const isResuming = lesson.status === "in_progress";
  return (
    <section
      aria-labelledby="continue-learning-heading"
      className="rounded-[14px] border border-gold-200 bg-gold-50 p-5 shadow-card sm:p-6"
    >
      <h2 id="continue-learning-heading" className="font-heading text-lg font-bold text-ink-900">
        เรียนต่อจากที่ค้าง
      </h2>
      <p className="mt-1 text-sm text-ink-600">
        {courseTitle} · {lesson.label}
      </p>
      <p className="mt-3 font-heading text-base font-semibold text-ink-900">{lesson.title}</p>
      {positionPercent !== null ? (
        <div className="mt-3 max-w-md">
          <ProgressBar percent={positionPercent} label="ดูวิดีโอไปแล้ว (ตำแหน่งล่าสุด)" />
        </div>
      ) : null}
      <div className="mt-4">
        <Link
          href={href}
          className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
        >
          {isResuming ? "เรียนต่อจากที่ค้าง" : "เริ่มเรียนบทเรียนแรก"}
        </Link>
      </div>
    </section>
  );
}

/**
 * Course Card — DS §5.3
 * ปก 16:9 (gradient โทน brand ตามหมวด) → badge หมวด (มุมซ้ายบนปก) → ชื่อหลักสูตร (h3 · 2 บรรทัด)
 * → คำโปรย → metadata แถวเดียว (บทเรียน · ชั่วโมง · หน่วยกิต) → แถวล่าง: ระดับ + สถานะเปิดรับ + จำนวนผู้เรียน
 * การ์ดทั้งใบคลิกได้ (stretched link) — hover ยกขึ้น 2px + เงา pop
 */

import Link from "next/link";

import { Badge, CourseStatusBadge } from "@/components/course/Badge";
import { AwardIcon, BookOpenIcon, ClockIcon, UsersIcon } from "@/components/course/icons";
import {
  courseLevelLabel,
  formatHours,
  formatLearnerCount,
  type CourseListItem,
} from "@/lib/fixtures/catalog";

export function CourseCard({ course }: { course: CourseListItem }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-[14px] bg-white shadow-card transition hover:-translate-y-0.5 hover:shadow-pop focus-within:-translate-y-0.5">
      <Link
        className="focus-visible:outline-offset-[-3px]"
        href={`/courses/${course.id}`}
      >
        <div className="relative aspect-video w-full bg-linear-to-br from-brand-700 to-brand-950">
          <div className="absolute left-3 top-3 flex flex-wrap gap-2">
            <Badge tone="brand">{course.category.nameTh}</Badge>
          </div>
          {!course.isPublic ? (
            <span className="absolute right-3 top-3">
              <Badge tone="warning">เฉพาะทนายความ</Badge>
              <span className="sr-only">หลักสูตรนี้สำหรับทนายความที่ผูกใบอนุญาตแล้ว</span>
            </span>
          ) : null}
          <span className="absolute bottom-3 right-4 text-sm font-semibold text-brand-200">
            {course.code}
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-2 p-5">
          <h3 className="font-heading text-lg font-semibold leading-snug text-ink-900 line-clamp-2">
            {course.titleTh}
          </h3>
          <p className="text-sm leading-relaxed text-ink-500 line-clamp-2">{course.summary}</p>
          <ul className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-500">
            <li className="flex items-center gap-1.5">
              <BookOpenIcon size={16} />
              <span className="tabular-nums">{course.lessonCount}</span> บทเรียน
            </li>
            <li className="flex items-center gap-1.5">
              <ClockIcon size={16} />
              <span className="tabular-nums">{formatHours(course.durationHours)}</span>
            </li>
            <li className="flex items-center gap-1.5">
              <AwardIcon size={16} />
              <span className="tabular-nums">{course.credits}</span> หน่วยกิต
            </li>
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-mist-200 pt-3 text-sm">
            <span className="text-ink-500">{courseLevelLabel(course.level)}</span>
            <CourseStatusBadge status={course.status} />
            <span className="ms-auto flex items-center gap-1.5 text-ink-500">
              <UsersIcon size={16} />
              <span className="tabular-nums">ผู้เรียน {formatLearnerCount(course.learnerCount)} คน</span>
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

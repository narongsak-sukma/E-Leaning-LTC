/**
 * หน้ารายละเอียดหลักสูตร — CAT-004 (guest เห็นคำอธิบาย โครงสร้างโมดูล/บทเรียน วิทยากร
 * ชั่วโมง credit เงื่อนไขสอบ จำนวนผู้ลงทะเบียน) + CAT-007 (เฉพาะทนายความ: เห็นได้แต่แจ้งเงื่อนไขเป็นไทย)
 * ปุ่ม "ลงทะเบียนเรียน": guest → /login?next=<path ปัจจุบัน> (กลับมาหลักสูตรเดิมหลังเข้าสู่ระบบ)
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Badge, CourseStatusBadge } from "@/components/course/Badge";
import {
  AwardIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ClockIcon,
  FileTextIcon,
  ListChecksIcon,
  PlayIcon,
  UsersIcon,
} from "@/components/course/icons";
import { SkeletonBlock } from "@/components/course/Skeleton";
import {
  courseLevelLabel,
  formatDuration,
  formatHours,
  formatLearnerCount,
  formatThaiDate,
  type CourseDetail,
  type CourseLesson,
} from "@/lib/fixtures/catalog";
import { findPublishedCourse } from "@/lib/fixtures/catalog.server";

type CoursePageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: CoursePageProps): Promise<Metadata> {
  const { id } = await params;
  const course = await findPublishedCourse(id);
  if (!course) {
    return {
      title: "ไม่พบหลักสูตร · ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
      description: "ไม่พบหลักสูตรที่คุณค้นหา อาจถูกปิดการเผยแพร่หรือรหัสไม่ถูกต้อง",
    };
  }
  return {
    title: `${course.titleTh} · รายละเอียดหลักสูตร · ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย`,
    description:
      course.summary ??
      `หลักสูตร ${course.titleTh} ของสภาทนายความแห่งประเทศไทย — โครงสร้างโมดูล บทเรียน เงื่อนไขการสอบ และหน่วยกิตที่จะได้รับ`,
  };
}

export default function CourseDetailPage({ params }: CoursePageProps) {
  return (
    <Suspense fallback={<CourseDetailSkeleton />}>
      <CourseDetailContent params={params} />
    </Suspense>
  );
}

async function CourseDetailContent({ params }: CoursePageProps) {
  const { id } = await params;
  const course = await findPublishedCourse(id);
  if (!course) {
    // guest เห็นเฉพาะ published (RLS/TC-005) — ไม่เจอ = ไม่เปิดเผยการมีอยู่ (API ตอบ 404 ERR-CRS-001)
    notFound();
  }

  const totalLessons = course.modules.reduce((sum, m) => sum + m.lessons.length, 0);
  const enrollHref = `/login?next=${encodeURIComponent(`/courses/${course.id}`)}`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:py-12">
      <nav aria-label="เส้นทาง" className="text-sm text-ink-500">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link className="hover:text-brand-700 hover:underline" href="/">
              หน้าแรก
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link className="hover:text-brand-700 hover:underline" href="/courses">
              หลักสูตรทั้งหมด
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>{course.category.nameTh}</li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="font-medium text-ink-700">
            {course.titleTh}
          </li>
        </ol>
      </nav>

      <div className="mt-4 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ───────── เนื้อหาหลัก ───────── */}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">{course.category.nameTh}</Badge>
            <CourseStatusBadge status={course.status} />
            {!course.isPublic ? <Badge tone="warning">เฉพาะทนายความ</Badge> : null}
          </div>

          <h1 className="mt-3 font-heading text-2xl font-bold leading-snug text-ink-900 sm:text-4xl">
            {course.titleTh}
          </h1>
          {course.summary !== null ? (
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink-600">{course.summary}</p>
          ) : null}

          <p className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-500">
            <span className="flex items-center gap-1.5">
              <UsersIcon size={16} />
              ผู้เรียน <span className="tabular-nums">{formatLearnerCount(course.learnerCount)}</span> คน
            </span>
            <span className="flex items-center gap-1.5">
              <BookOpenIcon size={16} />
              <span className="tabular-nums">{totalLessons}</span> บทเรียน ·{" "}
              <span className="tabular-nums">{course.modules.length}</span> โมดูล ·{" "}
              {formatHours(course.durationHours)}
            </span>
            <span>
              อัปเดตล่าสุด {formatThaiDate(course.publishedAt)}
            </span>
          </p>

          <section aria-labelledby="about-heading" className="mt-10">
            <h2 className="font-heading text-xl font-semibold text-brand-900" id="about-heading">
              เกี่ยวกับหลักสูตรนี้
            </h2>
            <p className="mt-3 leading-relaxed text-ink-700">{course.description}</p>
          </section>

          <section aria-labelledby="outcomes-heading" className="mt-10">
            <h2 className="font-heading text-xl font-semibold text-brand-900" id="outcomes-heading">
              สิ่งที่จะได้เรียนรู้
            </h2>
            <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {course.outcomes.map((outcome) => (
                <li className="flex items-start gap-2 text-ink-700" key={outcome}>
                  <span className="mt-0.5 shrink-0 text-success-600">
                    <CheckCircleIcon size={18} />
                  </span>
                  {outcome}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="structure-heading" className="mt-10">
            <h2 className="font-heading text-xl font-semibold text-brand-900" id="structure-heading">
              โครงสร้างหลักสูตร
            </h2>
            <p className="mt-1 text-sm text-ink-500">
              <span className="tabular-nums">{course.modules.length}</span> โมดูล ·{" "}
              <span className="tabular-nums">{totalLessons}</span> บทเรียน · {formatHours(course.durationHours)}
            </p>
            <ol className="mt-4 flex flex-col gap-4">
              {course.modules.map((module) => (
                <ModuleCard isPreviewModule={module.isPreview} key={module.id} module={module} />
              ))}
            </ol>
          </section>

          {course.exam !== null ? (
            <section aria-labelledby="exam-heading" className="mt-10">
              <h2 className="font-heading text-xl font-semibold text-brand-900" id="exam-heading">
                การสอบปลายหลักสูตร
              </h2>
              <div className="mt-3 rounded-[14px] border border-gold-200 bg-gold-50 p-5">
                <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-700">
                  <li className="tabular-nums">{course.exam.questionCount} ข้อ</li>
                  <li className="tabular-nums">
                    เวลาสอบ {course.exam.timeLimitMinutes} นาที
                  </li>
                  <li className="tabular-nums">เกณฑ์ผ่าน {course.exam.passScorePct}%</li>
                  <li className="tabular-nums">สอบได้ไม่เกิน {course.exam.maxAttempts} ครั้ง</li>
                </ul>
                <p className="mt-3 text-sm leading-relaxed text-ink-500">
                  ผู้เรียนที่สอบผ่านเกณฑ์จะได้รับประกาศนียบัตรจากสภาทนายความแห่งประเทศไทย พร้อมบันทึก{" "}
                  <span className="tabular-nums">{course.credits}</span> หน่วยกิตเข้า Credit Bank
                  * แบบทดสอบย่อยท้ายโมดูลใช้ทบทวนความเข้าใจ ทำซ้ำได้ ไม่นับหน่วยกิตโดยตรง
                </p>
              </div>
            </section>
          ) : null}

          <section aria-labelledby="instructors-heading" className="mt-10">
            <h2 className="font-heading text-xl font-semibold text-brand-900" id="instructors-heading">
              วิทยากร
            </h2>
            <ul className="mt-3 grid gap-4 sm:grid-cols-2">
              {course.instructors.map((instructor) => (
                <li className="rounded-[14px] border border-mist-200 bg-white p-5 shadow-card" key={instructor.nameTh}>
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-100 font-heading text-lg font-semibold text-brand-800"
                    >
                      {instructor.nameTh.slice(0, 1)}
                    </span>
                    <div>
                      <p className="font-heading font-semibold text-ink-900">{instructor.nameTh}</p>
                      {instructor.titleTh !== null ? (
                        <p className="text-sm text-ink-500">{instructor.titleTh}</p>
                      ) : null}
                    </div>
                  </div>
                  {instructor.bio !== null ? (
                    <p className="mt-3 text-sm leading-relaxed text-ink-500">{instructor.bio}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* ───────── แถบด้านข้าง: สรุปหลักสูตร + ลงทะเบียน ───────── */}
        <aside aria-label="สรุปหลักสูตรและการลงทะเบียน" className="lg:sticky lg:top-24 lg:self-start">
          <div className="overflow-hidden rounded-[14px] border border-mist-200 bg-white shadow-card">
            <div className="aspect-video w-full bg-linear-to-br from-brand-700 to-brand-950">
              <div className="flex h-full items-end justify-between p-4">
                <Badge tone="brand">{course.category.nameTh}</Badge>
                <span className="text-sm font-semibold text-brand-200">{course.code}</span>
              </div>
            </div>
            <div className="p-5">
              <p className="font-heading text-lg font-bold text-brand-900">
                <span className="tabular-nums">{course.credits}</span> หน่วยกิต · เรียนฟรี
              </p>
              <p className="mt-1 text-sm text-ink-500">
                เรียนได้ทันทีหลังลงทะเบียน · ไม่จำกัดเวลาเรียน
              </p>

              <dl className="mt-4 flex flex-col gap-2.5 border-t border-mist-200 pt-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-ink-500">
                    <BookOpenIcon size={16} />
                    จำนวนบทเรียน
                  </dt>
                  <dd className="tabular-nums text-ink-700">
                    {totalLessons} บทเรียน · {course.modules.length} โมดูล
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-ink-500">
                    <ClockIcon size={16} />
                    เวลาเรียนรวม
                  </dt>
                  <dd className="text-ink-700">{formatHours(course.durationHours)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-ink-500">
                    <AwardIcon size={16} />
                    หน่วยกิตที่ได้รับ
                  </dt>
                  <dd className="tabular-nums text-ink-700">{course.credits} หน่วยกิต</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-ink-500">
                    <ListChecksIcon size={16} />
                    ระดับความยาก
                  </dt>
                  <dd className="text-ink-700">{courseLevelLabel(course.level)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-ink-500">
                    <FileTextIcon size={16} />
                    ภาษา
                  </dt>
                  <dd className="text-ink-700">ภาษาไทย</dd>
                </div>
              </dl>

              {!course.isPublic ? (
                <p className="mt-4 rounded-[10px] bg-warning-50 px-3.5 py-2.5 text-sm leading-relaxed text-warning-600">
                  หลักสูตรนี้สำหรับทนายความที่ผูกเลขที่ใบอนุญาตแล้วเท่านั้น
                  หลังเข้าสู่ระบบจึงจะลงทะเบียนได้ (สอดคล้องเงื่อนไขหลักสูตร)
                </p>
              ) : null}

              <Link
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-brand-600 px-[26px] py-3.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700"
                href={enrollHref}
              >
                ลงทะเบียนเรียน
              </Link>
              <p className="mt-2 text-center text-xs text-ink-500">
                ผู้ที่ยังไม่ได้เข้าสู่ระบบจะพาไปหน้าเข้าสู่ระบบก่อน แล้วกลับมาที่หลักสูตรนี้
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** โมดูล 1 ก้อน + รายชื่อบทเรียน (ประเภทเนื้อหา: วิดีโอ / เอกสาร / แบบทดสอบย่อย) */
function ModuleCard({ module, isPreviewModule }: { module: CourseDetail["modules"][number]; isPreviewModule: boolean }) {
  const moduleSeconds = module.lessons.reduce((sum, l) => sum + (l.durationSec ?? 0), 0);
  return (
    <li className="overflow-hidden rounded-[14px] border border-mist-200 bg-white shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-mist-200 bg-mist-100 px-5 py-3">
        <h3 className="font-heading text-base font-semibold text-ink-900">
          <span className="tabular-nums">{module.sortOrder}</span>. {module.titleTh}
        </h3>
        {isPreviewModule ? <Badge tone="gold">ดูตัวอย่างฟรี</Badge> : null}
        <span className="ms-auto text-sm text-ink-500">
          <span className="tabular-nums">{module.lessons.length}</span> บทเรียน · ~{formatHours(moduleSeconds / 3600)}
        </span>
      </div>
      <ol>
        {module.lessons.map((lesson, index) => (
          <LessonRow index={index} key={lesson.id} lesson={lesson} moduleOrder={module.sortOrder} />
        ))}
      </ol>
    </li>
  );
}

function LessonRow({
  lesson,
  index,
  moduleOrder,
}: {
  lesson: CourseLesson;
  index: number;
  moduleOrder: number;
}) {
  const typeLabel = getLessonTypeLabel(lesson);
  const typeIcon = getLessonTypeIcon(lesson);
  return (
    <li className="flex items-center gap-3 border-b border-mist-100 px-5 py-3 last:border-b-0">
      <span className="w-9 shrink-0 text-sm tabular-nums text-ink-500">
        {moduleOrder}.{index + 1}
      </span>
      <span className="shrink-0 text-brand-600">{typeIcon}</span>
      <span className="flex-1 text-ink-700">
        {lesson.titleTh}
        <span className="ms-2 text-sm text-ink-400">({typeLabel})</span>
      </span>
      {lesson.isPreview ? <Badge tone="success">ดูตัวอย่างฟรี</Badge> : null}
      {lesson.durationSec !== null ? (
        <span className="shrink-0 text-sm tabular-nums text-ink-500">
          {formatDuration(lesson.durationSec)}
        </span>
      ) : null}
    </li>
  );
}

function getLessonTypeLabel(lesson: CourseLesson): string {
  if (lesson.type === "video") return "วิดีโอ";
  if (lesson.type === "document") return "เอกสาร";
  return "แบบทดสอบย่อย";
}

function getLessonTypeIcon(lesson: CourseLesson) {
  if (lesson.type === "video") return <PlayIcon size={16} />;
  if (lesson.type === "document") return <FileTextIcon size={16} />;
  return <ListChecksIcon size={16} />;
}

/** Skeleton ของหน้ารายละเอียด (DS §5.13) — แสดงระหว่างโหลดส่วนข้อมูล */
function CourseDetailSkeleton() {
  return (
    <div aria-busy="true" className="mx-auto max-w-7xl px-4 py-8 sm:py-12">
      <SkeletonBlock className="h-5 w-64" />
      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <SkeletonBlock className="h-6 w-40" />
          <SkeletonBlock className="mt-4 h-10 w-4/5" />
          <SkeletonBlock className="mt-3 h-5 w-3/5" />
          <SkeletonBlock className="mt-10 h-6 w-48" />
          <SkeletonBlock className="mt-3 h-24 w-full" />
          <SkeletonBlock className="mt-10 h-6 w-40" />
          <SkeletonBlock className="mt-3 h-64 w-full" />
        </div>
        <SkeletonBlock className="h-96 w-full rounded-[14px]" />
      </div>
    </div>
  );
}

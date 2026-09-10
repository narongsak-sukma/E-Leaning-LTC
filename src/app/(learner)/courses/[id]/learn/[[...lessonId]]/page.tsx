/**
 * หน้าบทเรียน /courses/[id]/learn/[[...lessonId]] — LRN-003..009
 * ไม่ระบุ lessonId = เปิดบทที่ค้าง (resume 2 คลิก)
 * heartbeat ใช้ VIDEO_HEARTBEAT_SEC จาก src/lib/config.ts → prop (ห้าม hardcode)
 * BFF-relative /api/v1/... เท่านั้น — ไม่มี Supabase client ฝั่ง browser (D26/SDS §5.1)
 */
import type { Metadata } from "next";
import Link from "next/link";

import { CourseOutlineNav } from "@/components/learner/course-outline-nav";
import { DocumentViewer } from "@/components/learner/document-viewer";
import { QuizPanel } from "@/components/learner/quiz-panel";
import { VideoPlayer } from "@/components/learner/video-player";
import { getConfig } from "@/lib/config";
import { getLessonDetail, getLessonLabel, getNeighborLessons } from "@/lib/fixtures/learning";

export const metadata: Metadata = {
  title: "บทเรียน — ระบบฝึกอบรมออนไลน์",
  description: "เรียนบทเรียนวิดีโอ เอกสาร และแบบทดสอบ",
};

type PageParams = Promise<{ id: string; lessonId?: string[] }>;

export default async function LessonPage({ params }: { params: PageParams }) {
  const { id, lessonId } = await params;
  const lessonIdParam = lessonId?.[0];
  const resolved = getLessonDetail(id, lessonIdParam);
  const heartbeatIntervalSec = getConfig().learning.videoHeartbeatSec;

  if (!resolved) {
    return (
      <section aria-labelledby="lesson-not-found-heading" className="rounded-[14px] border border-mist-200 bg-white p-6 shadow-card">
        <h1 id="lesson-not-found-heading" className="font-heading text-xl font-bold text-ink-900">
          ไม่พบหลักสูตรหรือบทเรียนที่ร้องขอ
        </h1>
        <p className="mt-2 text-sm text-ink-600">
          หลักสูตรหรือบทเรียนที่ท่านร้องขอไม่พบในระบบ กรุณากลับไปที่หน้าหลักสูตรของฉัน
        </p>
        <Link
          href="/my/courses"
          className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
        >
          กลับไปที่หลักสูตรของฉัน
        </Link>
      </section>
    );
  }

  const { outline, lesson } = resolved;
  const neighbors = getNeighborLessons(id, lesson.lessonId);
  const breadcrumbLabel = getLessonLabel(id, lesson.lessonId) ?? lesson.title;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div>
        <CourseOutlineNav outline={outline} currentLessonId={lesson.lessonId} />
      </div>
      <div className="min-w-0">
        <nav aria-label="เส้นทาง" className="text-sm text-ink-500">
          <ol className="flex flex-wrap items-center gap-1">
            <li>
              <Link href="/my/courses" className="hover:underline">หลักสูตรของฉัน</Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href={`/courses/${encodeURIComponent(id)}/learn`} className="hover:underline">
                {outline.title}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-semibold text-ink-700">{breadcrumbLabel}</li>
          </ol>
        </nav>
        <div className="mt-4 rounded-[14px] border border-mist-200 bg-white p-5 shadow-card">
          {lesson.kind === "video" ? (
            <VideoPlayer
              lessonId={lesson.lessonId}
              title={lesson.title}
              src={lesson.src}
              durationSeconds={lesson.durationSeconds}
              initialPositionSeconds={lesson.initialPositionSeconds}
              heartbeatIntervalSec={heartbeatIntervalSec}
            />
          ) : lesson.kind === "document" ? (
            <DocumentViewer
              lessonId={lesson.lessonId}
              documentTitle={lesson.documentTitle}
              paragraphs={lesson.paragraphs}
            />
          ) : (
            <QuizPanel
              lessonId={lesson.lessonId}
              title={lesson.title}
              questions={lesson.questions}
              passPct={lesson.passPct}
              bestScorePct={lesson.bestScorePct}
              quizId={lesson.quizId}
            />
          )}
        </div>
        {neighbors ? (
          <nav aria-label="บทเรียนถัดไปและก่อนหน้า" className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {neighbors.prev ? (
              <Link
                href={`/courses/${encodeURIComponent(id)}/learn/${encodeURIComponent(neighbors.prev.id)}`}
                className="text-sm font-semibold text-brand-700 hover:text-brand-800"
              >
                ← บทเรียนก่อนหน้า: {neighbors.prev.title}
              </Link>
            ) : (
              <span className="text-sm text-ink-400">นี่คือบทเรียนแรก</span>
            )}
            {neighbors.next ? (
              <Link
                href={`/courses/${encodeURIComponent(id)}/learn/${encodeURIComponent(neighbors.next.id)}`}
                className="text-sm font-semibold text-brand-700 hover:text-brand-800"
              >
                บทเรียนถัดไป: {neighbors.next.title} →
              </Link>
            ) : (
              <span className="text-sm text-ink-400">นี่คือบทเรียนสุดท้าย</span>
            )}
          </nav>
        ) : null}
      </div>
    </div>
  );
}

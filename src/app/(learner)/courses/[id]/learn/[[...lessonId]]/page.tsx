/**
 * หน้าเรียนบทเรียน (/courses/{id}/learn/[lessonId]) — LRN-003/004/005
 *
 * Phase 1: โหลดจาก BFF จริงผ่าน learning.server — โครงสร้างหลักสูตร + ความคืบหน้า +
 * โจทย์ quiz (GET /lessons/{id}/quiz — ไม่มีเฉลย DCR-5) · heartbeat → POST /lessons/{id}/progress
 */
import type { Metadata } from "next";
import Link from "next/link";

import { CourseOutlineNav } from "@/components/learner/course-outline-nav";
import { DocumentViewer } from "@/components/learner/document-viewer";
import { QuizPanel } from "@/components/learner/quiz-panel";
import { VideoPlayer } from "@/components/learner/video-player";
import { getConfig } from "@/lib/config";
import { loadLessonWorkspace } from "@/lib/fixtures/learning.server";

type PageProps = { params: Promise<{ id: string; lessonId?: string[] }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { lessonId } = await params;
  const current = lessonId?.[0];
  return {
    title: current === undefined ? "บทเรียน — ระบบฝึกอบรมออนไลน์" : "บทเรียนต่อเนื่อง — ระบบฝึกอบรมออนไลน์",
  };
}

function ErrorCard({
  heading,
  detail,
  href,
  actionLabel,
}: {
  heading: string;
  detail: string;
  href: string;
  actionLabel: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
    >
      <h1 className="font-heading text-lg font-bold text-ink-900">{heading}</h1>
      <p className="mt-2 text-sm text-ink-600">{detail}</p>
      <Link
        href={href}
        className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
      >
        {actionLabel}
      </Link>
    </div>
  );
}

export default async function LearnLessonPage({ params }: PageProps) {
  const { id, lessonId } = await params;
  const requestedLessonId = lessonId?.[0];
  const workspace = await loadLessonWorkspace(id, requestedLessonId);

  if (workspace.kind === "unauthenticated") {
    return (
      <ErrorCard
        heading="กรุณาเข้าสู่ระบบก่อนเข้าเรียน"
        detail="เซสชันของท่านหมดอายุ กรุณาเข้าสู่ระบบอีกครั้งเพื่อเรียนบทเรียนต่อ"
        href={`/login?next=${encodeURIComponent(`/courses/${encodeURIComponent(id)}/learn`)}`}
        actionLabel="ไปหน้าเข้าสู่ระบบ"
      />
    );
  }
  if (workspace.kind === "not_enrolled") {
    return (
      <ErrorCard
        heading="ยังไม่ได้ลงทะเบียนหลักสูตรนี้"
        detail="ท่านต้องลงทะเบียนหลักสูตรก่อนจึงจะเข้าเรียนบทเรียนได้ สามารถเลือกลงทะเบียนได้จากหน้าแคตตาล็อก"
        href="/courses"
        actionLabel="เลือกชมหลักสูตร"
      />
    );
  }
  if (workspace.kind === "not_found") {
    return (
      <ErrorCard
        heading="ไม่พบหน้าที่ท่านค้นหา"
        detail="ไม่พบหลักสูตรหรือบทเรียนตามลิงก์ที่ท่านเข้า กรุณาตรวจสอบรายการหลักสูตรของท่านอีกครั้ง"
        href="/my/courses"
        actionLabel="กลับหน้าหลักสูตรของฉัน"
      />
    );
  }
  if (workspace.kind === "unavailable") {
    return (
      <ErrorCard
        heading="โหลดบทเรียนไม่สำเร็จ"
        detail="ระบบไม่สามารถโหลดข้อมูลบทเรียนได้ในขณะนี้ กรุณาลองใหม่อีกครั้งภายหลัง"
        href="/my/courses"
        actionLabel="กลับหน้าหลักสูตรของฉัน"
      />
    );
  }

  const { outline, currentLessonId, breadcrumbLabel, prev, next, lesson } = workspace.data;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <CourseOutlineNav outline={outline} currentLessonId={currentLessonId} />
      <div>
        <p className="text-sm text-ink-600">
          <Link href="/my/courses" className="hover:text-brand-700">
            หลักสูตรของฉัน
          </Link>
          {" / "}
          <span className="font-semibold text-ink-800">{outline.title}</span>
          {" / "}
          <span aria-current="page">{breadcrumbLabel}</span>
        </p>
        {lesson.kind === "video" ? (
          <div className="mt-3">
            <VideoPlayer
              lessonId={lesson.lessonId}
              title={lesson.title}
              src={lesson.src}
              durationSeconds={lesson.durationSeconds}
              initialPositionSeconds={lesson.initialPositionSeconds}
              heartbeatIntervalSec={getConfig().learning.videoHeartbeatSec}
            />
          </div>
        ) : null}

        {lesson.kind === "document" ? (
          <div className="mt-3">
            <DocumentViewer
              lessonId={lesson.lessonId}
              documentTitle={lesson.documentTitle}
              paragraphs={[...lesson.paragraphs]}
            />
          </div>
        ) : null}

        {lesson.kind === "quiz" ? (
          <div className="mt-3">
            <QuizPanel
              lessonId={lesson.panel.lessonId}
              title={lesson.panel.title}
              passPct={lesson.panel.passPct}
              maxAttempts={lesson.panel.maxAttempts}
              questions={lesson.panel.questions}
            />
          </div>
        ) : null}

        {lesson.kind === "quiz_unavailable" ? (
          <div
            role="alert"
            className="mt-3 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center shadow-card"
          >
            <h1 className="font-heading text-lg font-bold text-ink-900">{lesson.title}</h1>
            <p className="mt-2 text-sm text-danger-700">
              โหลดชุดข้อสอบของบทเรียนนี้ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บเพื่อลองใหม่อีกครั้ง
            </p>
          </div>
        ) : null}

        <nav
          aria-label="นำทางบทเรียน"
          className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-mist-200 pt-4"
        >
          {prev !== null ? (
            <Link
              href={`/courses/${encodeURIComponent(id)}/learn/${encodeURIComponent(prev.id)}`}
              className="text-sm font-semibold text-brand-700 hover:text-brand-800"
            >
              ก่อนหน้า: {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next !== null ? (
            <Link
              href={`/courses/${encodeURIComponent(id)}/learn/${encodeURIComponent(next.id)}`}
              className="text-sm font-semibold text-brand-700 hover:text-brand-800"
            >
              ถัดไป: {next.title}
            </Link>
          ) : null}
        </nav>
      </div>
    </div>
  );
}

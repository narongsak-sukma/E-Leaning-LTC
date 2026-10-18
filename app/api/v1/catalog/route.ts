import { NextRequest, NextResponse } from "next/server";
import { resolveServerSession } from "@/lib/auth/server-session";
import { readDb } from "@/lib/db/store";

const COVER_STYLES = ["navy", "gold", "teal", "burgundy", "slate", "emerald"] as const;

export async function GET(req: NextRequest) {
  const db = readDb();
  const session = await resolveServerSession(req, db);
  const { searchParams } = new URL(req.url);

  const courseId = searchParams.get("courseId");
  const slug = searchParams.get("slug");
  const categoryId = searchParams.get("categoryId");
  const audience = searchParams.get("audience");
  const q = (searchParams.get("q") || "").trim().toLowerCase();

  const publishedCourses = db.courses.filter((c) => c.status === "published");

  if (courseId || slug) {
    const course = db.courses.find(
      (c) =>
        (courseId &&
          (c.id === courseId ||
            c.code.toLowerCase() === courseId.toLowerCase())) ||
        (slug && c.code.toLowerCase() === slug.toLowerCase()),
    );

    if (!course || (course.status !== "published" && !session)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-CRS-001",
            message: "ไม่พบหลักสูตรที่ระบุ",
          },
        },
        { status: 404 },
      );
    }

    const category = db.categories.find((cat) => cat.id === course.categoryId);
    const courseLessons = db.lessons.filter((l) => l.courseId === course.id);
    const totalDurationMin = Math.max(
      60,
      Math.round(
        courseLessons.reduce((acc, l) => acc + l.durationSec, 0) / 60,
      ),
    );

    const modules = db.courseModules
      .filter((m) => m.courseId === course.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((m) => {
        const mLessons = db.lessons
          .filter((l) => l.moduleId === m.id)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        return {
          ...m,
          durationMinutes: Math.max(
            15,
            Math.round(
              mLessons.reduce((acc, l) => acc + l.durationSec, 0) / 60,
            ),
          ),
          lessons: mLessons.map((l) => ({
            id: l.id,
            moduleId: l.moduleId,
            type: l.type,
            titleTh: l.titleTh,
            durationSec: l.durationSec,
            sortOrder: l.sortOrder,
            isRequired: true,
            summaryTh: (l.contentMd || "").replace(/[#*-]/g, "").slice(0, 120),
          })),
        };
      });

    const assessment = db.assessments.find((a) => a.courseId === course.id);
    const enrollment = session
      ? db.enrollments.find(
          (e) =>
            e.userId === session.user.id &&
            e.courseId === course.id &&
            e.status !== "cancelled",
        ) ?? null
      : null;

    const completedLessonIds = session
      ? db.lessonProgress
          .filter(
            (lp) =>
              lp.userId === session.user.id &&
              lp.courseId === course.id &&
              lp.completedAt !== null,
          )
          .map((lp) => lp.lessonId)
      : [];

    return NextResponse.json({
      course: {
        ...course,
        slug: course.code.toLowerCase(),
        subtitleTh: course.summary,
        audience: course.isPublic ? "all" : "lawyer_only",
        durationMinutes: totalDurationMin,
        instructorRole: course.instructorTitle,
        objectives: course.outcomeHighlights,
        categoryNameTh: category?.nameTh ?? "ทั่วไป",
        categorySlug: category?.slug ?? "general",
      },
      modules,
      assessment: assessment
        ? {
            id: assessment.id,
            title: assessment.title,
            questionCount: assessment.questionCount,
            passScorePct: assessment.passPct,
            timeLimitMin: assessment.timeLimitMinutes,
            maxAttempts: assessment.maxAttempts,
            reviewMode: assessment.reviewMode,
          }
        : null,
      enrollment,
      completedLessonIds,
    });
  }

  let filtered = publishedCourses;
  if (categoryId && categoryId !== "all") {
    filtered = filtered.filter(
      (c) => c.categoryId === categoryId || c.categoryId.endsWith(categoryId),
    );
  }
  if (audience && audience !== "all") {
    if (audience === "lawyer_only") {
      filtered = filtered.filter((c) => !c.isPublic);
    } else if (audience === "general") {
      filtered = filtered.filter((c) => c.isPublic);
    }
  }
  if (q) {
    filtered = filtered.filter(
      (c) =>
        c.titleTh.toLowerCase().includes(q) ||
        c.titleEn.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.instructorName.toLowerCase().includes(q),
    );
  }

  const enrichedCourses = filtered.map((c, idx) => {
    const category = db.categories.find((cat) => cat.id === c.categoryId);
    const moduleCount = db.courseModules.filter(
      (m) => m.courseId === c.id,
    ).length;
    const cLessons = db.lessons.filter((l) => l.courseId === c.id);
    const durationMinutes = Math.max(
      90,
      Math.round(cLessons.reduce((acc, l) => acc + l.durationSec, 0) / 60),
    );
    return {
      ...c,
      slug: c.code.toLowerCase(),
      subtitleTh: c.summary,
      audience: c.isPublic ? ("all" as const) : ("lawyer_only" as const),
      durationMinutes,
      instructorRole: c.instructorTitle,
      categoryNameTh: category?.nameTh ?? "ทั่วไป",
      categorySlug: category?.slug ?? "general",
      moduleCount,
      lessonCount: cLessons.length,
      coverStyle: COVER_STYLES[idx % COVER_STYLES.length],
    };
  });

  const categoriesWithCounts = db.categories
    .filter((cat) => cat.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((cat) => ({
      ...cat,
      courseCount: publishedCourses.filter((c) => c.categoryId === cat.id)
        .length,
    }));

  return NextResponse.json({
    courses: enrichedCourses,
    categories: categoriesWithCounts,
    stats: {
      publishedCourseCount: publishedCourses.length,
      registeredLearnersCount: 38420 + db.profiles.length,
      issuedCertificatesCount: 19680 + db.certificates.length,
      satisfactionPct: 98.4,
    },
  });
}

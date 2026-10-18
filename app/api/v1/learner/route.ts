import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  attachSessionCookie,
  createSessionRecord,
  resolveServerSession,
  verifyGuardPermission,
} from "@/lib/auth/server-session";
import {
  appendAuditLog,
  getUserNetCredits,
  readDb,
  submitExamAttemptInDb,
  writeDb,
} from "@/lib/db/store";
import {
  canReviewExamAnswers,
  computeCreditMeterState,
} from "@/lib/domain/ltc-logic";

const COVER_STYLES = ["navy", "gold", "teal", "burgundy", "slate", "emerald"] as const;

export async function GET(req: NextRequest) {
  const db = readDb();
  let session = await resolveServerSession(req, db);
  let autoCreatedToken: string | null = null;

  if (
    (!session || session.portal === "backoffice") &&
    req.headers.get("x-strict-auth") !== "1"
  ) {
    autoCreatedToken = createSessionRecord(db, "u-lawyer-001", "frontoffice", "aal1");
    const user = db.profiles.find((p) => p.id === "u-lawyer-001")!;
    session = {
      token: autoCreatedToken,
      portal: "frontoffice",
      aal: "aal1",
      user,
      roles: ["citizen", "lawyer"],
      verifiedLicense:
        db.lawyerLicenses.find((l) => l.userId === "u-lawyer-001") ?? null,
      requiresMfaChallenge: false,
    };
  }

  if (!session) {
    return NextResponse.json(
      {
        error: {
          code: "ERR-AUTH-001",
          message: "กรุณาเข้าสู่ระบบสำหรับผู้เรียน (Frontoffice)",
        },
      },
      { status: 401 },
    );
  }

  const userId = session.user.id;
  const { searchParams } = new URL(req.url);
  const courseId = searchParams.get("courseId");
  const attemptId = searchParams.get("attemptId");

  // Enrich enrollments
  const userEnrollments = db.enrollments
    .filter((e) => e.userId === userId && e.status !== "cancelled")
    .map((enr, idx) => {
      const course = db.courses.find((c) => c.id === enr.courseId);
      const category = db.categories.find((cat) => cat.id === course?.categoryId);
      const courseLessons = db.lessons
        .filter((l) => l.courseId === enr.courseId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const completedProgress = db.lessonProgress.filter(
        (lp) =>
          lp.userId === userId &&
          lp.courseId === enr.courseId &&
          (lp.completedAt !== null || lp.status === "completed"),
      );
      const completedLessonIds = new Set(completedProgress.map((lp) => lp.lessonId));
      const completedRequiredCount = courseLessons.filter((l) =>
        completedLessonIds.has(l.id),
      ).length;
      const progressPct =
        courseLessons.length > 0
          ? Math.round((completedRequiredCount / courseLessons.length) * 100)
          : 100;

      const nextLesson =
        courseLessons.find((l) => !completedLessonIds.has(l.id)) ??
        courseLessons[courseLessons.length - 1] ??
        null;

      const assessment = db.assessments.find((a) => a.courseId === enr.courseId);
      const userAttempts = db.attempts.filter(
        (a) => a.userId === userId && a.courseId === enr.courseId,
      );
      const passedAttempt = userAttempts.find((a) => a.status === "passed");
      const cert = db.certificates.find(
        (c) => c.userId === userId && c.courseId === enr.courseId && c.status === "valid",
      );
      const totalDurationSec = courseLessons.reduce(
        (acc, l) => acc + l.durationSec,
        0,
      );

      return {
        ...enr,
        progressPct,
        completedLessonCount: completedProgress.length,
        totalLessonCount: courseLessons.length,
        completedRequiredCount,
        totalRequiredCount: courseLessons.length,
        canStartExam: completedRequiredCount >= courseLessons.length,
        nextLessonId: nextLesson?.id ?? null,
        nextLessonTitle: nextLesson?.titleTh ?? null,
        passedExam: Boolean(passedAttempt),
        certificateCode: cert?.verificationCode ?? null,
        course: course
          ? {
              id: course.id,
              code: course.code,
              slug: course.code.toLowerCase(),
              titleTh: course.titleTh,
              titleEn: course.titleEn,
              categoryNameTh: category?.nameTh ?? "ทั่วไป",
              audience: course.isPublic ? ("all" as const) : ("lawyer_only" as const),
              credits: course.credits,
              durationMinutes: Math.max(30, Math.round(totalDurationSec / 60)),
              instructorName: course.instructorName,
              coverStyle: COVER_STYLES[idx % COVER_STYLES.length],
            }
          : null,
        assessment: assessment
          ? {
              id: assessment.id,
              title: assessment.title,
              passScorePct: assessment.passPct,
              timeLimitMin: assessment.timeLimitMinutes,
              maxAttempts: assessment.maxAttempts,
              attemptsUsed: userAttempts.filter((a) => a.status !== "in_progress").length,
            }
          : null,
      };
    });

  // Credit Bank meter & ledger
  const openCycle =
    db.renewalCycles.find((c) => c.userId === userId && c.status === "open") ?? null;
  const userLedger = db.creditLedger
    .filter((l) => l.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const netCredits = getUserNetCredits(db, userId);

  const cycleEndMs = openCycle
    ? new Date(`${openCycle.endDate}T23:59:59.000Z`).getTime()
    : Date.now() + 1000 * 60 * 60 * 24 * 120;
  const daysRemaining = Math.max(
    0,
    Math.ceil((cycleEndMs - Date.now()) / (1000 * 60 * 60 * 24)),
  );
  const creditMeter = computeCreditMeterState(
    netCredits,
    openCycle?.requiredCredits ?? 12,
    daysRemaining,
  );

  // Certificates
  const userCertificates = db.certificates
    .filter((c) => c.userId === userId)
    .map((c) => {
      const course = db.courses.find((crs) => crs.id === c.courseId);
      return {
        ...c,
        courseCode: course?.code ?? "LTC",
        instructorName: course?.instructorName ?? "สภาทนายความ",
      };
    });

  // License applications
  const userLicenseApps = db.licenseApplications.filter(
    (app) => app.userId === userId,
  );

  // Attempts summary
  const userAttempts = db.attempts
    .filter((a) => a.userId === userId)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .map((a) => {
      const course = db.courses.find((c) => c.id === a.courseId);
      const assessment = db.assessments.find((asm) => asm.id === a.assessmentId);
      return {
        ...a,
        courseTitleTh: course?.titleTh ?? "",
        courseCode: course?.code ?? "",
        courseCredits: course?.credits ?? 0,
        assessmentTitle: assessment?.title ?? "การสอบวัดผลปลายหลักสูตร",
        reviewMode: assessment?.reviewMode ?? "after_final_attempt",
        maxAttempts: assessment?.maxAttempts ?? 3,
      };
    });

  // Detailed course player / exam payload if requested
  let activeCourseWorkspace = null;
  if (courseId) {
    const course = db.courses.find(
      (c) => c.id === courseId || c.code.toLowerCase() === courseId.toLowerCase(),
    );
    if (course) {
      const modules = db.courseModules
        .filter((m) => m.courseId === course.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((m) => {
          const modLessons = db.lessons
            .filter((l) => l.moduleId === m.id)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((l) => {
              const cleanMd = (l.contentMd || course.summary)
                .replace(/#{1,6}\s*/g, "")
                .replace(/\*\*/g, "")
                .trim();
              return {
                ...l,
                isRequired: true,
                summaryTh: cleanMd,
                videoKeyPoints: course.outcomeHighlights,
                videoTranscript: [
                  {
                    time: "00:00",
                    speaker: course.instructorName,
                    text: `ยินดีต้อนรับสู่บทเรียน ${l.titleTh}`,
                  },
                  {
                    time: "03:15",
                    speaker: course.instructorName,
                    text: cleanMd,
                  },
                ],
                documentSections: l.contentMd
                  ? [
                      {
                        heading: l.titleTh,
                        body: cleanMd,
                      },
                    ]
                  : [],
              };
            });
          return {
            ...m,
            lessons: modLessons,
          };
        });
      const progressRows = db.lessonProgress.filter(
        (lp) => lp.userId === userId && lp.courseId === course.id,
      );
      const rawAssessment = db.assessments.find((a) => a.courseId === course.id) ?? null;
      const assessment = rawAssessment
        ? {
            ...rawAssessment,
            title: rawAssessment.title,
            passScorePct: rawAssessment.passPct,
            timeLimitMin: rawAssessment.timeLimitMinutes,
          }
        : null;
      activeCourseWorkspace = {
        course: {
          ...course,
          audience: course.isPublic ? ("all" as const) : ("lawyer_only" as const),
          objectives: course.outcomeHighlights,
        },
        modules,
        progressRows,
        assessment,
      };
    }
  }

  // Detailed attempt payload (for exam runner or exam result/review)
  let activeAttemptDetail = null;
  if (attemptId) {
    const attempt = db.attempts.find(
      (a) => (a.id === attemptId || a.code === attemptId) && a.userId === userId,
    );
    if (attempt) {
      const rawAssessment = db.assessments.find((a) => a.id === attempt.assessmentId);
      const course = db.courses.find((c) => c.id === attempt.courseId);
      const courseAttempts = db.attempts.filter(
        (a) => a.userId === userId && a.courseId === attempt.courseId,
      );
      const hasInProgress = courseAttempts.some((a) => a.status === "in_progress");
      const hasPassed = courseAttempts.some((a) => a.status === "passed");
      const attemptsUsed = courseAttempts.filter(
        (a) => a.status !== "in_progress",
      ).length;

      const allowReview = canReviewExamAnswers({
        hasInProgressAttempt: hasInProgress,
        reviewMode: rawAssessment?.reviewMode ?? "after_final_attempt",
        attemptsUsed,
        maxAttempts: rawAssessment?.maxAttempts ?? 3,
        hasPassedAttempt: hasPassed,
      });

      const reviewPolicy = {
        allowed: allowReview,
        canReview: allowReview,
        includeCorrectAnswers: allowReview,
        includeExplanations: allowReview,
        reasonTh: allowReview
          ? "เปิดเฉลยและคำอธิบายประกอบตามเกณฑ์หลังส่งข้อสอบ"
          : "ระบบจะเปิดเฉลยเมื่อสอบผ่านเกณฑ์หรือใช้สิทธิ์สอบครบจำนวนครั้งแล้ว",
      };

      // SECURITY INVARIANT (RBAC §3.5 & D84): Never send correct answers while in_progress
      const questions = attempt.questionIds
        .map((qid) => db.bankQuestions.find((q) => q.id === qid))
        .filter((q) => q !== undefined)
        .map((q) => ({
          id: q.id,
          moduleTitle: q.moduleTitle,
          questionText: q.questionText,
          points: q.points,
          explanation:
            attempt.status !== "in_progress" && reviewPolicy.includeExplanations
              ? q.explanation
              : null,
          options: q.options.map((o) => ({
            id: o.id,
            text: o.text,
            isCorrect:
              attempt.status !== "in_progress" && reviewPolicy.includeCorrectAnswers
                ? o.isCorrect
                : undefined,
          })),
        }));

      activeAttemptDetail = {
        attempt,
        course,
        assessment: rawAssessment
          ? {
              ...rawAssessment,
              title: rawAssessment.title,
              passScorePct: rawAssessment.passPct,
              timeLimitMin: rawAssessment.timeLimitMinutes,
            }
          : null,
        questions,
        reviewPolicy,
      };
    }
  }

  const res = NextResponse.json({
    user: {
      id: session.user.id,
      displayName: session.user.displayName,
      firstName: session.user.firstName,
      lastName: session.user.lastName,
      email: session.user.email,
      phone: session.user.phone,
      preferredLocale: session.user.preferredLocale,
      pdpaConsentedAt: session.user.pdpaConsentedAt,
    },
    roles: session.roles,
    verifiedLicense: session.verifiedLicense,
    licenseApplications: userLicenseApps,
    enrollments: userEnrollments,
    creditCycle: openCycle,
    creditMeter: {
      ...creditMeter,
      percentage: creditMeter.percent,
      badgeLabelTh: creditMeter.badgeText || creditMeter.statusLabel,
      netCredits,
      requiredCredits: openCycle?.requiredCredits ?? 12,
      daysRemaining,
    },
    creditLedger: userLedger,
    certificates: userCertificates,
    attempts: userAttempts,
    notifications: db.notifications.filter((n) => n.userId === userId),
    activeCourseWorkspace,
    activeAttemptDetail,
  });
  return autoCreatedToken ? attachSessionCookie(res, autoCreatedToken) : res;
}

export async function POST(req: NextRequest) {
  const db = readDb();
  const session = await resolveServerSession(req, db);
  if (!session) {
    return NextResponse.json(
      {
        error: {
          code: "ERR-AUTH-001",
          message: "กรุณาเข้าสู่ระบบก่อนดำเนินการ",
        },
      },
      { status: 401 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const userId = session.user.id;
  const nowIso = new Date().toISOString();

  if (action === "enroll") {
    const courseId = String(body.courseId || "");
    const course = db.courses.find((c) => c.id === courseId && c.status === "published");
    if (!course) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-CRS-001",
            message: "ไม่พบหลักสูตรที่เปิดให้ลงทะเบียน",
          },
        },
        { status: 404 },
      );
    }

    const guard = verifyGuardPermission(session, "enroll:create");
    if (!guard.ok) return guard.response;

    // Verify license eligibility for lawyer_only courses
    if (!course.isPublic && !session.verifiedLicense) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-ENR-002",
            message:
              "หลักสูตรนี้สงวนสิทธิ์เฉพาะทนายความที่ยืนยันใบอนุญาตว่าความแล้ว กรุณายื่นผูกเลขใบอนุญาตที่เมนูใบอนุญาตทนายความ",
          },
        },
        { status: 422 },
      );
    }

    const existing = db.enrollments.find(
      (e) => e.userId === userId && e.courseId === course.id && e.status !== "cancelled",
    );
    if (existing) {
      return NextResponse.json({
        ok: true,
        enrollment: existing,
        alreadyEnrolled: true,
      });
    }

    const newEnrollment = {
      id: `enr-${crypto.randomUUID().slice(0, 8)}`,
      userId,
      courseId: course.id,
      status: "active" as const,
      enrolledAt: nowIso,
      completedAt: null,
      lastLessonId: null,
    };
    db.enrollments.unshift(newEnrollment);
    course.enrolledCount += 1;
    writeDb(db);

    return NextResponse.json({
      ok: true,
      enrollment: newEnrollment,
    });
  }

  if (action === "complete_lesson") {
    const guard = verifyGuardPermission(session, "lesson:view");
    if (!guard.ok) return guard.response;

    const courseId = String(body.courseId || "");
    const lessonId = String(body.lessonId || "");
    const lesson = db.lessons.find((l) => l.id === lessonId && l.courseId === courseId);
    if (!lesson) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-NF-001",
            message: "ไม่พบบทเรียนที่ระบุ",
          },
        },
        { status: 404 },
      );
    }

    // Ensure enrolled
    let enr = db.enrollments.find(
      (e) => e.userId === userId && e.courseId === courseId && e.status !== "cancelled",
    );
    if (!enr) {
      enr = {
        id: `enr-${crypto.randomUUID().slice(0, 8)}`,
        userId,
        courseId,
        status: "active",
        enrolledAt: nowIso,
        completedAt: null,
        lastLessonId: lessonId,
      };
      db.enrollments.unshift(enr);
    } else {
      enr.lastLessonId = lessonId;
    }

    let lp = db.lessonProgress.find(
      (p) => p.userId === userId && p.lessonId === lessonId,
    );
    if (!lp) {
      lp = {
        id: `lp-${crypto.randomUUID().slice(0, 8)}`,
        enrollmentId: enr.id,
        userId,
        courseId,
        lessonId,
        status: "completed",
        watchPct: 100,
        dwellSec: lesson.durationSec || 600,
        quizScorePct: lesson.type === "quiz" ? 100 : null,
        updatedAt: nowIso,
        completedAt: nowIso,
      };
      db.lessonProgress.push(lp);
    } else {
      lp.status = "completed";
      lp.watchPct = 100;
      lp.dwellSec = Math.max(lp.dwellSec, lesson.durationSec || 600);
      lp.updatedAt = nowIso;
      lp.completedAt = lp.completedAt ?? nowIso;
    }

    writeDb(db);
    return NextResponse.json({
      ok: true,
      lessonProgress: lp,
    });
  }

  if (action === "start_exam") {
    const guard = verifyGuardPermission(session, "attempt:start");
    if (!guard.ok) return guard.response;

    const courseId = String(body.courseId || "");
    const course = db.courses.find((c) => c.id === courseId);
    const assessment = db.assessments.find((a) => a.courseId === courseId);
    if (!course || !assessment) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-NF-001",
            message: "ไม่พบแบบทดสอบปลายหลักสูตร",
          },
        },
        { status: 404 },
      );
    }

    // Check if there is already an active in_progress attempt
    const existingInProgress = db.attempts.find(
      (a) =>
        a.userId === userId &&
        a.courseId === courseId &&
        a.status === "in_progress",
    );
    if (existingInProgress) {
      return NextResponse.json({
        ok: true,
        attempt: existingInProgress,
        resumed: true,
      });
    }

    const isEnrolled = db.enrollments.some(
      (e) => e.userId === userId && e.courseId === courseId && e.status !== "cancelled",
    );
    if (!isEnrolled) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-LRN-001",
            message: "ต้องลงทะเบียนหลักสูตรก่อนเข้าสอบวัดผล",
          },
        },
        { status: 403 },
      );
    }

    const courseLessons = db.lessons.filter((l) => l.courseId === courseId);
    const completedIds = new Set(
      db.lessonProgress
        .filter(
          (lp) =>
            lp.userId === userId &&
            lp.courseId === courseId &&
            (lp.completedAt !== null || lp.status === "completed"),
        )
        .map((lp) => lp.lessonId),
    );
    const completedReqCount = courseLessons.filter((l) =>
      completedIds.has(l.id),
    ).length;

    if (completedReqCount < courseLessons.length) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-LRN-002",
            message: `กรุณาเรียนบทเรียนให้ครบก่อนเข้าสอบ (${completedReqCount}/${courseLessons.length} บท)`,
          },
        },
        { status: 422 },
      );
    }

    const finishedAttempts = db.attempts.filter(
      (a) =>
        a.userId === userId &&
        a.courseId === courseId &&
        a.status !== "in_progress",
    );

    if (finishedAttempts.length >= assessment.maxAttempts) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-ASM-001",
            message: `คุณใช้สิทธิ์สอบครบ ${assessment.maxAttempts} ครั้งตามเกณฑ์แล้ว`,
          },
        },
        { status: 422 },
      );
    }

    const bankQuestions = db.bankQuestions.filter(
      (q) => q.bankId === assessment.bankId && q.status === "active",
    );
    const questionIds = bankQuestions.map((q) => q.id);

    const expiresMs = Date.now() + assessment.timeLimitMinutes * 60 * 1000;
    const newAttempt = {
      id: `att-${crypto.randomUUID().slice(0, 8)}`,
      code: `ASM-2569-${Math.floor(10000 + Math.random() * 90000)}`,
      assessmentId: assessment.id,
      courseId: course.id,
      userId,
      attemptNo: finishedAttempts.length + 1,
      status: "in_progress" as const,
      startedAt: nowIso,
      expiresAt: new Date(expiresMs).toISOString(),
      submittedAt: null,
      durationUsedSec: 0,
      scorePct: null,
      earnedPoints: 0,
      totalPoints: bankQuestions.reduce((acc, q) => acc + q.points, 0),
      passPctSnapshot: assessment.passPct,
      questionIds,
      answers: {},
      flaggedQuestionIds: [],
      moduleBreakdown: [],
      certificateId: null,
    };

    db.attempts.unshift(newAttempt);
    writeDb(db);

    return NextResponse.json({
      ok: true,
      attempt: newAttempt,
      resumed: false,
    });
  }

  if (action === "save_exam_answer") {
    const attemptId = String(body.attemptId || "");
    const attempt = db.attempts.find(
      (a) => a.id === attemptId && a.userId === userId,
    );
    if (!attempt || attempt.status !== "in_progress") {
      return NextResponse.json(
        {
          error: {
            code: "ERR-ASM-005",
            message: "ไม่พบรอบการสอบที่กำลังดำเนินการ หรือส่งคำตอบไปแล้ว",
          },
        },
        { status: 409 },
      );
    }

    if (body.answers && typeof body.answers === "object") {
      attempt.answers = { ...attempt.answers, ...body.answers };
    }
    if (Array.isArray(body.flaggedQuestionIds)) {
      attempt.flaggedQuestionIds = body.flaggedQuestionIds.map(String);
    }
    writeDb(db);

    return NextResponse.json({
      ok: true,
      savedAt: nowIso,
      answeredCount: Object.keys(attempt.answers).length,
    });
  }

  if (action === "submit_exam") {
    const guard = verifyGuardPermission(session, "attempt:start");
    if (!guard.ok) return guard.response;

    const attemptId = String(body.attemptId || "");
    const attempt = db.attempts.find(
      (a) => a.id === attemptId && a.userId === userId,
    );
    if (!attempt) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-NF-001",
            message: "ไม่พบรอบการสอบที่ระบุ",
          },
        },
        { status: 404 },
      );
    }

    const gradedAttempt = submitExamAttemptInDb(
      db,
      attempt.id,
      body.answers,
      body.flaggedQuestionIds,
    );

    return NextResponse.json({
      ok: true,
      attempt: gradedAttempt,
    });
  }

  if (action === "apply_license") {
    const licenseNo = String(body.licenseNo || "").trim();
    const evidenceNote = String(
      body.evidenceNote || "สำเนาบัตรประจำตัวทนายความสภาทนายความ",
    ).trim();

    if (!/^\d{4,7}$/.test(licenseNo)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "เลขที่ใบอนุญาตว่าความต้องเป็นตัวเลข 4–7 หลัก (เช่น 45892)",
          },
        },
        { status: 422 },
      );
    }

    const existingPending = db.licenseApplications.find(
      (a) => a.userId === userId && a.status === "pending",
    );
    if (existingPending) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "คุณมีคำขอผูกเลขที่ใบอนุญาตที่กำลังรอตรวจสอบอยู่แล้ว",
          },
        },
        { status: 409 },
      );
    }

    const newApp = {
      id: `lapp-${crypto.randomUUID().slice(0, 8)}`,
      userId,
      licenseNo,
      evidenceNote,
      status: "pending" as const,
      submittedAt: nowIso,
      decidedBy: null,
      decidedAt: null,
      rejectedReason: null,
      resultingLicenseId: null,
    };

    db.licenseApplications.unshift(newApp);
    appendAuditLog(db, {
      eventType: "LICENSE_BIND_REQUEST",
      actorUserId: userId,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "license_applications",
      targetId: newApp.id,
      summaryTh: `ยื่นคำขอผูกเลขใบอนุญาตว่าความ ทล. ${licenseNo} รอนายทะเบียนอนุมัติ`,
    });
    writeDb(db);

    return NextResponse.json({
      ok: true,
      application: newApp,
    });
  }

  if (action === "update_profile") {
    const firstName = String(body.firstName || session.user.firstName).trim();
    const lastName = String(body.lastName || session.user.lastName).trim();
    const phone = String(body.phone || "").trim();
    const preferredLocale = body.preferredLocale === "en" ? "en" : "th";

    if (!firstName || !lastName) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "กรุณาระบุชื่อและนามสกุลให้ครบถ้วน",
          },
        },
        { status: 422 },
      );
    }

    const profileRow = db.profiles.find((p) => p.id === userId);
    if (profileRow) {
      profileRow.firstName = firstName;
      profileRow.lastName = lastName;
      profileRow.displayName = `${firstName} ${lastName}`;
      profileRow.phone = phone || null;
      profileRow.preferredLocale = preferredLocale;
      writeDb(db);
    }

    return NextResponse.json({
      ok: true,
      user: profileRow,
    });
  }

  if (action === "mark_notifications_read") {
    db.notifications.forEach((n) => {
      if (n.userId === userId) {
        n.isRead = true;
      }
    });
    writeDb(db);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    {
      error: {
        code: "ERR-VAL-001",
        message: "ไม่พบคำสั่งที่ระบุสำหรับผู้เรียน",
      },
    },
    { status: 400 },
  );
}

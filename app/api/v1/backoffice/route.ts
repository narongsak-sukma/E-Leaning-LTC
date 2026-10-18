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
  getActiveRolesForUser,
  getUserNetCredits,
  getVerifiedLicenseForUser,
  readDb,
  resetDbToSeed,
  writeDb,
} from "@/lib/db/store";
import {
  type Role,
  hasBackofficeAccess,
  requiresMfa,
} from "@/lib/domain/ltc-logic";

export async function GET(req: NextRequest) {
  const db = readDb();
  let session = await resolveServerSession(req, db);
  let autoCreatedToken: string | null = null;
  const autoDemo = req.nextUrl.searchParams.get("autoDemo") === "1";

  if ((!session || !hasBackofficeAccess(session.roles)) && autoDemo) {
    autoCreatedToken = createSessionRecord(db, "u-superadmin-001", "backoffice", "aal2");
    const adminUser = db.profiles.find((p) => p.id === "u-superadmin-001")!;
    session = {
      token: autoCreatedToken,
      portal: "backoffice",
      aal: "aal2",
      user: adminUser,
      roles: getActiveRolesForUser(db, "u-superadmin-001"),
      verifiedLicense: null,
      requiresMfaChallenge: false,
    };
  }

  if (!session) {
    return NextResponse.json(
      {
        error: {
          code: "ERR-AUTH-001",
          message: "กรุณาเข้าสู่ระบบสำหรับเจ้าหน้าที่และผู้สอน (Backoffice)",
        },
      },
      { status: 401 },
    );
  }

  // Enforce strict portal RBAC separation: Citizen and Lawyer cannot access Backoffice
  if (!hasBackofficeAccess(session.roles)) {
    return NextResponse.json(
      {
        error: {
          code: "ERR-ADM-001",
          message:
            "ปฏิเสธการเข้าถึง (403 Forbidden): บัญชีผู้เรียนไม่มีสิทธิ์เข้าถึงระบบบริหารจัดการหลังบ้าน (Backoffice)",
        },
      },
      { status: 403 },
    );
  }

  const isInstructorOnly =
    session.roles.includes("instructor") &&
    !session.roles.some((r) => r.startsWith("staff:") || r === "super_admin");

  // Enrich courses for Backoffice
  const visibleCourses = isInstructorOnly
    ? db.courses.filter((c) => c.createdBy === session.user.id)
    : db.courses;

  const courses = visibleCourses.map((c) => {
    const category = db.categories.find((cat) => cat.id === c.categoryId);
    const modules = db.courseModules.filter((m) => m.courseId === c.id);
    const lessons = db.lessons.filter((l) => l.courseId === c.id);
    const totalDurationSec = lessons.reduce((acc, l) => acc + l.durationSec, 0);
    return {
      ...c,
      audience: c.isPublic ? ("all" as const) : ("lawyer_only" as const),
      durationMinutes: Math.max(30, Math.round(totalDurationSec / 60)),
      categoryNameTh: category?.nameTh ?? "ทั่วไป",
      moduleCount: modules.length,
      lessonCount: lessons.length,
    };
  });

  // Enrich license applications for Registrar / Admin
  const licenseApplications = db.licenseApplications.map((app) => {
    const applicant = db.profiles.find((p) => p.id === app.userId);
    const decider = app.decidedBy
      ? db.profiles.find((p) => p.id === app.decidedBy)
      : null;
    return {
      ...app,
      applicantName: applicant?.displayName ?? "ไม่ระบุชื่อ",
      applicantEmail: applicant?.email ?? "",
      applicantPhone: applicant?.phone ?? "",
      deciderName: decider?.displayName ?? null,
    };
  });

  // Enrich users & role assignments
  const users = db.profiles.map((p) => {
    const activeRoles = getActiveRolesForUser(db, p.id);
    const verifiedLic = getVerifiedLicenseForUser(db, p.id);
    const netCredits = getUserNetCredits(db, p.id);
    const enrolledCount = db.enrollments.filter(
      (e) => e.userId === p.id && e.status !== "cancelled",
    ).length;
    const certCount = db.certificates.filter(
      (c) => c.userId === p.id && c.status === "valid",
    ).length;

    return {
      id: p.id,
      displayName: p.displayName,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      phone: p.phone,
      isActive: p.isActive,
      mfaEnabled: p.mfaEnabled,
      createdAt: p.createdAt,
      roles: activeRoles,
      licenseNo: verifiedLic?.licenseNo ?? null,
      licenseStatus: verifiedLic?.status ?? null,
      netCredits,
      enrolledCount,
      certCount,
    };
  });

  // Enrich question banks
  const questionBanks = db.questionBanks.map((qb) => {
    const course = db.courses.find((c) => c.id === qb.courseId);
    const questions = db.bankQuestions.filter((q) => q.bankId === qb.id);
    const rawAssessment = db.assessments.find((a) => a.bankId === qb.id);
    return {
      ...qb,
      title: qb.name,
      courseCode: course?.code ?? "",
      courseTitleTh: course?.titleTh ?? "",
      questionCount: questions.length,
      publishedQuestionCount: questions.filter((q) => q.status === "active").length,
      assessment: rawAssessment
        ? {
            ...rawAssessment,
            title: rawAssessment.title,
            passScorePct: rawAssessment.passPct,
            timeLimitMin: rawAssessment.timeLimitMinutes,
          }
        : null,
      questions,
    };
  });

  // Enrich credit ledger with user names
  const creditLedger = db.creditLedger.map((led) => {
    const usr = db.profiles.find((p) => p.id === led.userId);
    const actor = led.createdBy
      ? db.profiles.find((p) => p.id === led.createdBy)
      : null;
    const lic = getVerifiedLicenseForUser(db, led.userId);
    return {
      ...led,
      userName: usr?.displayName ?? led.userId,
      userLicenseNo: lic?.licenseNo ?? null,
      actorName: actor?.displayName ?? "ระบบอัตโนมัติ",
    };
  });

  // KPIs
  const pendingLicenseCount = db.licenseApplications.filter(
    (a) => a.status === "pending",
  ).length;
  const pendingCourseReviewCount = db.courses.filter(
    (c) => c.status === "pending_review",
  ).length;
  const validCertificateCount = db.certificates.filter(
    (c) => c.status === "valid",
  ).length;
  const passedAttempts = db.attempts.filter((a) => a.status === "passed").length;
  const finishedAttempts = db.attempts.filter(
    (a) => a.status === "passed" || a.status === "failed",
  ).length;
  const examPassRatePct =
    finishedAttempts > 0
      ? Math.round((passedAttempts / finishedAttempts) * 1000) / 10
      : 82.4;

  // Include revoked sample certificate in backoffice view if not yet in db.certificates
  const allCertificates = [...db.certificates];
  if (!allCertificates.some((c) => c.verificationCode === "LTC-2025-990112")) {
    allCertificates.push({
      id: "cert-revoked-demo",
      verificationCode: "LTC-2025-990112",
      userId: "u-lawyer-002",
      courseId: "crs-102",
      attemptId: null,
      recipientName: "สุรเชษฐ์ ใจมั่น",
      courseTitleTh: "จรรยาบรรณวิชาชีพทนายความ",
      creditsAwarded: 4,
      issuedAt: "2025-11-15T09:00:00.000Z",
      issuedBy: "u-registrar-001",
      issueMode: "manual",
      status: "revoked",
      revokedAt: "2025-12-01T14:20:00.000Z",
      revokedBy: "u-registrar-001",
      revokedReason: "ตรวจพบการลงทะเบียนซ้ำซ้อนและออกใบประกาศฉบับใหม่ทดแทนแล้ว",
    });
  }

  const res = NextResponse.json({
    session: {
      user: {
        id: session.user.id,
        displayName: session.user.displayName,
        email: session.user.email,
        mfaSecretHint: session.user.mfaSecret,
      },
      roles: session.roles,
      aal: session.aal,
      requiresMfaStepUp: requiresMfa(session.roles) && session.aal !== "aal2",
    },
    kpis: {
      totalLearners: 38420 + db.profiles.length,
      verifiedLawyersCount:
        14280 +
        db.lawyerLicenses.filter((l) => l.status === "verified").length,
      publishedCoursesCount: db.courses.filter((c) => c.status === "published")
        .length,
      pendingCourseReviewCount,
      pendingLicenseCount,
      validCertificateCount: 19680 + validCertificateCount,
      examPassRatePct,
      totalCreditsAccrued: db.creditLedger.reduce(
        (acc, r) => acc + r.creditsDelta,
        0,
      ),
    },
    categories: db.categories,
    courses,
    questionBanks,
    licenseApplications,
    certificates: allCertificates,
    creditRules: db.creditRules,
    creditLedger,
    users,
    auditLogs: db.auditLogs,
    featureFlags: db.featureFlags,
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
          message: "กรุณาเข้าสู่ระบบสำหรับเจ้าหน้าที่ (Backoffice)",
        },
      },
      { status: 401 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const nowIso = new Date().toISOString();

  if (action === "create_course") {
    const guard = verifyGuardPermission(session, "course:create");
    if (!guard.ok) return guard.response;

    const code = String(body.code || "").trim().toUpperCase();
    const titleTh = String(body.titleTh || "").trim();
    const titleEn = String(body.titleEn || titleTh).trim();
    const categoryId = String(body.categoryId || "cat-civil");
    const audience = body.audience === "lawyer_only" ? "lawyer_only" : "all";
    const credits = Number(body.credits ?? 3);
    const durationMinutes = Number(body.durationMinutes ?? 120);
    const descriptionTh = String(
      body.descriptionTh || "หลักสูตรฝึกอบรมวิชาชีพทนายความ สภาทนายความ",
    ).trim();

    if (!code || !titleTh) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "กรุณาระบุรหัสหลักสูตร (เช่น LTC-205) และชื่อหลักสูตรภาษาไทย",
          },
        },
        { status: 422 },
      );
    }

    if (db.courses.some((c) => c.code.toUpperCase() === code)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: `รหัสหลักสูตร ${code} มีอยู่ในระบบแล้ว`,
          },
        },
        { status: 409 },
      );
    }

    const newCourseId = `crs-${Date.now()}`;
    const newCourse = {
      id: newCourseId,
      code,
      categoryId,
      createdBy: session.user.id,
      instructorName: session.user.displayName,
      instructorTitle: "วิทยากรสภาทนายความ",
      titleTh,
      titleEn,
      summary: descriptionTh,
      descriptionTh,
      level: "intermediate" as const,
      isPublic: audience !== "lawyer_only",
      credits,
      status: "draft" as const,
      returnComment: null,
      outcomeHighlights: [
        "เข้าใจหลักกฎหมายและแนวคำพิพากษาศาลฎีกาที่เกี่ยวข้อง",
        "สามารถนำไปประยุกต์ใช้ในการปฏิบัติงานวิชาชีพทนายความได้จริง",
      ],
      rating: 5.0,
      reviewCount: 1,
      enrolledCount: 0,
      publishedAt: null,
      createdAt: nowIso,
    };

    db.courses.unshift(newCourse);

    // Create default module & lesson so the course is ready to preview
    const modId = `mod-${Date.now()}`;
    db.courseModules.push({
      id: modId,
      courseId: newCourseId,
      titleTh: "โมดูล 1 · หลักกฎหมายและแนวทางปฏิบัติ",
      sortOrder: 1,
    });
    db.lessons.push({
      id: `les-${Date.now()}`,
      moduleId: modId,
      courseId: newCourseId,
      type: "video",
      titleTh: `บทที่ 1.1 บทนำสู่หลักสูตร ${titleTh}`,
      durationSec: Math.max(600, durationMinutes * 60),
      videoUrl: "https://example.com/video.mp4",
      contentMd: descriptionTh,
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 1,
      isPreview: true,
    });

    appendAuditLog(db, {
      eventType: "COURSE_CREATE",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "courses",
      targetId: code,
      summaryTh: `สร้างหลักสูตรใหม่ ${code} '${titleTh}' (${credits} หน่วยกิต)`,
    });
    writeDb(db);

    return NextResponse.json({
      ok: true,
      course: newCourse,
    });
  }

  if (action === "submit_course_review") {
    const guard = verifyGuardPermission(session, "course:update");
    if (!guard.ok) return guard.response;

    const courseId = String(body.courseId || "");
    const course = db.courses.find((c) => c.id === courseId);
    if (!course) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบหลักสูตร" } },
        { status: 404 },
      );
    }

    course.status = "pending_review";
    appendAuditLog(db, {
      eventType: "COURSE_SUBMIT_REVIEW",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "courses",
      targetId: course.code,
      summaryTh: `ส่งหลักสูตร ${course.code} '${course.titleTh}' เข้าคิวรออนุมัติเผยแพร่`,
    });
    writeDb(db);

    return NextResponse.json({ ok: true, course });
  }

  if (action === "approve_course" || action === "reject_course") {
    const guard = verifyGuardPermission(session, "course:publish");
    if (!guard.ok) return guard.response;

    const courseId = String(body.courseId || "");
    const course = db.courses.find((c) => c.id === courseId);
    if (!course) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบหลักสูตร" } },
        { status: 404 },
      );
    }

    if (action === "approve_course") {
      course.status = "published";
      course.publishedAt = nowIso;
      appendAuditLog(db, {
        eventType: "COURSE_APPROVE_PUBLISH",
        actorUserId: session.user.id,
        actorName: session.user.displayName,
        actorRole: session.roles.join(","),
        targetTable: "courses",
        targetId: course.code,
        summaryTh: `อนุมัติและเผยแพร่หลักสูตร ${course.code} '${course.titleTh}' สู่หน้าแคตตาล็อกผู้เรียน`,
      });
    } else {
      const reason = String(body.reason || "ข้อมูลยังไม่ครบตามเกณฑ์").trim();
      course.status = "returned";
      course.returnComment = reason;
      appendAuditLog(db, {
        eventType: "COURSE_REJECT",
        actorUserId: session.user.id,
        actorName: session.user.displayName,
        actorRole: session.roles.join(","),
        targetTable: "courses",
        targetId: course.code,
        summaryTh: `ส่งคืนหลักสูตร ${course.code} ให้แก้ไข (${reason})`,
      });
    }

    writeDb(db);
    return NextResponse.json({ ok: true, course });
  }

  if (action === "archive_course") {
    const guard = verifyGuardPermission(session, "course:delete");
    if (!guard.ok) return guard.response;

    const courseId = String(body.courseId || "");
    const course = db.courses.find((c) => c.id === courseId);
    if (!course) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบหลักสูตร" } },
        { status: 404 },
      );
    }

    course.status = "archived";
    appendAuditLog(db, {
      eventType: "COURSE_ARCHIVE",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "courses",
      targetId: course.code,
      summaryTh: `เก็บเข้าคลัง (Archive) หลักสูตร ${course.code}`,
    });
    writeDb(db);
    return NextResponse.json({ ok: true, course });
  }

  if (action === "create_question") {
    const guard = verifyGuardPermission(session, "question_bank:create");
    if (!guard.ok) return guard.response;

    const bankId = String(body.bankId || "");
    const bank = db.questionBanks.find((qb) => qb.id === bankId);
    if (!bank) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบคลังข้อสอบ" } },
        { status: 404 },
      );
    }

    const questionText = String(body.questionText || "").trim();
    const explanation = String(body.explanation || "").trim();
    const moduleTitle = String(body.moduleTitle || "โมดูลหลัก").trim();
    const difficulty =
      body.difficulty === "hard"
        ? "hard"
        : body.difficulty === "easy"
          ? "easy"
          : "medium";
    const rawOptions: { text: string; isCorrect: boolean }[] = Array.isArray(
      body.options,
    )
      ? body.options
      : [];

    if (!questionText || rawOptions.length < 2) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "กรุณาระบุโจทย์คำถามและตัวเลือกอย่างน้อย 2 ตัวเลือก",
          },
        },
        { status: 422 },
      );
    }

    const qId = `q-${Date.now()}`;
    const newQuestion = {
      id: qId,
      bankId: bank.id,
      courseId: bank.courseId,
      moduleTitle,
      type: "single_choice" as const,
      questionText,
      difficulty: difficulty as "easy" | "medium" | "hard",
      points: 20,
      explanation: explanation || "อ้างอิงตามหลักกฎหมายและแนวคำพิพากษาศาลฎีกา",
      status: "active" as const,
      options: rawOptions.map((o, idx) => ({
        id: `${qId}-opt-${idx + 1}`,
        text: String(o.text || `ตัวเลือกที่ ${idx + 1}`),
        isCorrect: Boolean(o.isCorrect),
      })),
      version: 1,
      createdBy: session.user.id,
      createdAt: nowIso,
    };

    db.bankQuestions.push(newQuestion);

    appendAuditLog(db, {
      eventType: "QBANK_QUESTION_CREATE",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "bank_questions",
      targetId: qId,
      summaryTh: `เพิ่มข้อสอบใหม่ในคลัง '${bank.name}' (${questionText.slice(0, 48)}...)`,
    });
    writeDb(db);

    return NextResponse.json({
      ok: true,
      question: newQuestion,
    });
  }

  if (action === "approve_license" || action === "reject_license") {
    const guard = verifyGuardPermission(session, "license:verify");
    if (!guard.ok) return guard.response;

    const applicationId = String(body.applicationId || "");
    const app = db.licenseApplications.find((a) => a.id === applicationId);
    if (!app) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-NF-001",
            message: "ไม่พบคำขอใบอนุญาตทนายความ",
          },
        },
        { status: 404 },
      );
    }

    const applicant = db.profiles.find((p) => p.id === app.userId);

    if (action === "approve_license") {
      app.status = "approved";
      app.decidedBy = session.user.id;
      app.decidedAt = nowIso;

      const licId = `lic-${crypto.randomUUID().slice(0, 8)}`;
      app.resultingLicenseId = licId;

      db.lawyerLicenses.push({
        id: licId,
        userId: app.userId,
        licenseNo: app.licenseNo,
        status: "verified",
        verifiedBy: session.user.id,
        verifiedAt: nowIso,
        expiresOn: "2028-12-31",
        revokedAt: null,
        rejectedReason: null,
        createdAt: nowIso,
      });

      // Atomic grant of 'lawyer' role per RBAC-DELEGATION-MATRIX §3.1
      const hasLawyerRole = db.roleAssignments.some(
        (r) =>
          r.userId === app.userId && r.role === "lawyer" && r.revokedAt === null,
      );
      if (!hasLawyerRole) {
        db.roleAssignments.push({
          id: `ra-${crypto.randomUUID().slice(0, 8)}`,
          userId: app.userId,
          role: "lawyer",
          grantedBy: session.user.id,
          grantedAt: nowIso,
          revokedAt: null,
          reason: `อนุมัติคำขอใบอนุญาตว่าความ ทล. ${app.licenseNo} แบบ Atomic`,
        });
      }

      // Ensure open renewal cycle exists for lawyer
      if (
        !db.renewalCycles.some(
          (c) => c.userId === app.userId && c.status === "open",
        )
      ) {
        db.renewalCycles.push({
          id: `cyc-2569-${app.userId}`,
          userId: app.userId,
          cycleYearBuddhist: 2569,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          requiredCredits: 12,
          status: "open",
        });
      }

      db.notifications.unshift({
        id: `noti-${crypto.randomUUID().slice(0, 8)}`,
        userId: app.userId,
        title: `อนุมัติใบอนุญาตว่าความ ทล. ${app.licenseNo} เรียบร้อยแล้ว`,
        body: "คุณได้รับสิทธิ์ทนายความ (Lawyer) และเปิดใช้งานสมุดสะสมหน่วยกิต (Credit Bank) เรียบร้อยแล้ว",
        href: "/my/license",
        isRead: false,
        createdAt: nowIso,
      });

      appendAuditLog(db, {
        eventType: "LICENSE_VERIFY",
        actorUserId: session.user.id,
        actorName: session.user.displayName,
        actorRole: session.roles.join(","),
        targetTable: "lawyer_licenses",
        targetId: app.licenseNo,
        summaryTh: `อนุมัติใบอนุญาตว่าความ ทล. ${app.licenseNo} ของ ${applicant?.displayName ?? app.userId} และมอบบทบาท lawyer แบบ Atomic`,
      });
    } else {
      const reason = String(body.reason || "").trim();
      if (!reason) {
        return NextResponse.json(
          {
            error: {
              code: "ERR-VAL-001",
              message: "กรุณาระบุเหตุผลในการปฏิเสธคำขอใบอนุญาต",
            },
          },
          { status: 422 },
        );
      }

      app.status = "rejected";
      app.decidedBy = session.user.id;
      app.decidedAt = nowIso;
      app.rejectedReason = reason;

      db.notifications.unshift({
        id: `noti-${crypto.randomUUID().slice(0, 8)}`,
        userId: app.userId,
        title: `คำขอผูกเลขใบอนุญาต ทล. ${app.licenseNo} ไม่ผ่านการอนุมัติ`,
        body: `เหตุผล: ${reason}`,
        href: "/my/license",
        isRead: false,
        createdAt: nowIso,
      });

      appendAuditLog(db, {
        eventType: "LICENSE_REJECT",
        actorUserId: session.user.id,
        actorName: session.user.displayName,
        actorRole: session.roles.join(","),
        targetTable: "license_applications",
        targetId: app.id,
        summaryTh: `ปฏิเสธคำขอใบอนุญาต ทล. ${app.licenseNo} ของ ${applicant?.displayName ?? app.userId} (เหตุผล: ${reason})`,
      });
    }

    writeDb(db);
    return NextResponse.json({ ok: true, application: app });
  }

  if (action === "issue_certificate") {
    const guard = verifyGuardPermission(session, "certificate:issue");
    if (!guard.ok) return guard.response;

    const targetUserId = String(body.userId || "");
    const courseId = String(body.courseId || "");
    const targetUser = db.profiles.find((p) => p.id === targetUserId);
    const course = db.courses.find((c) => c.id === courseId);

    if (!targetUser || !course) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-NF-001",
            message: "ไม่พบข้อมูลผู้เรียนหรือหลักสูตรที่ระบุ",
          },
        },
        { status: 404 },
      );
    }

    const randomSix = String(Math.floor(100000 + Math.random() * 900000));
    const cert = {
      id: `cert-${crypto.randomUUID().slice(0, 8)}`,
      verificationCode: `LTC-2026-${randomSix}`,
      userId: targetUser.id,
      courseId: course.id,
      attemptId: null,
      recipientName: targetUser.displayName,
      courseTitleTh: course.titleTh,
      creditsAwarded: course.credits,
      issuedAt: nowIso,
      issuedBy: session.user.id,
      issueMode: "manual" as const,
      status: "valid" as const,
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    };

    db.certificates.unshift(cert);

    appendAuditLog(db, {
      eventType: "CERTIFICATE_ISSUE_MANUAL",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "certificates",
      targetId: cert.verificationCode,
      summaryTh: `ออกประกาศนียบัตรแบบ Manual รหัส ${cert.verificationCode} ให้ ${targetUser.displayName} (${course.code})`,
    });
    writeDb(db);

    return NextResponse.json({ ok: true, certificate: cert });
  }

  if (action === "revoke_certificate") {
    const guard = verifyGuardPermission(session, "certificate:revoke");
    if (!guard.ok) return guard.response;

    const certificateId = String(body.certificateId || "");
    const reason = String(body.reason || "").trim();
    if (!reason) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "การเพิกถอนประกาศนียบัตรต้องระบุเหตุผลประกอบใน Audit Log",
          },
        },
        { status: 422 },
      );
    }

    const cert = db.certificates.find(
      (c) => c.id === certificateId || c.verificationCode === certificateId,
    );
    if (!cert) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบประกาศนียบัตร" } },
        { status: 404 },
      );
    }

    cert.status = "revoked";
    cert.revokedAt = nowIso;
    cert.revokedBy = session.user.id;
    cert.revokedReason = reason;

    // Reverse accrued credits if any exist for this certificate
    const accruedEntry = db.creditLedger.find(
      (l) => l.certificateId === cert.id && l.entryType === "accrual",
    );
    if (accruedEntry) {
      db.creditLedger.unshift({
        id: `led-${crypto.randomUUID().slice(0, 8)}`,
        userId: cert.userId,
        cycleId: accruedEntry.cycleId,
        courseId: cert.courseId,
        courseTitleTh: cert.courseTitleTh,
        certificateId: cert.id,
        entryType: "reversal",
        creditsDelta: -Math.abs(accruedEntry.creditsDelta),
        reason: `หักคืนหน่วยกิตเนื่องจากเพิกถอนใบประกาศ ${cert.verificationCode} (${reason})`,
        createdBy: session.user.id,
        createdAt: nowIso,
      });
    }

    appendAuditLog(db, {
      eventType: "CERTIFICATE_REVOKE",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "certificates",
      targetId: cert.verificationCode,
      summaryTh: `เพิกถอนประกาศนียบัตร ${cert.verificationCode} ของ ${cert.recipientName} (เหตุผล: ${reason})`,
    });
    writeDb(db);

    return NextResponse.json({ ok: true, certificate: cert });
  }

  if (action === "adjust_credit") {
    const guard = verifyGuardPermission(session, "credit_adjustment:create");
    if (!guard.ok) return guard.response;

    const targetUserId = String(body.userId || "");
    const creditsDelta = Number(body.creditsDelta ?? 0);
    const reason = String(body.reason || "").trim();

    if (!targetUserId || !creditsDelta || Number.isNaN(creditsDelta) || !reason) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-CRD-002",
            message: "กรุณาระบุทนายความ จำนวนหน่วยกิตที่ปรับปรุง และเหตุผลให้ครบถ้วน",
          },
        },
        { status: 422 },
      );
    }

    const targetUser = db.profiles.find((p) => p.id === targetUserId);
    if (!targetUser) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบข้อมูลผู้ใช้" } },
        { status: 404 },
      );
    }

    let cycle = db.renewalCycles.find(
      (c) => c.userId === targetUser.id && c.status === "open",
    );
    if (!cycle) {
      cycle = {
        id: `cyc-2569-${targetUser.id}`,
        userId: targetUser.id,
        cycleYearBuddhist: 2569,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        requiredCredits: 12,
        status: "open",
      };
      db.renewalCycles.push(cycle);
    }

    const entryType = creditsDelta < 0 ? "reversal" : "adjustment";
    const newLedgerEntry = {
      id: `led-${crypto.randomUUID().slice(0, 8)}`,
      userId: targetUser.id,
      cycleId: cycle.id,
      courseId: null,
      courseTitleTh: "ปรับปรุงรายการหน่วยกิตโดยนายทะเบียน",
      certificateId: null,
      entryType: entryType as "adjustment" | "reversal",
      creditsDelta,
      reason,
      createdBy: session.user.id,
      createdAt: nowIso,
    };

    db.creditLedger.unshift(newLedgerEntry);

    appendAuditLog(db, {
      eventType: "CREDIT_LEDGER_ADJUST",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "credit_ledger",
      targetId: newLedgerEntry.id,
      summaryTh: `ปรับปรุงหน่วยกิต ${creditsDelta > 0 ? `+${creditsDelta}` : creditsDelta} หน่วย ให้ ${targetUser.displayName} (เหตุผล: ${reason})`,
    });
    writeDb(db);

    return NextResponse.json({
      ok: true,
      ledgerEntry: newLedgerEntry,
      netCredits: getUserNetCredits(db, targetUser.id),
    });
  }

  if (action === "create_credit_rule") {
    const guard = verifyGuardPermission(session, "credit_rule:create");
    if (!guard.ok) return guard.response;

    const courseId = String(body.courseId || "");
    const credits = Number(body.credits ?? 4);
    const creditType =
      body.creditType === "ethics"
        ? "ethics"
        : body.creditType === "specialized"
          ? "specialized"
          : "general";
    const carryOver = Boolean(body.carryOver);

    const course = db.courses.find((c) => c.id === courseId);
    if (!course) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบหลักสูตรที่ระบุ" } },
        { status: 404 },
      );
    }

    const newRule = {
      id: `cr-${crypto.randomUUID().slice(0, 8)}`,
      code: `CR-${course.code}`,
      courseId: course.id,
      name: `เกณฑ์หน่วยกิต ${course.titleTh}`,
      creditType: creditType as "general" | "ethics" | "specialized",
      credits,
      validDays: 365,
      carryOver,
      status: "active" as const,
      effectiveFrom: nowIso,
      createdAt: nowIso,
    };

    db.creditRules.unshift(newRule);
    course.credits = credits;

    appendAuditLog(db, {
      eventType: "CREDIT_RULE_WRITE",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "credit_rules",
      targetId: newRule.code,
      summaryTh: `กำหนดเกณฑ์หน่วยกิต ${newRule.code} (${credits} หน่วย · ประเภท ${creditType})`,
    });
    writeDb(db);

    return NextResponse.json({ ok: true, creditRule: newRule });
  }

  if (action === "grant_role" || action === "revoke_role") {
    const permission = action === "grant_role" ? "role:grant" : "role:revoke";
    const guard = verifyGuardPermission(session, permission);
    if (!guard.ok) return guard.response;

    const targetUserId = String(body.userId || "");
    const role = String(body.role || "") as Role;
    const reason = String(
      body.reason || "บริหารจัดการสิทธิ์ตามคำสั่งสภาทนายความ",
    ).trim();

    const targetUser = db.profiles.find((p) => p.id === targetUserId);
    if (!targetUser) {
      return NextResponse.json(
        { error: { code: "ERR-NF-001", message: "ไม่พบบัญชีผู้ใช้" } },
        { status: 404 },
      );
    }

    if (action === "grant_role") {
      const alreadyHas = db.roleAssignments.some(
        (r) =>
          r.userId === targetUser.id && r.role === role && r.revokedAt === null,
      );
      if (!alreadyHas) {
        db.roleAssignments.push({
          id: `ra-${crypto.randomUUID().slice(0, 8)}`,
          userId: targetUser.id,
          role,
          grantedBy: session.user.id,
          grantedAt: nowIso,
          revokedAt: null,
          reason,
        });
      }

      if (role.startsWith("staff:") || role === "instructor" || role === "super_admin") {
        targetUser.mfaEnabled = true;
      }

      appendAuditLog(db, {
        eventType: "ROLE_GRANT",
        actorUserId: session.user.id,
        actorName: session.user.displayName,
        actorRole: session.roles.join(","),
        targetTable: "role_assignments",
        targetId: `${targetUser.email}:${role}`,
        summaryTh: `มอบบทบาท '${role}' ให้แก่ ${targetUser.displayName} (${reason})`,
      });
    } else {
      // Prevent revoking the last super_admin
      if (role === "super_admin") {
        const activeSuperAdmins = db.roleAssignments.filter(
          (r) => r.role === "super_admin" && r.revokedAt === null,
        );
        if (activeSuperAdmins.length <= 1) {
          return NextResponse.json(
            {
              error: {
                code: "ERR-RBAC-001",
                message:
                  "ไม่สามารถเพิกถอนสิทธิ์ผู้ดูแลระบบสูงสุดคนสุดท้ายของระบบได้ (Last Super Admin Protection)",
              },
            },
            { status: 409 },
          );
        }
      }

      db.roleAssignments.forEach((r) => {
        if (
          r.userId === targetUser.id &&
          r.role === role &&
          r.revokedAt === null
        ) {
          r.revokedAt = nowIso;
          r.reason = reason;
        }
      });

      appendAuditLog(db, {
        eventType: "ROLE_REVOKE",
        actorUserId: session.user.id,
        actorName: session.user.displayName,
        actorRole: session.roles.join(","),
        targetTable: "role_assignments",
        targetId: `${targetUser.email}:${role}`,
        summaryTh: `เพิกถอนบทบาท '${role}' ของ ${targetUser.displayName} (${reason})`,
      });
    }

    writeDb(db);
    return NextResponse.json({
      ok: true,
      roles: getActiveRolesForUser(db, targetUser.id),
    });
  }

  if (action === "toggle_feature_flag") {
    const guard = verifyGuardPermission(session, "role:grant");
    if (!guard.ok) return guard.response;

    const flagKey = String(body.flagKey || "cert_auto_issue");
    const enabled = Boolean(body.enabled);
    db.featureFlags[flagKey] = enabled;

    appendAuditLog(db, {
      eventType: "FEATURE_FLAG_TOGGLE",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "feature_flags",
      targetId: flagKey,
      summaryTh: `ตั้งค่า Feature Flag '${flagKey}' เป็น ${enabled ? "เปิดใช้งาน (ON)" : "ปิดใช้งาน (OFF)"}`,
    });
    writeDb(db);

    return NextResponse.json({
      ok: true,
      featureFlags: db.featureFlags,
    });
  }

  if (action === "reset_demo_db") {
    resetDbToSeed();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    {
      error: {
        code: "ERR-VAL-001",
        message: "ไม่พบคำสั่งบริหารจัดการที่ระบุ",
      },
    },
    { status: 400 },
  );
}

/**
 * Unified Server-Side Relational Store — LTC E-Learning
 *
 * CRITICAL SECURITY INVARIANT:
 * - Server-only module. Never imported by Client Components.
 * - Both Frontoffice (User/Learner) and Backoffice (Management/Staff/Instructor)
 *   communicate ONLY via Next.js `/api/v1/*` BFF endpoints.
 * - Persists state to `/tmp/ltc-elearning-db.json` so mutations across Frontoffice
 *   and Backoffice (e.g., course publishing, license verification, exam submission,
 *   certificate issuance, credit adjustment, role grants, audit logs) immediately
 *   reflect across both portals.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  type AalLevel,
  type LedgerEntryType,
  type Role,
  computeNetCredits,
  gradeExamAttempt,
} from "@/lib/domain/ltc-logic";

const DB_FILE_PATH = path.join("/tmp", "ltc-elearning-db-v2.json");

export interface DbProfile {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string; // demo password check
  phone: string | null;
  preferredLocale: "th" | "en";
  pdpaConsentedAt: string | null;
  isActive: boolean;
  deletedAt: string | null;
  mfaEnabled: boolean;
  mfaSecret: string;
  createdAt: string;
}

export interface DbRoleAssignment {
  id: string;
  userId: string;
  role: Role;
  grantedBy: string | null;
  grantedAt: string;
  revokedAt: string | null;
  reason: string | null;
}

export interface DbLawyerLicense {
  id: string;
  userId: string;
  licenseNo: string;
  status: "pending" | "verified" | "rejected" | "expired";
  verifiedBy: string | null;
  verifiedAt: string | null;
  expiresOn: string | null;
  revokedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
}

export interface DbLicenseApplication {
  id: string;
  userId: string;
  licenseNo: string;
  evidenceNote: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectedReason: string | null;
  resultingLicenseId: string | null;
}

export interface DbCategory {
  id: string;
  slug: string;
  nameTh: string;
  nameEn: string;
  descriptionTh: string;
  sortOrder: number;
  isActive: boolean;
}

export interface DbLessonQuizQuestion {
  id: string;
  questionText: string;
  explanation: string;
  options: { id: string; text: string; isCorrect: boolean }[];
}

export interface DbLesson {
  id: string;
  moduleId: string;
  courseId: string;
  type: "video" | "document" | "quiz";
  titleTh: string;
  durationSec: number;
  videoUrl: string | null;
  contentMd: string | null;
  quizPassPct: number | null;
  quizQuestions: DbLessonQuizQuestion[];
  sortOrder: number;
  isPreview: boolean;
}

export interface DbCourseModule {
  id: string;
  courseId: string;
  titleTh: string;
  sortOrder: number;
}

export interface DbCourse {
  id: string;
  code: string;
  categoryId: string;
  createdBy: string;
  instructorName: string;
  instructorTitle: string;
  titleTh: string;
  titleEn: string;
  summary: string;
  descriptionTh: string;
  level: "beginner" | "intermediate" | "advanced";
  isPublic: boolean; // true = ประชาชนเรียนได้, false = เฉพาะทนายความ
  credits: number;
  status: "draft" | "pending_review" | "published" | "archived" | "returned";
  returnComment: string | null;
  outcomeHighlights: string[];
  rating: number;
  reviewCount: number;
  enrolledCount: number;
  publishedAt: string | null;
  createdAt: string;
}

export interface DbEnrollment {
  id: string;
  userId: string;
  courseId: string;
  status: "active" | "completed" | "expired" | "cancelled";
  enrolledAt: string;
  completedAt: string | null;
  lastLessonId: string | null;
}

export interface DbLessonProgress {
  id: string;
  enrollmentId: string;
  userId: string;
  courseId: string;
  lessonId: string;
  status: "not_started" | "in_progress" | "completed";
  watchPct: number;
  dwellSec: number;
  quizScorePct: number | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface DbQuestionOption {
  id: string;
  text: string;
  isCorrect: boolean;
}

export interface DbBankQuestion {
  id: string;
  bankId: string;
  courseId: string;
  moduleTitle: string;
  type: "single_choice" | "multiple_choice" | "true_false";
  difficulty: "easy" | "medium" | "hard";
  questionText: string;
  explanation: string;
  points: number;
  status: "draft" | "active" | "retired";
  options: DbQuestionOption[];
  version: number;
  createdBy: string;
  createdAt: string;
}

export interface DbQuestionBank {
  id: string;
  code: string;
  courseId: string;
  name: string;
  description: string;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
}

export interface DbAssessment {
  id: string;
  courseId: string;
  bankId: string;
  code: string;
  title: string;
  status: "draft" | "published" | "closed";
  timeLimitMinutes: number;
  questionCount: number;
  passPct: number;
  maxAttempts: number;
  proctoringMode: "none" | "basic";
  reviewMode: "after_final_attempt" | "never";
  requireCourseComplete: boolean;
  version: number;
  updatedAt: string;
}

export interface DbAssessmentAttempt {
  id: string;
  code: string;
  assessmentId: string;
  courseId: string;
  userId: string;
  attemptNo: number;
  status: "in_progress" | "submitted" | "passed" | "failed" | "expired" | "voided";
  startedAt: string;
  expiresAt: string;
  submittedAt: string | null;
  durationUsedSec: number;
  scorePct: number | null;
  earnedPoints: number | null;
  totalPoints: number | null;
  passPctSnapshot: number;
  questionIds: string[];
  answers: Record<string, string>; // questionId -> optionId
  flaggedQuestionIds: string[];
  moduleBreakdown: {
    moduleTitle: string;
    earnedPoints: number;
    totalPoints: number;
    percent: number;
  }[];
  certificateId: string | null;
}

export interface DbCertificate {
  id: string;
  verificationCode: string;
  userId: string;
  courseId: string;
  attemptId: string | null;
  recipientName: string;
  courseTitleTh: string;
  creditsAwarded: number;
  issuedAt: string;
  issuedBy: string | null; // null = auto-issued on exam pass
  issueMode: "auto" | "manual" | "bulk";
  status: "valid" | "revoked" | "superseded";
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

export interface DbCreditRule {
  id: string;
  code: string;
  courseId: string;
  name: string;
  creditType: "general" | "ethics" | "specialized";
  credits: number;
  validDays: number;
  carryOver: boolean;
  status: "active" | "retired";
  effectiveFrom: string;
  createdAt: string;
}

export interface DbRenewalCycle {
  id: string;
  userId: string;
  cycleYearBuddhist: number; // e.g., 2569
  startDate: string;
  endDate: string;
  requiredCredits: number;
  status: "open" | "closed" | "grace";
}

export interface DbCreditLedgerEntry {
  id: string;
  userId: string;
  cycleId: string;
  courseId: string | null;
  courseTitleTh: string;
  certificateId: string | null;
  entryType: LedgerEntryType;
  creditsDelta: number;
  reason: string;
  createdBy: string | null;
  createdAt: string;
}

export interface DbNotification {
  id: string;
  userId: string;
  title: string;
  body: string;
  href: string;
  isRead: boolean;
  createdAt: string;
}

export interface DbAuditLog {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorName: string;
  actorRole: string;
  targetTable: string;
  targetId: string;
  summaryTh: string;
  ipHash: string;
  createdAt: string;
}

export interface DbSessionRecord {
  token: string;
  userId: string;
  portal: "frontoffice" | "backoffice";
  aal: AalLevel;
  createdAt: string;
  expiresAt: string;
}

export interface LtcDatabase {
  profiles: DbProfile[];
  roleAssignments: DbRoleAssignment[];
  lawyerLicenses: DbLawyerLicense[];
  licenseApplications: DbLicenseApplication[];
  categories: DbCategory[];
  courses: DbCourse[];
  courseModules: DbCourseModule[];
  lessons: DbLesson[];
  enrollments: DbEnrollment[];
  lessonProgress: DbLessonProgress[];
  questionBanks: DbQuestionBank[];
  bankQuestions: DbBankQuestion[];
  assessments: DbAssessment[];
  attempts: DbAssessmentAttempt[];
  certificates: DbCertificate[];
  creditRules: DbCreditRule[];
  renewalCycles: DbRenewalCycle[];
  creditLedger: DbCreditLedgerEntry[];
  notifications: DbNotification[];
  auditLogs: DbAuditLog[];
  sessions: DbSessionRecord[];
  featureFlags: Record<string, boolean>;
}

function buildInitialSeed(): LtcDatabase {
  const now = "2026-09-08T09:00:00.000Z";

  const profiles: DbProfile[] = [
    {
      id: "u-lawyer-001",
      displayName: "ธนกร วัฒนกุล",
      firstName: "ธนกร",
      lastName: "วัฒนกุล",
      email: "thanakorn@ltc.or.th",
      passwordHash: "Password123!",
      phone: "081-234-5678",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-01-10T08:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: false,
      mfaSecret: "LTC-TOTP-USER1",
      createdAt: "2026-01-10T08:00:00.000Z",
    },
    {
      id: "u-citizen-001",
      displayName: "ปิยะพร แสงทอง",
      firstName: "ปิยะพร",
      lastName: "แสงทอง",
      email: "piyaporn@ltc.or.th",
      passwordHash: "Password123!",
      phone: "089-876-5432",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-03-15T10:30:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: false,
      mfaSecret: "LTC-TOTP-USER2",
      createdAt: "2026-03-15T10:30:00.000Z",
    },
    {
      id: "u-lawyer-002",
      displayName: "สุรเชษฐ์ ใจมั่น",
      firstName: "สุรเชษฐ์",
      lastName: "ใจมั่น",
      email: "surachet@ltc.or.th",
      passwordHash: "Password123!",
      phone: "086-555-1920",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-02-01T09:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: false,
      mfaSecret: "LTC-TOTP-USER3",
      createdAt: "2026-02-01T09:00:00.000Z",
    },
    {
      id: "u-registrar-001",
      displayName: "คุณสมหญิง ศรีวิไล",
      firstName: "สมหญิง",
      lastName: "ศรีวิไล",
      email: "registrar@ltc.or.th",
      passwordHash: "Password123!",
      phone: "02-351-1128",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: true,
      mfaSecret: "123456",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "u-content-001",
      displayName: "คุณกิตติพงศ์ วงศ์สวัสดิ์",
      firstName: "กิตติพงศ์",
      lastName: "วงศ์สวัสดิ์",
      email: "content@ltc.or.th",
      passwordHash: "Password123!",
      phone: "02-351-1128",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: true,
      mfaSecret: "123456",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "u-exam-001",
      displayName: "คุณพลอยไพลิน เกียรติขจร",
      firstName: "พลอยไพลิน",
      lastName: "เกียรติขจร",
      email: "exam@ltc.or.th",
      passwordHash: "Password123!",
      phone: "02-351-1128",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: true,
      mfaSecret: "123456",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "u-viewer-001",
      displayName: "ดร.วิษณุ ธรรมรักษ์",
      firstName: "วิษณุ",
      lastName: "ธรรมรักษ์",
      email: "viewer@ltc.or.th",
      passwordHash: "Password123!",
      phone: "02-351-1128",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: true,
      mfaSecret: "123456",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "u-instructor-001",
      displayName: "ศ.ดร.สมชาย นิติศาสตร์",
      firstName: "สมชาย",
      lastName: "นิติศาสตร์",
      email: "instructor@ltc.or.th",
      passwordHash: "Password123!",
      phone: "02-351-1128",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: true,
      mfaSecret: "123456",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "u-superadmin-001",
      displayName: "นายนรงค์ศักดิ์ สุขมา (Super Admin)",
      firstName: "นรงค์ศักดิ์",
      lastName: "สุขมา",
      email: "admin@ltc.or.th",
      passwordHash: "Password123!",
      phone: "02-351-1128",
      preferredLocale: "th",
      pdpaConsentedAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      deletedAt: null,
      mfaEnabled: true,
      mfaSecret: "123456",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const roleAssignments: DbRoleAssignment[] = [
    { id: "ra-1", userId: "u-lawyer-001", role: "citizen", grantedBy: null, grantedAt: now, revokedAt: null, reason: "สมัครสมาชิก" },
    { id: "ra-2", userId: "u-lawyer-001", role: "lawyer", grantedBy: "u-registrar-001", grantedAt: now, revokedAt: null, reason: "ยืนยันใบอนุญาตทนายความ ทล. 25891" },
    { id: "ra-3", userId: "u-citizen-001", role: "citizen", grantedBy: null, grantedAt: now, revokedAt: null, reason: "สมัครสมาชิก" },
    { id: "ra-4", userId: "u-lawyer-002", role: "citizen", grantedBy: null, grantedAt: now, revokedAt: null, reason: "สมัครสมาชิก" },
    { id: "ra-5", userId: "u-lawyer-002", role: "lawyer", grantedBy: "u-registrar-001", grantedAt: now, revokedAt: null, reason: "ยืนยันใบอนุญาตทนายความ ทล. 31402" },
    { id: "ra-6", userId: "u-registrar-001", role: "staff:registrar", grantedBy: "u-superadmin-001", grantedAt: now, revokedAt: null, reason: "แต่งตั้งนายทะเบียน" },
    { id: "ra-7", userId: "u-content-001", role: "staff:content", grantedBy: "u-superadmin-001", grantedAt: now, revokedAt: null, reason: "แต่งตั้งเจ้าหน้าที่ฝ่ายเนื้อหา" },
    { id: "ra-8", userId: "u-exam-001", role: "staff:exam", grantedBy: "u-superadmin-001", grantedAt: now, revokedAt: null, reason: "แต่งตั้งเจ้าหน้าที่ฝ่ายการสอบ" },
    { id: "ra-9", userId: "u-viewer-001", role: "staff:viewer", grantedBy: "u-superadmin-001", grantedAt: now, revokedAt: null, reason: "แต่งตั้งผู้ตรวจรายงาน" },
    { id: "ra-10", userId: "u-instructor-001", role: "instructor", grantedBy: "u-superadmin-001", grantedAt: now, revokedAt: null, reason: "แต่งตั้งวิทยากรผู้ทรงคุณวุฒิ" },
    { id: "ra-11", userId: "u-superadmin-001", role: "super_admin", grantedBy: null, grantedAt: now, revokedAt: null, reason: "System Bootstrap" },
  ];

  const lawyerLicenses: DbLawyerLicense[] = [
    {
      id: "lic-001",
      userId: "u-lawyer-001",
      licenseNo: "25891",
      status: "verified",
      verifiedBy: "u-registrar-001",
      verifiedAt: "2026-01-12T10:00:00.000Z",
      expiresOn: "2026-12-31",
      revokedAt: null,
      rejectedReason: null,
      createdAt: "2026-01-12T10:00:00.000Z",
    },
    {
      id: "lic-002",
      userId: "u-lawyer-002",
      licenseNo: "31402",
      status: "verified",
      verifiedBy: "u-registrar-001",
      verifiedAt: "2026-02-05T14:20:00.000Z",
      expiresOn: "2026-12-31",
      revokedAt: null,
      rejectedReason: null,
      createdAt: "2026-02-05T14:20:00.000Z",
    },
  ];

  const licenseApplications: DbLicenseApplication[] = [
    {
      id: "lapp-001",
      userId: "u-citizen-001",
      licenseNo: "39812",
      evidenceNote: "แนบสำเนาบัตรประจำตัวทนายความสภาทนายความ ออกเมื่อ 15 ส.ค. 2569",
      status: "pending",
      submittedAt: "2026-09-06T11:15:00.000Z",
      decidedBy: null,
      decidedAt: null,
      rejectedReason: null,
      resultingLicenseId: null,
    },
    {
      id: "lapp-002",
      userId: "u-lawyer-001",
      licenseNo: "25891",
      evidenceNote: "บัตรทนายความตลอดชีพ เลขที่ 25891",
      status: "approved",
      submittedAt: "2026-01-11T09:00:00.000Z",
      decidedBy: "u-registrar-001",
      decidedAt: "2026-01-12T10:00:00.000Z",
      rejectedReason: null,
      resultingLicenseId: "lic-001",
    },
  ];

  const categories: DbCategory[] = [
    {
      id: "cat-law-basics",
      slug: "law-basics",
      nameTh: "กฎหมายสำหรับประชาชน",
      nameEn: "Public Legal Literacy",
      descriptionTh: "ความรู้กฎหมายพื้นฐานและสิทธิในชีวิตประจำวันสำหรับประชาชนและผู้สนใจ",
      sortOrder: 1,
      isActive: true,
    },
    {
      id: "cat-ethics",
      slug: "ethics",
      nameTh: "จรรยาบรรณวิชาชีพทนายความ",
      nameEn: "Legal Ethics & Professional Conduct",
      descriptionTh: "ข้อบังคับว่าด้วยมรรยาททนายความและจริยธรรมแห่งวิชาชีพ",
      sortOrder: 2,
      isActive: true,
    },
    {
      id: "cat-contracts",
      slug: "contracts",
      nameTh: "กฎหมายแพ่งและสัญญา",
      nameEn: "Civil Law & Contract Drafting",
      descriptionTh: "หลักการทำนิติกรรมสัญญา การร่างสัญญาเชิงพาณิชย์ และการป้องกันข้อพิพาท",
      sortOrder: 3,
      isActive: true,
    },
    {
      id: "cat-litigation",
      slug: "litigation",
      nameTh: "วิธีพิจารณาความและงานคดี",
      nameEn: "Litigation & Trial Advocacy",
      descriptionTh: "ยุทธวิธีการว่าความ การเตรียมพยานหลักฐาน และวิธีพิจารณาความในศาล",
      sortOrder: 4,
      isActive: true,
    },
    {
      id: "cat-tax",
      slug: "tax",
      nameTh: "ภาษีอากรและกฎหมายธุรกิจ",
      nameEn: "Taxation & Corporate Law",
      descriptionTh: "การวางแผนภาษีอากร กฎหมายบริษัท และธุรกรรมทางการเงิน",
      sortOrder: 5,
      isActive: true,
    },
    {
      id: "cat-digital",
      slug: "digital-pdpa",
      nameTh: "กฎหมายดิจิทัลและ PDPA",
      nameEn: "Digital Law & Data Privacy",
      descriptionTh: "การคุ้มครองข้อมูลส่วนบุคคล อาชญากรรมทางเทคโนโลยี และธุรกรรมอิเล็กทรอนิกส์",
      sortOrder: 6,
      isActive: true,
    },
  ];

  const courses: DbCourse[] = [
    {
      id: "crs-101",
      code: "LTC-101",
      categoryId: "cat-law-basics",
      createdBy: "u-instructor-001",
      instructorName: "ศ.ดร.สมชาย นิติศาสตร์",
      instructorTitle: "กรรมการผู้ทรงคุณวุฒิ สภาทนายความแห่งประเทศไทย",
      titleTh: "กฎหมายที่ประชาชนควรรู้",
      titleEn: "Essential Law for Citizens",
      summary: "เพิ่มพูนความรู้กฎหมายเบื้องต้นที่ใช้ได้จริงในชีวิตประจำวัน ทั้งนิติกรรมสัญญา เช่าซื้อ อสังหาริมทรัพย์ และสิทธิผู้บริโภค",
      descriptionTh:
        "กฎหมายไม่ใช่เรื่องไกลตัว — ทุกวันเราทำนิติกรรมกันอยู่ตลอด ไม่ว่าจะเป็นการซื้อของออนไลน์ เช่าห้องพัก ทำสัญญาจ้างงาน หรือการโอนอสังหาริมทรัพย์ หลักสูตรนี้ออกแบบให้เข้าใจโครงสร้างระบบกฎหมายไทย สิทธิและหน้าที่ในสัญญาสำคัญ วิธีป้องกันการถูกเอาเปรียบ และขั้นตอนเบื้องต้นเมื่อเกิดข้อพิพาท",
      level: "beginner",
      isPublic: true,
      credits: 3,
      status: "published",
      returnComment: null,
      outcomeHighlights: [
        "เข้าใจโครงสร้างระบบกฎหมายไทยและลำดับชั้นของกฎหมาย",
        "อ่านและตรวจสอบสัญญาทั่วไปก่อนลงนามได้อย่างมั่นใจ",
        "รู้สิทธิของผู้บริโภคเมื่อซื้อสินค้าและบริการทั้งหน้าร้านและออนไลน์",
        "จัดการเรื่องทรัพย์สินและการซื้อขายอสังหาริมทรัพย์ได้อย่างถูกต้องตามประมวลกฎหมายแพ่งและพาณิชย์",
      ],
      rating: 4.8,
      reviewCount: 1205,
      enrolledCount: 3412,
      publishedAt: "2026-08-12T08:00:00.000Z",
      createdAt: "2026-08-01T08:00:00.000Z",
    },
    {
      id: "crs-102",
      code: "LTC-102",
      categoryId: "cat-ethics",
      createdBy: "u-instructor-001",
      instructorName: "นายเกษมสันต์ สุวรรณรัฐ",
      instructorTitle: "ประธานคณะกรรมการมรรยาททนายความ",
      titleTh: "จรรยาบรรณวิชาชีพทนายความ",
      titleEn: "Professional Legal Ethics & Conduct",
      summary: "มาตรฐานมรรยาททนายความ ความรับผิดชอบต่อลูกความและศาล กรณีศึกษาคำวินิจฉัยคดีมรรยาททนายความ",
      descriptionTh:
        "ศึกษาระเบียบและข้อบังคับสภาทนายความว่าด้วยมรรยาททนายความ พ.ศ. 2529 พร้อมวิเคราะห์แนวคำวินิจฉัยจริง เพื่อธำรงเกียรติศักดิ์แห่งวิชาชีพทนายความและป้องกันการประพฤติผิดมรรยาทโดยรู้เท่าไม่ถึงการณ์",
      level: "intermediate",
      isPublic: false,
      credits: 4,
      status: "published",
      returnComment: null,
      outcomeHighlights: [
        "วิเคราะห์องค์ประกอบความผิดมรรยาททนายความแต่ละหมวดได้แม่นยำ",
        "ปฏิบัติตนต่อลูกความ ศาล และทนายความฝ่ายตรงข้ามอย่างถูกต้องตามข้อบังคับ",
        "บริหารจัดการเงินและทรัพย์สินของลูกความโดยไม่ขัดต่อจรรยาบรรณ",
      ],
      rating: 4.9,
      reviewCount: 940,
      enrolledCount: 2890,
      publishedAt: "2026-08-15T08:00:00.000Z",
      createdAt: "2026-08-05T08:00:00.000Z",
    },
    {
      id: "crs-103",
      code: "LTC-103",
      categoryId: "cat-contracts",
      createdBy: "u-instructor-001",
      instructorName: "รศ.ดร.กานดา วัฒนชัย",
      instructorTitle: "ผู้เชี่ยวชาญกฎหมายสัญญาพาณิชย์",
      titleTh: "หลักกฎหมายสัญญาเช่าที่อยู่อาศัยและทักษะการร่างสัญญา",
      titleEn: "Residential Lease & Commercial Contract Drafting",
      summary: "เจาะลึกการร่างสัญญาเช่าที่อยู่อาศัย ประกาศคณะกรรมการว่าด้วยสัญญา และการวางข้อกำหนดปิดความเสี่ยงทางธุรกิจ",
      descriptionTh:
        "ครอบคลุมโครงสร้างสัญญามาตรฐาน ข้อสัญญาที่ไม่เป็นธรรมตามกฎหมายคุ้มครองผู้บริโภค และเทคนิคการร่างสัญญาเช่า-ซื้อขายที่รัดกุมทั้งฝ่ายผู้ให้เช่าและผู้เช่า",
      level: "intermediate",
      isPublic: true,
      credits: 4,
      status: "published",
      returnComment: null,
      outcomeHighlights: [
        "ร่างสัญญาเช่าและสัญญาพาณิชย์สอดคล้องประกาศคณะกรรมการว่าด้วยสัญญา",
        "ตรวจสอบข้อสัญญาที่เป็นโมฆะหรือไม่ได้เปรียบเทียบเท่าได้ทันที",
        "กำหนดเงื่อนไขการบอกเลิกสัญญาและการริบมัดจำอย่างถูกต้องตามกฎหมาย",
      ],
      rating: 4.7,
      reviewCount: 685,
      enrolledCount: 1950,
      publishedAt: "2026-08-20T08:00:00.000Z",
      createdAt: "2026-08-10T08:00:00.000Z",
    },
    {
      id: "crs-104",
      code: "LTC-104",
      categoryId: "cat-litigation",
      createdBy: "u-instructor-001",
      instructorName: "ศ.ดร.สมชาย นิติศาสตร์",
      instructorTitle: "กรรมการผู้ทรงคุณวุฒิ สภาทนายความแห่งประเทศไทย",
      titleTh: "การฟ้องร้องคดีขั้นสูงและการเตรียมพยานหลักฐานดิจิทัล",
      titleEn: "Advanced Litigation & Digital Evidence",
      summary: "ยุทธวิธีการตั้งรูปคดี การยื่นบัญชีระบุพยาน และการนำสืบพยานหลักฐานอิเล็กทรอนิกส์ในชั้นศาล",
      descriptionTh:
        "เจาะลึกหลักการร่างคำฟ้อง คำให้การ การซักค้านพยานบุคคล และการรับฟังพยานหลักฐานทางอิเล็กทรอนิกส์ตาม พ.ร.บ.ว่าด้วยธุรกรรมทางอิเล็กทรอนิกส์ และข้อกำหนดศาล",
      level: "advanced",
      isPublic: false,
      credits: 4,
      status: "published",
      returnComment: null,
      outcomeHighlights: [
        "วางโครงสร้างคำฟ้องและคำให้การอย่างเป็นระบบ",
        "จัดการความน่าเชื่อถือและห่วงโซ่การเก็บรักษาพยานหลักฐานดิจิทัล (Chain of Custody)",
        "เข้าใจหลักการตัดพยานและข้อยกเว้นการรับฟังพยานบอกเล่า",
      ],
      rating: 4.9,
      reviewCount: 512,
      enrolledCount: 1480,
      publishedAt: "2026-08-25T08:00:00.000Z",
      createdAt: "2026-08-18T08:00:00.000Z",
    },
    {
      id: "crs-105",
      code: "LTC-105",
      categoryId: "cat-digital",
      createdBy: "u-instructor-001",
      instructorName: "ดร.ปวีณา อัครเดช",
      instructorTitle: "ที่ปรึกษากฎหมายคุ้มครองข้อมูลส่วนบุคคล (DPO)",
      titleTh: "กฎหมายคุ้มครองข้อมูลส่วนบุคคล (PDPA) สำหรับสำนักงานทนายความ",
      titleEn: "PDPA Compliance for Law Firms",
      summary: "แนวปฏิบัติการจัดทำประกาศความเป็นส่วนตัว การบริหารสิทธิเจ้าของข้อมูล และมาตรการรักษาความมั่นคงปลอดภัย",
      descriptionTh:
        "เตรียมความพร้อมให้ทนายความและองค์กรปฏิบัติตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 ครบถ้วน ตั้งแต่การจำแนกฐานทางกฎหมายในการประมวลผลข้อมูลไปจนถึงการรับมือเหตุละเมิดข้อมูลส่วนบุคคล",
      level: "beginner",
      isPublic: true,
      credits: 3,
      status: "published",
      returnComment: null,
      outcomeHighlights: [
        "จำแนกฐานความชอบด้วยกฎหมาย (Legal Basis) สำหรับงานคดีและงานที่ปรึกษา",
        "จัดทำบันทึกกิจกรรมการประมวลผลข้อมูล (RoPA) และ Privacy Notice ได้จริง",
        "ดำเนินการแจ้งเหตุละเมิดข้อมูลส่วนบุคคลภายใน 72 ชั่วโมงตามเกณฑ์ สคส.",
      ],
      rating: 4.8,
      reviewCount: 430,
      enrolledCount: 1620,
      publishedAt: "2026-09-01T08:00:00.000Z",
      createdAt: "2026-08-22T08:00:00.000Z",
    },
    {
      id: "crs-106",
      code: "LTC-106",
      categoryId: "cat-tax",
      createdBy: "u-instructor-001",
      instructorName: "อาจารย์วรพจน์ เกียรติธนากร",
      instructorTitle: "ทนายความผู้เชี่ยวชาญกฎหมายภาษีอากร",
      titleTh: "ภาษีน่ารู้และการวางแผนภาษีสำหรับวิชาชีพทนายความ",
      titleEn: "Tax Essentials & Planning for Legal Professionals",
      summary: "ภาษีเงินได้บุคคลธรรมดา นิติบุคคล ภาษีหัก ณ ที่จ่าย และภาษีมูลค่าเพิ่มสำหรับผู้ประกอบวิชาชีพอิสระ",
      descriptionTh:
        "เรียนรู้โครงสร้างภาษีอากรที่เกี่ยวข้องกับค่าวิชาชีพทนายความ การหักค่าใช้จ่ายเป็นการเหมาหรือตามจริง และการวางแผนภาษีอย่างถูกต้องตามประมวลรัษฎากร",
      level: "intermediate",
      isPublic: false,
      credits: 3,
      status: "published",
      returnComment: null,
      outcomeHighlights: [
        "คำนวณภาษีเงินได้วิชาชีพอิสระ (มาตรา 40(6)) และวางแผนค่าลดหย่อนได้ถูกต้อง",
        "จัดการภาษีหัก ณ ที่จ่ายและภาษีมูลค่าเพิ่มของสำนักงานทนายความ",
      ],
      rating: 4.6,
      reviewCount: 310,
      enrolledCount: 1120,
      publishedAt: "2026-09-03T08:00:00.000Z",
      createdAt: "2026-08-28T08:00:00.000Z",
    },
    {
      id: "crs-201-pending",
      code: "LTC-201",
      categoryId: "cat-digital",
      createdBy: "u-instructor-001",
      instructorName: "ศ.ดร.สมชาย นิติศาสตร์",
      instructorTitle: "กรรมการผู้ทรงคุณวุฒิ สภาทนายความแห่งประเทศไทย",
      titleTh: "กฎหมายสินทรัพย์ดิจิทัลและสัญญาอัจฉริยะ (Smart Contracts)",
      titleEn: "Digital Assets & Smart Contract Law",
      summary: "หลักเกณฑ์ตาม พ.ร.ก.การประกอบธุรกิจสินทรัพย์ดิจิทัล และการบังคับใช้ Smart Contract ในระบบกฎหมายไทย",
      descriptionTh:
        "หลักสูตรใหม่อยู่ระหว่างรอการตรวจอนุมัติโดยเจ้าหน้าที่ฝ่ายเนื้อหาหลักสูตร (staff:content) ก่อนเปิดให้ลงทะเบียนเรียน",
      level: "advanced",
      isPublic: false,
      credits: 3,
      status: "pending_review",
      returnComment: null,
      outcomeHighlights: [
        "เข้าใจโครงสร้างการกำกับดูแลสินทรัพย์ดิจิทัลและโทเคนดิจิทัล",
        "วิเคราะห์ผลผูกพันทางกฎหมายของ Smart Contract และการระงับข้อพิพาท",
      ],
      rating: 0,
      reviewCount: 0,
      enrolledCount: 0,
      publishedAt: null,
      createdAt: "2026-09-07T15:00:00.000Z",
    },
  ];

  const courseModules: DbCourseModule[] = [
    { id: "mod-101-1", courseId: "crs-101", titleTh: "โมดูล 1 · พื้นฐานกฎหมายไทยและลำดับศักดิ์กฎหมาย", sortOrder: 1 },
    { id: "mod-101-2", courseId: "crs-101", titleTh: "โมดูล 2 · สัญญาในชีวิตประจำวันและอสังหาริมทรัพย์", sortOrder: 2 },
    { id: "mod-101-3", courseId: "crs-101", titleTh: "โมดูล 3 · สิทธิผู้บริโภคและการระงับข้อพิพาทเบื้องต้น", sortOrder: 3 },
    { id: "mod-102-1", courseId: "crs-102", titleTh: "โมดูล 1 · ข้อบังคับมรรยาททนายความและหลักจริยธรรม", sortOrder: 1 },
    { id: "mod-102-2", courseId: "crs-102", titleTh: "โมดูล 2 · กรณีศึกษาคำวินิจฉัยมรรยาททนายความ", sortOrder: 2 },
    { id: "mod-103-1", courseId: "crs-103", titleTh: "โมดูล 1 · โครงสร้างสัญญาเช่าและประกาศคณะกรรมการว่าด้วยสัญญา", sortOrder: 1 },
    { id: "mod-104-1", courseId: "crs-104", titleTh: "โมดูล 1 · ยุทธวิธีการตั้งรูปคดีและพยานหลักฐานดิจิทัล", sortOrder: 1 },
    { id: "mod-105-1", courseId: "crs-105", titleTh: "โมดูล 1 · หลักการ PDPA สำหรับสำนักงานทนายความ", sortOrder: 1 },
    { id: "mod-106-1", courseId: "crs-106", titleTh: "โมดูล 1 · ภาษีเงินได้วิชาชีพอิสระและภาษีมูลค่าเพิ่ม", sortOrder: 1 },
  ];

  const lessons: DbLesson[] = [
    {
      id: "les-101-1",
      moduleId: "mod-101-1",
      courseId: "crs-101",
      type: "video",
      titleTh: "1.1 โครงสร้างระบบกฎหมายไทยและลำดับชั้นของกฎหมาย",
      durationSec: 920,
      videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
      contentMd:
        "### สรุปสาระสำคัญ บทที่ 1.1\n\n- **รัฐธรรมนูญ** เป็นกฎหมายสูงสุดในการปกครองประเทศ กฎหมายใดขัดหรือแย้งต่อรัฐธรรมนูญใช้บังคับไม่ได้\n- **พระราชบัญญัติประกอบรัฐธรรมนูญ / พระราชบัญญัติ / ประมวลกฎหมาย** ออกโดยฝ่ายนิติบัญญัติ\n- **พระราชกำหนด / พระราชกฤษฎีกา / กฎกระทรวง** เป็นกฎหมายลำดับรองที่ออกโดยฝ่ายบริหารตามที่กฎหมายแม่บทให้อำนาจ",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 1,
      isPreview: true,
    },
    {
      id: "les-101-2",
      moduleId: "mod-101-1",
      courseId: "crs-101",
      type: "document",
      titleTh: "1.2 บุคคล สิทธิ หน้าที่ และความสามารถในการทำนิติกรรม",
      durationSec: 720,
      videoUrl: null,
      contentMd:
        "### เอกสารประกอบการเรียน: ความสามารถของบุคคลในการทำนิติกรรม\n\n1. **ผู้เยาว์ (ยังไม่บรรลุนิติภาวะ อายุต่ำกว่า 20 ปีบริบูรณ์ หรือยังไม่ทำการสมรสโดยชอบด้วยกฎหมาย)**: การทำนิติกรรมต้องได้รับความยินยอมจากผู้แทนโดยชอบธรรม มิฉะนั้นตกเป็น **โมฆียะ** ยกเว้นนิติกรรมที่เป็นคุณแก่ผู้เยาว์ฝ่ายเดียว หรือต้องทำเองเฉพาะตัว หรือสมแก่ฐานานุรูปและจำเป็นในการดำรงชีพ\n2. **คนไร้ความสามารถ**: ศาลสั่งให้เป็นคนไร้ความสามารถ ต้องอยู่ในความอนุบาล การใดๆ ที่คนไร้ความสามารถทำลงมีผลเป็น **โมฆียะ** เสมอแม้ผู้อนุบาลจะให้ความยินยอม\n3. **คนเสมือนไร้ความสามารถ**: ต้องได้รับความยินยอมจากผู้พิทักษ์ในกิจการสำคัญตามมาตรา 34 แห่ง ป.พ.พ.",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 2,
      isPreview: true,
    },
    {
      id: "les-101-3",
      moduleId: "mod-101-2",
      courseId: "crs-101",
      type: "video",
      titleTh: "2.1 นิติกรรมและสัญญา: โมฆะกรรม vs โมฆียะกรรม",
      durationSec: 1120,
      videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
      contentMd:
        "### ตารางเปรียบเทียบ โมฆะกรรม และ โมฆียะกรรม\n\n- **โมฆะกรรม (Void)**: เสียเปล่ามาตั้งแต่ต้น ไม่ก่อให้เกิดผลทางกฎหมายใดๆ ให้สัตยาบันไม่ได้ ผู้มีส่วนได้เสียยกขึ้นกล่าวอ้างได้ทุกเมื่อ\n- **โมฆียะกรรม (Voidable)**: สมบูรณ์อยู่จนกว่าจะถูกบอกล้าง หากให้สัตยาบันจะสมบูรณ์มาตั้งแต่เริ่มทำนิติกรรม",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 3,
      isPreview: false,
    },
    {
      id: "les-101-4",
      moduleId: "mod-101-2",
      courseId: "crs-101",
      type: "video",
      titleTh: "2.3 การทำสัญญาซื้อขายและเช่าอสังหาริมทรัพย์",
      durationSec: 872,
      videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
      contentMd:
        "### หลักสำคัญตามประมวลกฎหมายแพ่งและพาณิชย์ มาตรา 456 และ มาตรา 538\n\n- **การซื้อขายอสังหาริมทรัพย์ (มาตรา 456 วรรคหนึ่ง)**: ต้องทำเป็นหนังสือและจดทะเบียนต่อพนักงานเจ้าหน้าที่ มิฉะนั้นเป็น **โมฆะ**\n- **สัญญาจะซื้อจะขายอสังหาริมทรัพย์ (มาตรา 456 วรรคสอง)**: ต้องมีหลักฐานเป็นหนังสือลงลายมือชื่อฝ่ายที่ต้องรับผิด หรือวางประจำ หรือชำระหนี้บางส่วน มิฉะนั้นจะฟ้องร้องบังคับคดีไม่ได้\n- **การเช่าอสังหาริมทรัพย์ (มาตรา 538)**: เช่าไม่เกิน 3 ปี ต้องมีหลักฐานเป็นหนังสือลงลายมือชื่อฝ่ายที่ต้องรับผิด หากเช่าเกินกว่า 3 ปี ต้องทำเป็นหนังสือและจดทะเบียนต่อพนักงานเจ้าหน้าที่ มิฉะนั้นฟ้องร้องบังคับคดีได้เพียง 3 ปี",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 4,
      isPreview: false,
    },
    {
      id: "les-101-5",
      moduleId: "mod-101-3",
      courseId: "crs-101",
      type: "quiz",
      titleTh: "3.1 แบบทดสอบย่อยทบทวนความเข้าใจก่อนสอบปลายภาค",
      durationSec: 600,
      videoUrl: null,
      contentMd: "ทำแบบทดสอบย่อย 2 ข้อ (เกณฑ์ผ่าน 50%) เพื่อปลดล็อกการเข้าสอบปลายหลักสูตร",
      quizPassPct: 50,
      quizQuestions: [
        {
          id: "lqq-1",
          questionText: "กฎหมายใดมีลำดับศักดิ์สูงสุดในระบบกฎหมายไทย?",
          explanation: "รัฐธรรมนูญแห่งราชอาณาจักรไทยเป็นกฎหมายสูงสุดในการปกครองประเทศ",
          options: [
            { id: "lqo-1", text: "รัฐธรรมนูญแห่งราชอาณาจักรไทย", isCorrect: true },
            { id: "lqo-2", text: "พระราชบัญญัติประกอบรัฐธรรมนูญ", isCorrect: false },
            { id: "lqo-3", text: "ประมวลกฎหมายแพ่งและพาณิชย์", isCorrect: false },
            { id: "lqo-4", text: "พระราชกำหนด", isCorrect: false },
          ],
        },
        {
          id: "lqq-2",
          questionText: "การซื้อขายที่ดินมีโฉนดโดยทำสัญญาเป็นหนังสือกันเองแต่ไม่ได้จดทะเบียนต่อพนักงานเจ้าหน้าที่ มีผลทางกฎหมายอย่างไร?",
          explanation: "ตาม ป.พ.พ. มาตรา 456 วรรคหนึ่ง การซื้อขายอสังหาริมทรัพย์ถ้ามิได้ทำเป็นหนังสือและจดทะเบียนต่อพนักงานเจ้าหน้าที่เป็นโมฆะ",
          options: [
            { id: "lqo-5", text: "สมบูรณ์ผูกพันคู่สัญญา", isCorrect: false },
            { id: "lqo-6", text: "ตกเป็นโมฆะ", isCorrect: true },
            { id: "lqo-7", text: "ตกเป็นโมฆียะ", isCorrect: false },
            { id: "lqo-8", text: "สมบูรณ์เฉพาะ 3 ปีแรก", isCorrect: false },
          ],
        },
      ],
      sortOrder: 5,
      isPreview: false,
    },
    {
      id: "les-102-1",
      moduleId: "mod-102-1",
      courseId: "crs-102",
      type: "video",
      titleTh: "1.1 มรรยาททนายความต่อศาลและต่อลูกความ",
      durationSec: 1200,
      videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
      contentMd:
        "### ข้อบังคับสภาทนายความว่าด้วยมรรยาททนายความ พ.ศ. 2529\n\n- หมวด 2 มรรยาทต่อศาล: ไม่รับหน้าที่เมื่อรู้ว่าตนมีส่วนได้เสีย ไม่ปกปิดหรือบิดเบือนข้อเท็จจริงเพื่อหลอกลวงศาล\n- หมวด 3 มรรยาทต่อลูกความ: ไม่กระทำการอันเป็นการยุยงส่งเสริมให้มีการฟ้องร้องคดีอันหามูลมิได้ ไม่เปิดเผยความลับของลูกความ",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 1,
      isPreview: true,
    },
    {
      id: "les-102-2",
      moduleId: "mod-102-2",
      courseId: "crs-102",
      type: "document",
      titleTh: "2.1 กรณีศึกษาคำวินิจฉัยคดีมรรยาทและบทลงโทษ 3 ระดับ",
      durationSec: 900,
      videoUrl: null,
      contentMd:
        "### โทษผิดมรรยาททนายความตาม พ.ร.บ.ทนายความ พ.ศ. 2528 มาตรา 52\n\n1. **ภาคทัณฑ์** (กรณีความผิดเล็กน้อย)\n2. **ห้ามทำการเป็นทนายความมีกำหนดไม่เกิน 3 ปี**\n3. **ลบชื่อออกจากทะเบียนทนายความ** (กรณีความผิดร้ายแรงหรือเสื่อมเสียเกียรติศักดิ์วิชาชีพอย่างร้ายแรง)",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 2,
      isPreview: false,
    },
    {
      id: "les-103-1",
      moduleId: "mod-103-1",
      courseId: "crs-103",
      type: "video",
      titleTh: "1.1 โครงสร้างสัญญาเช่าที่อยู่อาศัยและประกาศ สคบ.",
      durationSec: 1080,
      videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
      contentMd:
        "### สาระสำคัญของประกาศคณะกรรมการว่าด้วยสัญญา เรื่อง ให้ธุรกิจการให้เช่าอาคารเพื่ออยู่อาศัยเป็นธุรกิจที่ควบคุมสัญญา\n\n- ห้ามเก็บเงินประกันและค่าเช่าล่วงหน้ารวมกันเกิน 3 เดือนของค่าเช่ารายเดือน\n- ผู้เช่ามีสิทธิบอกเลิกสัญญาก่อนครบกำหนดโดยแจ้งล่วงหน้าเป็นหนังสือไม่น้อยกว่า 30 วัน (เมื่อเช่ามาแล้วไม่น้อยกว่ากึ่งหนึ่งของอายุสัญญา)",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 1,
      isPreview: true,
    },
    {
      id: "les-104-1",
      moduleId: "mod-104-1",
      courseId: "crs-104",
      type: "document",
      titleTh: "1.1 ยุทธวิธีการตั้งรูปคดีและการยื่นพยานหลักฐานดิจิทัล",
      durationSec: 1100,
      videoUrl: null,
      contentMd:
        "### การรับฟังพยานหลักฐานข้อมูลอิเล็กทรอนิกส์\n\nตาม พ.ร.บ.ว่าด้วยธุรกรรมทางอิเล็กทรอนิกส์ มาตรา 11 ห้ามมิให้ปฏิเสธการรับฟังข้อมูลอิเล็กทรอนิกส์เป็นพยานหลักฐานในกระบวนการพิจารณาตามกฎหมายเพียงเพราะเหตุว่าเป็นข้อมูลอิเล็กทรอนิกส์ โดยศาลจะชั่งน้ำหนักจากความน่าเชื่อถือของวิธีการสร้าง เก็บรักษา หรือสื่อสารข้อมูล",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 1,
      isPreview: true,
    },
    {
      id: "les-105-1",
      moduleId: "mod-105-1",
      courseId: "crs-105",
      type: "video",
      titleTh: "1.1 ฐานทางกฎหมาย (Legal Basis) และหน้าที่ของสำนักงานทนายความตาม PDPA",
      durationSec: 960,
      videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
      contentMd:
        "### ฐานทางกฎหมายตามมาตรา 24 และมาตรา 26 แห่ง พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562\n\n- การเก็บรวบรวมข้อมูลส่วนบุคคลอ่อนไหวเพื่อการก่อตั้งสิทธิเรียกร้องตามกฎหมาย การปฏิบัติตามหรือการใช้สิทธิเรียกร้องตามกฎหมาย หรือการยกขึ้นต่อสู้สิทธิเรียกร้องตามกฎหมาย ได้รับยกเว้นไม่ต้องขอความยินยอมตามมาตรา 26 (4)",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 1,
      isPreview: true,
    },
    {
      id: "les-106-1",
      moduleId: "mod-106-1",
      courseId: "crs-106",
      type: "document",
      titleTh: "1.1 เงินได้พึงประเมินมาตรา 40(6) วิชาชีพอิสระกฎหมาย",
      durationSec: 840,
      videoUrl: null,
      contentMd:
        "### การหักค่าใช้จ่ายของทนายความ (เงินได้ตามมาตรา 40(6) ประมวลรัษฎากร)\n\nผู้ประกอบวิชาชีพอิสระวิชากฎหมายสามารถเลือกหักค่าใช้จ่ายได้ 2 วิธี:\n1. **หักค่าใช้จ่ายเป็นการเหมาในอัตราร้อยละ 30**\n2. **หักค่าใช้จ่ายตามความจำเป็นและสมควร (ตามจริง)** โดยมีใบเสร็จรับเงินและหลักฐานครบถ้วน",
      quizPassPct: null,
      quizQuestions: [],
      sortOrder: 1,
      isPreview: true,
    },
  ];

  const questionBanks: DbQuestionBank[] = [
    {
      id: "qb-101",
      code: "QB-LTC-101",
      courseId: "crs-101",
      name: "คลังข้อสอบหลักสูตร กฎหมายที่ประชาชนควรรู้",
      description: "ข้อสอบมาตรฐานวัดความรู้กฎหมายพื้นฐาน นิติกรรมสัญญา อสังหาริมทรัพย์ และสิทธิผู้บริโภค",
      isActive: true,
      createdBy: "u-instructor-001",
      createdAt: "2026-08-05T08:00:00.000Z",
    },
    {
      id: "qb-102",
      code: "QB-LTC-102",
      courseId: "crs-102",
      name: "คลังข้อสอบหลักสูตร จรรยาบรรณวิชาชีพทนายความ",
      description: "ข้อสอบวัดความเข้าใจข้อบังคับมรรยาททนายความ พ.ศ. 2529 และ พ.ร.บ.ทนายความ พ.ศ. 2528",
      isActive: true,
      createdBy: "u-instructor-001",
      createdAt: "2026-08-10T08:00:00.000Z",
    },
    {
      id: "qb-103",
      code: "QB-LTC-103",
      courseId: "crs-103",
      name: "คลังข้อสอบหลักสูตร สัญญาเช่าที่อยู่อาศัยและการร่างสัญญา",
      description: "ข้อสอบวัดทักษะการร่างสัญญาเช่าและกฎหมายคุ้มครองผู้บริโภคด้านสัญญา",
      isActive: true,
      createdBy: "u-instructor-001",
      createdAt: "2026-08-12T08:00:00.000Z",
    },
  ];

  const bankQuestions: DbBankQuestion[] = [
    {
      id: "q-101-1",
      bankId: "qb-101",
      courseId: "crs-101",
      moduleTitle: "โมดูล 1 · พื้นฐานกฎหมายไทย",
      type: "single_choice",
      difficulty: "easy",
      questionText: "ตามลำดับศักดิ์ของกฎหมายไทย กฎหมายในข้อใดมีลำดับชั้นสูงสุด?",
      explanation: "รัฐธรรมนูญแห่งราชอาณาจักรไทยเป็นกฎหมายสูงสุดในการปกครองประเทศ บทบัญญัติใดของกฎหมายขัดหรือแย้งต่อรัฐธรรมนูญใช้บังคับไม่ได้",
      points: 20,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-101-1a", text: "ก. รัฐธรรมนูญแห่งราชอาณาจักรไทย", isCorrect: true },
        { id: "qo-101-1b", text: "ข. ประมวลกฎหมายแพ่งและพาณิชย์", isCorrect: false },
        { id: "qo-101-1c", text: "ค. พระราชกำหนดที่ออกในกรณีฉุกเฉิน", isCorrect: false },
        { id: "qo-101-1d", text: "ง. พระราชกฤษฎีกา", isCorrect: false },
      ],
    },
    {
      id: "q-101-2",
      bankId: "qb-101",
      courseId: "crs-101",
      moduleTitle: "โมดูล 1 · พื้นฐานกฎหมายไทย",
      type: "single_choice",
      difficulty: "medium",
      questionText: "บุคคลย่อมบรรลุนิติภาวะเมื่อมีอายุครบกี่ปีบริบูรณ์ตามประมวลกฎหมายแพ่งและพาณิชย์?",
      explanation: "ตาม ป.พ.พ. มาตรา 19 บุคคลย่อมพ้นจากภาวะผู้เยาว์และบรรลุนิติภาวะเมื่อมีอายุยี่สิบปีบริบูรณ์",
      points: 20,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-101-2a", text: "ก. 17 ปีบริบูรณ์", isCorrect: false },
        { id: "qo-101-2b", text: "ข. 18 ปีบริบูรณ์", isCorrect: false },
        { id: "qo-101-2c", text: "ค. 20 ปีบริบูรณ์", isCorrect: true },
        { id: "qo-101-2d", text: "ง. 25 ปีบริบูรณ์", isCorrect: false },
      ],
    },
    {
      id: "q-101-3",
      bankId: "qb-101",
      courseId: "crs-101",
      moduleTitle: "โมดูล 2 · สัญญาในชีวิตประจำวัน",
      type: "single_choice",
      difficulty: "medium",
      questionText: "ตามประมวลกฎหมายแพ่งและพาณิชย์ การขายอสังหาริมทรัพย์เพื่อโอนกรรมสิทธิ์ ความถูกต้องของการทำนิติกรรมเป็นอย่างไร?",
      explanation: "ตาม ป.พ.พ. มาตรา 456 วรรคหนึ่ง การซื้อขายอสังหาริมทรัพย์ถ้ามิได้ทำเป็นหนังสือและจดทะเบียนต่อพนักงานเจ้าหน้าที่เป็นโมฆะ",
      points: 20,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-101-3a", text: "ก. ทำสัญญาปากเปล่าได้ หากมีการส่งมอบทรัพย์และชำระราคาเรียบร้อยแล้ว", isCorrect: false },
        { id: "qo-101-3b", text: "ข. ทำเป็นหนังสือสัญญาโดยมีพยานบุคคลอย่างน้อย 2 คนรับรองลายมือชื่อ", isCorrect: false },
        { id: "qo-101-3c", text: "ค. การโอนกรรมสิทธิ์ต้องทำเป็นหนังสือและจดทะเบียนต่อพนักงานเจ้าหน้าที่ มิฉะนั้นไม่สมบูรณ์ (เป็นโมฆะ)", isCorrect: true },
        { id: "qo-101-3d", text: "ง. ทำเป็นหนังสือต่อหน้าทนายความผู้รับมอบอำนาจ ไม่ต้องจดทะเบียนต่อพนักงานเจ้าหน้าที่", isCorrect: false },
      ],
    },
    {
      id: "q-101-4",
      bankId: "qb-101",
      courseId: "crs-101",
      moduleTitle: "โมดูล 2 · สัญญาในชีวิตประจำวัน",
      type: "single_choice",
      difficulty: "medium",
      questionText: "การกู้ยืมเงินเกินกว่าเท่าใดขึ้นไป จึงต้องมีหลักฐานแห่งการกู้ยืมเป็นหนังสือลงลายมือชื่อผู้ยืมเป็นสำคัญ มิฉะนั้นจะฟ้องร้องบังคับคดีไม่ได้?",
      explanation: "ตาม ป.พ.พ. มาตรา 653 วรรคหนึ่ง การกู้ยืมเงินกว่าสองพันบาทขึ้นไป ถ้ามิได้มีหลักฐานแห่งการกู้ยืมเป็นหนังสืออย่างใดอย่างหนึ่งลงลายมือชื่อผู้ยืมเป็นสำคัญ จะฟ้องร้องให้บังคับคดีหาได้ไม่",
      points: 20,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-101-4a", text: "ก. กว่า 500 บาทขึ้นไป", isCorrect: false },
        { id: "qo-101-4b", text: "ข. กว่า 2,000 บาทขึ้นไป", isCorrect: true },
        { id: "qo-101-4c", text: "ค. กว่า 5,000 บาทขึ้นไป", isCorrect: false },
        { id: "qo-101-4d", text: "ง. กว่า 10,000 บาทขึ้นไป", isCorrect: false },
      ],
    },
    {
      id: "q-101-5",
      bankId: "qb-101",
      courseId: "crs-101",
      moduleTitle: "โมดูล 3 · สิทธิผู้บริโภคและการระงับข้อพิพาท",
      type: "single_choice",
      difficulty: "hard",
      questionText: "การเช่าอสังหาริมทรัพย์ที่มีกำหนดเวลาเกินกว่า 3 ปี หากทำเป็นหนังสือสัญญาแต่ไม่ได้จดทะเบียนต่อพนักงานเจ้าหน้าที่ จะมีผลทางกฎหมายอย่างไร?",
      explanation: "ตาม ป.พ.พ. มาตรา 538 เช่าอสังหาริมทรัพย์มีกำหนดกว่า 3 ปีขึ้นไป ถ้ามิได้ทำเป็นหนังสือและจดทะเบียนต่อพนักงานเจ้าหน้าที่ จะฟ้องร้องให้บังคับคดีได้แต่เพียง 3 ปี",
      points: 20,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-101-5a", text: "ก. ตกเป็นโมฆะทั้งฉบับ", isCorrect: false },
        { id: "qo-101-5b", text: "ข. ฟ้องร้องบังคับคดีได้แต่เพียง 3 ปี", isCorrect: true },
        { id: "qo-101-5c", text: "ค. ฟ้องร้องบังคับคดีได้เต็มตามอายุสัญญาที่ระบุ", isCorrect: false },
        { id: "qo-101-5d", text: "ง. ตกเป็นโมฆียะ", isCorrect: false },
      ],
    },
    {
      id: "q-102-1",
      bankId: "qb-102",
      courseId: "crs-102",
      moduleTitle: "โมดูล 1 · ข้อบังคับมรรยาททนายความ",
      type: "single_choice",
      difficulty: "medium",
      questionText: "โทษของการประพฤติผิดมรรยาททนายความตาม พ.ร.บ.ทนายความ พ.ศ. 2528 มาตรา 52 มีกี่สถาน อะไรบ้าง?",
      explanation: "โทษผิดมรรยาททนายความมี 3 สถาน ได้แก่ (1) ภาคทัณฑ์ (2) ห้ามทำการเป็นทนายความมีกำหนดไม่เกิน 3 ปี และ (3) ลบชื่อออกจากทะเบียนทนายความ",
      points: 50,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-102-1a", text: "ก. 3 สถาน คือ ภาคทัณฑ์, ห้ามทำการเป็นทนายความไม่เกิน 3 ปี, ลบชื่อออกจากทะเบียน", isCorrect: true },
        { id: "qo-102-1b", text: "ข. 2 สถาน คือ ปรับพินัย และเพิกถอนใบอนุญาตตลอดชีวิต", isCorrect: false },
        { id: "qo-102-1c", text: "ค. 4 สถาน คือ ตักเตือน, ภาคทัณฑ์, พักใบอนุญาต 5 ปี, จำคุก", isCorrect: false },
        { id: "qo-102-1d", text: "ง. 3 สถาน คือ ตักเตือนเป็นหนังสือ, ปรับไม่เกิน 50,000 บาท, ลบชื่อ", isCorrect: false },
      ],
    },
    {
      id: "q-102-2",
      bankId: "qb-102",
      courseId: "crs-102",
      moduleTitle: "โมดูล 2 · กรณีศึกษาคำวินิจฉัยมรรยาท",
      type: "single_choice",
      difficulty: "medium",
      questionText: "เมื่อทนายความได้รับรู้ความลับของลูกความในหน้าที่ทนายความ จะสามารถเปิดเผยความลับนั้นได้ในกรณีใด?",
      explanation: "ข้อบังคับมรรยาททนายความ ข้อ 11 ห้ามเปิดเผยความลับของลูกความ เว้นแต่จะได้รับอนุญาตจากลูกความนั้นแล้ว หรือโดยอำนาจศาล",
      points: 50,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-102-2a", text: "ก. เมื่อคดีถึงที่สุดแล้วเกิน 1 ปี", isCorrect: false },
        { id: "qo-102-2b", text: "ข. เมื่อได้รับอนุญาตจากลูกความนั้นแล้ว หรือโดยอำนาจศาล", isCorrect: true },
        { id: "qo-102-2c", text: "ค. เมื่อลูกความค้างชำระค่าว่าความ", isCorrect: false },
        { id: "qo-102-2d", text: "ง. เปิดเผยต่อสื่อมวลชนเพื่อประโยชน์สาธารณะได้ทันที", isCorrect: false },
      ],
    },
    {
      id: "q-103-1",
      bankId: "qb-103",
      courseId: "crs-103",
      moduleTitle: "โมดูล 1 · โครงสร้างสัญญาเช่า",
      type: "single_choice",
      difficulty: "medium",
      questionText: "ตามประกาศคณะกรรมการว่าด้วยสัญญา เรื่องธุรกิจการให้เช่าอาคารเพื่ออยู่อาศัย ผู้ประกอบธุรกิจสามารถเรียกเก็บเงินประกันและค่าเช่าล่วงหน้ารวมกันได้ไม่เกินกี่เดือน?",
      explanation: "ประกาศ สคบ. พ.ศ. 2562 กำหนดห้ามผู้ประกอบธุรกิจเรียกเก็บค่าเช่าล่วงหน้าและเงินประกันรวมกันเกินกว่า 3 เดือนของค่าเช่ารายเดือน",
      points: 100,
      status: "active",
      version: 1,
      createdBy: "u-instructor-001",
      createdAt: now,
      options: [
        { id: "qo-103-1a", text: "ก. ไม่เกิน 1 เดือนของค่าเช่ารายเดือน", isCorrect: false },
        { id: "qo-103-1b", text: "ข. ไม่เกิน 3 เดือนของค่าเช่ารายเดือน", isCorrect: true },
        { id: "qo-103-1c", text: "ค. ไม่เกิน 6 เดือนของค่าเช่ารายเดือน", isCorrect: false },
        { id: "qo-103-1d", text: "ง. ไม่มีเพดานจำกัด ขึ้นอยู่กับตกลง", isCorrect: false },
      ],
    },
  ];

  const assessments: DbAssessment[] = [
    {
      id: "asm-101",
      courseId: "crs-101",
      bankId: "qb-101",
      code: "ASM-2569-101",
      title: "การสอบปลายหลักสูตร · กฎหมายที่ประชาชนควรรู้",
      status: "published",
      timeLimitMinutes: 60,
      questionCount: 5,
      passPct: 70,
      maxAttempts: 3,
      proctoringMode: "basic",
      reviewMode: "after_final_attempt",
      requireCourseComplete: false,
      version: 1,
      updatedAt: "2026-08-12T08:00:00.000Z",
    },
    {
      id: "asm-102",
      courseId: "crs-102",
      bankId: "qb-102",
      code: "ASM-2569-102",
      title: "การสอบปลายหลักสูตร · จรรยาบรรณวิชาชีพทนายความ",
      status: "published",
      timeLimitMinutes: 60,
      questionCount: 2,
      passPct: 70,
      maxAttempts: 3,
      proctoringMode: "basic",
      reviewMode: "after_final_attempt",
      requireCourseComplete: false,
      version: 1,
      updatedAt: "2026-08-15T08:00:00.000Z",
    },
    {
      id: "asm-103",
      courseId: "crs-103",
      bankId: "qb-103",
      code: "ASM-2569-103",
      title: "การสอบปลายหลักสูตร · หลักกฎหมายสัญญาเช่าที่อยู่อาศัย",
      status: "published",
      timeLimitMinutes: 45,
      questionCount: 1,
      passPct: 70,
      maxAttempts: 3,
      proctoringMode: "basic",
      reviewMode: "after_final_attempt",
      requireCourseComplete: false,
      version: 1,
      updatedAt: "2026-08-20T08:00:00.000Z",
    },
  ];

  const enrollments: DbEnrollment[] = [
    {
      id: "enr-001",
      userId: "u-lawyer-001",
      courseId: "crs-101",
      status: "completed",
      enrolledAt: "2026-08-20T09:00:00.000Z",
      completedAt: "2026-09-08T08:15:00.000Z",
      lastLessonId: "les-101-4",
    },
    {
      id: "enr-002",
      userId: "u-lawyer-001",
      courseId: "crs-102",
      status: "completed",
      enrolledAt: "2026-08-18T09:00:00.000Z",
      completedAt: "2026-09-02T14:00:00.000Z",
      lastLessonId: "les-102-2",
    },
    {
      id: "enr-003",
      userId: "u-lawyer-001",
      courseId: "crs-103",
      status: "active",
      enrolledAt: "2026-09-04T10:00:00.000Z",
      completedAt: null,
      lastLessonId: "les-103-1",
    },
    {
      id: "enr-004",
      userId: "u-citizen-001",
      courseId: "crs-101",
      status: "active",
      enrolledAt: "2026-09-05T11:00:00.000Z",
      completedAt: null,
      lastLessonId: "les-101-3",
    },
  ];

  const lessonProgress: DbLessonProgress[] = [
    {
      id: "lp-1",
      enrollmentId: "enr-001",
      userId: "u-lawyer-001",
      courseId: "crs-101",
      lessonId: "les-101-1",
      status: "completed",
      watchPct: 100,
      dwellSec: 920,
      quizScorePct: null,
      updatedAt: "2026-09-01T10:00:00.000Z",
      completedAt: "2026-09-01T10:00:00.000Z",
    },
    {
      id: "lp-2",
      enrollmentId: "enr-001",
      userId: "u-lawyer-001",
      courseId: "crs-101",
      lessonId: "les-101-2",
      status: "completed",
      watchPct: 100,
      dwellSec: 720,
      quizScorePct: null,
      updatedAt: "2026-09-02T10:00:00.000Z",
      completedAt: "2026-09-02T10:00:00.000Z",
    },
    {
      id: "lp-3",
      enrollmentId: "enr-001",
      userId: "u-lawyer-001",
      courseId: "crs-101",
      lessonId: "les-101-3",
      status: "completed",
      watchPct: 100,
      dwellSec: 1120,
      quizScorePct: null,
      updatedAt: "2026-09-05T10:00:00.000Z",
      completedAt: "2026-09-05T10:00:00.000Z",
    },
    {
      id: "lp-4",
      enrollmentId: "enr-001",
      userId: "u-lawyer-001",
      courseId: "crs-101",
      lessonId: "les-101-4",
      status: "completed",
      watchPct: 100,
      dwellSec: 872,
      quizScorePct: null,
      updatedAt: "2026-09-07T10:00:00.000Z",
      completedAt: "2026-09-07T10:00:00.000Z",
    },
    {
      id: "lp-5",
      enrollmentId: "enr-001",
      userId: "u-lawyer-001",
      courseId: "crs-101",
      lessonId: "les-101-5",
      status: "completed",
      watchPct: 100,
      dwellSec: 300,
      quizScorePct: 100,
      updatedAt: "2026-09-08T07:30:00.000Z",
      completedAt: "2026-09-08T07:30:00.000Z",
    },
    {
      id: "lp-6",
      enrollmentId: "enr-002",
      userId: "u-lawyer-001",
      courseId: "crs-102",
      lessonId: "les-102-1",
      status: "completed",
      watchPct: 100,
      dwellSec: 1200,
      quizScorePct: null,
      updatedAt: "2026-09-01T15:00:00.000Z",
      completedAt: "2026-09-01T15:00:00.000Z",
    },
    {
      id: "lp-7",
      enrollmentId: "enr-002",
      userId: "u-lawyer-001",
      courseId: "crs-102",
      lessonId: "les-102-2",
      status: "completed",
      watchPct: 100,
      dwellSec: 900,
      quizScorePct: null,
      updatedAt: "2026-09-02T14:00:00.000Z",
      completedAt: "2026-09-02T14:00:00.000Z",
    },
    {
      id: "lp-8",
      enrollmentId: "enr-004",
      userId: "u-citizen-001",
      courseId: "crs-101",
      lessonId: "les-101-1",
      status: "completed",
      watchPct: 100,
      dwellSec: 920,
      quizScorePct: null,
      updatedAt: "2026-09-06T12:00:00.000Z",
      completedAt: "2026-09-06T12:00:00.000Z",
    },
    {
      id: "lp-9",
      enrollmentId: "enr-004",
      userId: "u-citizen-001",
      courseId: "crs-101",
      lessonId: "les-101-2",
      status: "completed",
      watchPct: 100,
      dwellSec: 720,
      quizScorePct: null,
      updatedAt: "2026-09-07T12:00:00.000Z",
      completedAt: "2026-09-07T12:00:00.000Z",
    },
  ];

  const certificates: DbCertificate[] = [
    {
      id: "cert-001",
      verificationCode: "LTC-2026-483920",
      userId: "u-lawyer-001",
      courseId: "crs-101",
      attemptId: "att-001",
      recipientName: "ธนกร วัฒนกุล",
      courseTitleTh: "กฎหมายที่ประชาชนควรรู้",
      creditsAwarded: 4,
      issuedAt: "2026-09-08T08:20:00.000Z",
      issuedBy: null,
      issueMode: "auto",
      status: "valid",
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    },
    {
      id: "cert-002",
      verificationCode: "LTC-2026-391042",
      userId: "u-lawyer-001",
      courseId: "crs-102",
      attemptId: "att-002",
      recipientName: "ธนกร วัฒนกุล",
      courseTitleTh: "จรรยาบรรณวิชาชีพทนายความ",
      creditsAwarded: 4,
      issuedAt: "2026-09-02T14:30:00.000Z",
      issuedBy: null,
      issueMode: "auto",
      status: "valid",
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    },
    {
      id: "cert-003",
      verificationCode: "LTC-2026-512098",
      userId: "u-lawyer-002",
      courseId: "crs-103",
      attemptId: "att-003",
      recipientName: "สุรเชษฐ์ ใจมั่น",
      courseTitleTh: "หลักกฎหมายสัญญาเช่าที่อยู่อาศัยและทักษะการร่างสัญญา",
      creditsAwarded: 4,
      issuedAt: "2026-09-07T16:10:00.000Z",
      issuedBy: "u-registrar-001",
      issueMode: "manual",
      status: "valid",
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    },
  ];

  const attempts: DbAssessmentAttempt[] = [
    {
      id: "att-001",
      code: "ASM-2569-00841",
      assessmentId: "asm-101",
      courseId: "crs-101",
      userId: "u-lawyer-001",
      attemptNo: 1,
      status: "passed",
      startedAt: "2026-09-08T07:40:00.000Z",
      expiresAt: "2026-09-08T08:40:00.000Z",
      submittedAt: "2026-09-08T08:18:12.000Z",
      durationUsedSec: 2292,
      scorePct: 80,
      earnedPoints: 80,
      totalPoints: 100,
      passPctSnapshot: 70,
      questionIds: ["q-101-1", "q-101-2", "q-101-3", "q-101-4", "q-101-5"],
      answers: {
        "q-101-1": "qo-101-1a",
        "q-101-2": "qo-101-2c",
        "q-101-3": "qo-101-3c",
        "q-101-4": "qo-101-4b",
        "q-101-5": "qo-101-5a",
      },
      flaggedQuestionIds: ["q-101-5"],
      moduleBreakdown: [
        { moduleTitle: "โมดูล 1 · พื้นฐานกฎหมายไทย", earnedPoints: 40, totalPoints: 40, percent: 100 },
        { moduleTitle: "โมดูล 2 · สัญญาในชีวิตประจำวัน", earnedPoints: 40, totalPoints: 40, percent: 100 },
        { moduleTitle: "โมดูล 3 · สิทธิผู้บริโภคและการระงับข้อพิพาท", earnedPoints: 0, totalPoints: 20, percent: 0 },
      ],
      certificateId: "cert-001",
    },
    {
      id: "att-002",
      code: "ASM-2569-00712",
      assessmentId: "asm-102",
      courseId: "crs-102",
      userId: "u-lawyer-001",
      attemptNo: 1,
      status: "passed",
      startedAt: "2026-09-02T14:00:00.000Z",
      expiresAt: "2026-09-02T15:00:00.000Z",
      submittedAt: "2026-09-02T14:28:00.000Z",
      durationUsedSec: 1680,
      scorePct: 100,
      earnedPoints: 100,
      totalPoints: 100,
      passPctSnapshot: 70,
      questionIds: ["q-102-1", "q-102-2"],
      answers: {
        "q-102-1": "qo-102-1a",
        "q-102-2": "qo-102-2b",
      },
      flaggedQuestionIds: [],
      moduleBreakdown: [
        { moduleTitle: "โมดูล 1 · ข้อบังคับมรรยาททนายความ", earnedPoints: 50, totalPoints: 50, percent: 100 },
        { moduleTitle: "โมดูล 2 · กรณีศึกษาคำวินิจฉัยมรรยาท", earnedPoints: 50, totalPoints: 50, percent: 100 },
      ],
      certificateId: "cert-002",
    },
    {
      id: "att-003",
      code: "ASM-2569-00819",
      assessmentId: "asm-103",
      courseId: "crs-103",
      userId: "u-lawyer-002",
      attemptNo: 1,
      status: "passed",
      startedAt: "2026-09-07T15:30:00.000Z",
      expiresAt: "2026-09-07T16:15:00.000Z",
      submittedAt: "2026-09-07T16:05:00.000Z",
      durationUsedSec: 2100,
      scorePct: 100,
      earnedPoints: 100,
      totalPoints: 100,
      passPctSnapshot: 70,
      questionIds: ["q-103-1"],
      answers: { "q-103-1": "qo-103-1b" },
      flaggedQuestionIds: [],
      moduleBreakdown: [
        { moduleTitle: "โมดูล 1 · โครงสร้างสัญญาเช่า", earnedPoints: 100, totalPoints: 100, percent: 100 },
      ],
      certificateId: "cert-003",
    },
  ];

  const creditRules: DbCreditRule[] = [
    {
      id: "cr-101",
      code: "CR-LTC-101",
      courseId: "crs-101",
      name: "เกณฑ์หน่วยกิต กฎหมายที่ประชาชนควรรู้",
      creditType: "general",
      credits: 4,
      validDays: 365,
      carryOver: true,
      status: "active",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "cr-102",
      code: "CR-LTC-102",
      courseId: "crs-102",
      name: "เกณฑ์หน่วยกิต จรรยาบรรณวิชาชีพทนายความ",
      creditType: "ethics",
      credits: 4,
      validDays: 365,
      carryOver: false,
      status: "active",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "cr-103",
      code: "CR-LTC-103",
      courseId: "crs-103",
      name: "เกณฑ์หน่วยกิต สัญญาเช่าที่อยู่อาศัยและการร่างสัญญา",
      creditType: "specialized",
      credits: 4,
      validDays: 365,
      carryOver: true,
      status: "active",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "cr-104",
      code: "CR-LTC-104",
      courseId: "crs-104",
      name: "เกณฑ์หน่วยกิต การฟ้องร้องคดีขั้นสูง",
      creditType: "specialized",
      credits: 4,
      validDays: 365,
      carryOver: false,
      status: "active",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const renewalCycles: DbRenewalCycle[] = [
    {
      id: "cyc-2569-lawyer1",
      userId: "u-lawyer-001",
      cycleYearBuddhist: 2569,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      requiredCredits: 12,
      status: "open",
    },
    {
      id: "cyc-2569-lawyer2",
      userId: "u-lawyer-002",
      cycleYearBuddhist: 2569,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      requiredCredits: 12,
      status: "open",
    },
  ];

  const creditLedger: DbCreditLedgerEntry[] = [
    {
      id: "led-001",
      userId: "u-lawyer-001",
      cycleId: "cyc-2569-lawyer1",
      courseId: "crs-102",
      courseTitleTh: "จรรยาบรรณวิชาชีพทนายความ",
      certificateId: "cert-002",
      entryType: "accrual",
      creditsDelta: 4,
      reason: "สอบผ่านปลายหลักสูตร (ASM-2569-00712) · ออกใบประกาศ LTC-2026-391042",
      createdBy: null,
      createdAt: "2026-09-02T14:30:00.000Z",
    },
    {
      id: "led-002",
      userId: "u-lawyer-001",
      cycleId: "cyc-2569-lawyer1",
      courseId: "crs-101",
      courseTitleTh: "กฎหมายที่ประชาชนควรรู้",
      certificateId: "cert-001",
      entryType: "accrual",
      creditsDelta: 4,
      reason: "สอบผ่านปลายหลักสูตร (ASM-2569-00841) · ออกใบประกาศ LTC-2026-483920",
      createdBy: null,
      createdAt: "2026-09-08T08:20:00.000Z",
    },
    {
      id: "led-003",
      userId: "u-lawyer-002",
      cycleId: "cyc-2569-lawyer2",
      courseId: "crs-103",
      courseTitleTh: "หลักกฎหมายสัญญาเช่าที่อยู่อาศัยและทักษะการร่างสัญญา",
      certificateId: "cert-003",
      entryType: "accrual",
      creditsDelta: 4,
      reason: "สอบผ่านปลายหลักสูตร (ASM-2569-00819) · ออกใบประกาศ LTC-2026-512098",
      createdBy: "u-registrar-001",
      createdAt: "2026-09-07T16:10:00.000Z",
    },
  ];

  const notifications: DbNotification[] = [
    {
      id: "noti-1",
      userId: "u-lawyer-001",
      title: "ได้รับประกาศนียบัตรและหน่วยกิต +4 หน่วย",
      body: "คุณสอบผ่านหลักสูตร 'กฎหมายที่ประชาชนควรรู้' ระบบได้ออกประกาศนียบัตรรหัส LTC-2026-483920 และบันทึกหน่วยกิตเข้า Credit Bank เรียบร้อยแล้ว",
      href: "/my/certificates",
      isRead: false,
      createdAt: "2026-09-08T08:20:05.000Z",
    },
    {
      id: "noti-2",
      userId: "u-lawyer-001",
      title: "แจ้งเตือนความคืบหน้ารอบสะสมหน่วยกิต ปี 2569",
      body: "ขณะนี้คุณสะสมหน่วยกิตได้ 8 / 12 หน่วย (67%) ยังขาดอีก 4 หน่วยก่อนสิ้นสุดรอบวันที่ 31 ธันวาคม 2569",
      href: "/my/credits",
      isRead: false,
      createdAt: "2026-09-08T08:21:00.000Z",
    },
    {
      id: "noti-3",
      userId: "u-citizen-001",
      title: "รับคำขอผูกเลขที่ใบอนุญาตว่าความแล้ว",
      body: "คำขอผูกเลขที่ใบอนุญาต 39812 อยู่ระหว่างการตรวจสอบโดยนายทะเบียนสภาทนายความ",
      href: "/my/license",
      isRead: false,
      createdAt: "2026-09-06T11:15:05.000Z",
    },
  ];

  const auditLogs: DbAuditLog[] = [
    {
      id: "aud-001",
      eventType: "CERTIFICATE_ISSUE",
      actorUserId: null,
      actorName: "ระบบอัตโนมัติ (cert_auto_issue_tick)",
      actorRole: "system",
      targetTable: "certificates",
      targetId: "LTC-2026-483920",
      summaryTh: "ออกประกาศนียบัตรอัตโนมัติให้ ธนกร วัฒนกุล (หลักสูตร LTC-101 · คะแนนสอบ 80%)",
      ipHash: "sha256:9f2c8b11e4",
      createdAt: "2026-09-08T08:20:00.000Z",
    },
    {
      id: "aud-002",
      eventType: "CREDIT_ACCRUAL",
      actorUserId: null,
      actorName: "ระบบอัตโนมัติ (credit_accrual_tick)",
      actorRole: "system",
      targetTable: "credit_ledger",
      targetId: "led-002",
      summaryTh: "สะสมหน่วยกิต +4.00 หน่วย เข้ารอบปี 2569 ของ ธนกร วัฒนกุล (อ้างอิง LTC-2026-483920)",
      ipHash: "sha256:9f2c8b11e4",
      createdAt: "2026-09-08T08:20:01.000Z",
    },
    {
      id: "aud-003",
      eventType: "COURSE_SUBMIT_REVIEW",
      actorUserId: "u-instructor-001",
      actorName: "ศ.ดร.สมชาย นิติศาสตร์",
      actorRole: "instructor",
      targetTable: "courses",
      targetId: "LTC-201",
      summaryTh: "ส่งหลักสูตร LTC-201 'กฎหมายสินทรัพย์ดิจิทัลและสัญญาอัจฉริยะ' เข้าคิวรอตรวจสอบ (pending_review)",
      ipHash: "sha256:3a71d04c92",
      createdAt: "2026-09-07T15:00:00.000Z",
    },
    {
      id: "aud-004",
      eventType: "LICENSE_BIND_REQUEST",
      actorUserId: "u-citizen-001",
      actorName: "ปิยะพร แสงทอง",
      actorRole: "citizen",
      targetTable: "license_applications",
      targetId: "lapp-001",
      summaryTh: "ยื่นคำขอผูกเลขที่ใบอนุญาตว่าความ ทล. 39812 รอนายทะเบียนตรวจสอบ",
      ipHash: "sha256:7c88a120fe",
      createdAt: "2026-09-06T11:15:00.000Z",
    },
    {
      id: "aud-005",
      eventType: "LICENSE_VERIFY",
      actorUserId: "u-registrar-001",
      actorName: "คุณสมหญิง ศรีวิไล",
      actorRole: "staff:registrar",
      targetTable: "lawyer_licenses",
      targetId: "lic-001",
      summaryTh: "อนุมัติคำขอใบอนุญาต ทล. 25891 ของ ธนกร วัฒนกุล และมอบบทบาท lawyer แบบ atomic",
      ipHash: "sha256:1b44e890a1",
      createdAt: "2026-01-12T10:00:00.000Z",
    },
  ];

  return {
    profiles,
    roleAssignments,
    lawyerLicenses,
    licenseApplications,
    categories,
    courses,
    courseModules,
    lessons,
    enrollments,
    lessonProgress,
    questionBanks,
    bankQuestions,
    assessments,
    attempts,
    certificates,
    creditRules,
    renewalCycles,
    creditLedger,
    notifications,
    auditLogs,
    sessions: [],
    featureFlags: {
      cert_auto_issue: true,
    },
  };
}

let memoryDb: LtcDatabase | null = null;

export function readDb(): LtcDatabase {
  if (memoryDb !== null) {
    try {
      if (fs.existsSync(DB_FILE_PATH)) {
        const raw = fs.readFileSync(DB_FILE_PATH, "utf8");
        memoryDb = JSON.parse(raw) as LtcDatabase;
        return memoryDb;
      }
    } catch {
      // Fallback to in-memory
    }
    return memoryDb;
  }

  try {
    if (fs.existsSync(DB_FILE_PATH)) {
      const raw = fs.readFileSync(DB_FILE_PATH, "utf8");
      memoryDb = JSON.parse(raw) as LtcDatabase;
      return memoryDb;
    }
  } catch {
    // Initialize fresh seed
  }

  memoryDb = buildInitialSeed();
  writeDb(memoryDb);
  return memoryDb;
}

export function writeDb(db: LtcDatabase): void {
  memoryDb = db;
  try {
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(db, null, 2), "utf8");
  } catch {
    // Ignore filesystem errors in restricted containers
  }
}

export function resetDbToSeed(): LtcDatabase {
  const seeded = buildInitialSeed();
  writeDb(seeded);
  return seeded;
}

export function getActiveRolesForUser(db: LtcDatabase, userId: string): Role[] {
  return db.roleAssignments
    .filter((r) => r.userId === userId && r.revokedAt === null)
    .map((r) => r.role);
}

export function getVerifiedLicenseForUser(
  db: LtcDatabase,
  userId: string,
): DbLawyerLicense | null {
  return (
    db.lawyerLicenses.find(
      (l) => l.userId === userId && l.status === "verified" && l.revokedAt === null,
    ) ?? null
  );
}

export function appendAuditLog(
  db: LtcDatabase,
  entry: {
    eventType: string;
    actorUserId: string | null;
    actorName: string;
    actorRole: string;
    targetTable: string;
    targetId: string;
    summaryTh: string;
  },
): DbAuditLog {
  const log: DbAuditLog = {
    id: `aud-${crypto.randomUUID().slice(0, 8)}`,
    eventType: entry.eventType,
    actorUserId: entry.actorUserId,
    actorName: entry.actorName,
    actorRole: entry.actorRole,
    targetTable: entry.targetTable,
    targetId: entry.targetId,
    summaryTh: entry.summaryTh,
    ipHash: `sha256:${crypto.createHash("sha256").update(entry.targetId + Date.now()).digest("hex").slice(0, 10)}`,
    createdAt: new Date().toISOString(),
  };
  db.auditLogs.unshift(log);
  return log;
}

export function submitExamAttemptInDb(
  db: LtcDatabase,
  attemptId: string,
  submittedAnswers?: Record<string, string>,
  flaggedQuestionIds?: string[],
): DbAssessmentAttempt | null {
  const attempt = db.attempts.find((a) => a.id === attemptId);
  if (!attempt) return null;
  if (attempt.status !== "in_progress") return attempt;

  if (submittedAnswers) {
    attempt.answers = { ...attempt.answers, ...submittedAnswers };
  }
  if (flaggedQuestionIds) {
    attempt.flaggedQuestionIds = flaggedQuestionIds;
  }

  const questions = attempt.questionIds
    .map((qid) => db.bankQuestions.find((q) => q.id === qid))
    .filter((q): q is DbBankQuestion => q !== undefined)
    .map((q) => {
      const correctOpt = q.options.find((o) => o.isCorrect) ?? q.options[0];
      return {
        id: q.id,
        moduleTitle: q.moduleTitle,
        points: q.points,
        correctOptionId: correctOpt?.id ?? "",
      };
    });

  const grade = gradeExamAttempt(questions, attempt.answers, attempt.passPctSnapshot);
  const nowIso = new Date().toISOString();
  const startedMs = new Date(attempt.startedAt).getTime();
  const usedSec = Math.max(30, Math.round((Date.now() - startedMs) / 1000));

  attempt.submittedAt = nowIso;
  attempt.durationUsedSec = usedSec;
  attempt.scorePct = grade.scorePercent;
  attempt.earnedPoints = grade.earnedPoints;
  attempt.totalPoints = grade.totalPoints;
  attempt.status = grade.passed ? "passed" : "failed";
  attempt.moduleBreakdown = grade.moduleBreakdown;

  const user = db.profiles.find((p) => p.id === attempt.userId);
  const course = db.courses.find((c) => c.id === attempt.courseId);

  if (grade.passed && user && course) {
    // Mark enrollment completed
    const enr = db.enrollments.find(
      (e) => e.userId === user.id && e.courseId === course.id && e.status !== "cancelled",
    );
    if (enr) {
      enr.status = "completed";
      enr.completedAt = nowIso;
    }

    // Issue certificate if not already issued for this user + course
    let cert = db.certificates.find(
      (c) => c.userId === user.id && c.courseId === course.id && c.status === "valid",
    );
    if (!cert && db.featureFlags["cert_auto_issue"] !== false) {
      const randomSix = String(Math.floor(100000 + Math.random() * 900000));
      const activeRule = db.creditRules.find(
        (r) => r.courseId === course.id && r.status === "active",
      );
      const creditsToAward = activeRule ? activeRule.credits : course.credits;

      cert = {
        id: `cert-${crypto.randomUUID().slice(0, 8)}`,
        verificationCode: `LTC-2026-${randomSix}`,
        userId: user.id,
        courseId: course.id,
        attemptId: attempt.id,
        recipientName: user.displayName,
        courseTitleTh: course.titleTh,
        creditsAwarded: creditsToAward,
        issuedAt: nowIso,
        issuedBy: null,
        issueMode: "auto",
        status: "valid",
        revokedAt: null,
        revokedBy: null,
        revokedReason: null,
      };
      db.certificates.unshift(cert);
      attempt.certificateId = cert.id;

      appendAuditLog(db, {
        eventType: "CERTIFICATE_ISSUE",
        actorUserId: null,
        actorName: "ระบบอัตโนมัติ (cert_auto_issue_tick)",
        actorRole: "system",
        targetTable: "certificates",
        targetId: cert.verificationCode,
        summaryTh: `ออกประกาศนียบัตรอัตโนมัติให้ ${user.displayName} (หลักสูตร ${course.code} · คะแนน ${grade.scorePercent}%)`,
      });

      // Accrue Credit Bank if user has lawyer role or open renewal cycle
      const roles = getActiveRolesForUser(db, user.id);
      if (roles.includes("lawyer")) {
        let cycle = db.renewalCycles.find(
          (c) => c.userId === user.id && c.status === "open",
        );
        if (!cycle) {
          cycle = {
            id: `cyc-2569-${user.id}`,
            userId: user.id,
            cycleYearBuddhist: 2569,
            startDate: "2026-01-01",
            endDate: "2026-12-31",
            requiredCredits: 12,
            status: "open",
          };
          db.renewalCycles.push(cycle);
        }
        const alreadyAccrued = db.creditLedger.some(
          (l) =>
            l.userId === user.id &&
            l.courseId === course.id &&
            l.entryType === "accrual",
        );
        if (!alreadyAccrued && creditsToAward > 0) {
          const led: DbCreditLedgerEntry = {
            id: `led-${crypto.randomUUID().slice(0, 8)}`,
            userId: user.id,
            cycleId: cycle.id,
            courseId: course.id,
            courseTitleTh: course.titleTh,
            certificateId: cert.id,
            entryType: "accrual",
            creditsDelta: creditsToAward,
            reason: `สอบผ่านปลายหลักสูตร (${attempt.code}) · ออกใบประกาศ ${cert.verificationCode}`,
            createdBy: null,
            createdAt: nowIso,
          };
          db.creditLedger.unshift(led);
          appendAuditLog(db, {
            eventType: "CREDIT_ACCRUAL",
            actorUserId: null,
            actorName: "ระบบอัตโนมัติ (credit_accrual_tick)",
            actorRole: "system",
            targetTable: "credit_ledger",
            targetId: led.id,
            summaryTh: `สะสมหน่วยกิต +${creditsToAward} หน่วย เข้ารอบปี ${cycle.cycleYearBuddhist} ของ ${user.displayName}`,
          });
        }
      }

      db.notifications.unshift({
        id: `noti-${crypto.randomUUID().slice(0, 8)}`,
        userId: user.id,
        title: `สอบผ่านหลักสูตร ${course.titleTh} (${grade.scorePercent}%)`,
        body: `ระบบออกประกาศนียบัตรรหัส ${cert.verificationCode} เรียบร้อยแล้ว`,
        href: "/my/certificates",
        isRead: false,
        createdAt: nowIso,
      });
    } else if (cert) {
      attempt.certificateId = cert.id;
    }
  }

  writeDb(db);
  return attempt;
}

export function getUserNetCredits(db: LtcDatabase, userId: string): number {
  const entries = db.creditLedger.filter((l) => l.userId === userId);
  return computeNetCredits(entries);
}

export type RoleType = 
  | 'guest'
  | 'citizen'
  | 'lawyer'
  | 'instructor'
  | 'staff:viewer'
  | 'staff:content'
  | 'staff:exam'
  | 'staff:registrar'
  | 'super_admin';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  roles: RoleType[];
  currentRole: RoleType;
  avatar: string;
  lawyerLicenseNumber?: string; // e.g. "4521/2561"
  licenseStatus?: 'verified' | 'pending' | 'unregistered';
  licenseExpiryDate?: string;
  creditsEarned: number;
  creditsRequired: number; // default 30 credits / 3 years
  currentCycle: string; // e.g. "รอบ 2567 - 2570"
}

export type CourseCategory = 
  | 'ethics' // จริยธรรมและมรรยาททนายความ (บังคับ)
  | 'substantive' // กฎหมายสารบัญญัติ (แพ่ง/อาญา)
  | 'procedural' // กฎหมายวิธีพิจารณาความและการว่าความ
  | 'emerging_tech' // กฎหมายเทคโนโลยีและ PDPA
  | 'public_law' // กฎหมายสำหรับประชาชนทั่วไป
  | 'labor_tax'; // กฎหมายแรงงานและภาษีอากร

export type TargetAudience = 'all' | 'citizen' | 'lawyer';

export interface Lesson {
  id: string;
  title: string;
  durationMinutes: number;
  videoUrl: string;
  summary: string;
  contentPdfUrl?: string;
  isCompleted?: boolean;
}

export interface CourseModule {
  id: string;
  title: string;
  lessons: Lesson[];
}

export interface QuestionOption {
  id: string;
  text: string;
}

export interface Question {
  id: string;
  courseId: string;
  prompt: string;
  options: QuestionOption[];
  correctOptionId: string;
  explanation: string;
  legalReference: string; // e.g. "ประมวลกฎหมายแพ่งและพาณิชย์ มาตรา 1599"
}

export interface Course {
  id: string;
  code: string; // e.g. "LAW-CLE-101"
  title: string;
  subtitle: string;
  category: CourseCategory;
  targetAudience: TargetAudience;
  credits: number; // CLE Credits
  durationHours: number;
  passingScorePercent: number; // e.g. 75%
  coverImage: string;
  instructorName: string;
  instructorTitle: string;
  instructorAvatar: string;
  description: string;
  prerequisites?: string[];
  modules: CourseModule[];
  status: 'published' | 'draft' | 'archived';
  enrolledStudentsCount: number;
  rating: number;
  hasExam: boolean;
  isMandatoryForRenewal?: boolean;
}

export interface Enrollment {
  id: string;
  userId: string;
  courseId: string;
  enrolledAt: string;
  completedLessons: string[]; // lesson ids
  examScore?: number;
  examPassed?: boolean;
  status: 'in_progress' | 'completed';
  completedAt?: string;
  certificateId?: string;
}

export interface Certificate {
  id: string;
  certificateNumber: string; // e.g. "LTC-2026-CLE-8842"
  courseId: string;
  courseTitle: string;
  userId: string;
  userName: string;
  lawyerLicenseNumber?: string;
  creditsAwarded: number;
  issueDate: string;
  expiryDate?: string;
  status: 'valid' | 'revoked';
  qrVerificationUrl: string;
  signatureRegistrar: string;
}

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  date: string;
  courseId?: string;
  courseTitle: string;
  category: CourseCategory;
  credits: number;
  type: 'course_cle' | 'seminar' | 'registrar_adjustment';
  certificateNumber?: string;
  approvedBy: string;
  status: 'approved' | 'pending';
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  userRole: RoleType;
  action: string; // e.g. "AUTH_LOGIN", "EXAM_SUBMIT", "CERT_ISSUED", "CREDIT_GRANT"
  targetResource: string;
  ipAddress: string;
  status: 'SUCCESS' | 'WARNING' | 'FAILED';
  details: string;
}

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  linkTab?: string;
}

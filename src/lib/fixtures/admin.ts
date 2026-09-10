import type { Role } from "@/lib/rbac";

/**
 * Fixture ข้อมูลจำลองของหลังบ้าน (Phase 0 — โครงหน้าจอ UI admin)
 *
 * - สร้างตาม DESIGN-SYSTEM §5.5 (Table) / §5.6 (Badge) / §5.8 (Modal) / §6.3 (Admin Shell)
 * - authoring CRUD (CAT-001/005/006) เลื่อนออกนอก Wave C ตาม D25-O3 — หน้าจอนี้เป็น "โครง UI"
 *   Phase 1 จะแทนที่ข้อมูลชุดนี้ด้วย BFF จริง: GET /api/v1/admin/courses · GET /api/v1/admin/categories
 *   (API-SPECIFICATION §3.8) โดยรูปทรง type ด้านล่างออกแบบให้ใกล้เคียงคอลัมน์จริงของ
 *   DATA-DICTIONARY §3.2 (courses / course_categories)
 *
 * ข้อมูลทั้งหมดเป็นข้อมูลตัวอย่างเพื่อการออกแบบ — ไม่ใช่ข้อมูลจริง
 */

/** สถานะหลักสูตร — ตรง enum `course_status` (DATA-DICTIONARY §2 + migration 0001 + SRS CAT-005) */
export type CourseStatus = "draft" | "pending_review" | "published" | "archived";

/** กันค่า ?status=… จาก URL ที่ไม่อยู่ใน enum ก่อนใช้กรองฝั่ง server */
export function isCourseStatus(value: unknown): value is CourseStatus {
  return (
    value === "draft" ||
    value === "pending_review" ||
    value === "published" ||
    value === "archived"
  );
}

export type AdminCategory = {
  id: string;
  slug: string;
  nameTh: string;
  nameEn: string | null;
  /** uuid ของหมวดแม่ — null = หมวดหลัก (โครงแม่-ลูกลึก 2 ระดับ ตาม DATA-DICTIONARY §3.2) */
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
};

export type AdminCourse = {
  id: string;
  code: string;
  titleTh: string;
  titleEn: string | null;
  summary: string | null;
  categoryId: string;
  status: CourseStatus;
  version: number;
  language: string;
  /** true = สาธารณะ, false = เฉพาะทนายความ (SRS CAT-007) */
  isPublic: boolean;
  /** ISO date — null = ยังไม่เคยเผยแพร่ */
  publishedAt: string | null;
  updatedAt: string;
};

/** บัญชีเจ้าหน้าที่จำลอง — Phase 1 จะได้จาก session จริง (งาน C-0) */
export const adminFixtureStaff: {
  name: string;
  role: Role;
  mfaVerified: boolean;
} = {
  name: "เจ้าหน้าที่ทดสอบ (บัญชีจำลอง)",
  role: "staff:content",
  mfaVerified: true,
};

export const adminCategories: AdminCategory[] = [
  {
    id: "cat-general",
    slug: "general-law",
    nameTh: "กฎหมายทั่วไป",
    nameEn: "General Law",
    parentId: null,
    sortOrder: 1,
    isActive: true,
  },
  {
    id: "cat-criminal",
    slug: "criminal-law",
    nameTh: "กฎหมายอาญา",
    nameEn: "Criminal Law",
    parentId: "cat-general",
    sortOrder: 1,
    isActive: true,
  },
  {
    id: "cat-civil",
    slug: "civil-commercial-law",
    nameTh: "กฎหมายแพ่งและพาณิชย์",
    nameEn: "Civil and Commercial Law",
    parentId: "cat-general",
    sortOrder: 2,
    isActive: true,
  },
  {
    id: "cat-profession",
    slug: "lawyer-profession",
    nameTh: "วิชาชีพทนายความ",
    nameEn: "Lawyers' Profession",
    parentId: null,
    sortOrder: 2,
    isActive: true,
  },
  {
    id: "cat-ethics",
    slug: "professional-ethics",
    nameTh: "จรรยาบรรณทนายความ",
    nameEn: "Professional Ethics",
    parentId: "cat-profession",
    sortOrder: 1,
    isActive: false,
  },
  {
    id: "cat-skill",
    slug: "professional-skills",
    nameTh: "ทักษะวิชาชีพ",
    nameEn: "Professional Skills",
    parentId: null,
    sortOrder: 3,
    isActive: true,
  },
  {
    id: "cat-digital",
    slug: "technology-law",
    nameTh: "กฎหมายเทคโนโลยีสารสนเทศ",
    nameEn: "Technology Law",
    parentId: null,
    sortOrder: 4,
    isActive: true,
  },
];

export const adminCourses: AdminCourse[] = [
  {
    id: "c-101",
    code: "LTC-101",
    titleTh: "กฎหมายที่ประชาชนควรรู้เบื้องต้น",
    titleEn: null,
    summary:
      "สิทธิและหน้าที่ของประชาชนในชีวิตประจำวัน คดีแพ่งเล็กน้อย และช่องทางช่วยเหลือทางกฎหมาย",
    categoryId: "cat-general",
    status: "published",
    version: 2,
    language: "th",
    isPublic: true,
    publishedAt: "2026-08-20",
    updatedAt: "2026-08-20",
  },
  {
    id: "c-102",
    code: "LTC-102",
    titleTh: "จรรยาบรรณทนายความและวินัยวิชาชีพ",
    titleEn: null,
    summary:
      "ข้อบังคับจรรยาบรรณ กระบวนการวินัย และกรณีศึกษาการให้บริการงานทนายความ",
    categoryId: "cat-profession",
    status: "pending_review",
    version: 1,
    language: "th",
    isPublic: false,
    publishedAt: null,
    updatedAt: "2026-09-01",
  },
  {
    id: "c-103",
    code: "LTC-103",
    titleTh: "หลักพยานหลักฐานในคดีอาญา",
    titleEn: null,
    summary:
      "น้ำหนักและอำนาจพยานหลักฐาน การรับฟังพยาน และหลักประกันความยุติธรรมในกระบวนพิจารณา",
    categoryId: "cat-criminal",
    status: "draft",
    version: 1,
    language: "th",
    isPublic: true,
    publishedAt: null,
    updatedAt: "2026-09-04",
  },
  {
    id: "c-104",
    code: "LTC-104",
    titleTh: "สัญญาในชีวิตประจำวันและสิทธิผู้บริโภค",
    titleEn: null,
    summary:
      "สัญญาเช่า สัญญาซื้อขายผ่อน และการคุ้มครองผู้บริโภคตามกฎหมายคุ้มครองผู้บริโภค",
    categoryId: "cat-civil",
    status: "draft",
    version: 1,
    language: "th",
    isPublic: true,
    publishedAt: null,
    updatedAt: "2026-08-30",
  },
  {
    id: "c-201",
    code: "LTC-201",
    titleTh: "กฎหมายคอมพิวเตอร์และการคุ้มครองข้อมูลส่วนบุคคล",
    titleEn: "Computer and Personal Data Protection Law",
    summary:
      "พระราชบัญญัติการกระทำความผิดเกี่ยวกับคอมพิวเตอร์ และหลักพื้นฐาน PDPA สำหรับผู้ประกอบวิชาชีพ",
    categoryId: "cat-digital",
    status: "published",
    version: 1,
    language: "th",
    isPublic: true,
    publishedAt: "2026-07-15",
    updatedAt: "2026-07-15",
  },
  {
    id: "c-105",
    code: "LTC-105",
    titleTh: "กฎหมายที่ประชาชนควรรู้ (ฉบับปี 2566)",
    titleEn: null,
    summary: "หลักสูตรรุ่นเดิม — เก็บเข้าคลังแล้ว ผู้ลงทะเบียนเดิมยังเข้าเรียนต่อได้ (CAT-005)",
    categoryId: "cat-general",
    status: "archived",
    version: 3,
    language: "th",
    isPublic: true,
    publishedAt: "2025-10-01",
    updatedAt: "2026-06-30",
  },
];

/** นับหลักสูตรที่อ้างอิงหมวดตรง ๆ (ใช้แสดงในตารางหมวด) */
export function countCoursesInCategory(categoryId: string): number {
  return adminCourses.filter((course) => course.categoryId === categoryId).length;
}

const THAI_DATE_FORMAT = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** แสดงวันที่แบบพุทธศักราช (DESIGN-SYSTEM §9 I18N-003) — เช่น "20 สิงหาคม 2569" */
export function formatThaiDate(iso: string): string {
  return THAI_DATE_FORMAT.format(new Date(iso));
}

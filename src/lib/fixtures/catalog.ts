/**
 * Fixture แคตตาล็อกหลักสูตร (ภาษาไทย) — ฐานของ UI skeleton Wave C (lane C-6)
 *
 * Contract:
 * - รูป (shape) ของทุก type ยึด API-SPECIFICATION 1.0.1 §3.3 (GET /categories · GET /courses · GET /courses/{id})
 *   + §1.2 pagination envelope + DATA-DICTIONARY 1.0.0 §3.2 (courses / course_modules / lessons)
 * - fixture มีเฉพาะหลักสูตร status="published" (RLS ฝั่ง guest เห็นเฉพาะ published — DD §3.2 / TC-005)
 * - Phase 1 (C-2/C-3): เปลี่ยน body ของ getPublishedCourses()/getCategories()/findPublishedCourse()
 *   เป็น fetch จริง — ลายเซ็น (signatures) คงเดิม component จึงไม่ต้องรื้อโครง
 */

export type CourseStatus = "draft" | "pending_review" | "published" | "archived";
export type LessonType = "video" | "document" | "quiz";
export type CourseLevel = "beginner" | "intermediate" | "advanced";

/** GET /categories → { data } — DD §3.2 course_categories (โครง 1 ระดับ) */
export interface CatalogCategory {
  id: string;
  slug: string;
  nameTh: string;
  nameEn: string | null;
  courseCount: number;
}

/** วิทยากร (CAT-004 AC: แสดงชื่อวิทยากร) — join profiles ตอน wire จริง */
export interface CourseInstructor {
  nameTh: string;
  titleTh: string;
  bio: string | null;
}

/** เงื่อนไขสอบปลายหลักสูตร (CAT-004 AC: จำนวนครั้ง เกณฑ์ผ่าน เวลา) */
export interface CourseExam {
  questionCount: number;
  timeLimitMinutes: number;
  passScorePct: number;
  maxAttempts: number;
}

/** บทเรียน — DD §3.2 lessons */
export interface CourseLesson {
  id: string;
  type: LessonType;
  titleTh: string;
  /** วินาที (type="video") — null สำหรับ document/quiz */
  durationSec: number | null;
  isPreview: boolean;
}

/** โมดูล — DD §3.2 course_modules */
export interface CourseModule {
  id: string;
  titleTh: string;
  sortOrder: number;
  isPreview: boolean;
  lessons: CourseLesson[];
}

/** GET /courses → { data: CourseListItem[], page } — CAT-002 AC (ชื่อ/หมวด/ชั่วโมง/credit/กลุ่มเป้าหมาย) */
export interface CourseListItem {
  id: string;
  code: string;
  titleTh: string;
  titleEn: string | null;
  summary: string | null;
  category: { id: string; slug: string; nameTh: string };
  status: CourseStatus;
  /** false = เฉพาะทนายความที่ผูกใบอนุญาต (CAT-007) */
  isPublic: boolean;
  level: CourseLevel;
  lessonCount: number;
  /** ชั่วโมงเรียน (1 ตำแหน่ง) */
  durationHours: number;
  credits: number;
  learnerCount: number;
  publishedAt: string;
}

/** GET /courses/{id} → { data: CourseDetail } — CAT-004 (โครงสร้างโมดูล/บทเรียน + เงื่อนไขสอบ + วิทยากร) */
export interface CourseDetail extends CourseListItem {
  categorySlug: string;
  description: string;
  /** จุดเด่นหลักสูตร (ต้นแบบ "สิ่งที่จะได้เรียนรู้") */
  outcomes: string[];
  instructors: CourseInstructor[];
  exam: CourseExam | null;
  modules: CourseModule[];
}

/** ข้อมูลดิบของหลักสูตร — ค่าที่ derive ได้ (category/lessonCount/durationHours) ต่อยอด resolve จาก modules/หมวด จึงไม่ต้องพิมพ์ซ้ำให้คลาด */
type RawCourseDetail = Omit<CourseDetail, "category" | "lessonCount" | "durationHours">;

/** Envelope §1.2 (cursor-based) — รูปเดียวกับ BFF ที่จะตอบจริงใน Phase 1 */
export interface CourseListResponse {
  data: CourseListItem[];
  page: { nextCursor: string | null; hasMore: boolean };
}

/** ───────────────────────── ข้อมูล fixture (สถานะ published เท่านั้น) ───────────────────────── */

const COURSE_CATEGORIES: CatalogCategory[] = [
  {
    id: "11111111-1111-4111-8111-111111111101",
    slug: "public-law",
    nameTh: "กฎหมายสำหรับประชาชน",
    nameEn: "Law for Everyone",
    courseCount: 0,
  },
  {
    id: "11111111-1111-4111-8111-111111111102",
    slug: "legal-ethics",
    nameTh: "จรรยาบรรณและวิชาชีพทนายความ",
    nameEn: "Legal Ethics",
    courseCount: 0,
  },
  {
    id: "11111111-1111-4111-8111-111111111103",
    slug: "contract-law",
    nameTh: "กฎหมายสัญญาและนิติกรรม",
    nameEn: "Contract Law",
    courseCount: 0,
  },
  {
    id: "11111111-1111-4111-8111-111111111104",
    slug: "criminal-law",
    nameTh: "กฎหมายอาญาและการดำเนินคดี",
    nameEn: "Criminal Law and Procedure",
    courseCount: 0,
  },
  {
    id: "11111111-1111-4111-8111-111111111105",
    slug: "labor-law",
    nameTh: "กฎหมายแรงงาน",
    nameEn: "Labor Law",
    courseCount: 0,
  },
  {
    id: "11111111-1111-4111-8111-111111111106",
    slug: "professional-skills",
    nameTh: "ทักษะวิชาชีพและการฝึกอบรม",
    nameEn: "Professional Skills",
    courseCount: 0,
  },
];

/** หลักสูตรที่ 1 — เนื้อหาตามต้นแบบ 03-course-detail (หมวด กฎหมายสำหรับประชาชน) */
const COURSE_BASIC_LAW: RawCourseDetail = {
  id: "22222222-2222-4222-8222-222222222201",
  code: "LTC-CAT-001",
  titleTh: "กฎหมายที่ประชาชนควรรู้",
  titleEn: "Law in Everyday Life",
  summary:
    "พื้นฐานกฎหมายที่ใช้ได้จริงในชีวิตประจำวัน ตั้งแต่สัญญา ทรัพย์สิน ครอบครัว ไปจนถึงมรดกเบื้องต้น",
  description:
    "กฎหมายไม่ใช่เรื่องไกลตัว — ทุกวันเราทำนิติกรรมกันอยู่ตลอด ไม่ว่าจะเป็นการซื้อของออนไลน์ " +
    "การเช่าห้องพัก การจ้างงาน หรือการรับมรดก หลักสูตรนี้ออกแบบสำหรับประชาชนทั่วไปที่ไม่มีพื้นฐานกฎหมาย " +
    "ใช้ภาษาเข้าใจง่ายพร้อมกรณีศึกษาจากเหตุการณ์จริง ผู้เรียนจะเข้าใจโครงสร้างระบบกฎหมายไทย " +
    "สิทธิและหน้าที่ของตนในสัญญาสำคัญ วิธีป้องกันการถูกเอาเปรียบ และขั้นตอนเบื้องต้นเมื่อเกิดข้อพิพาท " +
    "ผู้เรียนที่ผ่านการสอบปลายหลักสูตรจะได้รับประกาศนียบัตรจากสภาทนายความแห่งประเทศไทย",
  outcomes: [
    "เข้าใจโครงสร้างระบบกฎหมายไทยและลำดับชั้นของกฎหมาย",
    "อ่านและทำความเข้าใจสัญญาทั่วไปก่อนลงนามได้",
    "รู้สิทธิของผู้บริโภคเมื่อซื้อสินค้าและบริการ ทั้งหน้าร้านและออนไลน์",
    "จัดการเรื่องทรัพย์สินและการซื้อขายอสังหาริมทรัพย์ได้อย่างถูกต้อง",
    "เข้าใจกฎหมายครอบครัวและมรดกเบื้องต้น",
    "รู้ขั้นตอนแรกเมื่อเกิดข้อพิพาทและควรปรึกษาผู้เชี่ยวชาญเมื่อใด",
  ],
  instructors: [
    {
      nameTh: "ผศ.ดร.สมชาย วัฒนศิริ",
      titleTh: "ภาคีสมาชิกสภาทนายความแห่งประเทศไทย",
      bio: "ผู้เชี่ยวชาญกฎหมายแพ่ง วิทยากรหลักสูตรกฎหมายสำหรับประชาชนมากว่า 15 ปี",
    },
    {
      nameTh: "ทนายพิมพ์ชนก ศรีสุวรรณ",
      titleTh: "ทนายความผู้เชี่ยวชาญด้านคุ้มครองผู้บริโภค",
      bio: "วิทยากรประจำหลักสูตรกฎหมายผู้บริโภคของสภาทนายความ",
    },
  ],
  exam: {
    questionCount: 30,
    timeLimitMinutes: 60,
    passScorePct: 70,
    maxAttempts: 3,
  },
  status: "published",
  isPublic: true,
  level: "beginner",
  credits: 3,
  learnerCount: 3412,
  publishedAt: "2026-08-12T03:00:00Z",
  categorySlug: "public-law",
  modules: [
    {
      id: "33333333-3333-4333-8333-333333333101",
      titleTh: "พื้นฐานกฎหมายไทย",
      sortOrder: 1,
      isPreview: true,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444101",
          type: "video",
          titleTh: "ระบบกฎหมายไทยเบื้องต้น: กฎหมายมาจากไหน ใครบังคับใช้",
          durationSec: 2100,
          isPreview: true,
        },
        {
          id: "44444444-4444-4444-8444-444444444102",
          type: "video",
          titleTh: "สังคม ศีลธรรม และกฎหมาย: เข้าใจขอบเขตของกฎหมาย",
          durationSec: 2000,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444103",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333102",
      titleTh: "สัญญาในชีวิตประจำวัน",
      sortOrder: 2,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444104",
          type: "video",
          titleTh: "นิติกรรมและสัญญา: การทำสัญญาที่ถูกต้องตามกฎหมาย",
          durationSec: 2200,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444105",
          type: "video",
          titleTh: "การซื้อขายและการคุ้มครองผู้บริโภค",
          durationSec: 2100,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444106",
          type: "video",
          titleTh: "การทำสัญญาซื้อขายอสังหาริมทรัพย์",
          durationSec: 2050,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444107",
          type: "video",
          titleTh: "สัญญาจ้างทำของ สัญญาจ้างแรงงาน และการกู้ยืม",
          durationSec: 2150,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333103",
      titleTh: "กฎหมายเกี่ยวกับทรัพย์สิน",
      sortOrder: 3,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444108",
          type: "video",
          titleTh: "ทรัพย์สินทุกชนิดและทรัพย์สินของราชการ",
          durationSec: 2150,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444109",
          type: "video",
          titleTh: "ภาระติดพันในทรัพย์สินและการจดทะเบียนสิทธิ",
          durationSec: 2200,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444110",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333104",
      titleTh: "กฎหมายครอบครัวและมรดกเบื้องต้น",
      sortOrder: 8,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444111",
          type: "video",
          titleTh: "การสมรส การหย่า และการเลี้ยงดูบุตร: สิทธิของแต่ละฝ่าย",
          durationSec: 2300,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444112",
          type: "video",
          titleTh: "การรับมรดกและการจัดการมรดกเบื้องต้น",
          durationSec: 2250,
          isPreview: false,
        },
      ],
    },
  ],
};

/** หลักสูตรที่ 2 — เฉพาะทนายความ (CAT-007: isPublic=false → แสดงเงื่อนไขเป็นภาษาไทย) */
const COURSE_ETHICS: RawCourseDetail = {
  id: "22222222-2222-4222-8222-222222222202",
  code: "LTC-ETH-001",
  titleTh: "จรรยาบรรณวิชาชีพทนายความ",
  titleEn: "Professional Ethics for Lawyers",
  summary:
    "หลักจรรยาบรรณและมาตรฐานวิชาชีพ พร้อมกรณีศึกษาจากคำวินิจฉัยของคณะกรรมการกิจการสภาทนายความ",
  description:
    "จรรยาบรรณวิชาชีพคือหัวใจของการเป็นทนายความ หลักสูตรนี้เจาะลึกข้อบังคับว่าด้วยจรรยาบรรณทนายความ " +
    "ผ่านกรณีศึกษาคำวินิจฉัยจริง ครอบคลุมความสัมพันธ์ระหว่างทนายความกับลู่ความ ศาล และเพื่อนทนายความ " +
    "การรักษาความลับของลู่ความ ความขัดแย้งทางผลประโยชน์ ค่าธรรมเนียม และการโฆษณาเกินจริง",
  outcomes: [
    "อธิบายหลักจรรยาบรรณข้อบังคับทนายความได้ครบทุกหมวด",
    "วิเคราะห์กรณีความขัดแย้งทางผลประโยชน์และหาทางหลีกเลี่ยงที่ถูกต้อง",
    "รักษาความลับลู่ความตามมาตรฐานวิชาชีพอย่างเคร่งครัด",
    "ตั้งค่าธรรมเนียมและออกแบบการรับงานอย่างโปร่งใส",
  ],
  instructors: [
    {
      nameTh: "นายอรรถพล จันทรางศุ",
      titleTh: "อดีตผู้พิพากษาหัวหน้าศาลอุทธรณ์",
      bio: "อนุกรรมการกิจการจรรยาบรรณทนายความ วิทยากรหลักสูตรจรรยาบรรณของสภาทนายความ",
    },
  ],
  exam: {
    questionCount: 25,
    timeLimitMinutes: 45,
    passScorePct: 70,
    maxAttempts: 3,
  },
  status: "published",
  isPublic: false,
  level: "intermediate",
  credits: 2,
  learnerCount: 2108,
  publishedAt: "2026-07-20T03:00:00Z",
  categorySlug: "legal-ethics",
  modules: [
    {
      id: "33333333-3333-4333-8333-333333333201",
      titleTh: "หลักจรรยาบรรณพื้นฐาน",
      sortOrder: 1,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444201",
          type: "video",
          titleTh: "ความหมายและขอบเขตของจรรยาบรรณทนายความ",
          durationSec: 2400,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444202",
          type: "video",
          titleTh: "ความสัมพันธ์ระหว่างทนายความกับลู่ความ",
          durationSec: 2300,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444203",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333202",
      titleTh: "กรณีศึกษาจากคำวินิจฉัย",
      sortOrder: 2,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444204",
          type: "video",
          titleTh: "ความขัดแย้งทางผลประโยชน์และการรับว่าความ",
          durationSec: 2350,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444205",
          type: "video",
          titleTh: "การรักษาความลับของลู่ความและความรับผิด",
          durationSec: 2250,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444206",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333203",
      titleTh: "มาตรฐานการประกอบวิชาชีพ",
      sortOrder: 3,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444207",
          type: "video",
          titleTh: "ค่าธรรมเนียม การโฆษณา และการประกอบวิชาชีพร่วมกับบุคคลอื่น",
          durationSec: 2600,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444208",
          type: "document",
          titleTh: "ข้อบังคับว่าด้วยจรรยาบรรณทนายความ ฉบับสมบูรณ์",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
  ],
};

/** หลักสูตรที่ 3 — กฎหมายสัญญาเช่า (ต้นแบบหน้าแรก) */
const COURSE_LEASE: RawCourseDetail = {
  id: "22222222-2222-4222-8222-222222222203",
  code: "LTC-CON-001",
  titleTh: "หลักกฎหมายสัญญาเช่าที่อยู่อาศัย",
  titleEn: "Residential Lease Law",
  summary:
    "สิทธิและหน้าที่ของผู้ให้เช่าและผู้เช่า การบอกเลิกสัญญา ค่าเสียหาย และข้อพิพาทที่พบบ่อย",
  description:
    "การเช่าที่อยู่อาศัยเป็นสัญญาที่คนไทยใช้มากที่สุดชนิดหนึ่ง หลักสูตรนี้อธิบายองค์ประกอบของสัญญาเช่า " +
    "สิทธิหน้าที่ตามประมวลกฎหมายแพ่งและพาณิชย์ รวมถึงกฎหมายคุ้มครองผู้เช่า การขับไล่ การเรียกค่าเสียหาย " +
    "และการระงับข้อพิพาทเช่าที่อยู่อาศัยซึ่งไม่ต้องฟ้องร้องเป็นคดี",
  outcomes: [
    "องค์ประกอบและประเภทของสัญญาเช่าตามกฎหมาย",
    "สิทธิของผู้เช่าเมื่อเจ้าของบ้านขายที่ (การรับโอนสิทธิเรียกร้อง)",
    "กรณีบอกเลิกสัญญา การขับไล่ และการเรียกค่าเสียหายอย่างถูกต้อง",
    "วิธีระงับข้อพิพาทเช่าที่อยู่อาศัยก่อนถึงศาล",
  ],
  instructors: [
    {
      nameTh: "ผศ.ดร.สมชาย วัฒนศิริ",
      titleTh: "ภาคีสมาชิกสภาทนายความแห่งประเทศไทย",
      bio: "ผู้เชี่ยวชาญกฎหมายแพ่ง วิทยากรหลักสูตรกฎหมายสัญญา",
    },
  ],
  exam: {
    questionCount: 30,
    timeLimitMinutes: 60,
    passScorePct: 70,
    maxAttempts: 3,
  },
  status: "published",
  isPublic: true,
  level: "intermediate",
  credits: 3,
  learnerCount: 1876,
  publishedAt: "2026-06-30T03:00:00Z",
  categorySlug: "contract-law",
  modules: [
    {
      id: "33333333-3333-4333-8333-333333333301",
      titleTh: "พื้นฐานสัญญาเช่า",
      sortOrder: 1,
      isPreview: true,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444301",
          type: "video",
          titleTh: "สัญญาเช่าคืออะไร องค์ประกอบและรูปแบบที่กฎหมายกำหนด",
          durationSec: 2000,
          isPreview: true,
        },
        {
          id: "44444444-4444-4444-8444-444444444302",
          type: "video",
          titleTh: "สิทธิและหน้าที่ของผู้ให้เช่าและผู้เช่า",
          durationSec: 1950,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444303",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333302",
      titleTh: "การสิ้นสุดและการบอกเลิกสัญญาเช่า",
      sortOrder: 2,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444304",
          type: "video",
          titleTh: "การคืนทรัพย์สินและการบอกเลิกสัญญาเช่า",
          durationSec: 2100,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444305",
          type: "video",
          titleTh: "การเรียกค่าเสียหายเมื่อฝ่าฝืนสัญญาเช่า",
          durationSec: 2050,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444306",
          type: "video",
          titleTh: "กฎหมายคุ้มครองผู้เช่าและการขับไล่",
          durationSec: 2000,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444307",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333303",
      titleTh: "ข้อพิพาทเช่าและการระงับข้อพิพาท",
      sortOrder: 3,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444308",
          type: "video",
          titleTh: "ข้อพิพาทที่พบบ่อยและการไกล่เกลี่ยคดีเช่า",
          durationSec: 2150,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444309",
          type: "video",
          titleTh: "การฟ้องร้องคดีเช่าที่อยู่อาศัยในศาลชั้นต้น",
          durationSec: 2100,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444310",
          type: "document",
          titleTh: "แบบฟอร์มสัญญาเช่าที่อยู่อาศัยตามแนวทางสภาทนายความ",
          durationSec: null,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444311",
          type: "video",
          titleTh: "กรณีศึกษา: คดีเช่าห้องชุดที่ดำเนินการจนถึงศาล",
          durationSec: 1950,
          isPreview: false,
        },
      ],
    },
  ],
};

/** หลักสูตรที่ 4 — กฎหมายแรงงาน (หมวด กฎหมายแรงงาน) */
const COURSE_LABOR: RawCourseDetail = {
  id: "22222222-2222-4222-8222-222222222204",
  code: "LTC-LAB-001",
  titleTh: "กฎหมายแรงงานเบื้องต้นสำหรับผู้ใช้แรงงาน",
  titleEn: "Introduction to Labour Law",
  summary:
    "สัญญาจ้างแรงงาน ค่าจ้าง ชดเชย การลา การเลิกสัญญา และการร้องเรียน — เข้าใจสิทธิของลูกจ้างอย่างถูกต้อง",
  description:
    "หลักสูตรนี้สอนกฎหมายคุ้มครองแรงงานที่ใช้บ่อยที่สุดในทางปฏิบัติ ตั้งแต่การทำสัญญาจ้างแรงงาน " +
    "การกำหนดเวลาทำงานและวันลา การคุ้มครองค่าจ้าง การรับเงินปันผลและเงินชดเชย ไปจนถึงขั้นตอน " +
    "การยื่นเรื่องร้องเรียนต่อกรมสวัสดิการและคุ้มครองแรงงาน และการคว่ำคดีแรงงานออนไลน์ (ระบบ e-Claim)",
  outcomes: [
    "แยกแยะความต่างของสัญญาจ้างแรงงานกับสัญญาจ้างทำของ",
    "คำนวณค่าจ้าง ค่าล่วงเวลา วันหยุด และเงินปันผลได้ถูกต้อง",
    "สิทธิได้รับเงินชดเชยกรณีเลิกสัญญาและการนับอายุงาน",
    "ขั้นตอนยื่นเรื่องร้องเรียนแรงงานและการเข้าสู่ระบบไกล่เกลี่ย",
  ],
  instructors: [
    {
      nameTh: "ทนายกฤษณะ สุขสวัสดิ์",
      titleTh: "ทนายความผู้เชี่ยวชาญกฎหมายแรงงาน",
      bio: "อดีตผู้แทนนายจ้างในคณะกรรมการแรงงาน วิทยากรอบรมฝ่ายบุคคลมากว่า 10 ปี",
    },
  ],
  exam: {
    questionCount: 25,
    timeLimitMinutes: 45,
    passScorePct: 70,
    maxAttempts: 3,
  },
  status: "published",
  isPublic: true,
  level: "beginner",
  credits: 2,
  learnerCount: 2540,
  publishedAt: "2026-05-18T03:00:00Z",
  categorySlug: "labor-law",
  modules: [
    {
      id: "33333333-3333-4333-8333-333333333401",
      titleTh: "สัญญาจ้างแรงงาน",
      sortOrder: 1,
      isPreview: true,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444401",
          type: "video",
          titleTh: "สัญญาจ้างแรงงานเกิดขึ้นเมื่อใด ใครเป็นลูกจ้าง",
          durationSec: 1900,
          isPreview: true,
        },
        {
          id: "44444444-4444-4444-8444-444444444402",
          type: "video",
          titleTh: "เวลาทำงาน วันหยุด และการลาตามกฎหมาย",
          durationSec: 1850,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444403",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333402",
      titleTh: "ค่าจ้าง ชดเชย และการเลิกสัญญา",
      sortOrder: 2,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444404",
          type: "video",
          titleTh: "ค่าจ้าง ค่าล่วงเวลา และการคุ้มครองค่าจ้าง",
          durationSec: 2100,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444405",
          type: "video",
          titleTh: "เงินชดเชยและการเลิกสัญญาโดยไม่ยุติธรรม",
          durationSec: 2000,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444406",
          type: "video",
          titleTh: "การเลิกสัญญาที่ไม่ชอบด้วยกฎหมายและค่าเสียหาย",
          durationSec: 1950,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444407",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333403",
      titleTh: "การร้องเรียนและการคว่ำคดีแรงงาน",
      sortOrder: 3,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444408",
          type: "video",
          titleTh: "การยื่นเรื่องร้องเรียนต่อกรมสวัสดิการและคุ้มครองแรงงาน",
          durationSec: 2200,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444409",
          type: "document",
          titleTh: "คู่มือการยื่นคดีแรงงานออนไลน์ (ระบบ e-Claim)",
          durationSec: null,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444410",
          type: "video",
          titleTh: "การไกล่เกลี่ยคดีแรงงานและคำพิพากษา",
          durationSec: 1950,
          isPreview: false,
        },
      ],
    },
  ],
};

/** หลักสูตรที่ 5 — PDPA (หมวด ทักษะวิชาชีพ) */
const COURSE_PDPA: RawCourseDetail = {
  id: "22222222-2222-4222-8222-222222222205",
  code: "LTC-PDP-001",
  titleTh: "การคุ้มครองข้อมูลส่วนบุคคลสำหรับสำนักงานทนายความ",
  titleEn: "PDPA for Law Offices",
  summary:
    "หลักปฏิบัติด้านข้อมูลส่วนบุคคลสำหรับสำนักงานทนายความ ตั้งแต่การเก็บรวบรวม การขอความยินยอม ไปจนถึงแผนตอบสนองเหตุข้อมูลรั่วไหล",
  description:
    "สำนักงานทนายความจัดการข้อมูลส่วนบุคคลของลู่ความจำนวนมาก หลักสูตรนี้แปลงพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล " +
    "ให้เป็นแนวปฏิบัติที่ใช้ได้จริงในสำนักงาน: การจัดทำทะเบียนกิจกรรมการประมวลผล การขอความยินยอมฉบับถูกต้อง " +
    "การคุ้มครองสิทธิของเจ้าของข้อมูล การจัดการผู้รับมอบฉันทะ และการจัดทำแผนตอบสนองต่อการละเมิดข้อมูลส่วนบุคคล",
  outcomes: [
    "อธิบายหลักการคุ้มครองข้อมูลส่วนบุคคลทั้ง 7 ข้อได้",
    "จัดทำทะเบียนกิจกรรมการประมวลผลของสำนักงานทนายความ",
    "ออกแบบฉบับขอความยินยอมและแจ้งการคุ้มครองข้อมูลส่วนบุคคลที่ถูกต้อง",
    "ตอบสนองต่อเหตุข้อมูลส่วนบุคคลรั่วไหลภายในกรอบเวลาที่กฎหมายกำหนด",
  ],
  instructors: [
    {
      nameTh: "ดร.ณัฐพงษ์ ตั้งมั่น",
      titleTh: "ที่ปรึกษาด้านการคุ้มครองข้อมูลส่วนบุคคล",
      bio: "ที่ปรึกษา DPO ให้องค์กรกว่า 40 แห่ง วิทยากรอบรม PDPA เชิงปฏิบัติการ",
    },
  ],
  exam: {
    questionCount: 20,
    timeLimitMinutes: 40,
    passScorePct: 70,
    maxAttempts: 3,
  },
  status: "published",
  isPublic: true,
  level: "intermediate",
  credits: 2,
  learnerCount: 1290,
  publishedAt: "2026-04-22T03:00:00Z",
  categorySlug: "professional-skills",
  modules: [
    {
      id: "33333333-3333-4333-8333-333333333501",
      titleTh: "หลักการและขอบเขตของ PDPA",
      sortOrder: 1,
      isPreview: true,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444501",
          type: "video",
          titleTh: "PDPA มีผลกับสำนักงานทนายความอย่างไร",
          durationSec: 1800,
          isPreview: true,
        },
        {
          id: "44444444-4444-4444-8444-444444444502",
          type: "video",
          titleTh: "หลักการคุ้มครองข้อมูลส่วนบุคคลทั้ง 7 ข้อ",
          durationSec: 1750,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444503",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333502",
      titleTh: "การประมวลผลและความยินยอม",
      sortOrder: 2,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444504",
          type: "video",
          titleTh: "ฐานทางกฎหมายในการประมวลผลและการขอความยินยอม",
          durationSec: 1950,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444505",
          type: "video",
          titleTh: "สิทธิของเจ้าของข้อมูลและการดำเนินการตามคำขอ",
          durationSec: 1900,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444506",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333503",
      titleTh: "การนำไปปฏิบัติในสำนักงานทนายความ",
      sortOrder: 3,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444507",
          type: "video",
          titleTh: "ทะเบียนกิจกรรมการประมวลผลและการประเมินผลกระทบ",
          durationSec: 2300,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444508",
          type: "document",
          titleTh: "แบบฟอร์มขอความยินยอมและนโยบายคุ้มครองข้อมูลส่วนบุคคลตัวอย่าง",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
  ],
};

/** หลักสูตรที่ 6 — มรดก (หมวด กฎหมายสำหรับประชาชน — ลึกขึ้นจากหลักสูตรที่ 1) */
const COURSE_INHERITANCE: RawCourseDetail = {
  id: "22222222-2222-4222-8222-222222222206",
  code: "LTC-CAT-002",
  titleTh: "การรับมรดกและการจัดการมรดกเบื้องต้น",
  titleEn: "Introduction to Inheritance Law",
  summary:
    "ผู้มีส่วนได้เสีย ทายาทโดยธรรม การทำพินัยกรรม การแบ่งมรดก และการยื่นคำขอจัดการมรดกต่อศาล",
  description:
    "เมื่อคนในครอบครัวเสียชีวิต ทายาทมักไม่รู้ว่าต้องเริ่มจากอะไร หลักสูตรนี้อธิบายลำดับทายาทโดยธรรม " +
    "ส่วนแบ่งมรดก หลักประสพตาย การทำพินัยกรรมและการปฏิบัติตามพินัยกรรม การยื่นคำขอจัดการมรดกต่อศาล " +
    "และการดำเนินการเมื่อมีหนี้สินติดตัวผู้ตาย โดยใช้กรณีศึกษาที่พบบ่อยในสำนักงานทนายความ",
  outcomes: [
    "ลำดับและส่วนแบ่งของทายาทโดยธรรมตามประมวลกฎหมายแพ่งและพาณิชย์",
    "หลักประสพตายและผลต่อส่วนแบ่งมรดกของคู่สมรส",
    "องค์ประกอบของพินัยกรรมที่ถูกต้องตามกฎหมาย",
    "ขั้นตอนยื่นคำขอจัดการมรดกและการนำจ่ายหนี้จากมรดก",
  ],
  instructors: [
    {
      nameTh: "ทนายพิมพ์ชนก ศรีสุวรรณ",
      titleTh: "ทนายความผู้เชี่ยวชาญด้านคุ้มครองผู้บริโภค",
      bio: "วิทยากรประจำหลักสูตรกฎหมายครอบครัวและมรดก",
    },
  ],
  exam: {
    questionCount: 20,
    timeLimitMinutes: 40,
    passScorePct: 70,
    maxAttempts: 3,
  },
  status: "published",
  isPublic: true,
  level: "beginner",
  credits: 2,
  learnerCount: 980,
  publishedAt: "2026-03-15T03:00:00Z",
  categorySlug: "public-law",
  modules: [
    {
      id: "33333333-3333-4333-8333-333333333601",
      titleTh: "ผู้มีส่วนได้เสียและทายาทโดยธรรม",
      sortOrder: 1,
      isPreview: true,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444601",
          type: "video",
          titleTh: "มรดกครอบคลุมอะไร ใครเป็นทายาทโดยธรรม",
          durationSec: 1600,
          isPreview: true,
        },
        {
          id: "44444444-4444-4444-8444-444444444602",
          type: "video",
          titleTh: "หลักประสพตายและส่วนแบ่งของคู่สมรส",
          durationSec: 1550,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444603",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333602",
      titleTh: "พินัยกรรมและการจัดการมรดก",
      sortOrder: 2,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444604",
          type: "video",
          titleTh: "รูปแบบพินัยกรรมตามกฎหมายและข้อควรระวัง",
          durationSec: 1700,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444605",
          type: "video",
          titleTh: "การยื่นคำขอจัดการมรดกต่อศาล",
          durationSec: 1650,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444606",
          type: "quiz",
          titleTh: "แบบทดสอบย่อยท้ายโมดูล (5 ข้อ)",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333603",
      titleTh: "กรณีศึกษาการแบ่งมรดก",
      sortOrder: 3,
      isPreview: false,
      lessons: [
        {
          id: "44444444-4444-4444-8444-444444444607",
          type: "video",
          titleTh: "กรณีศึกษา: มรดกที่มีทั้งหนี้และทรัพย์สิน",
          durationSec: 1400,
          isPreview: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444608",
          type: "document",
          titleTh: "แบบฟอร์มพินัยกรรมและคำขอจัดการมรดกตัวอย่าง",
          durationSec: null,
          isPreview: false,
        },
      ],
    },
  ],
};

/** ───────────────────────── ผู้ช่วยเชิงนิเทศ (export) ───────────────────────── */

const RAW_COURSES: RawCourseDetail[] = [
  COURSE_BASIC_LAW,
  COURSE_ETHICS,
  COURSE_LEASE,
  COURSE_LABOR,
  COURSE_PDPA,
  COURSE_INHERITANCE,
];

const CATEGORY_BY_SLUG = new Map(COURSE_CATEGORIES.map((c) => [c.slug, c]));

/** resolve หมวดจาก slug + นับจำนวนหลักสูตรต่อหมวด (ต้องเรียกหลัง RAW_COURSES พร้อม) */
function resolveCategory(slug: string): CatalogCategory | undefined {
  const category = CATEGORY_BY_SLUG.get(slug);
  if (!category) return undefined;
  return {
    ...category,
    courseCount: RAW_COURSES.filter((c) => c.categorySlug === slug).length,
  };
}

/** บทเรียนทั้งหมดของหลักสูตร (ข้ามโมดูล) */
function allLessons(course: Pick<RawCourseDetail, "modules">): CourseLesson[] {
  return course.modules.flatMap((m) => m.lessons);
}

/**
 * ค่าที่ derive จาก modules — ตัวเดียวของ detail และ list item
 * จึงจำนวนบทเรียน/ชั่วโมงของ detail กับ list ตรงกันเสมอ
 */
function deriveCourseMetrics(course: Pick<RawCourseDetail, "modules">): {
  lessonCount: number;
  durationHours: number;
} {
  const lessons = allLessons(course);
  const totalSec = lessons.filter((l) => l.type === "video").reduce((sum, l) => sum + (l.durationSec ?? 0), 0);
  return {
    lessonCount: lessons.length,
    durationHours: Math.round((totalSec / 3600) * 10) / 10,
  };
}

function toListItem(course: RawCourseDetail): CourseListItem {
  const { lessonCount, durationHours } = deriveCourseMetrics(course);
  const category = resolveCategory(course.categorySlug);
  if (!category) {
    throw new Error(`fixture หลักสูตร ${course.code} อ้างหมวดที่ไม่มีในระบบ: ${course.categorySlug}`);
  }
  return {
    id: course.id,
    code: course.code,
    titleTh: course.titleTh,
    titleEn: course.titleEn,
    summary: course.summary,
    category: { id: category.id, slug: category.slug, nameTh: category.nameTh },
    status: course.status,
    isPublic: course.isPublic,
    level: course.level,
    lessonCount,
    durationHours,
    credits: course.credits,
    learnerCount: course.learnerCount,
    publishedAt: course.publishedAt,
  };
}

const RESOLVED_COURSES: CourseDetail[] = RAW_COURSES.map((course) => {
  const category = resolveCategory(course.categorySlug);
  if (!category) {
    throw new Error(
      `fixture หลักสูตร ${course.code} อ้างหมวดที่ไม่มีในระบบ: ${course.categorySlug}`,
    );
  }
  const { lessonCount, durationHours } = deriveCourseMetrics(course);
  return { ...course, category, lessonCount, durationHours };
});

/**
 * GET /courses (fixture) — คืนเฉพาะ published เรียงตาม publishedAt ล่าสุดก่อน
 * Phase 1: เปลี่ยน body เป็น fetch("/api/v1/courses") — ลายเซ็นคงเดิม
 */
export async function getPublishedCourses(): Promise<CourseListResponse> {
  const data = RESOLVED_COURSES.map(toListItem).sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
  return {
    data,
    page: { nextCursor: null, hasMore: false },
  };
}

/** GET /categories (fixture) — เฉพาะหมวดที่มีหลักสูตร published */
export async function getCategories(): Promise<CatalogCategory[]> {
  const usedSlugs = new Set(RESOLVED_COURSES.map((c) => c.categorySlug));
  return COURSE_CATEGORIES.filter((c) => usedSlugs.has(c.slug)).map((c) =>
    resolveCategory(c.slug) as CatalogCategory,
  );
}

/** GET /courses/{id} (fixture) — ไม่เจอ = undefined → หน้าเว็บ notFound() (API ตอบ 404 ERR-CRS-001) */
export async function findPublishedCourse(id: string): Promise<CourseDetail | undefined> {
  return RESOLVED_COURSES.find((c) => c.id === id);
}

/** ───────────────────────── ผู้ช่วยแสดงผล (ภาษาไทย) ───────────────────────── */

const LEVEL_LABELS: Record<CourseLevel, string> = {
  beginner: "ระดับเริ่มต้น",
  intermediate: "ระดับกลาง",
  advanced: "ระดับสูง",
};

export function courseLevelLabel(level: CourseLevel): string {
  return LEVEL_LABELS[level];
}

/** "6 ชั่วโมง" / "4.4 ชั่วโมง" — ตัวเลขอารบิก ตาม DS §9 */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ชั่วโมง`;
}

/** "25:00" จากวินาที — tabular-nums */
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** วันที่พุทธศักราช "12 สิงหาคม 2569" — DS §9 (Intl th-TH + buddhist calendar) */
export function formatThaiDate(iso: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    calendar: "buddhist",
  }).format(new Date(iso));
}

/** จำนวนผู้เรียน "3,412" — อารบิก + คั่นหลักตามแนวราชการ */
export function formatLearnerCount(n: number): string {
  return new Intl.NumberFormat("th-TH").format(n);
}

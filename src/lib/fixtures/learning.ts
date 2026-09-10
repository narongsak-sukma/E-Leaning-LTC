/**
 * fixtures/learning — ข้อมูลจำลอง (fixture) ฝั่งผู้เรียน — Wave C task C-7 (Phase 0)
 *
 * - UI ผู้เรียน (learner shell / my/courses / lesson player) ทำงานบน fixture ชุดนี้
 *   แล้วสลับไปเรียก BFF จริงใน Phase 1 (หลัง C-2/C-3/C-4 ผ่าน gates)
 * - รูป URL/body ยึด API-SPECIFICATION §3.4 เป๊ะตั้งแต่วันนี้:
 *   · heartbeat วิดีโอ → POST /api/v1/lessons/{id}/progress  body { positionSeconds }
 *   · เอกสาร (attestation) → POST /api/v1/lessons/{id}/progress  body { documentRead: true }
 *     (positionSeconds XOR documentRead — LessonProgressRequest ตาม D12-12)
 *   · quiz → POST /api/v1/lessons/{id}/quiz/submit  body { answers: [{ questionId, choiceIds }] }
 * - ห้ามส่ง flag `completed` จาก client — สถานะ "จบบท" ตัดสินโดย server (D12-1/D12-12)
 * - ค่ากฎ (VIDEO_HEARTBEAT_SEC ฯลฯ) ไม่ปรากฏในไฟล์นี้ — server อ่านจาก src/lib/config.ts แล้วส่งเป็น props
 */

export type LessonType = "video" | "document" | "quiz";

/** สถานะความคืบหน้ารายบทเรียน (server เป็นผู้ตัดสิน — fixture เก็บเพื่อ render เท่านั้น) */
export type LessonStatus = "not_started" | "in_progress" | "completed";

export interface LessonSummary {
  id: string;
  title: string;
  type: LessonType;
  status: LessonStatus;
}

export interface CourseModule {
  id: string;
  title: string;
  lessons: LessonSummary[];
}

/** การ์ด "หลักสูตรของฉัน" — ความคืบหน้ารวม + บทที่ค้าง (LRN-002/009) */
export interface ContinueLessonInfo {
  id: string;
  title: string;
  type: LessonType;
  status: LessonStatus;
  label: string;
  positionSeconds: number | null;
  durationSeconds: number | null;
}

export interface EnrolledCourseCard {
  id: string;
  title: string;
  category: string;
  lessonCount: number;
  completedCount: number;
  progressPercent: number;
  continueLesson: ContinueLessonInfo | null;
}

export interface CourseOutline {
  id: string;
  title: string;
  category: string;
  modules: CourseModule[];
  lessonCount: number;
  completedCount: number;
  progressPercent: number;
}

/** บทเรียนวิดีโอ — heartbeat ตาม SDS §3.3(b) */
export interface VideoLessonDetail {
  kind: "video";
  lessonId: string;
  title: string;
  src: string | null;
  durationSeconds: number;
  initialPositionSeconds: number;
}

/** บทเรียนเอกสาร — ปิดท้ายด้วยคำยืนยัน "อ่านจบแล้ว" (client attestation — SDS §3.3(c)) */
export interface DocumentLessonDetail {
  kind: "document";
  lessonId: string;
  title: string;
  documentTitle: string;
  paragraphs: readonly string[];
}

/** บทเรียน quiz — คำถามไม่มีเฉลยปนใน view (เฉลยคืนหลังส่งเท่านั้น ตาม API §3.4 200 คะแนน+เฉลย) */
export interface QuizLessonDetail {
  kind: "quiz";
  lessonId: string;
  title: string;
  /** รหัสแบบทดสอบ (ไม่ใช่เฉลย) — Phase 0 ใช้ตรวจด้วย fixtureSubmitQuiz · null = ส่งตามสัญญาจริง */
  quizId: string | null;
  questions: QuizQuestionView[];
  passPct: number;
  bestScorePct: number | null;
}

export type LessonDetail = VideoLessonDetail | DocumentLessonDetail | QuizLessonDetail;

// ——— รูป request/response ตาม API-SPECIFICATION §3.4 (ใช้เป็นชนิด props เพื่อสลับ fixture→fetch) ——

export interface QuizSubmitRequest {
  answers: readonly { questionId: string; choiceIds: readonly string[] }[];
}

export interface QuizQuestionResult {
  questionId: string;
  isCorrect: boolean;
  correctChoiceIds: readonly string[];
  explanation: string | null;
}

export interface QuizSubmitResponse {
  scorePct: number;
  passed: boolean;
  passPct: number;
  results: readonly QuizQuestionResult[];
}

export type SubmitQuizFn = (body: QuizSubmitRequest) => Promise<QuizSubmitResponse>;
export type SendProgressFn = (positionSeconds: number) => Promise<void>;
export type SendAttestationFn = () => Promise<void>;

export interface QuizChoiceView {
  id: string;
  label: string;
}

export interface QuizQuestionView {
  id: string;
  prompt: string;
  choices: readonly QuizChoiceView[];
}

// ——— ข้อมูล fixture (ภาษาไทย — หลักสูตรของสภาทนายความฯ) ——

interface LessonSeed {
  id: string;
  title: string;
  type: LessonType;
  status: LessonStatus;
  positionSeconds?: number;
  durationSeconds?: number;
  videoSrc?: string;
  documentTitle?: string;
  documentParagraphs?: string[];
  quizId?: string;
}

interface ModuleSeed {
  id: string;
  title: string;
  lessons: LessonSeed[];
}

interface CourseSeed {
  id: string;
  title: string;
  category: string;
  modules: ModuleSeed[];
}

const COURSE_SEEDS: readonly CourseSeed[] = [
  {
    id: "course-pdpa-101",
    title: "กฎหมายคุ้มครองข้อมูลส่วนบุคคลสำหรับทนายความ",
    category: "กฎหมายทั่วไป",
    modules: [
      {
        id: "m1",
        title: "โมดูล 1 · หลักการพื้นฐานของการคุ้มครองข้อมูลส่วนบุคคล",
        lessons: [
          {
            id: "l-1-1",
            title: "หลักการพื้นฐานและขอบเขตการบังคับใช้",
            type: "video",
            status: "completed",
            durationSeconds: 300,
            positionSeconds: 300,
            videoSrc: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
          },
          {
            id: "l-1-2",
            title: "สิทธิของเจ้าของข้อมูลส่วนบุคคล",
            type: "document",
            status: "completed",
            documentTitle: "ใบความรู้ บทที่ 1.2 — สิทธิของเจ้าของข้อมูลส่วนบุคคล",
            documentParagraphs: [
              "เจ้าของข้อมูลส่วนบุคคลมีสิทธิหลายประการที่กฎหมายให้การคุ้มครอง เช่น สิทธิได้รับแจ้ง สิทธิเข้าถึงและขอรับสำเนาข้อมูล สิทธิให้แก้ไขให้ข้อมูลถูกต้อง สิทธิขอให้ลบหรือทำลายข้อมูล สิทธิให้ระงับการใช้ข้อมูล สิทธิคัดค้านการเก็บรวบรวม ใช้ หรือเปิดเผยข้อมูล และสิทธิให้โอนย้ายข้อมูล",
              "ผู้ประกอบธุรกิจต้องจัดให้มีช่องทางที่เจ้าของข้อมูลใช้สิทธิได้สะดวก และต้องดำเนินการให้แล้วเสร็จภายในระยะเวลาที่กฎหมายกำหนด หากปฏิเสธคำขอต้องแจ้งเหตุผลพร้อมสิทธิในการร้องเรียนต่อคณะกรรมการการคุ้มครองข้อมูลส่วนบุคคล",
              "ในทางปฏิบัติของผู้ประกอบวิชาชีพทนายความ ข้อมูลคดีและข้อมูลลูกความมักเป็นข้อมูลส่วนบุคคลที่มีความอ่อนไหวสูง การจัดการคำขอใช้สิทธิจึงต้องคำนึงถึงความลับทางวิชาชีพควบคู่กับหน้าที่ตามกฎหมายคุ้มครองข้อมูลส่วนบุคคลด้วย",
            ],
          },
          {
            id: "l-1-3",
            title: "ทดสอบความเข้าใจ — โมดูล 1",
            type: "quiz",
            status: "completed",
            quizId: "quiz-1",
          },
        ],
      },
      {
        id: "m2",
        title: "โมดูล 2 · หน้าที่ของผู้ควบคุมข้อมูลส่วนบุคคล",
        lessons: [
          {
            id: "l-2-1",
            title: "บันทึกกิจกรรมการประมวลผลข้อมูลส่วนบุคคล",
            type: "video",
            status: "in_progress",
            durationSeconds: 240,
            positionSeconds: 87,
            videoSrc: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
          },
          {
            id: "l-2-2",
            title: "มาตรการรักษาความมั่นคงปลอดภัย",
            type: "document",
            status: "not_started",
            documentTitle: "ใบความรู้ บทที่ 2.2 — มาตรการรักษาความมั่นคงปลอดภัย",
            documentParagraphs: [
              "ผู้ควบคุมข้อมูลส่วนบุคคลต้องจัดให้มีมาตรการรักษาความมั่นคงปลอดภัยที่เหมาะสมทางเทคนิคและทางบริหารจัดการ เพื่อป้องกันการสูญหาย เข้าถึง ใช้ เปลี่ยนแปลง แก้ไข หรือเปิดเผยข้อมูลโดยมิชอบ",
              "มาตรการทางเทคนิคที่ควรมี เช่น การควบคุมสิทธิการเข้าถึงตามหน้าที่ การเข้ารหัสลับข้อมูล การบันทึกเหตุการณ์การใช้งาน (audit log) และการสำรองข้อมูล ส่วนมาตรการทางบริหารจัดการ เช่น นโยบายความมั่นคงปลอดภัย การอบรมบุคลากร และการทำสัญญาคุ้มครองข้อมูลกับผู้ประมวลผลแทน",
              "เมื่อเกิดเหตุละเมิดข้อมูลส่วนบุคคล ผู้ควบคุมข้อมูลต้องแจ้งเหตุต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคลภายใน 72 ชั่วโมงนับแต่ทราบเหตุ และหากเหตุมีความเสี่ยงสูงต่อสิทธิเสรีภาพของเจ้าของข้อมูล ต้องแจ้งเจ้าของข้อมูลด้วย",
            ],
          },
          {
            id: "l-2-3",
            title: "ทดสอบความเข้าใจ — โมดูล 2",
            type: "quiz",
            status: "not_started",
            quizId: "quiz-2",
          },
        ],
      },
    ],
  },
  {
    id: "course-contract-201",
    title: "การทำสัญญาและการบังคับใช้สิทธิทางแพ่ง",
    category: "กฎหมายเอกชน",
    modules: [
      {
        id: "cm1",
        title: "โมดูล 1 · หลักการทำสัญญา",
        lessons: [
          {
            id: "cl-1-1",
            title: "องค์ประกอบของสัญญาและการเสนอกับการยอมรับคำเสนอ",
            type: "video",
            status: "in_progress",
            durationSeconds: 210,
            positionSeconds: 45,
            videoSrc: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
          },
          {
            id: "cl-1-2",
            title: "สัญญาที่เป็นโมฆะและสัญญาที่โมฆียะ",
            type: "document",
            status: "not_started",
            documentTitle: "ใบความรู้ บทที่ 1.2 — โมฆะและโมฆียะ",
            documentParagraphs: [
              "นิติกรรมที่มีลักษณะต้องห้ามตามกฎหมายโดยแท้ หรือเป็นการละเมิดความสงบเรียบร้อยของประชาชน ย่อมเป็นโมฆะ ส่วนนิติกรรมที่บกพร่องเพราะขาดสมรรถนะหรือเพราะเจตนามีข้อบกพร่องบางประเภท ย่อมเป็นโมฆียะ",
              "ความแตกต่างที่สำคัญคือ สัญญาที่เป็นโมฆะไม่มีผลสมบูรณ์แต่ต้นและหานิรันดร์ ศาลหรือคู่สัญญาไม่อาจทำให้กลับสู่สภาพสมบูรณ์ได้ ส่วนสัญญาที่เป็นโมฆียะมีผลบังคับแต่คู่สัญญาฝ่ายที่ได้เปรียบหรือผู้มีสิทธิอาจเรียกให้ยกเลิกได้ และการยกเลิกมีผลย้อนหลัง",
              "ผู้ประกอบวิชาชีพทนายความต้องพิจารณาองค์ประกอบเหล่านี้ประกอบหลักฐานที่แสดงเจตนาของคู่สัญญา เพื่อเสนอทางเลือกในการแก้ไขข้อพิพาทหรือความเสียหายของลูกความได้ถูกต้อง",
            ],
          },
          {
            id: "cl-1-3",
            title: "ทดสอบความเข้าใจ — หลักการทำสัญญา",
            type: "quiz",
            status: "not_started",
            quizId: "quiz-3",
          },
        ],
      },
    ],
  },
];

// ——— ธนาคารข้อสอบ quiz (fixture — เฉลยอยู่ฝั่งนี้เท่านั้น Phase 0; Phase 1 ย้ายไป POST /quiz/submit จริง) ——

interface QuizBankEntry {
  passPct: number;
  bestScorePct: number | null;
  questions: readonly (QuizQuestionView & {
    correctChoiceIds: readonly string[];
    explanation: string;
  })[];
}

const QUIZ_BANK: Readonly<Record<string, QuizBankEntry>> = {
  "quiz-1": {
    passPct: 60,
    bestScorePct: 100,
    questions: [
      {
        id: "q-1-1",
        prompt: "พระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคลใช้กับการประมวลผลข้อมูลส่วนบุคคลรูปแบบใด",
        choices: [
          { id: "q1c1", label: "เฉพาะการประมวลผลที่ทำด้วยระบบอิเล็กทรอนิกส์เท่านั้น" },
          { id: "q1c2", label: "การประมวลผลในระบบสารสนเทศ และการประมวลผลแบบผสมผสานกับสื่ออื่น" },
          { id: "q1c3", label: "เฉพาะข้อมูลที่เก็บไว้ในต่างประเทศ" },
          { id: "q1c4", label: "เฉพาะข้อมูลของนิติบุคคล" },
        ],
        correctChoiceIds: ["q1c2"],
        explanation: "กฎหมายคุ้มครองข้อมูลส่วนบุคคลใช้กับการประมวลผลที่ทำในระบบสารสนเทศ และการประมวลผลแบบผสมผสานกับสื่ออื่น ไม่จำกัดเฉพาะรูปแบบอิเล็กทรอนิกส์",
      },
      {
        id: "q-1-2",
        prompt: "ข้อใดไม่ถูกต้องตามหลักการเก็บรักษาข้อมูลส่วนบุคคล",
        choices: [
          { id: "q2c1", label: "เก็บข้อมูลได้ไม่จำกัดระยะเวลา เพื่อความสะดวกในการตรวจสอบย้อนหลัง" },
          { id: "q2c2", label: "จำกัดการเก็บให้มีเพียงเท่าที่จำเป็นตามความมุ่งหมาย" },
          { id: "q2c3", label: "กำหนดระยะเวลาที่จะต้องทำลายหรือทำให้ข้อมูลไม่สามารถระบุตัวตนเจ้าของได้" },
          { id: "q2c4", label: "ตรวจสอบให้ข้อมูลถูกต้องเป็นปัจจุบัน" },
        ],
        correctChoiceIds: ["q2c1"],
        explanation: "หลักการจำกัดระยะเวลาในการเก็บรักษา ห้ามเก็บข้อมูลเกินระยะเวลาที่จำเป็นตามความมุ่งหมายที่แจ้งไว้",
      },
      {
        id: "q-1-3",
        prompt: "สิทธิของเจ้าของข้อมูลส่วนบุคคลตามกฎหมาย ได้แก่ ข้อใด",
        choices: [
          { id: "q3c1", label: "สิทธิในการเข้าถึงข้อมูลและขอรับสำเนาข้อมูล" },
          { id: "q3c2", label: "สิทธิเปลี่ยนเลขที่ใบอนุญาตทนายความด้วยตนเอง" },
          { id: "q3c3", label: "สิทธิตัดสินคดีแทนศาล" },
          { id: "q3c4", label: "สิทธิยึดทรัพย์ของลูกหนี้" },
        ],
        correctChoiceIds: ["q3c1"],
        explanation: "สิทธิเข้าถึงและขอรับสำเนาข้อมูลเป็นสิทธิตามกฎหมาย ส่วนข้ออื่นไม่ใช่สิทธิที่กฎหมายฉบับนี้ให้ไว้",
      },
    ],
  },
  "quiz-2": {
    passPct: 60,
    bestScorePct: null,
    questions: [
      {
        id: "q2-1",
        prompt: "มาตรการรักษาความมั่นคงปลอดภัยข้อใดเป็นมาตรการทางเทคนิค",
        choices: [
          { id: "a1c1", label: "การอบรมความรู้ให้บุคลากร" },
          { id: "a1c2", label: "การควบคุมสิทธิการเข้าถึงข้อมูลตามหน้าที่ และการเข้ารหัสลับข้อมูล" },
          { id: "a1c3", label: "การทำสัญญาคุ้มครองข้อมูลส่วนบุคคลกับผู้ประมวลผลแทน" },
          { id: "a1c4", label: "การกำหนดนโยบายความมั่นคงปลอดภัย" },
        ],
        correctChoiceIds: ["a1c2"],
        explanation: "การควบคุมสิทธิการเข้าถึงและการเข้ารหัสลับเป็นมาตรการทางเทคนิค ส่วนข้ออื่นเป็นมาตรการทางบริหารจัดการ",
      },
      {
        id: "q2-2",
        prompt: "เมื่อเกิดเหตุละเมิดข้อมูลส่วนบุคคล ผู้ควบคุมข้อมูลต้องดำเนินการอย่างไร",
        choices: [
          { id: "a2c1", label: "รอให้ผู้ได้รับผลกระทบร้องเรียนก่อนจึงดำเนินการ" },
          { id: "a2c2", label: "แจ้งเหตุต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคลภายใน 72 ชั่วโมงนับแต่ทราบเหตุ" },
          { id: "a2c3", label: "ลบข้อมูลที่ถูกละเมิดทิ้งทั้งหมดเพื่อปิดเหตุการณ์" },
          { id: "a2c4", label: "เปิดเผยข้อมูลเพื่อให้เจ้าของข้อมูลตรวจสอบได้เองทุกกรณี" },
        ],
        correctChoiceIds: ["a2c2"],
        explanation: "ต้องแจ้งเหตุต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคลภายใน 72 ชั่วโมง และหากมีความเสี่ยงสูงต้องแจ้งเจ้าของข้อมูลด้วย",
      },
      {
        id: "q2-3",
        prompt: "ขอบเขตของบันทึกกิจกรรมการประมวลผลข้อมูลส่วนบุคคลที่ถูกต้อง คือ ข้อใด",
        choices: [
          { id: "a3c1", label: "จัดทำเฉพาะเมื่อเกิดเหตุละเมิดข้อมูลแล้ว" },
          { id: "a3c2", label: "จัดทำให้ครอบคลุมกิจกรรมการประมวลผลทั้งหมด ตั้งแต่เก็บรวบรวมจนถึงการทำลาย" },
          { id: "a3c3", label: "จัดทำเฉพาะข้อมูลของลูกความ ไม่รวมข้อมูลบุคลากร" },
          { id: "a3c4", label: "จัดทำเพื่อส่งต่อให้หน่วยงานต่างประเทศเท่านั้น" },
        ],
        correctChoiceIds: ["a3c2"],
        explanation: "บันทึกกิจกรรมการประมวลผลต้องครอบคลุมกิจกรรมทั้งหมด เพื่อให้ตรวจสอบความสอดคล้องของการใช้ข้อมูลได้ทุกขั้นตอน",
      },
    ],
  },
  "quiz-3": {
    passPct: 60,
    bestScorePct: null,
    questions: [
      {
        id: "q3-1",
        prompt: "สัญญาที่เป็นโมฆะ มีผลอย่างไร",
        choices: [
          { id: "b1c1", label: "ไม่มีผลสมบูรณ์แต่ต้นและหานิรันดร์" },
          { id: "b1c2", label: "มีผลบังคับจนกว่าจะมีการยกเลิก" },
          { id: "b1c3", label: "มีผลเมื่อได้รับความยินยอมจากศาล" },
          { id: "b1c4", label: "มีผลเฉพาะระหว่างคู่สัญญา" },
        ],
        correctChoiceIds: ["b1c1"],
        explanation: "สัญญาที่เป็นโมฆะไม่มีผลสมบูรณ์แต่ต้นและหานิรันดร์ ต่างจากโมฆียะที่มีผลบังคับจนกว่าจะยกเลิก",
      },
      {
        id: "q3-2",
        prompt: "การเสนอและการยอมรับแถลงความประสงค์จะผูกพันตามสัญญา มีผลเมื่อใด",
        choices: [
          { id: "b2c1", label: "เมื่อคู่สัญญาฝ่ายหนึ่งจัดทำเอกสารเป็นหนังสือ" },
          { id: "b2c2", label: "เมื่อคู่สัญญาทั้งสองฝ่ายตกลงกันได้ในเรื่องที่เป็นสาระสำคัญแห่งสัญญา" },
          { id: "b2c3", label: "เมื่อมีพยานบุคคลที่เห็นการตกลง" },
          { id: "b2c4", label: "เมื่อลงลายมือชื่อต่อหน้านายทะเบียน" },
        ],
        correctChoiceIds: ["b2c2"],
        explanation: "สัญญาเกิดขึ้นเมื่อมีการเสนอและยอมรับที่ตรงกันในเรื่องสาระสำคัญ โดยไม่จำเป็นต้องมีหนังสือ เว้นแต่กฎหมายกำหนดรูปแบบพิเศษ",
      },
      {
        id: "q3-3",
        prompt: "สัญญาที่โมฆียะ คู่สัญญาสามารถยกเลิกได้ภายในเวลาเท่าใดนับแต่รู้เหตุที่ทำให้โมฆียะ",
        choices: [
          { id: "b3c1", label: "1 ปี" },
          { id: "b3c2", label: "2 ปี" },
          { id: "b3c3", label: "5 ปี" },
          { id: "b3c4", label: "10 ปี" },
        ],
        correctChoiceIds: ["b3c4"],
        explanation: "สิทธิยกเลิกนิติกรรมที่โมฆียะมีอายุ 10 ปีนับแต่วันที่นิติกรรมนั้นมีผลสมบูรณ์ เว้นแต่กฎหมายกำหนดระยะเวลาอื่น",
      },
    ],
  },
};

// ——— ผู้ช่วยคำนวณ ——

const roundedPercent = (part: number, total: number): number =>
  total <= 0 ? 0 : Math.round((part / total) * 100);

function flattenLessons(course: CourseSeed): LessonSeed[] {
  return course.modules.flatMap((module) => module.lessons);
}

function countLessons(course: CourseSeed): { total: number; completed: number } {
  const lessons = flattenLessons(course);
  return {
    total: lessons.length,
    completed: lessons.filter((lesson) => lesson.status === "completed").length,
  };
}

/** ป้ายตำแหน่งบทเรียน "บทเรียน {โมดูล}.{ลำดับ}" — ใช้บนการ์ดเรียนต่อและ breadcrumb */
function lessonLabel(course: CourseSeed, lessonId: string): string | null {
  for (const [moduleIndex, module] of course.modules.entries()) {
    const lessonIndex = module.lessons.findIndex((lesson) => lesson.id === lessonId);
    if (lessonIndex >= 0) {
      return `บทเรียน ${moduleIndex + 1}.${lessonIndex + 1}`;
    }
  }
  return null;
}

function toContinueLesson(course: CourseSeed, lesson: LessonSeed): ContinueLessonInfo {
  return {
    id: lesson.id,
    title: lesson.title,
    type: lesson.type,
    status: lesson.status,
    label: lessonLabel(course, lesson.id) ?? lesson.title,
    positionSeconds: lesson.positionSeconds ?? null,
    durationSeconds: lesson.durationSeconds ?? null,
  };
}

/** บทที่ค้าง = บทล่าสุดที่กำลังเรียน ถ้าไม่มีใช้บทแรกที่ยังไม่เริ่ม ถ้าเรียนครบแล้วเป็น null (LRN-009) */
function pickContinueLesson(course: CourseSeed): LessonSeed | null {
  const lessons = flattenLessons(course);
  const inProgress = lessons.filter((lesson) => lesson.status === "in_progress");
  const latest = inProgress.at(-1);
  if (latest) {
    return latest;
  }
  return lessons.find((lesson) => lesson.status === "not_started") ?? null;
}

function findCourse(courseId: string): CourseSeed | null {
  return COURSE_SEEDS.find((course) => course.id === courseId) ?? null;
}

// ——— API ที่หน้า UI เรียกใช้ ——

function buildOutline(course: CourseSeed): CourseOutline {
  const { total, completed } = countLessons(course);
  return {
    id: course.id,
    title: course.title,
    category: course.category,
    modules: course.modules.map((module) => ({
      id: module.id,
      title: module.title,
      lessons: module.lessons.map(({ id, title, type, status }) => ({ id, title, type, status })),
    })),
    lessonCount: total,
    completedCount: completed,
    progressPercent: roundedPercent(completed, total),
  };
}

export function getMyEnrolledCourses(): EnrolledCourseCard[] {
  return COURSE_SEEDS.map((course) => {
    const { total, completed } = countLessons(course);
    const pending = pickContinueLesson(course);
    return {
      id: course.id,
      title: course.title,
      category: course.category,
      lessonCount: total,
      completedCount: completed,
      progressPercent: roundedPercent(completed, total),
      continueLesson: pending ? toContinueLesson(course, pending) : null,
    };
  });
}

export function getCourseOutline(courseId: string): CourseOutline | null {
  const course = findCourse(courseId);
  return course ? buildOutline(course) : null;
}

export interface ResolvedLesson {
  outline: CourseOutline;
  lesson: LessonDetail;
}

/** หาบทเรียนในหลักสูตร — ไม่ระบุ lessonId = ไปยังบทที่ค้าง (ใช้กับ resume 2 คลิก — LRN-009) */
export function getLessonDetail(courseId: string, lessonId?: string): ResolvedLesson | null {
  const course = findCourse(courseId);
  if (!course) {
    return null;
  }
  const lessons = flattenLessons(course);
  const target = lessonId !== undefined ? lessons.find((lesson) => lesson.id === lessonId) : pickContinueLesson(course);
  const lesson = target ?? lessons[0];
  if (!lesson) {
    return null;
  }

  let detail: LessonDetail;
  if (lesson.type === "video") {
    detail = {
      kind: "video",
      lessonId: lesson.id,
      title: lesson.title,
      src: lesson.videoSrc ?? null,
      durationSeconds: lesson.durationSeconds ?? 0,
      initialPositionSeconds: lesson.status === "completed" ? 0 : (lesson.positionSeconds ?? 0),
    };
  } else if (lesson.type === "document") {
    detail = {
      kind: "document",
      lessonId: lesson.id,
      title: lesson.title,
      documentTitle: lesson.documentTitle ?? lesson.title,
      paragraphs: lesson.documentParagraphs ?? [],
    };
  } else {
    const entry = lesson.quizId !== undefined ? QUIZ_BANK[lesson.quizId] : undefined;
    if (!entry) {
      return null;
    }
    detail = {
      kind: "quiz",
      lessonId: lesson.id,
      title: lesson.title,
      quizId: lesson.quizId ?? null,
      questions: entry.questions.map(({ id, prompt, choices }) => ({ id, prompt, choices })),
      passPct: entry.passPct,
      bestScorePct: entry.bestScorePct,
    };
  }

  return { outline: buildOutline(course), lesson: detail };
}

export interface NeighborLessons {
  index: number;
  total: number;
  prev: LessonSummary | null;
  next: LessonSummary | null;
}

export function getNeighborLessons(courseId: string, lessonId: string): NeighborLessons | null {
  const course = findCourse(courseId);
  if (!course) {
    return null;
  }
  const lessons = flattenLessons(course);
  const index = lessons.findIndex((lesson) => lesson.id === lessonId);
  if (index < 0) {
    return null;
  }
  const toSummary = (lesson: LessonSeed | undefined): LessonSummary | null =>
    lesson ? { id: lesson.id, title: lesson.title, type: lesson.type, status: lesson.status } : null;
  return {
    index,
    total: lessons.length,
    prev: toSummary(lessons[index - 1]),
    next: toSummary(lessons[index + 1]),
  };
}

export function getLessonLabel(courseId: string, lessonId: string): string | null {
  const course = findCourse(courseId);
  return course ? lessonLabel(course, lessonId) : null;
}

// ——— URL และ transport ตาม API-SPECIFICATION §3.4 (ผูกตั้งแต่วันนี้ — endpoint จริงมา Phase 1) ——

export function lessonProgressUrl(lessonId: string): string {
  return `/api/v1/lessons/${encodeURIComponent(lessonId)}/progress`;
}

export function lessonQuizSubmitUrl(lessonId: string): string {
  return `/api/v1/lessons/${encodeURIComponent(lessonId)}/quiz/submit`;
}

/**
 * ตรวจ quiz บน fixture — รูป response เลียนแบบ 200 ของ POST /lessons/{id}/quiz/submit
 * (คะแนน + เฉลยทันที · สถานะผ่านใช้คะแนนสูงสุดตลอดช่วงตาม progress_pass_score_policy=highest)
 */
export function fixtureSubmitQuiz(quizId: string, body: QuizSubmitRequest): QuizSubmitResponse {
  const entry = QUIZ_BANK[quizId];
  if (!entry) {
    throw new Error("ไม่พบแบบทดสอบในระบบ");
  }
  const results = entry.questions.map((question) => {
    const answer = body.answers.find((item) => item.questionId === question.id);
    const picked = answer?.choiceIds ?? [];
    const isCorrect =
      picked.length === question.correctChoiceIds.length &&
      question.correctChoiceIds.every((choiceId) => picked.includes(choiceId));
    return {
      questionId: question.id,
      isCorrect,
      correctChoiceIds: question.correctChoiceIds,
      explanation: question.explanation,
    } satisfies QuizQuestionResult;
  });
  const correctCount = results.filter((result) => result.isCorrect).length;
  const scorePct = roundedPercent(correctCount, entry.questions.length);
  if (entry.bestScorePct === null || scorePct > entry.bestScorePct) {
    entry.bestScorePct = scorePct;
  }
  return { scorePct, passed: scorePct >= entry.passPct, passPct: entry.passPct, results };
}

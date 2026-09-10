/**
 * learning — data layer ฝั่งผู้เรียน (Phase 1 — เรียก BFF จริงผ่าน /api/v1)
 *
 * - ทุกฟังก์ชัน fetch จริง ผ่าน helper absolute-origin:
 *   · browser → window.location.origin (same-origin fetch — Origin/Sec-Fetch-Site ผ่าน middleware CSRF เอง)
 *   · server (RSC) → ต้องส่ง origin + cookieHeader ผ่าน FetchCallOptions (ดู learning.server.ts)
 * - เฉลยแบบทดสอบไม่อยู่ในไฟล์นี้เด็ดขาด (D28/DCR-5): โจทย์มาจาก GET /lessons/{id}/quiz
 *   (โจทย์+ตัวเลือกเท่านั้น) และผล+คะแนนกลับจาก server หลังส่งเท่านั้น (POST .../quiz/submit)
 * - id ทุกตัวเป็น uuid จริงจาก BFF — ข้อมูลที่มี schema กลางตรวจด้วย zod (src/lib/schemas/v1)
 * - ห้ามส่ง flag `completed` จาก client — สถานะ "จบบท" ตัดสินโดย server (D12-1/D12-12)
 * - ค่ากฎ (VIDEO_HEARTBEAT_SEC ฯลฯ) server อ่านจาก src/lib/config.ts แล้วส่งเป็น props
 */
import { z } from "zod";

import { CourseProgressView, LessonProgressView, QuizSubmitView } from "@/lib/schemas/v1/progress";
import { EnrollmentResource } from "@/lib/schemas/v1/enrollment";

// ——— ชนิดข้อมูลมุมมองผู้เรียน (client view model) ———

export type LessonType = "video" | "document" | "quiz";

/** สถานะความคืบหน้ารายบทเรียน — server เป็นผู้ตัดสิน (lesson_progress.status) */
export type LessonStatus = "not_started" | "in_progress" | "completed";

export interface LessonSummary {
  id: string;
  title: string;
  type: LessonType;
  status: LessonStatus;
}

/** บทเรียนในโครงสร้างหลักสูตรที่ผูกสถานะความคืบหน้าแล้ว (GET /courses/{id} + progress) */
export interface OutlineLesson extends LessonSummary {
  watchPct: number;
}

export interface CourseModule {
  id: string;
  title: string;
  lessons: OutlineLesson[];
}

/** การ์ด "หลักสูตรของฉัน" — ความคืบหน้ารวม + บทที่ค้าง (LRN-002/009) */
export interface ContinueLessonInfo {
  id: string;
  title: string;
  type: LessonType;
  status: LessonStatus;
  label: string;
  watchPct: number;
}

export interface EnrolledCourseCard {
  id: string;
  title: string;
  category: string;
  /** สถานะการลงทะเบียนจาก GET /me/enrollments */
  enrollmentStatus: z.infer<typeof EnrollmentResource>["status"];
  lessonCount: number;
  completedCount: number;
  progressPercent: number;
  continueLesson: ContinueLessonInfo | null;
  /** false = โหลดโครงสร้าง/ความคืบหน้าของหลักสูตรนี้ไม่สำเร็จบางส่วน (UI แสดงหมายเหตุ) */
  isLoaded: boolean;
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

/** โครงสร้างหลักสูตรจาก GET /courses/{id} (modules/lessons — ยังไม่ผูกสถานะ) */
export interface CourseDetailSummary {
  id: string;
  title: string;
  category: string;
  modules: {
    id: string;
    title: string;
    lessons: {
      id: string;
      title: string;
      type: LessonType;
      durationSeconds: number | null;
    }[];
  }[];
  lessonCount: number;
}

/** ผลลัพธ์ GET /courses/{id}/progress — validate ด้วย zod (src/lib/schemas/v1/progress) */
export type CourseProgress = z.infer<typeof CourseProgressView>;

/** การลงทะเบียนจาก GET /me/enrollments — validate ด้วย zod (src/lib/schemas/v1/enrollment) */
export type EnrollmentSummary = z.infer<typeof EnrollmentResource>;

// ——— แบบทดสอบย่อย — โจทย์เท่านั้น ไม่มีเฉลยในชนิดข้อมูลใด ๆ (D28/DCR-5) ———

export interface QuizChoiceView {
  id: string;
  label: string;
}

export interface QuizQuestionView {
  id: string;
  prompt: string;
  choices: readonly QuizChoiceView[];
}

/** ข้อมูลแบบทดสอบสำหรับทำ (GET /lessons/{id}/quiz — DCR-5): โจทย์+ตัวเลือก+กติกา ไม่มีเฉลย */
export interface LessonQuizView {
  lessonId: string;
  passPct: number;
  /** จำนวนครั้งสูงสุดที่ทำได้ (lesson_quizzes.max_attempts) — null = ไม่ระบุ */
  maxAttempts: number | null;
  questions: readonly QuizQuestionView[];
}

/** ผลหลังส่ง (POST /lessons/{id}/quiz/submit — คะแนน+ผ่าน/ไม่ผ่าน ตาม contract QuizSubmitView) */
export type QuizSubmitResult = z.infer<typeof QuizSubmitView>;

/** body ของ POST /lessons/{id}/progress — XOR ตาม §4 #5 (D12-12) · ห้ามส่ง `completed` */
export type LessonProgressPayload =
  | { readonly positionSeconds: number }
  | { readonly documentRead: true };

/** body ของ POST /lessons/{id}/quiz/submit — คำตอบเท่านั้น (§4 #6) ไม่มีเฉลย/คะแนนจาก client */
export type QuizSubmitRequest = {
  readonly answers: readonly {
    readonly questionId: string;
    readonly choiceIds: readonly string[];
  }[];
};

// ——— URL builders (BFF-relative path เท่านั้น — API-SPECIFICATION §3) ———

export function courseDetailUrl(courseId: string): string {
  return `/api/v1/courses/${encodeURIComponent(courseId)}`;
}

export function courseProgressUrl(courseId: string): string {
  return `/api/v1/courses/${encodeURIComponent(courseId)}/progress`;
}

/** list endpoint ตอบเป็นหน้า — ใช้ limit สูงสุดตาม PageQuery (§1.2 — max 100) */
export function meEnrollmentsUrl(): string {
  return "/api/v1/me/enrollments?limit=100";
}

export function lessonQuizUrl(lessonId: string): string {
  return `/api/v1/lessons/${encodeURIComponent(lessonId)}/quiz`;
}

export function lessonProgressUrl(lessonId: string): string {
  return `/api/v1/lessons/${encodeURIComponent(lessonId)}/progress`;
}

export function lessonQuizSubmitUrl(lessonId: string): string {
  return `/api/v1/lessons/${encodeURIComponent(lessonId)}/quiz/submit`;
}

export function authLogoutUrl(): string {
  return "/api/v1/auth/logout";
}

/** POST /courses/{id}/enroll — ลงทะเบียนเรียน (§3.3) */
export function enrollCourseUrl(courseId: string): string {
  return `/api/v1/courses/${encodeURIComponent(courseId)}/enroll`;
}

// ——— transport กลาง — absolute-origin helper + error envelope (§1.3) ———

/**
 * ตัวเลือกของการเรียก API — browser ไม่ต้องส่ง (same-origin เอง);
 * server/RSC ต้องส่ง origin + cookieHeader (forward session cookie ให้ BFF เพราะ
 * fetch จาก RSC ไม่แนบ cookie ของ request ให้เอง)
 */
export interface FetchCallOptions {
  /** origin สัมบูรณ์ เช่น https://learn.lawcouncil.go.th — บังคับเมื่อเรียกจากฝั่ง server */
  origin?: string;
  /** ค่า header Cookie ที่ forward จาก request ปัจจุบัน (server เท่านั้น) */
  cookieHeader?: string;
}

/** error ฝั่ง client — code อ้างทะเบียน src/lib/errors (§1.3) · ข้อความไทยจาก envelope ของ BFF */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const TRANSPORT_FALLBACK_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ข้อมูลขาออกของ BFF ผิดรูปตามสัญญา — ตอบเหมือน internal error แบบ opaque (SDS §6.1) */
function contractViolation(): ApiError {
  return new ApiError("ERR-SYS-001", 500, "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw contractViolation();
  }
  return value;
}

function lessonTypeOf(value: unknown): LessonType {
  if (value === "video" || value === "document" || value === "quiz") {
    return value;
  }
  throw contractViolation();
}

function resolveOrigin(options?: FetchCallOptions): string {
  if (options?.origin !== undefined && options.origin.length > 0) {
    return options.origin;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  throw new Error("ต้องระบุ origin ใน FetchCallOptions เมื่อเรียก API จากฝั่ง server (RSC)");
}

/**
 * เรียก BFF แบบ JSON — คืน { status, body } ดิบ · ผิดพลาด (non-2xx / parse ไม่ได้ / network) → ApiError
 * (204 = สำเร็จไม่มี body → body เป็น null — ใช้กับ POST /auth/logout)
 */
async function requestJson(
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: unknown; readonly keepalive?: boolean },
  options?: FetchCallOptions,
): Promise<{ status: number; body: unknown }> {
  const origin = resolveOrigin(options);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.method === "POST") {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
  // gate-cleanup r1 M1: ขาเรียกจาก server (RSC ผ่าน learning.server.ts) ประกาศตัวเป็นขาใน —
  // middleware เห็น header นี้แล้วจะไม่หมุน token (Set-Cookie ของขาในไม่มีทางถึง browser —
  // RSC ตั้ง cookie เองไม่ได้ หมุนตรงนั้น = ทิ้ง rotation กลางอากาศ) · เฉพาะฝั่ง server
  // (typeof window) — โมดูลนี้ client ใช้ร่วมด้วย (logout keepalive) และขาบราวเซอร์คือขานอก
  if (typeof window === "undefined") {
    headers["x-ltc-bff-internal"] = "1";
  }
  const requestInit: RequestInit = {
    method: init.method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  };
  if (init.method === "POST" && init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
  }
  if (init.keepalive === true) {
    requestInit.keepalive = true;
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), requestInit);
  } catch {
    throw new ApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  if (response.status === 204) {
    return { status: 204, body: null };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const envelope = isRecord(body) && isRecord(body["error"]) ? body["error"] : null;
    const code =
      envelope !== null && typeof envelope["code"] === "string" && envelope["code"].length > 0
        ? envelope["code"]
        : `HTTP_${response.status}`;
    const message =
      envelope !== null &&
      typeof envelope["message"] === "string" &&
      envelope["message"].length > 0
        ? envelope["message"]
        : TRANSPORT_FALLBACK_MESSAGE;
    throw new ApiError(code, response.status, message);
  }
  return { status: response.status, body };
}

/** validate ข้อมูลขาออกของ BFF ด้วย schema กลาง — ไม่ผ่าน = contract ผิดรูป → ERR-SYS-001 */
function parseContract<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw contractViolation();
  }
  return parsed.data;
}

/**
 * คลาก envelope ของ single-resource 200 — BFF ตอบ `{data}` เสมอ (API-SPEC §1.1 ·
 * jsonOk) ต่างจาก list `{data, page}` (§1.2 อ่านเองใน getMyEnrollments) —
 * 200 ที่ไม่มี data = contract ผิดรูป → ERR-SYS-001 (gate r7 MAJOR-3)
 */
function unwrapData(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw contractViolation();
  }
  return body["data"];
}

// ——— data layer ผู้เรียน ———

/** GET /me/enrollments — รายการหลักสูตรที่ลงทะเบียน (§3.3) */
export async function getMyEnrollments(
  options?: FetchCallOptions,
): Promise<{ enrollments: readonly EnrollmentSummary[]; hasMore: boolean }> {
  const { body } = await requestJson(meEnrollmentsUrl(), { method: "GET" }, options);
  if (!isRecord(body) || !Array.isArray(body["data"])) {
    throw contractViolation();
  }
  const enrollments = parseContract(z.array(EnrollmentResource), body["data"]);
  const page = isRecord(body["page"]) ? body["page"] : null;
  const hasMore = page !== null && typeof page["hasMore"] === "boolean" ? page["hasMore"] : false;
  return { enrollments, hasMore };
}

/** GET /courses/{id} — โครงสร้างหลักสูตร (§3.3 — ชื่อ/หมวด/modules/lessons) */
export async function getCourseDetail(
  courseId: string,
  options?: FetchCallOptions,
): Promise<CourseDetailSummary> {
  const { body } = await requestJson(courseDetailUrl(courseId), { method: "GET" }, options);
  return mapCourseDetail(unwrapData(body));
}

function mapCourseDetail(body: unknown): CourseDetailSummary {
  if (!isRecord(body)) {
    throw contractViolation();
  }
  const rawModules = body["modules"];
  if (!Array.isArray(rawModules)) {
    throw contractViolation();
  }
  const rawCategory = body["category"];
  return {
    id: requiredString(body, "id"),
    title: requiredString(body, "titleTh"),
    category: isRecord(rawCategory) ? requiredString(rawCategory, "nameTh") : "",
    modules: rawModules.map((rawModule) => {
      if (!isRecord(rawModule)) {
        throw contractViolation();
      }
      const rawLessons = rawModule["lessons"];
      if (!Array.isArray(rawLessons)) {
        throw contractViolation();
      }
      return {
        id: requiredString(rawModule, "id"),
        title: requiredString(rawModule, "titleTh"),
        lessons: rawLessons.map((rawLesson) => {
          if (!isRecord(rawLesson)) {
            throw contractViolation();
          }
          const duration = rawLesson["durationSec"];
          return {
            id: requiredString(rawLesson, "id"),
            title: requiredString(rawLesson, "titleTh"),
            type: lessonTypeOf(rawLesson["type"]),
            durationSeconds: typeof duration === "number" ? duration : null,
          };
        }),
      };
    }),
    lessonCount: rawModules.reduce((sum, rawModule) => {
      const lessons =
        isRecord(rawModule) && Array.isArray(rawModule["lessons"]) ? rawModule["lessons"] : [];
      return sum + lessons.length;
    }, 0),
  };
}

/** GET /courses/{id}/progress — ความคืบหน้าของตัวเองในหลักสูตร (§3.4 — ต่อโมดูล/บทเรียน) */
export async function getCourseProgress(
  courseId: string,
  options?: FetchCallOptions,
): Promise<CourseProgress> {
  const { body } = await requestJson(courseProgressUrl(courseId), { method: "GET" }, options);
  return parseContract(CourseProgressView, unwrapData(body));
}

/**
 * GET /lessons/{id}/quiz — โจทย์+ตัวเลือก+กติกา ไม่มีเฉลย (§3.4 · DCR-5)
 *
 * ชื่อ field ฝั่ง producer (QuizView ของ route): questions[].`text`/`options`[].`text`
 * — view model ผู้เรียนใช้ `prompt`/`choices`/`label` จึงแปลงตรงนี้ (gate r7 MAJOR-4;
 * คู่ producer–consumer ยึดไว้ด้วย contract test ใน learning.test.ts)
 */
export async function getLessonQuiz(
  lessonId: string,
  options?: FetchCallOptions,
): Promise<LessonQuizView> {
  const { body } = await requestJson(lessonQuizUrl(lessonId), { method: "GET" }, options);
  const quiz = unwrapData(body);
  if (!isRecord(quiz)) {
    throw contractViolation();
  }
  const rawQuestions = quiz["questions"];
  if (!Array.isArray(rawQuestions)) {
    throw contractViolation();
  }
  const passPct = quiz["passPct"];
  if (typeof passPct !== "number") {
    throw contractViolation();
  }
  const maxAttempts = quiz["maxAttempts"];
  return {
    lessonId,
    passPct,
    maxAttempts: typeof maxAttempts === "number" ? maxAttempts : null,
    questions: rawQuestions.map((rawQuestion) => {
      if (!isRecord(rawQuestion)) {
        throw contractViolation();
      }
      const rawOptions = rawQuestion["options"];
      if (!Array.isArray(rawOptions)) {
        throw contractViolation();
      }
      return {
        id: requiredString(rawQuestion, "id"),
        prompt: requiredString(rawQuestion, "text"),
        choices: rawOptions.map((rawOption) => {
          if (!isRecord(rawOption)) {
            throw contractViolation();
          }
          return {
            id: requiredString(rawOption, "id"),
            label: requiredString(rawOption, "text"),
          };
        }),
      };
    }),
  };
}

/** POST /lessons/{id}/quiz/submit — ส่งคำตอบ ได้คะแนน+ผ่าน/ไม่ผ่านกลับทันที (§3.4) */
export async function submitLessonQuiz(
  lessonId: string,
  body: QuizSubmitRequest,
  options?: FetchCallOptions,
): Promise<QuizSubmitResult> {
  const { body: payload } = await requestJson(
    lessonQuizSubmitUrl(lessonId),
    { method: "POST", body: { answers: body.answers } },
    options,
  );
  return parseContract(QuizSubmitView, unwrapData(payload));
}

/** POST /lessons/{id}/progress — heartbeat วิดีโอ (positionSeconds) XOR อ่านจบเอกสาร (documentRead) */
export async function saveLessonProgress(
  lessonId: string,
  payload: LessonProgressPayload,
  options?: FetchCallOptions,
): Promise<z.infer<typeof LessonProgressView>> {
  const { body } = await requestJson(
    lessonProgressUrl(lessonId),
    { method: "POST", body: payload, keepalive: true },
    options,
  );
  return parseContract(LessonProgressView, unwrapData(body));
}

/** POST /auth/logout — ออกจากระบบ (204 = สำเร็จ; 401 = ไม่มี session — ผู้เรียกจัดการเอง) */
export async function logout(options?: FetchCallOptions): Promise<void> {
  await requestJson(authLogoutUrl(), { method: "POST" }, options);
}

/**
 * POST /courses/{id}/enroll — ลงทะเบียนเรียน (§3.3) — 201 (ลงทะเบียนใหม่) / 200 (ซ้ำ
 * idempotent คืน enrollment เดิม — DCR-3) · body ไม่มี (route อ่านเฉพาะ path param) ·
 * error เป็น envelope จาก BFF: 401 AUTH-001 · 404 CRS-001 · 422 ENR-002 · 409 ENR-001
 */
export async function enrollCourse(
  courseId: string,
  options?: FetchCallOptions,
): Promise<EnrollmentSummary> {
  const { body } = await requestJson(enrollCourseUrl(courseId), { method: "POST" }, options);
  return parseContract(EnrollmentResource, unwrapData(body));
}

// ——— ผู้ช่วยประกอบข้อมูล (pure — ใช้ทั้ง server pages และ test) ———

/** ปัดเปอร์เซ็นต์ 0-100 — สูตรเดียวกับ v_enrollment_progress (0009_views.sql) */
function roundedPercent(part: number, total: number): number {
  return total <= 0 ? 0 : Math.round((100 * part) / total);
}

/** ผูกโครงสร้างหลักสูตร (GET /courses/{id}) เข้ากับสถานะความคืบหน้า (GET /courses/{id}/progress) */
export function buildCourseOutline(
  detail: CourseDetailSummary,
  progress: CourseProgress,
): CourseOutline {
  const stateByLesson = new Map<string, { status: LessonStatus; watchPct: number }>();
  for (const moduleRow of progress.modules) {
    for (const lesson of moduleRow.lessons) {
      stateByLesson.set(lesson.lessonId, { status: lesson.status, watchPct: lesson.watchPct });
    }
  }
  const modules: CourseModule[] = detail.modules.map((module) => ({
    id: module.id,
    title: module.title,
    lessons: module.lessons.map((lesson) => {
      const state = stateByLesson.get(lesson.id);
      return {
        id: lesson.id,
        title: lesson.title,
        type: lesson.type,
        status: state?.status ?? "not_started",
        watchPct: state?.watchPct ?? 0,
      };
    }),
  }));
  const lessons = modules.flatMap((module) => module.lessons);
  const completed = lessons.filter((lesson) => lesson.status === "completed").length;
  return {
    id: detail.id,
    title: detail.title,
    category: detail.category,
    modules,
    lessonCount: lessons.length,
    completedCount: completed,
    progressPercent: roundedPercent(completed, lessons.length),
  };
}

/** ป้าย "บทเรียน {โมดูล}.{ลำดับ}" ของบทเรียนใน outline — ไม่พบ = null */
export function lessonLabelInOutline(outline: CourseOutline, lessonId: string): string | null {
  for (const [moduleIndex, module] of outline.modules.entries()) {
    const lessonIndex = module.lessons.findIndex((lesson) => lesson.id === lessonId);
    if (lessonIndex >= 0) {
      return `บทเรียน ${moduleIndex + 1}.${lessonIndex + 1}`;
    }
  }
  return null;
}

export interface ContinuePicked {
  lesson: OutlineLesson;
  label: string;
}

/** บทที่ค้าง = บทล่าสุดที่กำลังเรียน ถ้าไม่มีใช้บทแรกที่ยังไม่เริ่ม ถ้าเรียนครบแล้วเป็น null (LRN-009) */
export function pickContinueLesson(outline: CourseOutline): ContinuePicked | null {
  const flat = outline.modules.flatMap((module, moduleIndex) =>
    module.lessons.map((lesson, lessonIndex) => ({
      lesson,
      label: `บทเรียน ${moduleIndex + 1}.${lessonIndex + 1}`,
    })),
  );
  const inProgress = flat.find((item) => item.lesson.status === "in_progress");
  if (inProgress !== undefined) {
    return inProgress;
  }
  return flat.find((item) => item.lesson.status === "not_started") ?? null;
}

/** บทเรียนปัจจุบัน — ระบุ id แล้วพบใน outline = บทนั้น; ไม่ระบุ/ไม่พบ = บทที่ค้าง (LRN-009) */
export function resolveCurrentLesson(
  outline: CourseOutline,
  lessonIdParam: string | undefined,
): ContinuePicked | null {
  if (lessonIdParam !== undefined && lessonIdParam.length > 0) {
    for (const [moduleIndex, module] of outline.modules.entries()) {
      const lessonIndex = module.lessons.findIndex((lesson) => lesson.id === lessonIdParam);
      if (lessonIndex >= 0) {
        const lesson = module.lessons[lessonIndex];
        if (lesson !== undefined) {
          return { lesson, label: `บทเรียน ${moduleIndex + 1}.${lessonIndex + 1}` };
        }
      }
    }
  }
  return pickContinueLesson(outline);
}

export interface NeighborLessons {
  index: number;
  total: number;
  prev: LessonSummary | null;
  next: LessonSummary | null;
}

/** บทเรียนก่อน/ถัดไปของบทปัจจุบัน (นับจาก outline เรียงตามโมดูล/ลำดับ) */
export function findLessonNeighbors(outline: CourseOutline, lessonId: string): NeighborLessons | null {
  const flat = outline.modules.flatMap((module) => module.lessons);
  const index = flat.findIndex((lesson) => lesson.id === lessonId);
  if (index < 0) {
    return null;
  }
  return {
    index,
    total: flat.length,
    prev: flat[index - 1] ?? null,
    next: flat[index + 1] ?? null,
  };
}

/** การ์ด "หลักสูตรของฉัน" — จาก enrollment + (detail/progress ที่โหลดได้บางส่วนก็ยังแสดงได้) */
export function buildEnrolledCourseCard(
  enrollment: EnrollmentSummary,
  detail: CourseDetailSummary | null,
  progress: CourseProgress | null,
): EnrolledCourseCard {
  const outline =
    detail !== null && progress !== null ? buildCourseOutline(detail, progress) : null;
  const picked = outline !== null ? pickContinueLesson(outline) : null;
  return {
    id: enrollment.courseId,
    title: detail?.title ?? "หลักสูตรที่ลงทะเบียน",
    category: detail?.category ?? "",
    enrollmentStatus: enrollment.status,
    lessonCount: progress?.lessonTotal ?? detail?.lessonCount ?? 0,
    completedCount: progress?.lessonCompleted ?? 0,
    progressPercent: progress?.progressPct ?? 0,
    continueLesson:
      picked === null
        ? null
        : {
            id: picked.lesson.id,
            title: picked.lesson.title,
            type: picked.lesson.type,
            status: picked.lesson.status,
            label: picked.label,
            watchPct: picked.lesson.watchPct,
          },
    isLoaded: detail !== null && progress !== null,
  };
}

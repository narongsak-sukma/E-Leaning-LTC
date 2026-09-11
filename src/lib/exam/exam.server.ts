/**
 * exam.server - loaders ฝั่ง Server Component (RSC) ของเส้นการสอบ (แบบเดียวกับ
 * learning.server - server-only fetch + forward cookie ให้ BFF เสมอ แล้วส่งเป็น props)
 *
 * - ประสานข้อมูลผ่าน transport ของ exam-api (client-safe) โดยแนบ origin จาก config
 *   (PUBLIC_BASE_URL) และ cookie ของ request ปัจจุบันให้ BFF (fetch จาก RSC ไม่แนบเอง)
 * - validate ขาเข้าด้วย zod schemas กลางของเส้นการสอบ (schemas/v1/exam) - ผิดสัญญา =
 *   fail-closed เป็นสถานะ unavailable ข่งหน้า (แสดงแผงไทย ไม่พังหน้า)
 * - server-only: ห้าม import เข้า Client Component (ป้องกัน config/cookie เข้า browser
 *   bundle) - แผนที่ error ของ BFF เป็นสถานะหน้าเว็บ: ไม่ login = unauthenticated,
 *   ไม่พบ = not_found, อื่น ๆ = unavailable
 */
import "server-only";

import { cookies } from "next/headers";
import { z } from "zod";

import { getConfig } from "@/lib/config";
import {
  AssessmentDetailView,
  AttemptResultView,
  MyAttemptView,
  type AssessmentDetailViewParsed,
  type AttemptResultViewParsed,
  type MyAttemptViewParsed,
} from "@/lib/schemas/v1/exam";

import {
  assessmentDetailUrl,
  attemptResultUrl,
  examRequest,
  ExamApiError,
  myAttemptsUrl,
  type ExamCallOptions,
} from "./exam-api";

/** สถานะผิดพลาดของหน้า - UI แสดงข้อความไทยต่างกันตามชนิด (DESIGN-SYSTEM 5.12) */
export type ExamPageError =
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

/** ข้อมูลหน้ากติกาก่อนสอบ - พร้อมแสดง / ผิดพลาดตามชนิด */
export type ExamRulesPageData =
  | { kind: "ready"; detail: AssessmentDetailViewParsed }
  | ExamPageError;

/** ข้อมูลหน้าประวัติการสอบ - หน้าละ 100 (ขีดบนของ PageQuery) เรียงใหม่ล่าสุดก่อน */
export type MyAttemptsPageData =
  | {
      kind: "ready";
      attempts: readonly MyAttemptViewParsed[]; hasMore: boolean; nextCursor: string | null;
    }
  | ExamPageError;

/** ข้อมูลหน้าผลสอบของ attempt เดียว - แสดงตามที่ BFF ตอบเท่านั้น (ธง lead ข้อ 4) */
export type AttemptResultPageData =
  | { kind: "ready"; result: AttemptResultViewParsed }
  | ExamPageError;

/** แผนที่ error ของ BFF เป็นสถานะหน้า (เทียบแบบเดียวกับ learning.server toPageError) */
function toPageError(error: unknown): ExamPageError {
  if (error instanceof ExamApiError) {
    if (error.status === 401) {
      return { kind: "unauthenticated" };
    }
    if (error.code === "ERR-NF-001" || error.status === 404) {
      return { kind: "not_found" };
    }
  }
  return { kind: "unavailable" };
}

/** บริบทการเรียก BFF จาก RSC - origin จาก config + forward cookie ของ request ปัจจุบัน */
async function serverContext(): Promise<ExamCallOptions> {
  const cookieStore = await cookies();
  const config = getConfig();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return cookieHeader.length > 0
    ? { origin: config.publicBaseUrl, cookieHeader }
    : { origin: config.publicBaseUrl };
}

// ─── loaders ที่หน้าเว็บเรียก ───

/**
 * จัดรูปวันเวลาแบบไทย (ปฏิทินพุทธศักราช, เขตเวลา Asia/Bangkok) สำหรับหน้าประวัติ/ผลสอบ -
 * ISO ผิดรูป = null (ไม่เดา) · จัดบน server จึงไม่เสี่ยง hydration mismatch
 */
export function formatThaiDateTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("th-TH", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Asia/Bangkok",
    }).format(date);
  } catch {
    return null;
  }
}

/** ผลลัพธ์ zod แบบไม่ throw - ไม่ผ่าน = fail-closed */
type ViewResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function parseView<T extends z.ZodType>(schema: T, value: unknown): ViewResult<z.output<T>> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false };
}

/** unwrap 1.1 - ไม่มี data = fail-closed */
function unwrapData(body: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.hasOwn(body, "data") === false) {
    return { ok: false };
  }
  return { ok: true, value: (body as Record<string, unknown>)["data"] };
}

/** GET /assessments/{id} - ข้อมูลการสอบ + กติกา effective ล่าสุด (หน้ากติกาก่อนสอบ) */
export async function loadAssessmentDetail(
  assessmentId: string,
): Promise<ExamRulesPageData> {
  let data: unknown;
  try {
    data = await examRequest(assessmentDetailUrl(assessmentId), { method: "GET" }, await serverContext());
  } catch (error: unknown) {
    return toPageError(error);
  }
  const unwrapped = unwrapData(data);
  if (unwrapped.ok === false) {
    return { kind: "unavailable" };
  }
  const parsed = parseView(AssessmentDetailView, unwrapped.value);
  return parsed.ok
    ? { kind: "ready", detail: parsed.value }
    : { kind: "unavailable" };
}

/** ผลลัพธ์หน้าประวัติ - attempts เรียง (started_at, id) มากน้อยตาม BFF ตอบ */
export interface MyAttemptsPage {
  readonly attempts: readonly MyAttemptViewParsed[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** GET /me/attempts - ประวัติการสอบของตัวเอง (cursor ถัดไปถ้ามี) */
export async function loadMyAttemptsPage(cursor: string | undefined): Promise<MyAttemptsPageData> {
  let body: unknown;
  try {
    body = await examRequest(myAttemptsUrl(cursor), { method: "GET" }, await serverContext());
  } catch (error: unknown) {
    return toPageError(error);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "unavailable" };
  }
  const record = body as Record<string, unknown>;
  const rawRows = record["data"];
  if (Array.isArray(rawRows) === false) {
    return { kind: "unavailable" };
  }
  const attempts: MyAttemptViewParsed[] = [];
  for (const rawRow of rawRows) {
    const parsed = parseView(MyAttemptView, rawRow);
    if (parsed.ok === false) {
      return { kind: "unavailable" };
    }
    attempts.push(parsed.value);
  }
  const rawPage = record["page"];
  const hasMore = typeof rawPage === "object" && rawPage !== null
    && typeof (rawPage as Record<string, unknown>)["hasMore"] === "boolean"
    ? (rawPage as Record<string, unknown>)["hasMore"] as boolean
    : false;
  const rawNextCursor = typeof rawPage === "object" && rawPage !== null
    ? (rawPage as Record<string, unknown>)["nextCursor"]
    : undefined;
  const nextCursor = typeof rawNextCursor === "string" && rawNextCursor.length > 0
    ? rawNextCursor
    : null;
  return { kind: "ready", attempts, hasMore, nextCursor };
}

/** GET /attempts/{id}/result - ผลสอบ + เฉลยตามที่ view เปิด (ส่งตาม BFF ตอบเป๊ะ) */
export async function loadAttemptResult(attemptId: string): Promise<AttemptResultPageData> {
  let body: unknown;
  try {
    body = await examRequest(attemptResultUrl(attemptId), { method: "GET" }, await serverContext());
  } catch (error: unknown) {
    return toPageError(error);
  }
  const unwrapped = unwrapData(body);
  if (unwrapped.ok === false) {
    return { kind: "unavailable" };
  }
  const parsed = parseView(AttemptResultView, unwrapped.value);
  return parsed.ok
    ? { kind: "ready", result: parsed.value }
    : { kind: "unavailable" };
}

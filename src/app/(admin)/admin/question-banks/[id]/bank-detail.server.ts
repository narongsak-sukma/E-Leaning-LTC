/**
 * bank-detail.server — loader ฝั่ง RSC ของหน้าคลังข้อสอบรายคลัง (Wave G P2 · lane W2)
 *
 * - mirror plumbing ของ exam-admin.server.ts (bffGet) เป๊ะ: absolute origin จาก config
 *   (PUBLIC_BASE_URL — gate r2 SSRF: ห้ามสร้างปลายทางจาก header ที่ผู้ใช้ควบคุมได้) +
 *   forward cookie ของ request เดิม + x-ltc-internal header ตามแบบ — ทำเป็นไฟล์ local
 *   ของ lane W2 เพราะ bffGet เดิมไม่ export (คง ownership ของ W1 บน exam-admin.server.ts
 *   ไม่ชนกัน — lead รวมศูนย์ภายหลังได้)
 * - ผลลัพธ์ผิดรูปตามสัญญา → fail-closed (ไม่แสดงแถวที่ผิดรูป) · 401/403 → forbidden ·
 *   404 → not-found (bank ไม่มี/เข้าไม่ถึง — ต่างจากคลังว่าง 200 data:[])
 * - **ห้ามโหลดเฉลยราย RSC** — parser ของรายการข้ออ่านเฉพาะฟิลด์ที่ไม่ใช่เฉลย
 *   (QuestionResource ไม่มี isCorrect ตาม contract · edit GET มีเฉลยและโหลดจาก
 *   client modal เท่านั้น ตาม D74)
 */
import "server-only";

import { headers } from "next/headers";

import { getConfig } from "@/lib/config";

import {
  bankQuestionsListPathOf,
  isQuestionDifficulty,
  isQuestionStatus,
  isQuestionType,
  type BankQuestionOptionRow,
  type BankQuestionRow,
} from "./bank-detail.view";
import type { ExamAdminQuestionBank } from "@/lib/exam-admin.view";

/** ผลลัพธ์ loader — สามสถานะล้มเหลว: ไม่มีสิทธิ์ / ไม่พบ / ระบบขัดข้อง (fail-closed) */
export type BankDetailResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "server" | "forbidden" | "not-found" };

/** สถานะล้มเหลวอย่างเดียวของ loader — prop type ของแผงล้มเหลว (เรียกหลัง narrow ok:false แล้ว) */
export type BankDetailFailure = Extract<BankDetailResult<never>, { ok: false }>;

/** query ของ GET .../{id}/questions — cursor keyset (created_at,id) DESC */
export interface AdminBankQuestionsQuery {
  readonly cursor?: string | undefined;
}

/** หน้ารายการข้อ — { data, page } ตาม API-SPECIFICATION §1.2 */
export interface AdminBankQuestionsPage {
  readonly data: readonly BankQuestionRow[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

type BffOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; kind: "server" | "forbidden" };

/** ตรวจว่าค่าเป็น object (ไม่ใช่ array/null) — ใช้กับ body ของ BFF ทุกชั้น */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET ไปยัง BFF ของตัวเองแบบ absolute origin — mirror bffGet (exam-admin.server.ts:74):
 * origin จาก config เท่านั้น · forward cookie · x-ltc-bff-internal: 1 · cache no-store
 */
async function bffGet(
  path: string,
  query: Readonly<Record<string, string>> = {},
): Promise<BffOutcome> {
  const headerBag = await headers();
  const url = new URL(path, getConfig().publicBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { cookie: headerBag.get("cookie") ?? "", "x-ltc-bff-internal": "1" },
    });
  } catch {
    return { ok: false, kind: "server" };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, kind: "forbidden" };
  }
  if (response.status === 204 || response.status === 304) {
    return { ok: true, status: response.status, body: null };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok) {
      return { ok: false, kind: "server" };
    }
    body = null;
  }
  return { ok: true, status: response.status, body };
}

/* ─── contract parsing — ตรวจรูป body ก่อนใช้งาน (ผิดรูป = fail-closed kind "server") ─── */

/** อ่าน string ที่จำเป็น — ไม่ใช่ string หรือค่าว่าง → null (ผิด contract) */
function requiredStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** อ่าน string ที่อนุญาต null — ผิด type → undefined (ผิด contract) */
function nullableStringOf(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** อ่าน boolean ที่จำเป็น — ผิด type → null */
function requiredBooleanOf(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

/** อ่าน int ในช่วง — ผิด type/ช่วง → null */
function requiredIntOf(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

/** ISO timestamp ที่อ่านกลับมาเป็นวันจริงได้ — พัง → null */
function isoStringOf(value: string): string | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : value;
}

/* ─── resource parsers ─── */

/**
 * parseBank — mirror parseBank ของ exam-admin.server.ts เป๊ะ (QuestionBankResource):
 * id/code/name จำเป็น · description/courseId/categoryId อนุญาต null · isActive/questionCount/
 * createdAt จำเป็น — ผิดรูปส่วนใดส่วนหนึ่ง → null (fail-closed)
 */
function parseBank(raw: unknown): ExamAdminQuestionBank | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredStringOf(raw, "id");
  const code = requiredStringOf(raw, "code");
  const name = requiredStringOf(raw, "name");
  const description = nullableStringOf(raw, "description");
  const courseId = nullableStringOf(raw, "courseId");
  const categoryId = nullableStringOf(raw, "categoryId");
  const isActive = requiredBooleanOf(raw, "isActive");
  const questionCount = requiredIntOf(raw, "questionCount", 0, 1000000);
  const createdAtRaw = requiredStringOf(raw, "createdAt");
  const createdAt = createdAtRaw === null ? null : isoStringOf(createdAtRaw);
  if (
    id === null ||
    code === null ||
    name === null ||
    description === undefined ||
    courseId === undefined ||
    categoryId === undefined ||
    isActive === null ||
    questionCount === null ||
    createdAt === null
  ) {
    return null;
  }
  return {
    id,
    code,
    name,
    description,
    courseId,
    categoryId,
    isActive,
    questionCount,
    createdAt,
  };
}

/** ตัวเลือกในแถวรายการข้อ — id/optionText/sortOrder เท่านั้น (**ไม่อ่าน isCorrect เด็ดขาด**) */
function parseQuestionOptionRow(raw: unknown): BankQuestionOptionRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredStringOf(raw, "id");
  const optionText = typeof raw["optionText"] === "string" ? raw["optionText"] : null;
  const sortOrder = requiredIntOf(raw, "sortOrder", 0, 999);
  if (id === null || optionText === null || sortOrder === null) {
    return null;
  }
  return { id, optionText, sortOrder };
}

/** แถวข้อสอบรายการ — QuestionResource ของ BFF (ไม่มีเฉลย): ทุกฟิลด์ตรวจรูปก่อนแสดง */
function parseQuestionRow(raw: unknown): BankQuestionRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredStringOf(raw, "id");
  const bankId = requiredStringOf(raw, "bankId");
  const typeRaw = raw["type"];
  const difficultyRaw = raw["difficulty"];
  const questionText = typeof raw["questionText"] === "string" ? raw["questionText"] : null;
  const explanation = nullableStringOf(raw, "explanation");
  const points = requiredIntOf(raw, "points", 1, 100);
  const statusRaw = raw["status"];
  const version = requiredIntOf(raw, "version", 1, 2147483647);
  const createdAtRaw = requiredStringOf(raw, "createdAt");
  const createdAt = createdAtRaw === null ? null : isoStringOf(createdAtRaw);
  if (
    id === null ||
    bankId === null ||
    !isQuestionType(typeRaw) ||
    !isQuestionDifficulty(difficultyRaw) ||
    questionText === null ||
    explanation === undefined ||
    points === null ||
    !isQuestionStatus(statusRaw) ||
    version === null ||
    createdAt === null ||
    !Array.isArray(raw["tags"]) ||
    !Array.isArray(raw["options"])
  ) {
    return null;
  }
  const tags = raw["tags"].every((tag) => typeof tag === "string") ? (raw["tags"] as string[]) : null;
  if (tags === null) {
    return null;
  }
  const options: BankQuestionOptionRow[] = [];
  for (const optionRaw of raw["options"]) {
    const option = parseQuestionOptionRow(optionRaw);
    if (option === null) {
      return null;
    }
    options.push(option);
  }
  return {
    id,
    bankId,
    type: typeRaw,
    difficulty: difficultyRaw,
    questionText,
    explanation,
    points,
    status: statusRaw,
    tags,
    version,
    createdAt,
    options,
  };
}

/* ─── envelope §1.1/§1.2 parsing — ตรวจ { data } / { data, page } ก่อนใช้ ─── */

/** แตก { data: [...] } จาก envelope — ไม่มี data / ไม่ใช่ array → null */
function parseDataArray(body: unknown): readonly unknown[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const data = body["data"];
  return Array.isArray(data) ? data : null;
}

/** แตก { data: object } จาก envelope — ไม่ใช่ object → null */
function parseDataRecord(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) {
    return null;
  }
  const data = body["data"];
  return isRecord(data) ? data : null;
}

/** ตรวจ { nextCursor: string | null, hasMore: boolean } — ผิดรูป → null */
function parsePageEnvelope(body: unknown): { nextCursor: string | null; hasMore: boolean } | null {
  if (!isRecord(body)) {
    return null;
  }
  const page = body["page"];
  if (!isRecord(page)) {
    return null;
  }
  const nextCursor = page["nextCursor"];
  const hasMore = page["hasMore"];
  if (typeof hasMore !== "boolean") {
    return null;
  }
  if (nextCursor !== null && typeof nextCursor !== "string") {
    return null;
  }
  return { nextCursor, hasMore };
}

/** แตกสถานะล้มเหลวจากผล bffGet ที่ ok:false → kind ของหน้า (404 แยกเป็น not-found ที่ caller) */
function outcomeFailureKind(outcome: { ok: false; kind: "server" | "forbidden" }): "server" | "forbidden" {
  return outcome.kind;
}

/**
 * GET /api/v1/admin/question-banks/{id} — รายละเอียดคลัง (หัวคลัง + สถานะ is_active)
 * bank ไม่มี/เข้าไม่ถึง = 404 → kind "not-found" (ต่างจากคลังว่าง)
 */
export async function loadAdminQuestionBank(
  bankId: string,
): Promise<BankDetailResult<ExamAdminQuestionBank>> {
  const outcome = await bffGet(`/api/v1/admin/question-banks/${bankId}`);
  if (!outcome.ok) {
    return { ok: false, kind: outcomeFailureKind(outcome) };
  }
  if (outcome.status === 404) {
    return { ok: false, kind: "not-found" };
  }
  if (outcome.status !== 200) {
    return { ok: false, kind: "server" };
  }
  const raw = parseDataRecord(outcome.body);
  const bank = raw === null ? null : parseBank(raw);
  if (bank === null) {
    return { ok: false, kind: "server" };
  }
  return { ok: true, data: bank };
}

/**
 * GET /api/v1/admin/question-banks/{id}/questions?cursor= — รายการข้อของคลัง
 * (แถวผิดรูปแม้แต่แถวเดียว = ทั้งหน้า fail-closed kind "server" — ตามแบบ loadPageOf)
 */
export async function loadAdminBankQuestions(
  bankId: string,
  options: AdminBankQuestionsQuery = {},
): Promise<BankDetailResult<AdminBankQuestionsPage>> {
  const cursor = options.cursor;
  const outcome = await bffGet(
    bankQuestionsListPathOf(bankId),
    cursor !== undefined && cursor.length > 0 ? { cursor } : {},
  );
  if (!outcome.ok) {
    return { ok: false, kind: outcomeFailureKind(outcome) };
  }
  if (outcome.status === 404) {
    return { ok: false, kind: "not-found" };
  }
  if (outcome.status !== 200) {
    return { ok: false, kind: "server" };
  }
  const rows = parseDataArray(outcome.body);
  const page = parsePageEnvelope(outcome.body);
  if (rows === null || page === null) {
    return { ok: false, kind: "server" };
  }
  const data: BankQuestionRow[] = [];
  for (const row of rows) {
    const parsed = parseQuestionRow(row);
    if (parsed === null) {
      return { ok: false, kind: "server" };
    }
    data.push(parsed);
  }
  return { ok: true, data: { data, page } };
}

/**
 * admin — ชั้นข้อมูลหลังบ้าน (Phase 1 — เชื่อม BFF จริง)
 *
 * เดิมไฟล์นี้เป็น fixture ข้อมูลจำลองของ Phase 0 (โครงหน้าจอ UI admin ตาม DESIGN-SYSTEM
 * §5.5/§5.6/§5.8/§6.3) — Phase 1 (C-8) เปลี่ยน body เป็น fetch จริง:
 * - GET /api/v1/admin/courses?q&status&categoryId&cursor&limit → { data: AdminCourse[], page }
 * - GET /api/v1/admin/categories → { data: AdminCategory[] } (ทุกสถานะ + courseCount)
 * - GET /api/v1/me → { data: { …, displayName, roles, mfaVerified? } }
 *   (API-SPECIFICATION §3.8 / §3.2 — lane c5 เป็นเจ้าของฝั่ง BFF ทั้งหมด src/app/api/**)
 *
 * หลักการ:
 * - server-side fetch ด้วย absolute origin จาก headers()
 *   (x-forwarded-proto + x-forwarded-host/host) และส่งต่อ cookie ของ request เดิมทุกครั้ง
 *   (session อยู่ที่ httpOnly cookie — ไม่มี token ฝั่ง browser ตาม SDS §5.1)
 * - cache: "no-store" ทุก call — ข้อมูลหลังบ้านต้อง fresh (ไม่ cache ที่ data cache/CDN)
 * - ลายเซ็นคงรูปร่าง fixture เดิม — หน้า/คอมโพเนนต์จึงไม่ต้องรื้อโครง
 * - ข้อมูลจำลอง static ถูกถอดออกจาก production path ทั้งหมด (คงเหลือเฉพาะใน *.test.ts)
 * - ทุก fetch จัด error path เป็น 2 กลุ่ม: "forbidden" (401/403 — สิทธิ์หมดอายุ/ไม่มีสิทธิ์)
 *   และ "server" (เครือข่ายล่ม / 5xx / contract ผิดรูป — fail-closed ไม่เดาข้อมูลเอง)
 */
import "server-only";
import { headers } from "next/headers";
import { getConfig } from "@/lib/config";
import { ROLES, type Role } from "@/lib/rbac";

/** สถานะหลักสูตร — ตรง enum `course_status` (DATA-DICTIONARY §2 + migration 0001 + SRS CAT-005) */
export type CourseStatus = "draft" | "pending_review" | "published" | "archived";

/** กันค่า ?status=… จาก URL ที่ไม่อยู่ใน enum ก่อนส่งไปกรองฝั่ง BFF */
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
  /** จำนวนหลักสูตรที่อ้างหมวดนี้ตรง ๆ (BFF นับจากหลักสูตรทุกสถานะ) */
  courseCount: number;
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

/** ผลลัพธ์ที่หน้าต้องแสดงเป็น UI ไทยสุภาพ แทนการ crash */
export type AdminDataErrorKind = "server" | "forbidden";

export type AdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: AdminDataErrorKind };

/** เจ้าหน้าที่จาก session จริง (GET /api/v1/me) — แทน adminFixtureStaff เดิม */
export type AdminStaffSession = {
  name: string;
  /** เฉพาะบทบาทที่อยู่ในทะเบียน RBAC (src/lib/rbac.ts) — ค่าแปลกปลอมถูกกรองทิ้ง */
  roles: Role[];
  /** true/false ตาม BFF · null = BFF ไม่ส่ง field นี้มา (แสดงผลเป็นกลาง ไม่ตัดสินแทน) */
  mfaVerified: boolean | null;
};

export type AdminSessionResult =
  | { ok: true; staff: AdminStaffSession | null }
  | { ok: false };

/** บทบาทที่เข้าหลังบ้านได้ — ตรงคอลัมน์ "บทบาท" ของ GET /admin/* (API-SPECIFICATION §3.8) */
export const ADMIN_STAFF_ROLES: readonly Role[] = [
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
  "super_admin",
] as const;

/** pure — บทบาทนี้เข้ากลุ่มหลังบ้านได้หรือไม่ */
export function isAdminStaffRole(role: Role): boolean {
  return (ADMIN_STAFF_ROLES as readonly string[]).includes(role);
}

/** pure — ชุดบทบาทครอบบทบาทหลังบ้านอย่างน้อยหนึ่ง → true */
export function hasAdminStaffRole(roles: readonly string[]): boolean {
  return roles.some((role) => isAdminStaffRole(role as Role));
}

/** query ของ GET /admin/courses — ทุกช่องเลือกได้ (undefined = ไม่ส่งพารามิเตอร์) */
export type AdminCoursesQuery = {
  q?: string | undefined;
  status?: CourseStatus | undefined;
  categoryId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type AdminCoursesPage = {
  data: AdminCourse[];
  page: { nextCursor: string | null; hasMore: boolean };
};

/** ค่าเริ่มต้นของ ?limit=… — ตรง default ของ PageQuery (API-SPECIFICATION §4 #12) */
export const ADMIN_COURSES_PAGE_SIZE = 20;

/* ---------------------------------------------------------------- */
/* BFF plumbing — absolute origin + cookie forwarding + no-store    */
/* ---------------------------------------------------------------- */

/** ตรวจว่าค่าเป็น object (ไม่ใช่ array/null) — ใช้กับ body ของ BFF ทุกชั้น */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type BffOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; kind: AdminDataErrorKind };

/**
 * GET ไปยัง BFF ของตัวเองแบบ absolute origin (จำเป็นเมื่อ fetch จาก server component)
 * - origin จาก config เท่านั้น (PUBLIC_BASE_URL — gate r2: ห้ามสร้างปลายทางจาก header ที่
 *   ผู้ใช้ควบคุมได้ เช่น x-forwarded-host → SSRF + ส่ง cookie session ไปโฮสต์ปลิ้น)
 * - ส่งต่อ cookie ของ request เดิม — BFF อ่าน session จาก httpOnly cookie เสมอ
 * - cache: "no-store" — ข้อมูลหลังบ้านต้อง fresh
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
      headers: { cookie: headerBag.get("cookie") ?? "" },
    });
  } catch {
    return { ok: false, kind: "server" };
  }

  if (response.status === 204 || response.status === 304) {
    return { ok: true, status: response.status, body: null };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok) {
      // 2xx แต่ body ไม่ใช่ JSON = contract ผิดรูป → ความล้มเหลวฝั่งระบบ (fail-closed)
      return { ok: false, kind: "server" };
    }
    body = null; // error response ที่ไม่ใช่ JSON — ใช้ status เป็นตัวตัดสินพอ
  }
  return { ok: true, status: response.status, body };
}

/* ---------------------------------------------------------------- */
/* contract parsing — ตรวจรูป body ก่อนใช้งาน (ผิดรูป = fail-closed) */
/* ---------------------------------------------------------------- */

/** อ่าน string ที่จำเป็น — ไม่ใช่ string → null (ผิด contract) */
function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** อ่าน string ที่อนุญาต null — ผิด type → undefined (ผิด contract) */
function nullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** อ่านจำนวนเต็มไม่ติดลบที่จำเป็น — ผิด → null */
function requiredCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseCourse(raw: unknown): AdminCourse | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredString(raw, "id");
  const code = requiredString(raw, "code");
  const titleTh = requiredString(raw, "titleTh");
  const titleEn = nullableString(raw, "titleEn");
  const summary = nullableString(raw, "summary");
  const categoryId = requiredString(raw, "categoryId");
  const version = requiredCount(raw, "version");
  const language = requiredString(raw, "language");
  const publishedAt = nullableString(raw, "publishedAt");
  const updatedAt = requiredString(raw, "updatedAt");
  const status = raw["status"];
  const isPublic = raw["isPublic"];
  if (
    id === null ||
    code === null ||
    titleTh === null ||
    titleEn === undefined ||
    summary === undefined ||
    categoryId === null ||
    version === null ||
    language === null ||
    publishedAt === undefined ||
    updatedAt === null ||
    !isCourseStatus(status) ||
    typeof isPublic !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    code,
    titleTh,
    titleEn,
    summary,
    categoryId,
    status,
    version,
    language,
    isPublic,
    publishedAt,
    updatedAt,
  };
}

function parseCategory(raw: unknown): AdminCategory | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredString(raw, "id");
  const slug = requiredString(raw, "slug");
  const nameTh = requiredString(raw, "nameTh");
  const nameEn = nullableString(raw, "nameEn");
  const parentId = nullableString(raw, "parentId");
  const sortOrder = requiredCount(raw, "sortOrder");
  const courseCount = requiredCount(raw, "courseCount");
  const isActive = raw["isActive"];
  if (
    id === null ||
    slug === null ||
    nameTh === null ||
    nameEn === undefined ||
    parentId === undefined ||
    sortOrder === null ||
    courseCount === null ||
    typeof isActive !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    slug,
    nameTh,
    nameEn,
    parentId,
    sortOrder,
    isActive,
    courseCount,
  };
}

/** แตก { data: [...] } ออกจาก envelope §1.1 — ไม่มี data / ไม่ใช่ array → null */
function parseDataArray(body: unknown): readonly unknown[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const data = body["data"];
  return Array.isArray(data) ? data : null;
}

/* ---------------------------------------------------------------- */
/* data accessors — ลายเซ็นคงรูปร่าง fixture เดิม (async ทั้งหมด)     */
/* ---------------------------------------------------------------- */

/**
 * GET /api/v1/admin/courses — ทุกหลักสูตรทุกสถานะ (§3.8 — staff:viewer/content, super_admin)
 * query: q / status / categoryId / cursor / limit — ผลลัพธ์ผิดรูป → { ok: false }
 */
export async function getAdminCourses(
  query: AdminCoursesQuery = {},
): Promise<AdminResult<AdminCoursesPage>> {
  const parameters: Record<string, string> = {};
  if (query.q !== undefined && query.q.length > 0) {
    parameters["q"] = query.q;
  }
  if (query.status !== undefined) {
    parameters["status"] = query.status;
  }
  if (query.categoryId !== undefined && query.categoryId.length > 0) {
    parameters["categoryId"] = query.categoryId;
  }
  if (query.cursor !== undefined && query.cursor.length > 0) {
    parameters["cursor"] = query.cursor;
  }
  parameters["limit"] = String(query.limit ?? ADMIN_COURSES_PAGE_SIZE);

  const outcome = await bffGet("/api/v1/admin/courses", parameters);
  if (!outcome.ok) {
    return outcome;
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return { ok: false, kind: "forbidden" };
  }
  if (outcome.status !== 200) {
    return { ok: false, kind: "server" };
  }
  const items = parseDataArray(outcome.body);
  if (items === null) {
    return { ok: false, kind: "server" };
  }
  const data: AdminCourse[] = [];
  for (const item of items) {
    const course = parseCourse(item);
    if (course === null) {
      return { ok: false, kind: "server" };
    }
    data.push(course);
  }
  const rawPage = isRecord(outcome.body) ? outcome.body["page"] : undefined;
  const page = isRecord(rawPage) ? rawPage : undefined;
  const nextCursor = page === undefined ? undefined : nullableString(page, "nextCursor");
  const hasMore = page === undefined ? undefined : page["hasMore"];
  if (page === undefined || nextCursor === undefined || typeof hasMore !== "boolean") {
    return { ok: false, kind: "server" };
  }
  return { ok: true, data: { data, page: { nextCursor, hasMore } } };
}

/**
 * GET /api/v1/admin/categories — หมวดหลักสูตรทุกสถานะ (รวม isActive=false) + courseCount
 * (staff:content/viewer, super_admin — API-SPECIFICATION §3.8)
 */
export async function getAdminCategories(): Promise<AdminResult<AdminCategory[]>> {
  const outcome = await bffGet("/api/v1/admin/categories");
  if (!outcome.ok) {
    return outcome;
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return { ok: false, kind: "forbidden" };
  }
  if (outcome.status !== 200) {
    return { ok: false, kind: "server" };
  }
  const items = parseDataArray(outcome.body);
  if (items === null) {
    return { ok: false, kind: "server" };
  }
  const data: AdminCategory[] = [];
  for (const item of items) {
    const category = parseCategory(item);
    if (category === null) {
      return { ok: false, kind: "server" };
    }
    data.push(category);
  }
  return { ok: true, data };
}

/**
 * GET /api/v1/me — session จริงของเจ้าหน้าที่ (แทน adminFixtureStaff เดิม)
 * - 200 + บทบาทในทะเบียน RBAC → { ok: true, staff: { name, roles, mfaVerified } }
 * - 401/403 (ไม่มี session / ไม่ใช่เจ้าหน้าที่ / MFA ยังไม่ผ่าน) → { ok: true, staff: null }
 *   (layout ใช้ตัวตัดสินนี้ redirect ไป /login)
 * - BFF ล่ม / 5xx / contract ผิดรูป → { ok: false } (layout แสดงแผง "ระบบขัดข้อง" — fail-closed)
 */
export async function getAdminStaffSession(): Promise<AdminSessionResult> {
  const outcome = await bffGet("/api/v1/me");
  if (!outcome.ok) {
    return { ok: false };
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return { ok: true, staff: null };
  }
  if (outcome.status !== 200) {
    return { ok: false };
  }
  const payload = isRecord(outcome.body) ? outcome.body["data"] : undefined;
  if (!isRecord(payload)) {
    return { ok: false };
  }
  const name = (() => {
    const displayName = payload["displayName"];
    if (typeof displayName === "string" && displayName.length > 0) {
      return displayName;
    }
    const name = payload["name"];
    return typeof name === "string" && name.length > 0 ? name : null;
  })();
  const rolesRaw = payload["roles"];
  if (name === null || !Array.isArray(rolesRaw)) {
    return { ok: false };
  }
  const roles: Role[] = [];
  for (const role of rolesRaw) {
    if (typeof role === "string" && (ROLES as readonly string[]).includes(role)) {
      roles.push(role as Role);
    }
  }
  const mfaRaw = payload["mfaVerified"];
  const mfaVerified = typeof mfaRaw === "boolean" ? mfaRaw : null;
  return { ok: true, staff: { name, roles, mfaVerified } };
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

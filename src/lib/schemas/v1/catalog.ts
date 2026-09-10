/**
 * schemas/v1/catalog — zod schema ของ query/params แคตตาล็อก (API-SPECIFICATION §3.3)
 *
 * - GET /courses     → CatalogCoursesQuery = PageQuery (§4 #12 — default 20, max 100, strict)
 *                      + ฟิลเตอร์ `category` / `q` ของหน้า catalog (§3.3 "ค้นหา/กรองหลักสูตร")
 *                      — เลือกเฉพาะชุดที่ map ลงคอลัมน์จริงของ DATA-DICTIONARY §3.2
 *                        (course_categories.slug / courses.title_th·title_en·summary)
 * - GET /courses/{id} → CourseIdParams — id = UUID (§1.1 "ID: UUID v4 ทุกตาราง",
 *                      รูปแบบเดียวกับ EnrollParams §4 #4)
 * - parse ไม่ผ่านทุกกรณี → AppError ERR-VAL-001 (400) พร้อมรายชื่อ field (§2)
 *   ในรูปแบบเดียวกับ parsePageQuery (schemas/v1/common)
 */
import { z } from "zod";
import { AppError } from "../../errors";
import { PageQuery } from "./common";

/** query ของ GET /courses — limit/cursor มาจาก PageQuery (default 20, max 100 — §1.2) */
export const CatalogCoursesQuery = z
  .object({
    ...PageQuery.shape,
    /** กรองตาม slug ของหมวด (course_categories.slug — DD §3.2) */
    category: z.string().trim().min(1).max(100).optional(),
    /** ค้นหาอิสระใน title_th / title_en / summary (courses — DD §3.2) */
    q: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type CatalogCoursesQueryParsed = z.infer<typeof CatalogCoursesQuery>;

/** path param ของ GET /courses/{id} — id เป็น UUID (§1.1 / §4 #4) */
export const CourseIdParams = z.object({ id: z.uuid() }).strict();
export type CourseIdParamsParsed = z.infer<typeof CourseIdParams>;

/** รวม path ของ issue เป็นรายชื่อ field — รูปแบบเดียวกับ parsePageQuery (path ว่าง = "query") */
function valErrorFields(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0 ? path : "query";
      }),
    ),
  ];
}

/**
 * URLSearchParams → parsed CatalogCoursesQuery
 * - ค่าที่ผิด (limit ไม่ใช่เลข, key แปลกปลอมโดย .strict(), q ยาว > 120) → ERR-VAL-001 + fields
 * - ใช้ค่าสุดท้ายเมื่อ key ซ้ำ (พฤติกรรม Object.fromEntries — เดียวกับ parsePageQuery)
 */
export function parseCatalogCoursesQuery(searchParams: URLSearchParams): CatalogCoursesQueryParsed {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = CatalogCoursesQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: valErrorFields(parsed.error) } });
  }
  return parsed.data;
}

/**
 * path param {id} → uuid ที่ผ่านการตรวจ — ผิดรูปแบบ → ERR-VAL-001 ระบุ field "id"
 * (คืน string เดิม — uuid ที่ valid ใช้ได้ตรง ๆ กับคอลัมน์ courses.id)
 */
export function parseCourseIdParam(id: string): string {
  const parsed = CourseIdParams.safeParse({ id });
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["id"] } });
  }
  return parsed.data.id;
}

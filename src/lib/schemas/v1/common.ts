/**
 * schemas/v1/common — zod schema กลางของ query ทุก list endpoint
 *
 * PageQuery = API-SPECIFICATION §4 #12 ตรงตัวอักษร (default 20, max 100, strict)
 * parsePageQuery = helper แปลง URLSearchParams → PageQuery (ผิด → ERR-VAL-001)
 */
import { z } from "zod";
import { AppError } from "../../errors";

/** query กลางของทุก list endpoint (API-SPECIFICATION §4 #12) */
export const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export type PageQueryParsed = z.infer<typeof PageQuery>;

/**
 * แปลง URLSearchParams → parsed PageQuery
 * - ค่าที่ผิด (limit ไม่ใช่เลข, key แปลกปลอม, cursor > 512 ตัวอักษร) → ERR-VAL-001 พร้อมรายชื่อ field
 * - ใช้ค่าสุดท้ายเมื่อ key ซ้ำ (พฤติกรรม Object.fromEntries)
 */
export function parsePageQuery(searchParams: URLSearchParams): PageQueryParsed {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = PageQuery.safeParse(raw);
  if (!parsed.success) {
    // path ว่าง = ปัญหาระดับ query ทั้งชุด (เช่น key แปลกปลอมโดย .strict()) → รายงานเป็น "query"
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : "query";
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return parsed.data;
}

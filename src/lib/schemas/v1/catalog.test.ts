/**
 * catalog.test — unit test ของ src/lib/schemas/v1/catalog.ts (API-SPECIFICATION §3.3/§4 #12)
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../../errors";
import { CatalogCoursesQuery, CourseIdParams, parseCatalogCoursesQuery, parseCourseIdParam } from "./catalog";

describe("CatalogCoursesQuery (PageQuery + ฟิลเตอร์ catalog)", () => {
  it("default limit = 20 เมื่อไม่ส่ง limit/cursor (§1.2)", () => {
    expect(CatalogCoursesQuery.parse({})).toEqual({ limit: 20 });
  });

  it("ผ่าน coercion ของ limit + ฟิลเตอร์ category/q", () => {
    expect(
      CatalogCoursesQuery.parse({ limit: "50", category: " contract-law ", q: " กฎหมาย " }),
    ).toEqual({ limit: 50, category: "contract-law", q: "กฎหมาย" });
  });

  it("ขอบเขต limit: 0/101 ไม่ผ่าน, 1/100 ผ่าน (default 20, max 100 — §1.2)", () => {
    expect(CatalogCoursesQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(CatalogCoursesQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(CatalogCoursesQuery.safeParse({ limit: "1" }).success).toBe(true);
    expect(CatalogCoursesQuery.safeParse({ limit: "100" }).success).toBe(true);
  });

  it("key แปลกปลอมถูกปฏิเสธ (.strict() — เดียวกับ PageQuery §4 #12)", () => {
    expect(CatalogCoursesQuery.safeParse({ limit: "10", foo: "bar" }).success).toBe(false);
  });

  it("q ที่เป็นช่องว่างล้วน/ยาวเกิน 120 ไม่ผ่าน", () => {
    expect(CatalogCoursesQuery.safeParse({ q: "   " }).success).toBe(false);
    expect(CatalogCoursesQuery.safeParse({ q: "x".repeat(121) }).success).toBe(false);
  });

  it("category ยาวเกิน 100 ไม่ผ่าน", () => {
    expect(CatalogCoursesQuery.safeParse({ category: "x".repeat(101) }).success).toBe(false);
  });

  it("cursor > 512 ตัวอักษร ไม่ผ่าน (§1.2)", () => {
    expect(CatalogCoursesQuery.safeParse({ cursor: "x".repeat(513) }).success).toBe(false);
  });
});

describe("CourseIdParams (path param {id} — UUID ตาม §1.1)", () => {
  const UUID = "11111111-1111-4111-8111-111111111101";

  it("uuid ที่ถูกต้องผ่าน", () => {
    expect(CourseIdParams.safeParse({ id: UUID }).success).toBe(true);
  });

  it("ไม่ใช่ uuid → ไม่ผ่าน", () => {
    expect(CourseIdParams.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(CourseIdParams.safeParse({ id: "../etc/passwd" }).success).toBe(false);
  });
});

describe("parseCatalogCoursesQuery — URLSearchParams → parsed query", () => {
  it("แปลง ?limit=5&category=contract-law&q=สัญญา ได้ตรงตัว", () => {
    expect(
      parseCatalogCoursesQuery(new URLSearchParams("limit=5&category=contract-law&q=%E0%B8%AA%E0%B8%B1%E0%B8%8D%E0%B8%8D%E0%B8%B2")),
    ).toEqual({ limit: 5, category: "contract-law", q: "สัญญา" });
  });

  it("ไม่มี param → { limit: 20 } (default ตาม doc)", () => {
    expect(parseCatalogCoursesQuery(new URLSearchParams(""))).toEqual({ limit: 20 });
  });

  it("limit ไม่ใช่เลข → ERR-VAL-001 (400) พร้อม fields", () => {
    const err = (() => {
      try {
        parseCatalogCoursesQuery(new URLSearchParams("limit=abc"));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-VAL-001");
    expect((err as AppError).httpStatus).toBe(400);
    expect((err as AppError).details).toEqual({ fields: ["limit"] });
  });

  it("key แปลกปลอม → ERR-VAL-001 ระบุ field (เดียวกับ parsePageQuery)", () => {
    const err = (() => {
      try {
        parseCatalogCoursesQuery(new URLSearchParams("sort=desc"));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AppError).details).toEqual({ fields: ["query"] });
  });
});

describe("parseCourseIdParam", () => {
  const UUID = "11111111-1111-4111-8111-111111111101";

  it("uuid ถูกต้อง → คืนค่าเดิม", () => {
    expect(parseCourseIdParam(UUID)).toBe(UUID);
  });

  it("ไม่ใช่ uuid → ERR-VAL-001 (400) ระบุ field id", () => {
    const err = (() => {
      try {
        parseCourseIdParam("not-a-uuid");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-VAL-001");
    expect((err as AppError).httpStatus).toBe(400);
    expect((err as AppError).details).toEqual({ fields: ["id"] });
  });
});

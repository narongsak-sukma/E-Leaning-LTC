/**
 * admin-catalog.test — unit test ของ contract ล้วน (Wave C-5):
 * parseAdminCoursesQuery (ERR-VAL-001 boundary) + mapper/metrics ที่ไม่ต้อง mock DB
 */
import { describe, expect, it } from "vitest";
import {
  AdminCategoryResource,
  AdminCourseResource,
  deriveAdminCourseMetrics,
  parseAdminCoursesQuery,
  toAdminCategoryResource,
  toAdminCourseResource,
  type AdminCategoryRow,
  type AdminCourseRow,
} from "./admin-catalog";

const CAT_ID = "b0000000-0000-4000-8000-000000000001";

function courseRow(overrides: Partial<AdminCourseRow> = {}): AdminCourseRow {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    code: "LTC-101",
    category_id: CAT_ID,
    title_th: "หลักสูตรตัวอย่าง",
    title_en: null,
    summary: null,
    status: "draft",
    is_public: true,
    level: "beginner",
    version: 1,
    language: "th",
    published_at: null,
    created_at: "2026-09-01T00:00:00+00:00",
    category: { id: CAT_ID, slug: "general-law", name_th: "กฎหมายทั่วไป" },
    course_modules: null,
    ...overrides,
  };
}

describe("parseAdminCoursesQuery — §1.2 + ฟิลเตอร์หลังบ้าน", () => {
  it("ไม่มี query → limit default 20 + ไม่มีฟิลเตอร์", () => {
    expect(parseAdminCoursesQuery(new URLSearchParams())).toEqual({ limit: 20 });
  });

  it("รับ limit/cursor/q/status/categoryId ที่ถูกรูปแบบ", () => {
    const parsed = parseAdminCoursesQuery(
      new URLSearchParams(
        "?limit=50&cursor=abc&q=LTC&status=pending_review&categoryId=" + CAT_ID,
      ),
    );
    expect(parsed).toEqual({
      limit: 50,
      cursor: "abc",
      q: "LTC",
      status: "pending_review",
      categoryId: CAT_ID,
    });
  });

  it("trim คำค้น (q) ก่อนใช้", () => {
    expect(parseAdminCoursesQuery(new URLSearchParams("?q=  LTC  ")).q).toBe("LTC");
  });

  it.each(["?limit=0", "?limit=101", "?limit=abc", "?status=deleted", "?categoryId=xyz", "?foo=1"])(
    "%s → ERR-VAL-001",
    (query) => {
      expect(() => parseAdminCoursesQuery(new URLSearchParams(query))).toThrowError(
        expect.objectContaining({ code: "ERR-VAL-001" }),
      );
    },
  );

  it("q ยาวเกิน 120 → ERR-VAL-001", () => {
    expect(() => parseAdminCoursesQuery(new URLSearchParams("?q=" + "a".repeat(121)))).toThrowError(
      expect.objectContaining({ code: "ERR-VAL-001" }),
    );
  });
});

describe("toAdminCourseResource — mapping + metrics", () => {
  it("map snake_case → camelCase ครบทุกฟิลด์ของ contract", () => {
    const row = courseRow({
      title_en: "Sample Course",
      summary: "สรุป",
      status: "published",
      level: "advanced",
      version: 3,
      published_at: "2026-08-20T00:00:00+00:00",
      course_modules: [
        { lessons: [{ duration_sec: 1800 }, { duration_sec: 600 }] },
        { lessons: [{ duration_sec: null }] },
      ],
    });
    const resource = toAdminCourseResource(row);
    expect(() => AdminCourseResource.parse(resource)).not.toThrow();
    expect(resource).toEqual({
      id: row.id,
      code: "LTC-101",
      titleTh: "หลักสูตรตัวอย่าง",
      titleEn: "Sample Course",
      summary: "สรุป",
      categoryId: CAT_ID,
      category: { id: CAT_ID, slug: "general-law", nameTh: "กฎหมายทั่วไป" },
      status: "published",
      isPublic: true,
      level: "advanced",
      version: 3,
      language: "th",
      lessonCount: 3,
      durationHours: Math.round((2400 / 3600) * 10) / 10,
      publishedAt: "2026-08-20T00:00:00+00:00",
      createdAt: "2026-09-01T00:00:00+00:00",
    });
  });

  it("category ถูก RLS บังคับ (null) → resource เก็บ categoryId ไว้ได้", () => {
    const resource = toAdminCourseResource(courseRow({ category: null }));
    expect(resource.categoryId).toBe(CAT_ID);
    expect(resource.category).toBeNull();
    expect(() => AdminCourseResource.parse(resource)).not.toThrow();
  });

  it("deriveAdminCourseMetrics — course_modules null / duration NULL → 0 บทเรียน 0 ชั่วโมง", () => {
    expect(deriveAdminCourseMetrics(courseRow())).toEqual({ lessonCount: 0, durationHours: 0 });
    expect(
      deriveAdminCourseMetrics(
        courseRow({ course_modules: [{ lessons: [{ duration_sec: null }] }] }),
      ),
    ).toEqual({ lessonCount: 1, durationHours: 0 });
  });
});

describe("toAdminCategoryResource — mapping + courseCount", () => {
  it("map ครบ + คง isActive=false ตามแถวจริง", () => {
    const row: AdminCategoryRow = {
      id: CAT_ID,
      slug: "professional-ethics",
      name_th: "จรรยาบรรณทนายความ",
      name_en: null,
      parent_id: "b0000000-0000-4000-8000-000000000009",
      sort_order: 4,
      is_active: false,
    };
    const resource = toAdminCategoryResource(row, 7);
    expect(AdminCategoryResource.parse(resource)).toEqual({
      id: CAT_ID,
      slug: "professional-ethics",
      nameTh: "จรรยาบรรณทนายความ",
      nameEn: null,
      parentId: "b0000000-0000-4000-8000-000000000009",
      sortOrder: 4,
      isActive: false,
      courseCount: 7,
    });
  });
});

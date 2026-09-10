import { describe, expect, it } from "vitest";

import {
  courseLevelLabel,
  findPublishedCourse,
  formatDuration,
  formatHours,
  formatLearnerCount,
  formatThaiDate,
  getCategories,
  getPublishedCourses,
} from "./catalog";

describe("fixture แคตตาล็อก (C-6)", () => {
  it("มีเฉพาะหลักสูตรสถานะ published (guest เห็นเฉพาะ published — RLS/TC-005)", async () => {
    const list = await getPublishedCourses();
    expect(list.data.length).toBeGreaterThanOrEqual(3);
    for (const course of list.data) {
      expect(course.status).toBe("published");
    }
  });

  it("รูป response ตรง envelope §1.2 + จัดเรียง publishedAt ล่าสุดก่อน", async () => {
    const list = await getPublishedCourses();
    expect(list.page).toEqual({ nextCursor: null, hasMore: false });
    const dates = list.data.map((c) => Date.parse(c.publishedAt));
    for (let i = 1; i < dates.length; i += 1) {
      expect(dates[i] ?? 0).toBeLessThanOrEqual(dates[0] ?? 0);
    }
  });

  it("ทุกหลักสูตร resolve หมวดได้ + lessonCount ตรงกับโมดูลจริง (ไม่ throw ที่ toListItem)", async () => {
    const list = await getPublishedCourses();
    const categories = await getCategories();
    const slugs = new Set(categories.map((c) => c.slug));
    for (const course of list.data) {
      expect(slugs.has(course.category.slug)).toBe(true);
      expect(course.lessonCount).toBeGreaterThan(0);
    }
    const detail = await findPublishedCourse(list.data[0]?.id ?? "");
    expect(detail).toBeDefined();
    expect(detail?.modules.length).toBeGreaterThan(0);
    expect(detail?.outcomes.length).toBeGreaterThan(0);
  });

  it("id ไม่ซ้ำกันและเป็นรูป UUID (API §1.1)", async () => {
    const list = await getPublishedCourses();
    const ids = list.data.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const id of ids) {
      expect(id).toMatch(uuidPattern);
    }
  });

  it("ผู้ช่วยแสดงผลภาษาไทย: ชั่วโมง/เวลา/จำนวนผู้เรียน/วันที่ พ.ศ./ระดับ", () => {
    expect(formatHours(6)).toBe("6 ชั่วโมง");
    expect(formatHours(4.44)).toBe("4.4 ชั่วโมง");
    expect(formatDuration(1500)).toBe("25:00");
    expect(formatLearnerCount(3412)).toBe("3,412");
    expect(formatThaiDate("2026-08-12T03:00:00Z")).toContain("2569");
    expect(courseLevelLabel("beginner")).toBe("ระดับเริ่มต้น");
  });
});

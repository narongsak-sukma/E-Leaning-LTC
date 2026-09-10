/**
 * catalog.test — unit test ของชั้นอ่านข้อมูลแคตตาล็อก (C-6 Phase 1 — fetch BFF จริง)
 *
 * mock global fetch เพื่อทดสอบ:
 * - mapping response camelCase ของ BFF → type ของ UI (status/level แคบเป็น union, null → [] / null)
 * - error path: BFF ตอบ 5xx/4xx → throw ภาษาไทยให้ error boundary จัดการ, 404 → undefined (→ notFound())
 * - absolute URL จาก headers (x-forwarded-proto + host) และ cache: "no-store"
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

/** จับ URL + ตอบ JSON ตาม status — mock ของ global fetch */
function stubFetch(handler: (url: string) => { status: number; body?: unknown }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const result = handler(String(input));
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ORIGIN = "http://localhost:3000";

/** response body ของ GET /api/v1/courses (รูป camelCase ตาม BFF) */
const LIST_BODY = {
  data: [
    {
      id: "22222222-2222-4222-8222-222222222201",
      code: "LTC-CAT-001",
      titleTh: "กฎหมายที่ประชาชนควรรู้",
      titleEn: "Law in Everyday Life",
      summary: "สรุปหลักสูตร",
      category: { id: "cat-1", slug: "public-law", nameTh: "กฎหมายสำหรับประชาชน" },
      status: "published",
      isPublic: true,
      level: "beginner",
      lessonCount: 9,
      durationHours: 4.4,
      credits: 3,
      learnerCount: 3412,
      publishedAt: "2026-08-12T03:00:00Z",
    },
  ],
  page: { nextCursor: null, hasMore: false },
};

/** response body ของ GET /api/v1/courses/{id} — ครบ null-path (outcomes/exam/title วิทยากร) */
const DETAIL_BODY = {
  id: "22222222-2222-4222-8222-222222222201",
  code: "LTC-CAT-001",
  titleTh: "กฎหมายที่ประชาชนควรรู้",
  titleEn: null,
  summary: null,
  category: { id: "cat-1", slug: "public-law", nameTh: "กฎหมายสำหรับประชาชน" },
  categorySlug: "public-law",
  status: "published",
  isPublic: true,
  level: "beginner",
  lessonCount: 9,
  durationHours: 4.4,
  credits: 3,
  learnerCount: 3412,
  publishedAt: "2026-08-12T03:00:00Z",
  description: "รายละเอียดหลักสูตร",
  outcomes: null,
  instructors: [{ nameTh: "ผศ.ดร.สมชาย วัฒนศิริ", titleTh: null, bio: null }],
  exam: null,
  modules: [
    {
      id: "mod-1",
      titleTh: "โมดูล 1",
      sortOrder: 1,
      isPreview: true,
      lessons: [
        { id: "l1", type: "video", titleTh: "บทที่ 1", durationSec: 1800, isPreview: true },
      ],
    },
  ],
};

describe("getPublishedCourses — fetch BFF GET /api/v1/courses", () => {
  it("absolute URL จาก origin fallback + cache no-store + mapping เป็น type ของ UI", async () => {
    const fetchMock = stubFetch((url) =>
      url === `${ORIGIN}/api/v1/courses` ? { status: 200, body: LIST_BODY } : { status: 404 },
    );

    const list = await getPublishedCourses();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/v1/courses`);
    expect(init.cache).toBe("no-store");
    const item = list.data[0];
    expect(item).toEqual({ ...LIST_BODY.data[0] });
    expect(item?.status).toBe("published");
    expect(item?.level).toBe("beginner");
    expect(list.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("BFF ตอบ 5xx → throw Error ภาษาไทย (page/error boundary จัดการต่อ)", async () => {
    stubFetch(() => ({ status: 503, body: { error: { code: "ERR-SYS-002" } } }));

    await expect(getPublishedCourses()).rejects.toThrow("503");
    await expect(getPublishedCourses()).rejects.toThrow("GET /api/v1/courses");
  });

  it("เรียกไม่ถึง BFF (network fail) → throw ภาษาไทยระบุ path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(getPublishedCourses()).rejects.toThrow("เรียก API แคตตาล็อกไม่สำเร็จ");
  });
});

describe("getCategories — fetch BFF GET /api/v1/categories", () => {
  it("mapping data ตรงตามที่ BFF ตอบ (courseCount รวมอยู่)", async () => {
    const categories = [
      { id: "cat-1", slug: "public-law", nameTh: "กฎหมายสำหรับประชาชน", nameEn: "Law for Everyone", courseCount: 2 },
    ];
    stubFetch(() => ({ status: 200, body: { data: categories } }));

    await expect(getCategories()).resolves.toEqual(categories);
  });

  it("BFF ตอบ 5xx → throw", async () => {
    stubFetch(() => ({ status: 500 }));

    await expect(getCategories()).rejects.toThrow("GET /api/v1/categories");
  });
});

describe("findPublishedCourse — fetch BFF GET /api/v1/courses/{id}", () => {
  it("200 → detail พร้อม null-path (outcomes null → [], exam null → null) + encodeURIComponent(id)", async () => {
    const fetchMock = stubFetch((url) =>
      url === `${ORIGIN}/api/v1/courses/${LIST_BODY.data[0]?.id}`
        ? { status: 200, body: { data: DETAIL_BODY } }
        : { status: 404 },
    );

    const course = await findPublishedCourse(LIST_BODY.data[0]?.id ?? "");
    expect(course).toBeDefined();
    expect(course?.id).toBe(LIST_BODY.data[0]?.id);
    expect(course?.outcomes).toEqual([]);
    expect(course?.exam).toBeNull();
    expect(course?.instructors).toEqual([{ nameTh: "ผศ.ดร.สมชาย วัฒนศิริ", titleTh: null, bio: null }]);
    expect(course?.modules[0]?.lessons[0]?.type).toBe("video");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${ORIGIN}/api/v1/courses/${encodeURIComponent(LIST_BODY.data[0]?.id ?? "")}`,
    );
  });

  it("404 (draft/ไม่มีจริง — ERR-CRS-001) → undefined (page notFound())", async () => {
    stubFetch(() => ({ status: 404, body: { error: { code: "ERR-CRS-001" } } }));

    await expect(findPublishedCourse("22222222-2222-4222-8222-222222222299")).resolves.toBeUndefined();
  });

  it("5xx → throw Error ภาษาไทย", async () => {
    stubFetch(() => ({ status: 500 }));

    await expect(findPublishedCourse(LIST_BODY.data[0]?.id ?? "")).rejects.toThrow("500");
  });
});

describe("ผู้ช่วยแสดงผลภาษาไทย (คงเดิมจากยุค fixture)", () => {
  it("ชั่วโมง/เวลา/จำนวนผู้เรียน/วันที่ พ.ศ./ระดับ", () => {
    expect(formatHours(6)).toBe("6 ชั่วโมง");
    expect(formatHours(4.44)).toBe("4.4 ชั่วโมง");
    expect(formatDuration(1500)).toBe("25:00");
    expect(formatLearnerCount(3412)).toBe("3,412");
    expect(formatThaiDate("2026-08-12T03:00:00Z")).toContain("2569");
    expect(courseLevelLabel("beginner")).toBe("ระดับเริ่มต้น");
  });
});

/**
 * unit tests — ชั้นข้อมูลหลังบ้าน (C-8 Phase 1)
 * ครอบ: mapping shape · หน้าว่าง · error 5xx · 403 · contract ผิดรูป · session /me
 * วิธี: mock global fetch + mock next/headers (ตามแบบ "mock ที่ขอบเขต" ของ session.test.ts)
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      host: "admin.test.local",
      "x-forwarded-proto": "https",
      cookie: "session-cookie=abc",
    }),
}));

import {
  ADMIN_COURSES_PAGE_SIZE,
  getAdminCategories,
  getAdminCourses,
  getAdminStaffSession,
  hasAdminStaffRole,
  isAdminStaffRole,
  type AdminCategory,
  type AdminCourse,
} from "./admin";

/** ตอบ response แบบ JSON ตาม envelope §1.1 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** หลักสูตรจำลองสำหรับ test (ข้อมูลจำลองอยู่ใน .test.ts เท่านั้น ตามขอบเขต C-8) */
function makeCourse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c-101",
    code: "LTC-101",
    titleTh: "กฎหมายที่ประชาชนควรรู้เบื้องต้น",
    titleEn: null,
    summary: "สิทธิและหน้าที่ของประชาชน",
    categoryId: "cat-general",
    status: "published",
    version: 2,
    language: "th",
    isPublic: true,
    publishedAt: "2026-08-20",
    updatedAt: "2026-08-20",
    ...overrides,
  };
}

/** หมวดจำลองสำหรับ test */
function makeCategory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cat-general",
    slug: "general-law",
    nameTh: "กฎหมายทั่วไป",
    nameEn: "General Law",
    parentId: null,
    sortOrder: 1,
    isActive: true,
    courseCount: 2,
    ...overrides,
  };
}

describe("GET /admin/courses (ผ่านชั้นข้อมูล getAdminCourses)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("mapping shape ครบทุกฟิลด์ + สร้าง absolute URL และ query ถูกต้อง (status/q/cursor/limit)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [makeCourse()],
        page: { nextCursor: "cursor-2", hasMore: true },
      }),
    );
    const result = await getAdminCourses({
      q: "กฎหมาย",
      status: "published",
      cursor: "cursor-1",
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const course = result.data.data[0] as AdminCourse;
    expect(course.id).toBe("c-101");
    expect(course.code).toBe("LTC-101");
    expect(course.titleTh).toBe("กฎหมายที่ประชาชนควรรู้เบื้องต้น");
    expect(course.titleEn).toBeNull();
    expect(course.summary).toBe("สิทธิและหน้าที่ของประชาชน");
    expect(course.categoryId).toBe("cat-general");
    expect(course.status).toBe("published");
    expect(course.version).toBe(2);
    expect(course.language).toBe("th");
    expect(course.isPublic).toBe(true);
    expect(course.publishedAt).toBe("2026-08-20");
    expect(course.updatedAt).toBe("2026-08-20");
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.origin).toBe("https://admin.test.local");
    expect(url.pathname).toBe("/api/v1/admin/courses");
    expect(url.searchParams.get("status")).toBe("published");
    expect(url.searchParams.get("q")).toBe("กฎหมาย");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("mapping แถวเดียวแบบ default query — ไม่มีพารามิเตอร์เสริมนอกจาก limit", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [makeCourse()],
        page: { nextCursor: null, hasMore: false },
      }),
    );
    const result = await getAdminCourses();
    expect(result.ok).toBe(true);
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get("status")).toBeNull();
    expect(url.searchParams.get("q")).toBeNull();
    expect(url.searchParams.get("cursor")).toBeNull();
    expect(url.searchParams.get("limit")).toBe(String(ADMIN_COURSES_PAGE_SIZE));
  });

  it("หน้าว่าง → data [] และ hasMore=false (empty state)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [],
        page: { nextCursor: null, hasMore: false },
      }),
    );
    const result = await getAdminCourses();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.data).toHaveLength(0);
    expect(result.data.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("error 5xx → kind=server (BFF ขัดข้อง)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: "ERR-SYS-001" } }));
    const result = await getAdminCourses();
    expect(result).toEqual({ ok: false, kind: "server" });
  });

  it("error 403 → kind=forbidden (ไม่มีสิทธิ์)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: "ERR-RBAC-001" } }));
    const result = await getAdminCourses();
    expect(result).toEqual({ ok: false, kind: "forbidden" });
  });

  it("fetch throw (BFF ล่ม/เครือข่าย) → kind=server", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await getAdminCourses();
    expect(result).toEqual({ ok: false, kind: "server" });
  });

  it("contract ผิดรูป (status ไม่อยู่ใน enum) → kind=server แบบ fail-closed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [makeCourse({ status: "wrong_status" })],
        page: { nextCursor: null, hasMore: false },
      }),
    );
    const result = await getAdminCourses();
    expect(result).toEqual({ ok: false, kind: "server" });
  });

  it("contract ผิดรูป (ขาด field จำเป็น) → kind=server", async () => {
    const broken = makeCourse();
    delete broken["code"];
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [broken],
        page: { nextCursor: null, hasMore: false },
      }),
    );
    const result = await getAdminCourses();
    expect(result).toEqual({ ok: false, kind: "server" });
  });
});

describe("GET /admin/categories (ผ่านชั้นข้อมูล getAdminCategories)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("mapping ครบ + รวมหมวด isActive=false และ courseCount มาจาก BFF", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [
          makeCategory(),
          makeCategory({
            id: "cat-ethics",
            slug: "professional-ethics",
            nameTh: "จรรยาบรรณทนายความ",
            nameEn: null,
            parentId: "cat-general",
            isActive: false,
            courseCount: 0,
          }),
        ],
      }),
    );
    const result = await getAdminCategories();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toHaveLength(2);
    const inactive = result.data[1] as AdminCategory;
    expect(inactive.isActive).toBe(false);
    expect(inactive.courseCount).toBe(0);
    expect(inactive.nameTh).toBe("จรรยาบรรณทนายความ");
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe("/api/v1/admin/categories");
    expect(url.origin).toBe("https://admin.test.local");
  });

  it("error 403 → kind=forbidden", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, {}));
    const result = await getAdminCategories();
    expect(result).toEqual({ ok: false, kind: "forbidden" });
  });

  it("error 500 → kind=server", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const result = await getAdminCategories();
    expect(result).toEqual({ ok: false, kind: "server" });
  });
});

describe("GET /me (ผ่านชั้นข้อมูล getAdminStaffSession)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("200 → staff มี name/roles ที่อยู่ในทะเบียน RBAC + mfaVerified", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          id: "u-1",
          email: "staff@example.com",
          displayName: "ดิลดา ใจดี",
          roles: ["staff:content", "citizen"],
          mfaVerified: true,
        },
      }),
    );
    const result = await getAdminStaffSession();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const staff = result.staff;
    expect(staff).not.toBeNull();
    if (staff === null) {
      return;
    }
    expect(staff.name).toBe("ดิลดา ใจดี");
    expect(staff.roles).toEqual(["staff:content", "citizen"]);
    expect(staff.mfaVerified).toBe(true);
  });

  it("401/403 → staff = null (layout จะ redirect /login)", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValue(jsonResponse(status, {}));
      const result = await getAdminStaffSession();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.staff).toBeNull();
    }
  });

  it("5xx → ok=false (layout แสดงแผงระบบขัดข้อง ไม่ redirect)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const result = await getAdminStaffSession();
    expect(result).toEqual({ ok: false });
  });

  it("บทบาทแปลกปลอมถูกกรองออก + mfaVerified ขาดหาย → null", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          displayName: "ดิลดา ใจดี",
          roles: ["super_admin", "not_a_role", 42],
          email: "s@example.com",
        },
      }),
    );
    const result = await getAdminStaffSession();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const staff = result.staff;
    expect(staff).not.toBeNull();
    if (staff === null) {
      return;
    }
    expect(staff.roles).toEqual(["super_admin"]);
    expect(staff.mfaVerified).toBeNull();
  });

  it("contract ผิดรูป (ไม่มี roles) → ok=false fail-closed", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { displayName: "x" } }));
    const result = await getAdminStaffSession();
    expect(result).toEqual({ ok: false });
  });

  it("cookie ของ request เดิมถูกส่งต่อไปยัง BFF ทุกครั้ง", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { displayName: "ดิลดา", roles: ["staff:viewer"] } }),
    );
    await getAdminStaffSession();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("session-cookie=abc");
  });
});

describe("pure helpers ของชั้นข้อมูล", () => {
  it("isAdminStaffRole/hasAdminStaffRole แยกเจ้าหน้าที่ออกจากผู้เรียน", () => {
    expect(isAdminStaffRole("staff:content")).toBe(true);
    expect(isAdminStaffRole("super_admin")).toBe(true);
    expect(isAdminStaffRole("instructor")).toBe(false);
    expect(isAdminStaffRole("citizen")).toBe(false);
    expect(hasAdminStaffRole(["citizen"])).toBe(false);
    expect(hasAdminStaffRole(["citizen", "staff:exam"])).toBe(true);
  });
});


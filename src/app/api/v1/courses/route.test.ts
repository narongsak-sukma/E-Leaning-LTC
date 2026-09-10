/**
 * route.test — unit test ของ GET /api/v1/courses (contract-first —
 * mock Supabase client ตามแบบ src/lib/rbac.test.ts; envelope/cursor ตาม API §1.2/§1.3)
 */
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { errorDefinition } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { GET } from "./route";

vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  // gate r12: getUser ของ session.ts ใช้ buffered client — wrapper อ่าน stub จาก
  // createSupabaseSsrClient ณ เวลาถูกเรียก (mockResolvedValue ตั้งทีหลังได้)
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

interface QuerySpy {
  readonly select: Mock;
  readonly eq: Mock;
  readonly in: Mock;
  readonly order: Mock;
  readonly limit: Mock;
  readonly not: Mock;
  readonly or: Mock;
  readonly filter: Mock;
}

interface Terminal {
  data: unknown;
  error: { message: string } | null;
}

function makeBuilder(result: { data?: unknown; error?: { message: string } | null } = {}) {
  const terminal: Terminal = { data: result.data ?? null, error: result.error ?? null };
  const spy: QuerySpy = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    not: vi.fn(),
    or: vi.fn(),
    filter: vi.fn(),
  };
  const self = spy as unknown as Record<string, unknown>;
  const chain = ["select", "eq", "in", "order", "limit", "not", "or", "filter"] as const;
  for (const method of chain) {
    spy[method].mockImplementation(() => self);
  }
  // thenable — await self → terminal (จำลอง query builder ของ supabase-js)
  self.then = ((onFulfilled?: (value: unknown) => unknown) =>
    Promise.resolve(terminal).then(onFulfilled)) as unknown;
  return { spy, self: self as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>> };
}

const createClientMock = vi.mocked(createSupabaseSsrClient);

/**
 * client จำลองที่ dispatch ตามตาราง/view — `from("courses")` กับ `from("course_public_stats")`
 * ได้ builder คนละตัว (route ของ DCR-4 query view แยกแล้ว merge ใน JS)
 */
function makeClient(tables: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const byTable = new Map<string, ReturnType<typeof makeBuilder>>();
  const from = vi.fn((table: string) => {
    const cached = byTable.get(table);
    if (cached !== undefined) {
      return cached.self;
    }
    const created = makeBuilder(tables[table]);
    byTable.set(table, created);
    return created.self;
  });
  createClientMock.mockResolvedValue({ from } as never);
  return {
    from,
    /** spy ของ builder ที่ route เรียกไปแล้ว (หรือสร้างใหม่ถ้ายังไม่ถูกใช้ — ไว้ assert args) */
    spyOf: (table: string): QuerySpy => {
      const cached = byTable.get(table);
      if (cached !== undefined) {
        return cached.spy;
      }
      return makeBuilder(tables[table]).spy;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** request จำลองที่มี session cookie ปลอม (RLS ฝั่ง mock จัดการ — guest ตาม TC-005) */
function makeRequest(search: string): Request {
  return new Request(`http://localhost:3000/api/v1/courses${search}`);
}

const ROWS = [
  {
    id: "11111111-1111-4111-8111-111111111101",
    code: "C101",
    title_th: "หลักสูตรที่ 1",
    title_en: "Course One",
    summary: "สรุป 1",
    status: "published",
    is_public: true,
    level: "beginner",
    published_at: "2026-08-01T00:00:00+00:00",
    category: { id: "cat-1", slug: "public-law", name_th: "กฎหมายสำหรับประชาชน" },
    course_modules: [
      { lessons: [{ duration_sec: 1800 }, { duration_sec: 600 }] },
      { lessons: [{ duration_sec: null }] },
    ],
  },
  {
    id: "11111111-1111-4111-8111-111111111102",
    code: "C102",
    title_th: "หลักสูตรที่ 2",
    title_en: null,
    summary: null,
    status: "published",
    is_public: false,
    level: "intermediate",
    published_at: "2026-07-01T00:00:00+00:00",
    category: { id: "cat-1", slug: "public-law", name_th: "กฎหมายสำหรับประชาชน" },
    course_modules: [{ lessons: [{ duration_sec: 3600 }] }],
  },
] as const;

describe("GET /api/v1/courses — envelope §1.2", () => {
  it("200 — { data, page } ตรงรูป §1.2 + mapped camelCase + metrics + ฟิลด์ DCR-4", async () => {
    const client = makeClient({
      courses: { data: ROWS },
      course_public_stats: {
        data: [
          { course_id: "11111111-1111-4111-8111-111111111101", learner_count: 3412, credits: 3 },
          { course_id: "11111111-1111-4111-8111-111111111102", learner_count: 2108, credits: null },
        ],
      },
    });

    const response = await GET(makeRequest(""));
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
      page: { nextCursor: string | null; hasMore: boolean };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(body.data).toEqual([
      {
        id: ROWS[0]?.id,
        code: "C101",
        titleTh: "หลักสูตรที่ 1",
        titleEn: "Course One",
        summary: "สรุป 1",
        category: { id: "cat-1", slug: "public-law", nameTh: "กฎหมายสำหรับประชาชน" },
        status: "published",
        isPublic: true,
        level: "beginner",
        lessonCount: 3,
        durationHours: Math.round((2400 / 3600) * 10) / 10,
        credits: 3,
        learnerCount: 3412,
        publishedAt: "2026-08-01T00:00:00+00:00",
      },
      {
        id: ROWS[1]?.id,
        code: "C102",
        titleTh: "หลักสูตรที่ 2",
        titleEn: null,
        summary: null,
        category: { id: "cat-1", slug: "public-law", nameTh: "กฎหมายสำหรับประชาชน" },
        status: "published",
        isPublic: false,
        level: "intermediate",
        lessonCount: 1,
        durationHours: 1,
        credits: 0,
        learnerCount: 2108,
        publishedAt: "2026-07-01T00:00:00+00:00",
      },
    ]);
    expect(client.spyOf("courses").select).toHaveBeenCalledWith(expect.stringContaining("course_modules"));
    expect(client.spyOf("course_public_stats").in).toHaveBeenCalledWith("course_id", [
      "11111111-1111-4111-8111-111111111101",
      "11111111-1111-4111-8111-111111111102",
    ]);
  });

  it("cursor pagination: limit+1 แถว → hasMore + nextCursor ชี้ (published_at, id) ของแถวสุดท้าย", async () => {
    const rows = [
      { ...ROWS[0], published_at: "2026-09-01T00:00:00+00:00" },
      { ...ROWS[1], published_at: "2026-08-01T00:00:00+00:00" },
      { ...ROWS[0], id: "11111111-1111-4111-8111-111111111109", published_at: "2026-07-01T00:00:00+00:00" },
    ];
    const client = makeClient({ courses: { data: rows }, course_public_stats: { data: [] } });

    const response = await GET(makeRequest("?limit=2"));
    const body = (await response.json()) as {
      data: unknown[];
      page: { nextCursor: string | null; hasMore: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.page.hasMore).toBe(true);
    expect(client.spyOf("courses").limit).toHaveBeenCalledWith(3);
    expect(client.spyOf("courses").order).toHaveBeenCalledWith("published_at", { ascending: false });
    expect(body.page.nextCursor).not.toBeNull();
    expect(decodeCursor(body.page.nextCursor as string)).toEqual({
      sortKey: "2026-08-01T00:00:00+00:00",
      id: "11111111-1111-4111-8111-111111111102",
    });
  });

  it("cursor มาพร้อม request → decode แล้วใส่ or-filter เลื่อนตำแหน่ง (row-wise DESC)", async () => {
    const client = makeClient({ courses: { data: [] }, course_public_stats: { data: [] } });
    const cursor = encodeCursor({ sortKey: "2026-08-01T00:00:00+00:00", id: "11111111-1111-4111-8111-111111111102" });

    const response = await GET(makeRequest(`?cursor=${encodeURIComponent(cursor)}`));

    expect(response.status).toBe(200);
    expect(client.spyOf("courses").or).toHaveBeenCalledWith(
      "published_at.lt.2026-08-01T00:00:00+00:00,and(published_at.eq.2026-08-01T00:00:00+00:00,id.lt.11111111-1111-4111-8111-111111111102)",
    );
    expect(vi.mocked(enforceRateLimit)).toHaveBeenCalledWith(expect.anything(), { group: "PUBLIC_READ" });
  });

  it("cursor ปลอม/ถูกแก้ → ERR-VAL-001 400 (§1.2 — signed)", async () => {
    makeClient({});

    const response = await GET(makeRequest("?cursor=tampered.abc"));

    const body = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("ฟิลเตอร์: category → eq(course_categories.slug), q → or(ilike 3 คอลัมน์)", async () => {
    const client = makeClient({ courses: { data: [] }, course_public_stats: { data: [] } });

    const response = await GET(makeRequest("?category=contract-law&q=%E0%B8%AA%E0%B8%B1%E0%B8%8D%E0%B8%8D%E0%B8%B2,()"));

    expect(response.status).toBe(200);
    expect(client.spyOf("courses").eq).toHaveBeenCalledWith("course_categories.slug", "contract-law");
    expect(client.spyOf("courses").or).toHaveBeenCalledWith(
      "title_th.ilike.%สัญญา%,title_en.ilike.%สัญญา%,summary.ilike.%สัญญา%",
    );
    // guest/RLS บังคับ published — handler ไม่เช็คสถานะใน JS (D26)
    expect(client.spyOf("courses").eq).not.toHaveBeenCalledWith("status", expect.anything());
  });

  it("RLS คืนแถวว่าง (guest เห็นเฉพาะ published) → data: [] + hasMore false + ไม่ query stats", async () => {
    const client = makeClient({ courses: { data: [] } });

    const response = await GET(makeRequest(""));
    const body = (await response.json()) as { data: unknown[]; page: { hasMore: boolean } };

    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(client.from).not.toHaveBeenCalledWith("course_public_stats");
  });

  it("limit ผิดรูป → ERR-VAL-001 400 พร้อม fields (zod boundary)", async () => {
    makeClient({});

    const response = await GET(makeRequest("?limit=abc"));
    const body = (await response.json()) as {
      error: { code: string; message: string; details: unknown };
    };

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "ERR-VAL-001",
        message: errorDefinition("ERR-VAL-001").message,
        details: { fields: ["limit"] },
      },
    });
  });

  it("error ฝั่ง DB → 503 ERR-SYS-002 แบบ opaque", async () => {
    const client = makeClient({ courses: { error: { message: "SQLSTATE XX000" } } });

    const response = await GET(makeRequest(""));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
    expect(client.from).not.toHaveBeenCalledWith("course_public_stats");
  });

  it("error ฝั่ง view course_public_stats → 503 ERR-SYS-002 (DCR-4 — ไม่ leak SQL)", async () => {
    makeClient({
      courses: { data: ROWS },
      course_public_stats: { error: { message: "SQLSTATE XX000" } },
    });

    const response = await GET(makeRequest(""));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
  });
});

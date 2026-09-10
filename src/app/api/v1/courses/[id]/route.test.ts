/**
 * route.test — unit test ของ GET /api/v1/courses/{id} (contract-first —
 * mock Supabase client ตามแบบ src/lib/rbac.test.ts; guest/draft ตาม TC-005)
 */
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { errorDefinition } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { GET } from "./route";

vi.mock("@/lib/supabase/ssr", () => ({
  createSupabaseSsrClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

interface QuerySpy {
  readonly select: Mock;
  readonly eq: Mock;
  readonly order: Mock;
  readonly limit: Mock;
  readonly not: Mock;
  readonly or: Mock;
  readonly filter: Mock;
  readonly maybeSingle: Mock;
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
    order: vi.fn(),
    limit: vi.fn(),
    not: vi.fn(),
    or: vi.fn(),
    filter: vi.fn(),
    maybeSingle: vi.fn(),
  };
  const self = spy as unknown as Record<string, unknown>;
  const chain = ["select", "eq", "order", "limit", "not", "or", "filter"] as const;
  for (const method of chain) {
    spy[method].mockImplementation(() => self);
  }
  spy.maybeSingle.mockImplementation(async () => terminal);
  // thenable — await self → terminal (จำลอง query builder ของ supabase-js)
  self.then = ((onFulfilled?: (value: unknown) => unknown) =>
    Promise.resolve(terminal).then(onFulfilled)) as unknown;
  return { spy, self: self as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>> };
}

const createClientMock = vi.mocked(createSupabaseSsrClient);
const enforceRateLimitMock = vi.mocked(enforceRateLimit);

beforeEach(() => {
  vi.clearAllMocks();
});

const COURSE_ID = "11111111-1111-4111-8111-111111111101";

function makeRequest(id: string): Request {
  return new Request(`http://localhost:3000/api/v1/courses/${id}`);
}

async function callRoute(id: string): Promise<Response> {
  return GET(makeRequest(id), { params: Promise.resolve({ id }) });
}

/** แถว courses จำลอง (RLS อนุญาต — published) */
function publishedRow() {
  return {
    id: COURSE_ID,
    code: "C101",
    title_th: "หลักสูตรทดสอบ",
    title_en: "Test Course",
    summary: "สรุป",
    description_md: "รายละเอียดแบบ markdown",
    status: "published",
    is_public: true,
    published_at: "2026-08-01T00:00:00+00:00",
    category: { id: "cat-1", slug: "public-law", name_th: "กฎหมายสำหรับประชาชน" },
    course_modules: [
      {
        id: "mod-2",
        title_th: "โมดูล 2",
        sort_order: 2,
        is_preview: false,
        lessons: [
          { id: "l1", type: "video", title_th: "บทที่ 1", duration_sec: 1800, is_preview: true, sort_order: 1 },
          { id: "l2", type: "document", title_th: "บทที่ 2", duration_sec: null, is_preview: false, sort_order: 2 },
        ],
      },
      {
        id: "mod-1",
        title_th: "โมดูล 1",
        sort_order: 1,
        is_preview: true,
        lessons: [{ id: "l3", type: "quiz", title_th: "แบบทดสอบ", duration_sec: null, is_preview: false, sort_order: 1 }],
      },
    ],
  };
}

describe("GET /api/v1/courses/{id}", () => {
  it("200 — รายละเอียด + โมดูล/บทเรียนเรียง sort_order + camelCase ตาม fixture", async () => {
    const builder = makeBuilder({ data: publishedRow() });
    createClientMock.mockResolvedValue({ from: () => builder.self } as never);

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as {
      data: {
        modules: Array<{ id: string; sortOrder: number; lessons: Array<{ id: string }> }>;
        lessonCount: number;
        durationHours: number;
        [key: string]: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body.data.id).toBe(COURSE_ID);
    expect(body.data.categorySlug).toBe("public-law");
    expect(body.data.description).toBe("รายละเอียดแบบ markdown");
    expect(body.data.modules.map((m) => m.id)).toEqual(["mod-1", "mod-2"]);
    expect(body.data.modules[0]?.lessons.map((l) => l.id)).toEqual(["l3"]);
    expect(body.data.lessonCount).toBe(3);
    expect(body.data.durationHours).toBe(0.5);
    expect(enforceRateLimitMock).toHaveBeenCalledWith(expect.anything(), { group: "PUBLIC_READ" });
  });

  it("select เฉพาะคอลัมน์ที่ต้องใช้ + query ด้วย id ที่ parse แล้ว", async () => {
    const builder = makeBuilder({ data: publishedRow() });
    createClientMock.mockResolvedValue({ from: () => builder.self } as never);

    await callRoute(COURSE_ID);

    expect(builder.spy.select).toHaveBeenCalledWith(expect.stringContaining("description_md"));
    expect(builder.spy.eq).toHaveBeenCalledWith("id", COURSE_ID);
    expect(builder.spy.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("draft/ไม่พบ (RLS คืน null สำหรับ guest — TC-005) → 404 ERR-CRS-001 ไม่เปิดเผยการมีอยู่", async () => {
    const builder = makeBuilder({ data: null });
    createClientMock.mockResolvedValue({ from: () => builder.self } as never);

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("ERR-CRS-001");
    expect(body.error.message).toBe(errorDefinition("ERR-CRS-001").message);
  });

  it("id ไม่ใช่ UUID → 400 ERR-VAL-001 field id (ไม่ query DB)", async () => {
    createClientMock.mockResolvedValue({ from: vi.fn() } as never);

    const response = await callRoute("not-a-uuid");
    const body = (await response.json()) as { error: { code: string; details: { fields: string[] } } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details).toEqual({ fields: ["id"] });
    // ตรวจรูปแบบ id ก่อนแตะฐานข้อมูล — ไม่สร้าง client / ไม่ query
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("error ฝั่ง DB → 503 ERR-SYS-002 แบบ opaque (ไม่ leak SQL)", async () => {
    const builder = makeBuilder({ error: { message: "SQLSTATE XX000" } });
    createClientMock.mockResolvedValue({ from: () => builder.self } as never);

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
  });

  it("สะท้อน x-request-id กลับทุก response (SDS §5.4)", async () => {
    const builder = makeBuilder({ data: publishedRow() });
    createClientMock.mockResolvedValue({ from: () => builder.self } as never);
    const request = new Request(`http://localhost:3000/api/v1/courses/${COURSE_ID}`, {
      headers: { "x-request-id": "req-c2-detail" },
    });

    const response = await GET(request, { params: Promise.resolve({ id: COURSE_ID }) });

    expect(response.headers.get("x-request-id")).toBe("req-c2-detail");
  });
});

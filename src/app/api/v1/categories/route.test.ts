/**
 * route.test — unit test ของ GET /api/v1/categories (contract-first —
 * mock Supabase client ตามแบบ src/lib/rbac.test.ts / src/lib/supabase/ssr.test.ts)
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

/** spy ของ query builder จำลอง supabase-js (thenable — await ได้ตรง ๆ) */
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
  count: number | null;
}

/** builder จำลอง — เมธอด chain คืนตัวเอง, await → terminal, maybeSingle() → terminal */
function makeBuilder(result: { data?: unknown; error?: { message: string } | null; count?: number | null } = {}) {
  const terminal: Terminal = {
    data: result.data ?? null,
    error: result.error ?? null,
    count: result.count ?? null,
  };
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
  // thenable — await self → terminal (จำลองพฤติกรรม query builder ของ supabase-js)
  self.then = ((onFulfilled?: (value: unknown) => unknown) =>
    Promise.resolve(terminal).then(onFulfilled)) as unknown;
  return { spy, self: self as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>> };
}

const createClientMock = vi.mocked(createSupabaseSsrClient);
const enforceRateLimitMock = vi.mocked(enforceRateLimit);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/categories", () => {
  it("200 — { data } envelope + แถว mapped camelCase + courseCount นับจาก count exact", async () => {
    const categoryBuilder = makeBuilder({
      data: [
        { id: "cat-1", slug: "public-law", name_th: "กฎหมายสำหรับประชาชน", name_en: "Law for Everyone" },
        { id: "cat-2", slug: "legal-ethics", name_th: "จรรยาบรรณและวิชาชีพทนายความ", name_en: null },
      ],
    });
    const countForCat1 = makeBuilder({ count: 3 });
    const countForCat2 = makeBuilder({ count: 0 });
    const countQueue = [countForCat1.self, countForCat2.self];
    const fromMock = vi.fn((table: string) =>
      table === "course_categories"
        ? categoryBuilder.self
        : (countQueue.shift() ?? countForCat2.self),
    );
    createClientMock.mockResolvedValue({ from: fromMock } as never);

    const response = await GET(new Request("http://localhost:3000/api/v1/categories"));
    const body = (await response.json()) as { data: unknown };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body).toEqual({
      data: [
        { id: "cat-1", slug: "public-law", nameTh: "กฎหมายสำหรับประชาชน", nameEn: "Law for Everyone", courseCount: 3 },
        { id: "cat-2", slug: "legal-ethics", nameTh: "จรรยาบรรณและวิชาชีพทนายความ", nameEn: null, courseCount: 0 },
      ],
    });
    expect(fromMock).toHaveBeenCalledWith("course_categories");
    expect(fromMock).toHaveBeenCalledWith("courses");
    expect(countForCat1.spy.eq).toHaveBeenCalledWith("category_id", "cat-1");
    expect(countForCat1.spy.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
  });

  it("rate limit เรียกด้วยกลุ่ม PUBLIC_READ (§5) + สะท้อน x-request-id", async () => {
    const categoryBuilder = makeBuilder({ data: [] });
    const fromMock = vi.fn(() => categoryBuilder.self);
    createClientMock.mockResolvedValue({ from: fromMock } as never);
    const request = new Request("http://localhost:3000/api/v1/categories", {
      headers: { "x-request-id": "req-c2-1" },
    });

    const response = await GET(request);

    expect(enforceRateLimitMock).toHaveBeenCalledWith(request, { group: "PUBLIC_READ" });
    expect(response.headers.get("x-request-id")).toBe("req-c2-1");
  });

  it("หมวดว่าง → data: [] และไม่เรียกนับ courseCount", async () => {
    const categoryBuilder = makeBuilder({ data: [] });
    const fromMock = vi.fn(() => categoryBuilder.self);
    createClientMock.mockResolvedValue({ from: fromMock } as never);

    const response = await GET(new Request("http://localhost:3000/api/v1/categories"));
    const body = (await response.json()) as { data: unknown[] };

    expect(response.status).toBe(200);
    expect(body).toEqual({ data: [] });
    expect(fromMock).toHaveBeenCalledTimes(1);
  });

  it("error ฝั่ง DB → 503 ERR-SYS-002 แบบ opaque (ไม่ leak ข้อความ SQL)", async () => {
    const categoryBuilder = makeBuilder({ error: { message: "SQLSTATE 42P01" } });
    const fromMock = vi.fn(() => categoryBuilder.self);
    createClientMock.mockResolvedValue({ from: fromMock } as never);

    const response = await GET(new Request("http://localhost:3000/api/v1/categories"));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
  });

  it("count query ล้ม → 503 ERR-SYS-002 (opaque เช่นกัน)", async () => {
    const categoryBuilder = makeBuilder({ data: [{ id: "cat-1", slug: "s", name_th: "t", name_en: null }] });
    const failingCount = makeBuilder({ error: { message: "SQLSTATE 42P01" } });
    const fromMock = vi.fn((table: string) =>
      table === "course_categories" ? categoryBuilder.self : failingCount.self,
    );
    createClientMock.mockResolvedValue({ from: fromMock } as never);

    const response = await GET(new Request("http://localhost:3000/api/v1/categories"));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

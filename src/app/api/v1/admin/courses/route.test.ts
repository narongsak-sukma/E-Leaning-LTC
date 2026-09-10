/**
 * route.test — unit test ของ GET /api/v1/admin/courses (Wave C-5 · contract-first)
 *
 * rate ยึด §5 ROUTE_RULES: /api/v1/admin/* = STAFF_WRITE (60/min ต่อบัญชี + ip) —
 * เกิน → 429 ERR-RATE-001 พร้อม details.group="STAFF_WRITE" (audit RATE_LIMIT_HIT ยังไม่
 * wire ใน helper จึงไม่ assert)
 *
 * mock client ตามแบบ src/app/api/v1/me/enrollments/route.test.ts (vi.mock supabase/ssr;
 * auth.getUser + mfa aal2 + profiles.is_active=true/deleted_at=null + rpc my_roles) —
 * ขอบเขต "ทุกสถานะ" จำลองที่ mock (RLS จริงบังคับที่ DB — DD §3.2 courses_staff_read)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
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

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { errorDefinition } from "@/lib/errors";
import { AdminCourseResource } from "@/lib/schemas/admin-catalog";
import { GET } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const CAT_ID = "b0000000-0000-4000-8000-000000000001";
const T1 = "2026-08-01T00:00:00+00:00";
const T2 = "2026-09-01T00:00:00+00:00";

/** thenable builder — `await query` ได้เหมือน PostgrestBuilder จริง */
function makeBuilder() {
  const calls: {
    eq: Array<{ column: string; value: unknown }>;
    or: string[];
    filter: Array<{ column: string; value: string }>;
    order: Array<[string, { ascending: boolean }]>;
    limit: unknown[];
    select: unknown[];
  } = { eq: [], or: [], filter: [], order: [], limit: [], select: [] };
  const builder = {
    select: vi.fn((s: unknown) => {
      calls.select.push(s);
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      calls.eq.push({ column, value });
      return builder;
    }),
    or: vi.fn((filter: string) => {
      calls.or.push(filter);
      return builder;
    }),
    filter: vi.fn((column: string, op: string, value: string) => {
      calls.filter.push({ column, value });
      return builder;
    }),
    order: vi.fn((column: string, opts: { ascending: boolean }) => {
      calls.order.push([column, opts]);
      return builder;
    }),
    limit: vi.fn((n: unknown) => {
      calls.limit.push(n);
      return builder;
    }),
    then(res: (v: { data: unknown; error: null }) => unknown) {
      return res({ data: null, error: null });
    },
  };
  return { builder, calls };
}

type BuilderControl = ReturnType<typeof makeBuilder>;

/**
 * mock client ของ requirePermission + query — roles/aal ตั้งได้ต่อ test;
 * from("profiles") คืนแถว active (SDS §5.5), from("courses") คืน builder ที่ให้ `rows`
 */
function mockClient(rows: unknown[], roles: readonly string[] = ["staff:content"], aal: "aal1" | "aal2" = "aal2"): BuilderControl {
  const { builder, calls } = makeBuilder();
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: STAFF_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: aal },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles" ? { data: roles, error: null } : { data: null, error: null }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : builder)),
    _builder: builder,
  };
  builder.then = (res: (v: { data: unknown; error: null }) => unknown) =>
    res({ data: rows, error: null });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { builder, calls };
}

function adminUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/courses" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-c5-1" },
  });
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    code: "LTC-101",
    title_th: "หลักสูตรตัวอย่าง",
    title_en: "Sample Course",
    summary: "สรุปหลักสูตร",
    category_id: CAT_ID,
    status: "draft",
    is_public: true,
    level: "beginner",
    version: 2,
    language: "th",
    published_at: null,
    created_at: T1,
    category: { id: CAT_ID, slug: "general-law", name_th: "กฎหมายทั่วไป" },
    course_modules: [
      { lessons: [{ duration_sec: 1800 }, { duration_sec: 600 }] },
      { lessons: [{ duration_sec: null }] },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/courses — สิทธิ์ + envelope §1.2", () => {
  it("staff ผ่านสิทธิ์ → 200 { data, page } + resource ผ่าน zod contract", async () => {
    mockClient([row()]);
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-c5-1");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await res.json()) as {
      data: unknown[];
      page: { nextCursor: string | null; hasMore: boolean };
    };
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(body.data).toHaveLength(1);
    expect(() => AdminCourseResource.parse(body.data[0])).not.toThrow();
  });

  it("แถวต่างสถานะผ่านได้ (draft/pending_review/archived — staff เห็นทุกสถานะ)", async () => {
    mockClient([
      row({ id: "c0000000-0000-4000-8000-000000000002", status: "pending_review" }),
      row({ id: "c0000000-0000-4000-8000-000000000003", status: "archived", published_at: T1 }),
      row({ id: "c0000000-0000-4000-8000-000000000004", status: "published", published_at: T1 }),
    ]);
    const res = await GET(adminUrl());
    const body = (await res.json()) as { data: Array<{ status: string }> };
    expect(res.status).toBe(200);
    expect(body.data.map((item) => item.status)).toEqual([
      "pending_review",
      "archived",
      "published",
    ]);
  });

  it("embed category ผูก !left — category ถูก RLS บัง (null) → 200 + แถวไม่หาย + category=null", async () => {
    const control = mockClient([row({ category: null })]);
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    // แถวหลักสูตรยังอยู่ครบ — ไม่ถูกตัดทั้งแถวเพราะหมวดที่ฝังมองไม่เห็น
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.["categoryId"]).toBe(CAT_ID);
    expect(body.data[0]?.["category"]).toBeNull();
    expect(() => AdminCourseResource.parse(body.data[0])).not.toThrow();
    // hint ชัดเจนใน select — กัน PostgREST ตีความเป็น inner
    expect(control.calls.select[0]).toContain("course_categories!left(");
  });

  it("ไม่มีบทบาทที่มี course:view → 403 ERR-RBAC-001 (ผ่าน auth แต่ไม่มี permission)", async () => {
    mockClient([], []);
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("course:view");
  });

  it("staff บังคับ MFA ที่ยัง aal1 → 403 ERR-AUTH-004 (D25-O4) — ก่อนถึง query", async () => {
    mockClient([], ["staff:content"], "aal1");
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(body.error.message).toBe(errorDefinition("ERR-AUTH-004").message);
  });
});

describe("GET /admin/courses — ฟิลเตอร์ + cursor (§1.2)", () => {
  it("กรอง status → .eq(status), categoryId → .eq(category_id) — ไม่มีคำค้นไม่เรียก or", async () => {
    const control = mockClient([]);
    const res = await GET(adminUrl("?status=draft&categoryId=" + CAT_ID));
    expect(res.status).toBe(200);
    expect(control.calls.eq).toEqual([
      { column: "status", value: "draft" },
      { column: "category_id", value: CAT_ID },
    ]);
    expect(control.calls.or).toEqual([]);
  });

  it("q → or(code,title_th ilike) โดยตัด , ( ) ออกจากคำค้นก่อนฝัง (กันรื้อ or-syntax)", async () => {
    const control = mockClient([]);
    const res = await GET(adminUrl("?q=%E0%B8%AA%E0%B8%B1%E0%B8%8D%E0%B8%8D%E0%B8%B2,()"));
    expect(res.status).toBe(200);
    expect(control.calls.or).toEqual([
      "code.ilike.%สัญญา%,title_th.ilike.%สัญญา%",
    ]);
  });

  it("limit+1 แถว → hasMore=true + nextCursor signed ชี้ (created_at,id) ของแถวสุดท้าย", async () => {
    const rows = [
      row({ id: "c0000000-0000-4000-8000-000000000002", created_at: T2 }),
      row({ id: "c0000000-0000-4000-8000-000000000001", created_at: T1 }),
      row({ id: "c0000000-0000-4000-8000-000000000009", created_at: "2026-07-01T00:00:00+00:00" }),
    ];
    const control = mockClient(rows);
    const res = await GET(adminUrl("?limit=2"));
    const body = (await res.json()) as {
      data: unknown[];
      page: { nextCursor: string | null; hasMore: boolean };
    };
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.page.hasMore).toBe(true);
    expect(control.calls.limit).toEqual([3]);
    expect(control.calls.order).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(decodeCursor(String(body.page.nextCursor))).toEqual({
      sortKey: T1,
      id: "c0000000-0000-4000-8000-000000000001",
    });
  });

  it("cursor มาพร้อม request → or-filter เลื่อนตำแหน่งแบบ row-wise DESC", async () => {
    const control = mockClient([]);
    const cursor = encodeCursor({ sortKey: T1, id: "c0000000-0000-4000-8000-000000000001" });
    const res = await GET(adminUrl("?cursor=" + encodeURIComponent(cursor)));
    expect(res.status).toBe(200);
    expect(control.calls.or).toEqual([
      "created_at.lt." + T1 + ",and(created_at.eq." + T1 + ",id.lt.c0000000-0000-4000-8000-000000000001)",
    ]);
  });

  it("cursor ปลอม/ถูกแก้ → 400 ERR-VAL-001 (signed — §1.2)", async () => {
    mockClient([]);
    const res = await GET(adminUrl("?cursor=tampered.abc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("limit=abc / status นอก enum / categoryId ไม่ใช่ uuid / key แปลกปลอม → 400 ERR-VAL-001", async () => {
    for (const query of [
      "?limit=abc",
      "?status=deleted",
      "?categoryId=not-a-uuid",
      "?foo=bar",
    ]) {
      mockClient([]);
      const res = await GET(adminUrl(query));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: unknown } };
      expect(body.error.code).toBe("ERR-VAL-001");
      expect(Array.isArray((body.error.details as { fields: string[] }).fields)).toBe(true);
    }
  });

  it("RLS คืนแถวว่าง → data: [] + hasMore false", async () => {
    mockClient([]);
    const res = await GET(adminUrl());
    const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean } };
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("error ฝั่ง DB → 503 ERR-SYS-002 แบบ opaque", async () => {
    const control = mockClient([]);
    control.builder.then = ((
      res: (v: { data: unknown; error: { message: string } }) => unknown,
    ) => res({ data: null, error: { message: "SQLSTATE XX000" } })) as never;
    const res = await GET(adminUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
  });

  it("rate STAFF_WRITE (§5 — /admin/*) — เกิน 60/min ต่อบัญชี → 429 ERR-RATE-001", async () => {
    mockClient([]);
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await GET(adminUrl());
    }
    expect(last).not.toBeNull();
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
  });
});

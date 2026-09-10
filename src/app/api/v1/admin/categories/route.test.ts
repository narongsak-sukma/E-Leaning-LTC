/**
 * route.test — unit test ของ GET /api/v1/admin/categories (Wave C-5 · contract-first)
 *
 * rate ยึด §5 ROUTE_RULES: /api/v1/admin/* = STAFF_WRITE (60/min ต่อบัญชี + ip) —
 * เกิน → 429 ERR-RATE-001 พร้อม details.group="STAFF_WRITE" (audit RATE_LIMIT_HIT ยังไม่
 * wire ใน helper จึงไม่ assert)
 *
 * mock client ตามแบบ me/enrollments/route.test.ts — from("course_categories") คืนทุกแถว
 * รวม is_active=false (จำลอง policy cc_read_admin — DCR-4 · migration ของ C-9) และ
 * from("courses") นับแบบ count exact head ต่อหมวด
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
import { errorDefinition } from "@/lib/errors";
import { AdminCategoryResource } from "@/lib/schemas/admin-catalog";
import { GET } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const PARENT_ID = "b0000000-0000-4000-8000-000000000001";
const CHILD_ID = "b0000000-0000-4000-8000-000000000002";

/** thenable builders ต่อตาราง + ตัวนับ count ต่อ category_id ที่ถูก eq มา */
function mockClient(
  categoryRows: unknown[],
  countsByCategory: Record<string, number> = {},
  roles: readonly string[] = ["staff:viewer"],
  aal: "aal1" | "aal2" = "aal2",
) {
  const countedCategoryIds: string[] = [];
  const categoriesBuilder = {
    select: vi.fn(() => categoriesBuilder),
    order: vi.fn(() => categoriesBuilder),
    then(res: (v: { data: unknown; error: null }) => unknown) {
      return res({ data: categoryRows, error: null });
    },
  };
  const countBuilder = {
    select: vi.fn(() => countBuilder),
    eq: vi.fn((column: string, value: unknown) => {
      if (column === "category_id" && typeof value === "string") countedCategoryIds.push(value);
      return countBuilder;
    }),
    then(res: (v: { data: null; error: null; count: number | null }) => unknown) {
      const key = countedCategoryIds[countedCategoryIds.length - 1] ?? "";
      return res({ data: null, error: null, count: countsByCategory[key] ?? 0 });
    },
  };
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
    from: vi.fn((table: string) => {
      if (table === "profiles") return profilesBuilder;
      if (table === "courses") return countBuilder;
      return categoriesBuilder;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { countedCategoryIds, categoriesBuilder, countBuilder };
}

function adminUrl(): Request {
  return new Request("http://localhost:3000/api/v1/admin/categories", {
    headers: { "x-forwarded-for": "10.5.0.2", "x-request-id": "req-c5-2" },
  });
}

const CATEGORY_ROWS = [
  {
    id: PARENT_ID,
    slug: "general-law",
    name_th: "กฎหมายทั่วไป",
    name_en: "General Law",
    parent_id: null,
    sort_order: 1,
    is_active: true,
  },
  {
    id: CHILD_ID,
    slug: "professional-ethics",
    name_th: "จรรยาบรรณทนายความ",
    name_en: "Professional Ethics",
    parent_id: PARENT_ID,
    sort_order: 2,
    is_active: false,
  },
];

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /admin/categories — §3.8 ทุกสถานะ", () => {
  it("staff ผ่านสิทธิ์ → 200 { data } + รูป AdminCategory (รวม is_active=false) + courseCount", async () => {
    mockClient(CATEGORY_ROWS, { [PARENT_ID]: 3, [CHILD_ID]: 1 });
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-c5-2");
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(2);
    expect(body.data.map((item) => AdminCategoryResource.parse(item))).toEqual([
      {
        id: PARENT_ID,
        slug: "general-law",
        nameTh: "กฎหมายทั่วไป",
        nameEn: "General Law",
        parentId: null,
        sortOrder: 1,
        isActive: true,
        courseCount: 3,
      },
      {
        id: CHILD_ID,
        slug: "professional-ethics",
        nameTh: "จรรยาบรรณทนายความ",
        nameEn: "Professional Ethics",
        parentId: PARENT_ID,
        sortOrder: 2,
        isActive: false,
        courseCount: 1,
      },
    ]);
  });

  it("เรียง sort_order แล้ว slug + นับ count ต่อหมวดด้วย eq(category_id) ทุกหมวด", async () => {
    const control = mockClient(CATEGORY_ROWS, { [PARENT_ID]: 3, [CHILD_ID]: 1 });
    const res = await GET(adminUrl());
    expect(res.status).toBe(200);
    expect(control.categoriesBuilder.order).toHaveBeenCalledWith("sort_order", {
      ascending: true,
    });
    expect(control.categoriesBuilder.order).toHaveBeenCalledWith("slug", { ascending: true });
    expect(control.countedCategoryIds).toEqual([PARENT_ID, CHILD_ID]);
    expect(control.countBuilder.select).toHaveBeenCalledWith("id", {
      count: "exact",
      head: true,
    });
  });

  it("ไม่มีบทบาทที่มี course:view → 403 ERR-RBAC-001", async () => {
    mockClient([], {}, []);
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("staff บังคับ MFA ที่ยัง aal1 → 403 ERR-AUTH-004 (D25-O4)", async () => {
    mockClient([], {}, ["staff:viewer"], "aal1");
    const res = await GET(adminUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(body.error.message).toBe(errorDefinition("ERR-AUTH-004").message);
  });

  it("RLS คืนแถวว่าง → 200 data: []", async () => {
    mockClient([]);
    const res = await GET(adminUrl());
    const body = (await res.json()) as { data: unknown[] };
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("error ฝั่ง DB (รายการหมวด / count) → 503 ERR-SYS-002 แบบ opaque", async () => {
    const control = mockClient([]);
    control.categoriesBuilder.then = ((
      res: (v: { data: unknown; error: { message: string } }) => unknown,
    ) => res({ data: null, error: { message: "SQLSTATE XX000" } })) as never;
    const failedList = await GET(adminUrl());
    expect(failedList.status).toBe(503);
    const listBody = (await failedList.json()) as { error: { code: string; message: string } };
    expect(listBody.error.code).toBe("ERR-SYS-002");
    expect(listBody.error.message).toBe(errorDefinition("ERR-SYS-002").message);

    const control2 = mockClient(CATEGORY_ROWS);
    control2.countBuilder.then = ((
      res: (v: { data: null; error: { message: string }; count: null }) => unknown,
    ) => res({ data: null, error: { message: "SQLSTATE XX000" }, count: null })) as never;
    const failedCount = await GET(adminUrl());
    expect(failedCount.status).toBe(503);
    const countBody = (await failedCount.json()) as { error: { code: string } };
    expect(countBody.error.code).toBe("ERR-SYS-002");
  });

  it("rate STAFF_WRITE (§5 — /admin/*) — เกิน 60/min ต่อบัญชี → 429 ERR-RATE-001 + Retry-After", async () => {
    mockClient([]);
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await GET(adminUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("STAFF_WRITE");
    expect(last?.headers.get("retry-after")).not.toBeNull();
  });
});

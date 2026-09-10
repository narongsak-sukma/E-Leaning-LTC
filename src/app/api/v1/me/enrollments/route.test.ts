/**
 * unit tests — GET /api/v1/me/enrollments (Wave C-3)
 *
 * mock client ตามแบบ rbac.test.ts (vi.mock supabase/ssr) — ขอบเขต "เฉพาะของตัวเอง"
 * ตรวจที่ handler (.eq user_id) + RLS เจ้าของแถว (DD §3.2); mock จำลองฝั่งหลังผ่าน client
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
import { GET } from "./route";
import { EnrollmentResource, type EnrollmentRow } from "@/lib/schemas/v1/enrollment";

const USER_ID = "u0000000-0000-4000-8000-000000000001";
const T1 = "2026-09-01T00:00:00+00:00";
const T2 = "2026-09-02T00:00:00+00:00";
const T3 = "2026-09-03T00:00:00+00:00";

function row(index: number, enrolledAt: string): EnrollmentRow {
  return {
    id: "e0000000-0000-4000-8000-0000000000" + String(index).padStart(2, "0"),
    course_id: "c0000000-0000-4000-8000-0000000000" + String(index).padStart(2, "0"),
    status: "active",
    enrolled_at: enrolledAt,
    expires_at: null,
    completed_at: null,
  };
}

/** thenable builder — `await query` ได้เหมือน PostgrestBuilder จริง */
function makeBuilder(rows: EnrollmentRow[]) {
  const eqCalls: Array<{ column: string; value: unknown }> = [];
  const orCalls: string[] = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqCalls.push({ column, value });
      return builder;
    }),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    or: vi.fn((filter: string) => {
      orCalls.push(filter);
      return builder;
    }),
    then(res: (v: { data: EnrollmentRow[]; error: null }) => unknown) {
      return res({ data: rows, error: null });
    },
  };
  return { builder, eqCalls, orCalls };
}

function mockClient(rows: EnrollmentRow[], roles: readonly string[] = ["citizen"]) {
  const { builder, eqCalls, orCalls } = makeBuilder(rows);
  // profiles ของ session.getUser (SDS §5.5) — builder แยก: บัญชี active ค่าตั้งต้น
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1" },
          error: null,
        })),
      },
    },
    // my_roles ของ requireMfaForRoles (AUTH-007 gate) — default citizen = ไม่ถูกบังคับ MFA
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles" ? { data: roles, error: null } : { data: null, error: null }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : builder)),
    _builder: builder,
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { eqCalls, orCalls, order: builder.order, limit: builder.limit };
}

function meUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/me/enrollments" + query, {
    headers: { "x-forwarded-for": "10.0.0.2", "x-request-id": "req-c3-2" },
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /me/enrollments — envelope + resource (§1.2/§3.3)", () => {
  it("200 { data, page } — resource ผ่าน zod contract + x-request-id สะท้อนกลับ", async () => {
    mockClient([row(1, T1), row(2, T2)]);
    const res = await GET(meUrl("?limit=2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      page: { nextCursor: string | null; hasMore: boolean };
    };
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(body.data).toHaveLength(2);
    for (const item of body.data) {
      expect(() => EnrollmentResource.parse(item)).not.toThrow();
    }
    expect(res.headers.get("x-request-id")).toBe("req-c3-2");
  });

  it("ผูกเจ้าของเสมอ: .eq(user_id) + เรียง (enrolled_at,id) desc + limit default+1", async () => {
    const filters = mockClient([row(1, T1)]);
    const res = await GET(meUrl());
    expect(res.status).toBe(200);
    expect(filters.eqCalls).toEqual([{ column: "user_id", value: USER_ID }]);
    expect(filters.order).toHaveBeenCalledWith("enrolled_at", { ascending: false });
    expect(filters.order).toHaveBeenCalledWith("id", { ascending: false });
    expect(filters.limit).toHaveBeenCalledWith(21);
  });

  it("limit+1 แถว → hasMore=true + nextCursor signed ชี้แถวสุดท้ายของหน้า", async () => {
    mockClient([row(1, T3), row(2, T2), row(3, T1)]);
    const res = await GET(meUrl("?limit=2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      page: { nextCursor: string | null; hasMore: boolean };
    };
    expect(body.page.hasMore).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(decodeCursor(String(body.page.nextCursor))).toEqual({
      sortKey: T2,
      id: "e0000000-0000-4000-8000-000000000002",
    });
  });

  it("cursor → กรอง keyset or(...) ตาม (enrolled_at,id) desc", async () => {
    const cursor = encodeCursor({ sortKey: T2, id: "e0000000-0000-4000-8000-000000000002" });
    const filters = mockClient([row(3, T1)]);
    const res = await GET(meUrl("?limit=2&cursor=" + encodeURIComponent(cursor)));
    expect(res.status).toBe(200);
    expect(filters.orCalls).toEqual([
      "enrolled_at.lt." + T2 + ",and(enrolled_at.eq." + T2 + ",id.lt.e0000000-0000-4000-8000-000000000002)",
    ]);
  });

  it("cursor ปลอม → 400 ERR-VAL-001", async () => {
    mockClient([]);
    const res = await GET(meUrl("?cursor=bm90LXNpZ25lZA.not-a-signature"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("limit=0 / key แปลกปลอม → 400 ERR-VAL-001", async () => {
    mockClient([]);
    const res = await GET(meUrl("?limit=0"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });
});

describe("GET /me/enrollments — auth + rate", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก query)", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
      from: vi.fn(),
    } as never);
    const res = await GET(meUrl());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-001");
  });

  it("บทบาทบังคับ MFA ที่ยัง aal1 → 403 ERR-AUTH-004 (AUTH-007 — /me/enrollments ไม่อยู่ enrollment-only allowlist)", async () => {
    mockClient([], ["staff:viewer"]); // aal1 ตาม mock
    const res = await GET(meUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("เรียก rate กลุ่ม READ — เกิน 120/min → 429 พร้อม details.group=READ", async () => {
    mockClient([]);
    let last: Response | null = null;
    for (let i = 0; i < 121; i += 1) {
      last = await GET(meUrl());
    }
    expect(last).not.toBeNull();
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

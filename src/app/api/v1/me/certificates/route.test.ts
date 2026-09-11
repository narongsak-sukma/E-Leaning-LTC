/**
 * route.test — GET /api/v1/me/certificates (Wave D-2 · API-SPECIFICATION §3.6)
 *
 * mock ssr client (requirePermission จริง) + rate-limit จริง (resetRateLimitStore)
 * ตามแบบ me/enrollments/route.test.ts — จุดหลัก: ขอบเขตเจ้าของ 2 ชั้น (RLS + eq user_id) ·
 * envelope §1.2 + cursor signed · ไม่มี holder_name (PII) ใน response
 */
process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { MyCertificateResource, type MyCertificateRow } from "@/lib/schemas/v1/certificate";
import { GET } from "./route";

vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});

const USER_ID = "u0000000-0000-4000-8000-000000000001";
const T1 = "2026-03-01T00:00:00+00:00";
const T2 = "2026-04-01T00:00:00+00:00";
const T3 = "2026-05-01T00:00:00+00:00";

function row(index: number, issuedAt: string, status = "valid"): MyCertificateRow {
  return {
    id: "c0000000-0000-4000-8000-0000000000" + String(index).padStart(2, "0"),
    cert_no: "LTC-2026-00000" + String(index),
    course_title_snapshot: "หลักสูตร " + String(index),
    issued_at: issuedAt,
    status,
  };
}

/** thenable builder — select/eq/or/order/limit + await ได้เหมือน PostgrestBuilder จริง */
function makeBuilder(rows: MyCertificateRow[], dbError: { message: string } | null = null) {
  const calls = {
    select: [] as string[],
    eq: [] as Array<{ column: string; value: unknown }>,
    or: [] as string[],
    order: [] as Array<{ column: string; options: unknown }>,
    limit: [] as number[],
  };
  const builder = {
    select: vi.fn((columns: string) => {
      calls.select.push(columns);
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
    order: vi.fn((column: string, options: unknown) => {
      calls.order.push({ column, options });
      return builder;
    }),
    limit: vi.fn((count: number) => {
      calls.limit.push(count);
      return builder;
    }),
    then(res: (v: { data: MyCertificateRow[]; error: { message: string } | null }) => unknown) {
      return res({ data: rows, error: dbError });
    },
  };
  return { builder, calls };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

/** client จำลอง: session + บทบาท + ตาราง profiles/certificates */
function mockClient(
  rows: MyCertificateRow[],
  options: {
    roles?: readonly string[];
    aal?: "aal1" | "aal2";
    session?: boolean;
    dbError?: { message: string };
  } = {},
) {
  const { builder, calls } = makeBuilder(rows, options.dbError ?? null);
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () =>
        options.session === false
          ? { data: { user: null }, error: { message: "no session" } }
          : { data: { user: { id: USER_ID } }, error: null },
      ),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: options.aal ?? "aal1" },
          error: null,
        })),
      },
    },
    rpc: vi.fn((fn: string) => {
      if (fn === "my_roles") {
        return Promise.resolve({ data: options.roles ?? ["citizen"], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn((table: string) => (table === "certificates" ? builder : profilesBuilder)),
    _calls: calls,
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function meUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/me/certificates" + query, {
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-d2-3" },
  });
}

describe("GET /me/certificates — envelope + ขอบเขตเจ้าของ", () => {
  it("200 { data, page } — resource snake_case ผ่าน zod + ไม่มี holder_name + สะท้อน x-request-id", async () => {
    mockClient([row(1, T2)]);
    const res = await GET(meUrl());
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      page: { nextCursor: string | null; hasMore: boolean };
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-d2-3");
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(body.data).toHaveLength(1);
    for (const item of body.data) {
      expect(() => MyCertificateResource.parse(item)).not.toThrow();
      expect(Object.keys(item).sort()).toEqual(["cert_no", "course_title", "id", "issued_at", "status"]);
      expect(Object.keys(item)).not.toContain("holder_name");
    }
  });

  it("ขอบเขตเจ้าของ 2 ชั้น — RLS (ตาราง certificates) + eq(user_id) ฝั่ง handler · เรียง (issued_at,id) desc · limit+1", async () => {
    const client = mockClient([row(1, T2), row(2, T1)]);
    const res = await GET(meUrl());

    expect(res.status).toBe(200);
    expect(client._calls.eq).toEqual([{ column: "user_id", value: USER_ID }]);
    expect(client._calls.order).toEqual([
      { column: "issued_at", options: { ascending: false } },
      { column: "id", options: { ascending: false } },
    ]);
    expect(client._calls.limit).toEqual([21]);
  });

  it("limit+1 แถว → hasMore=true + nextCursor signed ชี้ (issued_at, id) ของแถวสุดท้ายของหน้า", async () => {
    mockClient([row(1, T3), row(2, T2), row(3, T1)]);
    const res = await GET(meUrl("?limit=2"));
    const body = (await res.json()) as {
      data: Array<{ id: string; issued_at: string }>;
      page: { nextCursor: string | null; hasMore: boolean };
    };

    expect(res.status).toBe(200);
    expect(body.page.hasMore).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(decodeCursor(String(body.page.nextCursor))).toEqual({
      sortKey: T2,
      id: "c0000000-0000-4000-8000-000000000002",
    });
  });

  it("cursor → กรอง keyset or(...) ตาม (issued_at,id) desc", async () => {
    const cursor = encodeCursor({ sortKey: T2, id: "c0000000-0000-4000-8000-000000000002" });
    const client = mockClient([row(3, T1)]);
    const res = await GET(meUrl("?limit=2&cursor=" + encodeURIComponent(cursor)));

    expect(res.status).toBe(200);
    expect(client._calls.or).toEqual([
      "issued_at.lt." + T2 + ",and(issued_at.eq." + T2 + ",id.lt.c0000000-0000-4000-8000-000000000002)",
    ]);
  });

  it("cursor ปลอม → 400 ERR-VAL-001", async () => {
    mockClient([]);
    const res = await GET(meUrl("?cursor=bm90LXNpZ25lZA.not-a-signature"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("limit=0 / key แปลกปลอม → 400 ERR-VAL-001", async () => {
    mockClient([]);
    const res = await GET(meUrl("?limit=0"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("ไม่ login → 401 ERR-AUTH-001 (ไม่ query certificates)", async () => {
    const client = mockClient([], { session: false });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client._calls.eq).toEqual([]);
  });

  it("บทบาทบังคับ MFA ที่ยัง aal1 → 403 ERR-AUTH-004", async () => {
    mockClient([], { roles: ["staff:viewer"], aal: "aal1" });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("บทบาทไม่มี certificate:view (staff:viewer aal2) → 403 ERR-RBAC-001", async () => {
    mockClient([], { roles: ["staff:viewer"], aal: "aal2" });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("DB error → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    mockClient([], { dbError: { message: "SQLSTATE XX000" } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

describe("GET /me/certificates — rate READ (§5)", () => {
  it("เกิน 120/min → 429 ERR-RATE-001 พร้อม details.group=READ", async () => {
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

describe("GET /me/certificates — B4 fail-closed view", () => {
  it("แถว drift (status นอกทะเบียน) → 503 ERR-SYS-002 ไม่รั่ง payload เพี้ยน", async () => {
    mockClient([{ ...row(9, T2), status: "drift" }]);
    const res = await GET(meUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("my_certificate_row_drift"); // F5: ตายที่ขาเข้าก่อน map
  });
});

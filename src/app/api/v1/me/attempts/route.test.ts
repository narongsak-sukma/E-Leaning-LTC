/**
 * unit tests — GET /api/v1/me/attempts (Wave D-1)
 *
 * mock client ตามแบบ enroll/route.test.ts — ขอบเขตเจ้าของบังคับซ้ำที่ handler (.eq user_id)
 * + RLS attempts_owner_read (0010 L755) อยู่ฝั่ง DB; จุดตรวจของ unit test คือลำดับ handler,
 * รูป query (table/columns/filter), envelope §1.2 { data, page } และ mapping ผลตามทะเบียน error
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  // READ=2 เพื่อทดสอบ 429 (config cache ตอน first getConfig — ต้องตั้งก่อน import)
  process.env.RATE_LIMIT_READ_PER_MIN = "2";
});

vi.mock("server-only", () => ({}));
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

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { GET } from "./route";
import { MyAttemptView } from "@/lib/schemas/v1/exam";

const USER_ID = "u0000000-0000-4000-8000-000000000001";
const T1 = "2026-09-01T00:00:00+00:00";
const T2 = "2026-09-02T00:00:00+00:00";
const T3 = "2026-09-03T00:00:00+00:00";

function row(index: number, startedAt: string) {
  const suffix = String(index).padStart(2, "0");
  return {
    id: "b0000000-0000-4000-8000-0000000000" + suffix,
    assessment_id: "a0000000-0000-4000-8000-0000000000" + suffix,
    attempt_no: 1,
    status: index % 2 === 0 ? "passed" : "failed",
    started_at: startedAt,
    expires_at: "2026-09-01T01:00:00+00:00",
    submitted_at: startedAt,
    score_pct: index % 2 === 0 ? 80 : 40,
    passed: index % 2 === 0,
    question_count: 30,
    correct_count: index % 2 === 0 ? 24 : 12,
  };
}

interface Spec {
  userId: string | null;
  aal: "aal1" | "aal2";
  roles: readonly string[];
  rows: unknown[];
  error: { message: string } | null;
}

function makeClient(spec: Partial<Spec> = {}) {
  const full: Spec = {
    userId: USER_ID,
    aal: "aal1",
    roles: ["citizen"],
    rows: [],
    error: null,
    ...spec,
  };
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const rec = {
    select: [] as string[],
    eq: [] as Array<[string, unknown]>,
    or: [] as string[],
    limit: 0 as number,
    executed: false,
  };
  const builder = {
    select: vi.fn((columns: string) => {
      rec.select.push(columns);
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      rec.eq.push([column, value]);
      return builder;
    }),
    order: vi.fn(() => builder),
    limit: vi.fn((n: number) => {
      rec.limit = n;
      return builder;
    }),
    or: vi.fn((filter: string) => {
      rec.or.push(filter);
      return builder;
    }),
    then(res: (v: { data: unknown[]; error: { message: string } | null }) => unknown) {
      rec.executed = true;
      return res({ data: full.rows, error: full.error });
    },
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: full.userId === null ? null : { id: full.userId } },
        error: null,
      })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: full.aal, nextLevel: null, currentAuthenticationMethods: [] },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles" ? { data: full.roles, error: null } : { data: null, error: null },
    ),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : builder)),
  };
  return { client, rec };
}

async function get(query = "", spec: Partial<Spec> = {}) {
  const { client, rec } = makeClient(spec);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  const res = await GET(
    new Request("http://localhost:3000/api/v1/me/attempts" + query, {
      headers: { "x-forwarded-for": "10.0.0.4", "x-request-id": "req-d1-3" },
    }),
  );
  return { res, rec };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

interface PageBody {
  data: Array<Record<string, unknown>>;
  page: { nextCursor: string | null; hasMore: boolean };
}
interface ErrorBody {
  error: { code: string; message: string; details?: { fields?: string[]; field?: string; group?: string } };
}

describe("GET /me/attempts — happy path", () => {
  it("citizen → 200 + envelope §1.2 + resource ผ่าน zod · query ผูก user_id เท่านั้น", async () => {
    const { res, rec } = await get("", { rows: [row(1, T3), row(2, T2), row(3, T1)] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PageBody;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(3);
    for (const item of body.data) {
      const parsed = MyAttemptView.parse(item);
      expect(parsed.attemptNo).toBe(1);
      expect(typeof parsed.correctCount).toBe("number");
    }
    expect(body.page.hasMore).toBe(false);
    expect(body.page.nextCursor).toBeNull();
    expect(res.headers.get("x-request-id")).toBe("req-d1-3");
    // ขอบเขตเจ้าของบังคับซ้ำที่ handler — .eq("user_id", userId) เสมอ
    expect(rec.eq).toContainEqual(["user_id", USER_ID]);
    // คอลัมน์ประวัติเท่านั้น — ไม่มีคอลัมน์เฉลย/ข้อสอบ
    const cols = rec.select.join(" ");
    expect(cols).toContain("correct_count");
    expect(cols).not.toContain("user_id");
    expect(cols).not.toMatch(/is_correct|explanation|points_earned|question_snapshot/);
    // default limit 20 → query limit+1 เพื่อตรวจ hasMore
    expect(rec.limit).toBe(21);
  });

  it("lawyer เห็นประวัติของตัวเองได้เช่นกัน (attempt:view)", async () => {
    const { res } = await get("", { roles: ["lawyer"], rows: [row(3, T2)] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PageBody;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.["status"]).toBe("failed");
  });
});

describe("GET /me/attempts — pagination (cursor keyset)", () => {
  it("limit=2 กับ 3 แถว → hasMore true + nextCursor แกะได้ตรง (started_at, id) แถวสุดท้าย", async () => {
    const rows = [row(1, T3), row(2, T2), row(3, T1)];
    const { res } = await get("?limit=2", { rows });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PageBody;
    expect(body.data).toHaveLength(2);
    expect(body.page.hasMore).toBe(true);
    expect(body.page.nextCursor).not.toBeNull();
    const payload = decodeCursor(body.page.nextCursor as string);
    expect(payload.sortKey).toBe(T2);
    expect(payload.id).toBe("b0000000-0000-4000-8000-000000000002");
  });

  it("มี cursor → เติม .or() keyset ตาม (started_at, id) desc", async () => {
    const cursor = encodeCursor({ sortKey: T2, id: "b0000000-0000-4000-8000-000000000002" });
    const { res, rec } = await get("?limit=2&cursor=" + encodeURIComponent(cursor), {
      rows: [row(3, T1)],
    });
    expect(res.status).toBe(200);
    expect(rec.or).toEqual([
      "started_at.lt." + T2 + ",and(started_at.eq." + T2 + ",id.lt.b0000000-0000-4000-8000-000000000002)",
    ]);
    const body = (await res.json()) as PageBody;
    expect(body.data).toHaveLength(1);
    expect(body.page.hasMore).toBe(false);
  });

  it("cursor ปลอม/ถูกแก้ → 400 ERR-VAL-001 (field cursor)", async () => {
    const { res, rec } = await get("?cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.field).toBe("cursor");
    // ปฏิเสธก่อนรัน query ฐานข้อมูล (builder ถูกสร้างแต่ไม่ execute)
    expect(rec.executed).toBe(false);
  });
});

describe("GET /me/attempts — denial ตามทะเบียน error", () => {
  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    const { res, rec } = await get("", { userId: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(rec.select).toHaveLength(0);
  });

  it("บทบาทไม่มี attempt:view → 403 ERR-RBAC-001", async () => {
    const { res } = await get("", { roles: ["guest-unknown"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("staff aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004 ก่อนพิจารณาสิทธิ์", async () => {
    const { res } = await get("", { roles: ["staff:exam"], aal: "aal1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("staff:exam aal2 (มี attempt:view) → 200", async () => {
    const { res } = await get("", { roles: ["staff:exam"], aal: "aal2", rows: [row(5, T1)] });
    expect(res.status).toBe(200);
  });

  it("limit เกินขีด (101) → 400 ERR-VAL-001 (fields มี limit)", async () => {
    const { res, rec } = await get("?limit=101");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toContain("limit");
    expect(rec.select).toHaveLength(0);
  });

  it("query ล้มเหลว → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    const { res } = await get("", {
      error: { message: "SQLSTATE 42501 permission denied" },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("rate READ = 2/min (env) → ครั้งที่ 3 เป็น 429 ERR-RATE-001 + Retry-After", async () => {
    const first = await get("", { rows: [row(1, T3)] });
    expect(first.res.status).toBe(200);
    const second = await get("", { rows: [row(1, T3)] });
    expect(second.res.status).toBe(200);
    const third = await get("", { rows: [row(1, T3)] });
    expect(third.res.status).toBe(429);
    const body = (await third.res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details?.group).toBe("READ");
    expect(third.res.headers.get("retry-after")).not.toBeNull();
  });
});

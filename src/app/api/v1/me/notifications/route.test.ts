/**
 * route.test — GET /api/v1/me/notifications (Wave E Phase 4 · NTF-001 · §3.9)
 *
 * mock ssr client (requireUser จริง) + rate-limit จริง (resetRateLimitStore) ตามแบบ
 * me/credits/route.test.ts — จุดหลัก: RPC my_notifications ด้วย user JWT · cursor opaque
 * signed (encodeCursor/decodeCursor) · ขาออก zod strict drift → 503 · rate READ
 */
vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  process.env.RATE_LIMIT_READ_PER_MIN = "2";
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import { NotificationsPageView } from "./schema";
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

const USER_ID = "b0000000-0000-4000-8000-000000000001";
const N1 = "d0000000-0000-4000-8000-000000000001";
const N2 = "d0000000-0000-4000-8000-000000000002";
const T1 = "2026-09-10T01:00:00+00:00";
const T2 = "2026-09-10T02:00:00+00:00";

function itemFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: N1,
    recipient_id: "e0000000-0000-4000-8000-000000000001",
    topic: "exam.result",
    title: "ผลสอบผ่าน",
    body: "คุณสอบผ่านหลักสูตร A",
    severity: "success",
    ref_type: "assessment_attempt",
    ref_id: "a0000000-0000-4000-8000-000000000009",
    read_at: null,
    created_at: T1,
    ...overrides,
  };
}

/** ผล RPC — {items, unread_count, next_cursor:{unread,created_at,id}|null} ตาม §4.6 + D-p4-13 */
function rpcPageFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [itemFixture(), itemFixture({ id: N2, read_at: T2, created_at: T2, topic: "credit.adjusted", severity: "info", title: "หน่วยกิตเข้า", body: "ได้รับ 3 หน่วยกิต", ref_type: "credit_ledger", ref_id: "a0000000-0000-4000-8000-000000000008" })],
    unread_count: 1,
    next_cursor: { unread: false, created_at: T2, id: N2 },
    ...overrides,
  };
}

interface RpcSpec {
  data: unknown;
  error: { message: string } | null;
}

interface ClientSpec {
  session: boolean;
  rpcPage: RpcSpec;
}

/** client จำลอง: session + rpc(my_notifications) + profiles ของ requireUser */
function mockClient(spec: Partial<ClientSpec> = {}) {
  const full: ClientSpec = {
    session: true,
    rpcPage: { data: rpcPageFixture(), error: null },
    ...spec,
  };
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () =>
        full.session
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "no session" } },
      ),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1" },
          error: null,
        })),
      },
    },
    rpc: vi.fn((fn: string) => {
      if (fn === "my_notifications") {
        return Promise.resolve({ data: full.rpcPage.data, error: full.rpcPage.error });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn(() => profilesBuilder),
    _rpcArgs: undefined as Record<string, unknown> | undefined,
  };
  // เก็บ args ล่าสุดของ my_notifications เพื่อ assert พารามิเตอร์
  (client.rpc as ReturnType<typeof vi.fn>).mockImplementation((fn: string, args?: Record<string, unknown>) => {
    if (fn === "my_notifications") {
      client._rpcArgs = args;
      return Promise.resolve({ data: full.rpcPage.data, error: full.rpcPage.error });
    }
    return Promise.resolve({ data: null, error: null });
  });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function meUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/me/notifications" + query, {
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-1" },
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /me/notifications — 200 ทางหลัก", () => {
  it("200 { data } — strict ผ่าน + สะท้อน x-request-id + content-type json", async () => {
    mockClient();
    const res = await GET(meUrl());
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e14-1");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(() => NotificationsPageView.parse(body.data)).not.toThrow();
    expect((body.data.items as unknown[]).length).toBe(2);
    expect(body.data.unread_count).toBe(1);
    expect(typeof body.data.next_cursor).toBe("string");
  });

  it("next_cursor ของ response = signed cursor ที่แกะกลับได้เป็น (rank|created_at,id) ของแถวสุดท้าย", async () => {
    mockClient();
    const res = await GET(meUrl());
    const body = (await res.json()) as { data: { next_cursor: string } };

    const decoded = decodeCursor(body.data.next_cursor);
    expect(decoded.sortKey).toBe(`0|${T2}`); // แถวสุดท้าย fixture = read → rank "0"
    expect(decoded.id).toBe(N2);
  });

  it("ไม่ส่ง cursor → RPC รับ p_limit=20 (default) + p_after_* = null ทั้งสามค่า", async () => {
    const client = mockClient();
    await GET(meUrl());
    expect(client._rpcArgs).toEqual({
      p_limit: 20,
      p_after_unread: null,
      p_after_created_at: null,
      p_after_id: null,
    });
  });

  it("?limit=5 → RPC รับ p_limit=5 (1..50)", async () => {
    const client = mockClient();
    await GET(meUrl("?limit=5"));
    expect(client._rpcArgs?.["p_limit"]).toBe(5);
  });

  it("?cursor= ถูกต้อง → RPC รับทูเปิล (unread,created_at,id) จาก sortKey \"1|<ISO>\" + id", async () => {
    const client = mockClient();
    const cursor = encodeCursor({ sortKey: `1|${T1}`, id: N1 });
    await GET(meUrl(`?cursor=${encodeURIComponent(cursor)}`));
    expect(client._rpcArgs?.["p_after_unread"]).toBe(true);
    expect(client._rpcArgs?.["p_after_created_at"]).toBe(T1);
    expect(client._rpcArgs?.["p_after_id"]).toBe(N1);
  });

  it("?cursor= รูปเก่า (sortKey ลอย ไม่มี rank prefix) → 400 ERR-VAL-001 field=cursor (D-p4-13)", async () => {
    const client = mockClient();
    const cursor = encodeCursor({ sortKey: T1, id: N1 }); // ลงนามถูก แต่ไร้ prefix rank
    const res = await GET(meUrl(`?cursor=${encodeURIComponent(cursor)}`));
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.field).toBe("cursor");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("RPC next_cursor = null (หน้าสุดท้าย) → response next_cursor = null", async () => {
    mockClient({ rpcPage: { data: rpcPageFixture({ next_cursor: null }), error: null } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { data: { next_cursor: string | null } };
    expect(res.status).toBe(200);
    expect(body.data.next_cursor).toBeNull();
  });

  it("กล่องจดหมายว่าง (items [] · unread 0) → 200", async () => {
    mockClient({ rpcPage: { data: rpcPageFixture({ items: [], unread_count: 0, next_cursor: null }), error: null } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { data: { items: unknown[]; unread_count: number } };
    expect(res.status).toBe(200);
    expect(body.data.items).toEqual([]);
    expect(body.data.unread_count).toBe(0);
  });

  it("staff ยัง aal1 → 200 (ไม่มี MFA gate — เส้นข้อมูลของตัวเอง)", async () => {
    mockClient();
    const res = await GET(meUrl());
    expect(res.status).toBe(200);
  });
});

describe("GET /me/notifications — 401/400 ก่อนยิง RPC", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient({ session: false });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("?limit=0 → 400 ERR-VAL-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient();
    const res = await GET(meUrl("?limit=0"));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toContain("limit");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("?limit=51 (เกินเพดาน 50) → 400", async () => {
    const client = mockClient();
    const res = await GET(meUrl("?limit=51"));
    expect(res.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("?limit=abc → 400", async () => {
    const client = mockClient();
    const res = await GET(meUrl("?limit=abc"));
    expect(res.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("query key แปลกปลอม (?user_id=...) → 400 (ห้ามรับ user_id จาก query)", async () => {
    const client = mockClient();
    const res = await GET(meUrl("?user_id=b0000000-0000-4000-8000-000000000099"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("?cursor= ขยะ (decode ไม่ได้) → 400 ERR-VAL-001 field=cursor", async () => {
    const client = mockClient();
    const res = await GET(meUrl("?cursor=garbage-not-a-cursor"));
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.field).toBe("cursor");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("?cursor= ถูกแก้ (ลายเซ็นพัง) → 400 ERR-VAL-001", async () => {
    const client = mockClient();
    const cursor = encodeCursor({ sortKey: `1|${T1}`, id: N1 });
    const tampered = cursor.slice(0, -2) + "xx";
    const res = await GET(meUrl(`?cursor=${encodeURIComponent(tampered)}`));
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.field).toBe("cursor");
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("GET /me/notifications — ข้อผิดพลาดฝั่ง RPC/contract", () => {
  it("RPC error → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    mockClient({ rpcPage: { data: null, error: { message: "SQLSTATE XX000" } } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("ขาออก drift (item มีคีย์เกิน) → 503 ERR-SYS-002 reason notifications_contract_drift", async () => {
    const page = rpcPageFixture();
    ((page.items as unknown[])[0] as Record<string, unknown>)["extra"] = 1;
    mockClient({ rpcPage: { data: page, error: null } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("notifications_contract_drift");
  });

  it("ขาออก drift (unread_count ผิดชนิด) → 503", async () => {
    mockClient({ rpcPage: { data: rpcPageFixture({ unread_count: "หนึ่ง" }), error: null } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("RPC next_cursor รูปร่างผิด (ขาด id) → 503", async () => {
    mockClient({ rpcPage: { data: rpcPageFixture({ next_cursor: { created_at: T2 } }), error: null } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(res.status).toBe(503);
    expect(body.error.details?.reason).toBe("notifications_contract_drift");
  });

  it("RPC คืน array = drift → 503", async () => {
    mockClient({ rpcPage: { data: [itemFixture()], error: null } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(res.status).toBe(503);
    expect(body.error.details?.reason).toBe("notifications_contract_drift");
  });
});

describe("GET /me/notifications — rate READ (§5)", () => {
  it("เกิน 2/min (env ทดสอบ) → 429 ERR-RATE-001 details.group=READ + Retry-After", async () => {
    mockClient();
    let last: Response | null = null;
    for (let i = 0; i < 3; i += 1) {
      last = await GET(meUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
    expect(last?.headers.get("retry-after")).not.toBeNull();
  });
});

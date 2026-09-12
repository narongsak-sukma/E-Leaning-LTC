/**
 * route.test — POST /api/v1/me/notifications/{id}/read (Wave E Phase 4 · NTF-001 · §3.9)
 *
 * mock ssr client (requireUser จริง) + rate-limit จริง ตามแบบ me/credits/route.test.ts —
 * จุดหลัก: RPC my_notification_read ด้วย user JWT · :id uuid ผิดรูป → 400 · ไม่ใช่เจ้าของ =
 * RPC โยน '(ERR-NF-001)' → 404 · idempotent ซ้ำก็ 204 · ไม่มีป้าย → 503 opaque · rate READ
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
import { POST } from "./route";

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
const NOTIF_ID = "d0000000-0000-4000-8000-000000000001";
const NOTIF_ID_OTHER = "d0000000-0000-4000-8000-000000000099";

interface ReadSpec {
  session: boolean;
  rpcResult: { data: unknown; error: { message: string } | null };
}

/** client จำลอง: session + rpc(my_notification_read) + profiles ของ requireUser */
function mockClient(spec: Partial<ReadSpec> = {}) {
  const full: ReadSpec = {
    session: true,
    rpcResult: { data: null, error: null },
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
      if (fn === "my_notification_read") {
        return Promise.resolve(full.rpcResult);
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn(() => profilesBuilder),
    _rpcArgs: undefined as Record<string, unknown> | undefined,
  };
  (client.rpc as ReturnType<typeof vi.fn>).mockImplementation((fn: string, args?: Record<string, unknown>) => {
    if (fn === "my_notification_read") {
      client._rpcArgs = args;
      return Promise.resolve(full.rpcResult);
    }
    return Promise.resolve({ data: null, error: null });
  });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function readRequest(id: string): Request {
  return new Request(`http://localhost:3000/api/v1/me/notifications/${id}/read`, {
    method: "POST",
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-2" },
  });
}

async function post(id: string, spec: Partial<ReadSpec> = {}): Promise<{ res: Response; client: ReturnType<typeof mockClient> }> {
  const client = mockClient(spec);
  const res = await POST(readRequest(id), { params: Promise.resolve({ id }) } as never);
  return { res, client };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("POST /me/notifications/{id}/read — 204 ทางหลัก", () => {
  it("204 ว่าง — ไม่มี body และไม่มี content-type (jsonNoContent) + p_notification_id ถูกต้อง", async () => {
    const { res, client } = await post(NOTIF_ID);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("x-request-id")).toBe("req-e14-2");
    expect(client._rpcArgs).toEqual({ p_notification_id: NOTIF_ID });
  });

  it("idempotent — อ่านซ้ำ (RPC สำเร็จอีกครั้ง) ก็ 204 เท่าเดิม", async () => {
    await post(NOTIF_ID);
    const second = await post(NOTIF_ID);
    expect(second.res.status).toBe(204);
  });

  it("staff ยัง aal1 → 204 (ไม่มี MFA gate — เส้นข้อมูลของตัวเอง)", async () => {
    const { res } = await post(NOTIF_ID);
    expect(res.status).toBe(204);
  });
});

describe("POST /me/notifications/{id}/read — 401/400 ก่อนยิง RPC", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก RPC)", async () => {
    const { res, client } = await post(NOTIF_ID, { session: false });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it(":id ผิดรูป (ไม่ใช่ uuid) → 400 ERR-VAL-001 fields=[\"id\"] (ไม่เรียก RPC)", async () => {
    const { res, client } = await post("not-a-uuid");
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toEqual(["id"]);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /me/notifications/{id}/read — error จาก RPC", () => {
  it("ไม่ใช่เจ้าของ → RPC โยน '(ERR-NF-001)' → 404 envelope (ไม่ leak SQL)", async () => {
    const { res } = await post(NOTIF_ID_OTHER, {
      rpcResult: { data: null, error: { message: "ไม่พบรายการแจ้งเตือนนี้หรือไม่ใช่ของคุณ (ERR-NF-001)" } },
    });
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.message).toBe("ไม่พบข้อมูลที่ต้องการ");
    expect(body.error.message).not.toContain("notification");
  });

  it("RPC error ไม่มีป้าย code → 503 ERR-SYS-002 opaque", async () => {
    const { res } = await post(NOTIF_ID, {
      rpcResult: { data: null, error: { message: "SQLSTATE XX000 something" } },
    });
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("RPC โยน code นอกทะเบียน '(ERR-XXX-999)' → 503 ERR-SYS-002", async () => {
    const { res } = await post(NOTIF_ID, {
      rpcResult: { data: null, error: { message: "boom (ERR-XXX-999)" } },
    });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

describe("POST /me/notifications/{id}/read — rate READ (§5)", () => {
  it("เกิน 2/min (env ทดสอบ) → 429 ERR-RATE-001 details.group=READ", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 3; i += 1) {
      const r = await post(NOTIF_ID);
      last = r.res;
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

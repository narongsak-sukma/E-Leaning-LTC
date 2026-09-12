/**
 * route.test — GET /api/v1/profile/export (IDENT-008 · D-p5-7 · #90)
 *
 * mock ssr client (requireUser จริง) + rate-limit จริง ตามแบบ profile/consents —
 * จุดหลัก: RPC my_request_data_export ด้วย user JWT → 202 {jobId, status} ทันที ·
 * query ต้องว่าง (key ใด ๆ → 400) · export_pending → 409 · export_cooldown → 429 ·
 * ไม่มีป้าย → 503 opaque · drift → 503 · rate EXPORT ต่อ user_id + ip
 */
vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  process.env.RATE_LIMIT_EXPORT_PER_HOUR = "2";
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { ExportJobView } from "./schema";
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
const JOB_ID = "d0000000-0000-4000-8000-000000000002";

interface ClientSpec {
  session: boolean;
  rpcResult: { data: unknown; error: { message: string } | null };
}

/** client จำลอง: session + rpc my_request_data_export + profiles ของ requireUser */
function mockClient(spec: Partial<ClientSpec> = {}) {
  const full: ClientSpec = {
    session: true,
    rpcResult: { data: { jobId: JOB_ID, status: "pending" }, error: null },
    ...spec,
  };
  const profilesBuilder = {
    select: () => profilesBuilder,
    eq: () => profilesBuilder,
    maybeSingle: async () => ({ data: { is_active: true, deleted_at: null }, error: null }),
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
    rpc: vi.fn(async (fn: string) => {
      if (fn === "my_request_data_export") {
        return full.rpcResult;
      }
      return { data: null, error: null };
    }),
    from: () => profilesBuilder,
    _rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  };
  (client.rpc as ReturnType<typeof vi.fn>).mockImplementation((fn: string, args?: Record<string, unknown>) => {
    client._rpcCalls.push({ fn, args: args ?? {} });
    if (fn === "my_request_data_export") {
      return Promise.resolve(full.rpcResult);
    }
    return Promise.resolve({ data: null, error: null });
  });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function getUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/profile/export" + query, {
    headers: { "x-forwarded-for": "10.0.0.8", "x-request-id": "req-e15-7" },
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /profile/export — 202 ทางหลัก", () => {
  it("202 {jobId, status} + x-request-id + content-type + p_request_id จาก header", async () => {
    const client = mockClient();
    const res = await GET(getUrl());
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(202);
    expect(res.headers.get("x-request-id")).toBe("req-e15-7");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(() => ExportJobView.parse(body.data)).not.toThrow();
    expect(body.data).toEqual({ jobId: JOB_ID, status: "pending" });
    const call = client._rpcCalls.find((c) => c.fn === "my_request_data_export");
    expect(call?.args).toEqual({ p_request_id: "req-e15-7" });
  });

  it("RPC คืน array หลักเดียว (r8-N2) → คลี่แล้ว 202", async () => {
    mockClient({ rpcResult: { data: [{ jobId: JOB_ID, status: "pending" }], error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { data: { jobId: string; status: string } };
    expect(res.status).toBe(202);
    expect(body.data).toEqual({ jobId: JOB_ID, status: "pending" });
  });
});

describe("GET /profile/export — 401/400/409/429/503", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient({ session: false });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("query key แปลกปลอม (?limit=...) → 400 ERR-VAL-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient();
    const res = await GET(getUrl("?limit=20"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("RPC โยน export_pending → 409 + code ตามป้าย + reason", async () => {
    mockClient({ rpcResult: { data: null, error: { message: "มี job ค้าง (ERR-VAL-001|export_pending)" } } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.reason).toBe("export_pending");
  });

  it("RPC โยน export_cooldown → 429 + reason", async () => {
    mockClient({ rpcResult: { data: null, error: { message: "เย็น (ERR-VAL-001|export_cooldown)" } } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(429);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.reason).toBe("export_cooldown");
  });

  it("RPC error ไม่มีป้าย → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    mockClient({ rpcResult: { data: null, error: { message: "SQLSTATE XX000" } } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("drift — RPC คืนคีย์เกิน → 503 reason export_job_view_drift", async () => {
    mockClient({ rpcResult: { data: { jobId: JOB_ID, status: "pending", extra: 1 }, error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("export_job_view_drift");
  });
});

describe("GET /profile/export — rate EXPORT (§5)", () => {
  it("เกิน 2/ชม. (env ทดสอบ) → 429 ERR-RATE-001 details.group=EXPORT", async () => {
    mockClient();
    let last: Response | null = null;
    for (let i = 0; i < 3; i += 1) {
      last = await GET(getUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("EXPORT");
  });
});

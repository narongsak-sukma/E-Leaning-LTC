/**
 * route.test — GET /api/v1/me/credits (Wave E Phase 3 · API-SPECIFICATION 1.1.0 §3)
 *
 * mock ssr client (requireUser จริง) + rate-limit จริง (resetRateLimitStore) ตามแบบ
 * me/certificates/route.test.ts — จุดหลัก: RPC my_credit_summary ด้วย user JWT ·
 * citizen (current null) = 200 ไม่ error · ขาออก zod strict drift → 503 · rate READ
 */
process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { CreditSummaryView } from "@/lib/api/credits";
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
const CYCLE_ID = "a0000000-0000-4000-8000-000000000001";
const T1 = "2026-01-01";
const T2 = "2026-12-31";

function cycleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cycle_id: CYCLE_ID,
    cycle_no: 1,
    starts_on: T1,
    ends_on: T2,
    status: "open",
    required_credits: { general: 12 },
    balances: { general: { earned: 3.5, required: 12, missing: 8.5 } },
    ...overrides,
  };
}

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    current: cycleFixture(),
    history: [cycleFixture()],
    ...overrides,
  };
}

function meUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/me/credits" + query, {
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e10-1" },
  });
}

/** client จำลอง: session + rpc (my_credit_summary) + profiles ของ requireUser */
function mockClient(
  rpcData: unknown,
  options: {
    rpcError?: { message: string };
    roles?: readonly string[];
    aal?: "aal1" | "aal2";
    session?: boolean;
  } = {},
) {
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
      if (fn === "my_credit_summary") {
        return Promise.resolve({ data: rpcData, error: options.rpcError ?? null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn(() => profilesBuilder),
    _calls: { rpc: [] as string[] },
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /me/credits — envelope + ขอบเขตเจ้าของใน RPC", () => {
  it("200 { data } — strict ผ่าน + สะท้อน x-request-id + content-type json", async () => {
    const payload = summaryFixture();
    mockClient(payload);
    const res = await GET(meUrl());
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e10-1");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(() => CreditSummaryView.parse(body.data)).not.toThrow();
    expect(body.data).toEqual(payload);
  });

  it("citizen (current null, history []) → 200 ไม่ error", async () => {
    mockClient(summaryFixture({ current: null, history: [] }));
    const res = await GET(meUrl());
    const body = (await res.json()) as { data: { current: unknown; history: unknown[] } };

    expect(res.status).toBe(200);
    expect(body.data.current).toBeNull();
    expect(body.data.history).toEqual([]);
  });

  it("staff ยัง aal1 → ยังได้ 200 (ไม่มี MFA gate — allowlist AUTH-007 เหมือน /me)", async () => {
    mockClient(summaryFixture(), { roles: ["super_admin"], aal: "aal1" });
    const res = await GET(meUrl());
    expect(res.status).toBe(200);
  });

  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient(summaryFixture(), { session: false });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("RPC error → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    mockClient(null, { rpcError: { message: "SQLSTATE XX000" } });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("ขาออก drift (คีย์เกิน) → 503 ERR-SYS-002 reason credit_summary_contract_drift", async () => {
    const drifted = summaryFixture();
    (drifted as Record<string, unknown>)["extra"] = 1;
    mockClient(drifted);
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("credit_summary_contract_drift");
  });

  it("ขาออก drift (current.cycle_no ผิดชนิด) → 503 ERR-SYS-002", async () => {
    mockClient(summaryFixture({ current: cycleFixture({ cycle_no: "หนึ่ง" }) }));
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("RPC คืน array/null = drift → 503", async () => {
    mockClient([cycleFixture()]);
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.details?.reason).toBe("credit_summary_contract_drift");
  });
});

describe("GET /me/credits — rate READ (§5)", () => {
  it("เกิน 120/min → 429 ERR-RATE-001 details.group=READ", async () => {
    mockClient(summaryFixture());
    let last: Response | null = null;
    for (let i = 0; i < 121; i += 1) {
      last = await GET(meUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

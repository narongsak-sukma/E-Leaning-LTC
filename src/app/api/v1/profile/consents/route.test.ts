/**
 * route.test — GET/PATCH /api/v1/profile/consents (Wave E Phase 4 · D12-17 · §3.2 L142-143)
 *
 * mock ssr client (requireUser จริง) + rate-limit จริง ตามแบบ me/credits/route.test.ts —
 * จุดหลัก: RPC my_consents_get/my_consents_update ด้วย user JWT · GET ประกอบ 2 sections
 * (notice_acknowledgments = [] · consents จาก RPC) · PATCH {type,action} strict → {type,status} ·
 * type/action ผิด → 400 · drift → 503 · rate READ
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
import { ConsentStatusView, ConsentsView } from "./schema";
import { GET, PATCH } from "./route";

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
const T = "2026-09-10T01:02:03+00:00";

/** consent หนึ่งรายการตาม §3.2 — {type,status,updated_at} */
function consentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "marketing", status: "granted", updated_at: T, ...overrides };
}

interface ClientSpec {
  session: boolean;
  getResult: { data: unknown; error: { message: string } | null };
  updateResult: { data: unknown; error: { message: string } | null };
}

/** client จำลอง: session + rpc สองตัว (consents get/update) + profiles ของ requireUser */
function mockClient(spec: Partial<ClientSpec> = {}) {
  const full: ClientSpec = {
    session: true,
    getResult: { data: [consentFixture(), consentFixture({ type: "email_notify", status: "revoked" })], error: null },
    updateResult: { data: { type: "marketing", status: "granted" }, error: null },
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
      if (fn === "my_consents_get") {
        return Promise.resolve(full.getResult);
      }
      if (fn === "my_consents_update") {
        return Promise.resolve(full.updateResult);
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn(() => profilesBuilder),
    _rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  };
  (client.rpc as ReturnType<typeof vi.fn>).mockImplementation((fn: string, args?: Record<string, unknown>) => {
    client._rpcCalls.push({ fn, args: args ?? {} });
    if (fn === "my_consents_get") {
      return Promise.resolve(full.getResult);
    }
    if (fn === "my_consents_update") {
      return Promise.resolve(full.updateResult);
    }
    return Promise.resolve({ data: null, error: null });
  });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function getUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/profile/consents" + query, {
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-4" },
  });
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/profile/consents", {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-4" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /profile/consents — 200 ทางหลัก", () => {
  it("200 2 sections — notice_acknowledgments [] + consents จาก RPC + x-request-id + content-type", async () => {
    mockClient();
    const res = await GET(getUrl());
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e14-4");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(() => ConsentsView.parse(body.data)).not.toThrow();
    expect(body.data["notice_acknowledgments"]).toEqual([]);
    expect((body.data["consents"] as unknown[]).length).toBe(2);
  });

  it("RPC คืน {consents: [...]} ห่อ (ไม่ใช่ array ตรง) → ยัง 200 (คลี่สองรูปตามสัญญาที่ยังล็อกไม่แน่)", async () => {
    mockClient({ getResult: { data: { consents: [consentFixture()] }, error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { data: { consents: unknown[] } };
    expect(res.status).toBe(200);
    expect(body.data.consents.length).toBe(1);
  });

  it("ยังไม่เคยให้ consent ใด (RPC คืน []) → 200 consents []", async () => {
    mockClient({ getResult: { data: [], error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { data: { consents: unknown[] } };
    expect(res.status).toBe(200);
    expect(body.data.consents).toEqual([]);
  });

  it("ไม่มี MFA gate — staff aal1 → 200", async () => {
    mockClient();
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
  });
});

describe("GET /profile/consents — 401/400/503", () => {
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

  it("RPC error → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    mockClient({ getResult: { data: null, error: { message: "SQLSTATE XX000" } } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("drift — consent มีคีย์เกิน → 503 ERR-SYS-002 reason consents_read_drift", async () => {
    const drifted = consentFixture();
    drifted["extra"] = 1;
    mockClient({ getResult: { data: [drifted], error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("consents_read_drift");
  });

  it("drift — status นอก enum (\"maybe\") → 503", async () => {
    mockClient({ getResult: { data: [consentFixture({ status: "maybe" })], error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

describe("PATCH /profile/consents — 200 ทางหลัก", () => {
  it("grant marketing → 200 {type,status} + p_type/p_action ตรง body + ไม่ผ่าน service client", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ type: "marketing", action: "grant" }));
    const body = (await res.json()) as { data: { type: string; status: string } };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e14-4");
    expect(() => ConsentStatusView.parse(body.data)).not.toThrow();
    expect(body.data).toEqual({ type: "marketing", status: "granted" });
    const updateCall = client._rpcCalls.find((c) => c.fn === "my_consents_update");
    expect(updateCall?.args).toEqual({ p_type: "marketing", p_action: "grant" });
  });

  it("revoke email_notify → 200 {type: email_notify, status: revoked}", async () => {
    mockClient({ updateResult: { data: { type: "email_notify", status: "revoked" }, error: null } });
    const res = await PATCH(patchRequest({ type: "email_notify", action: "revoke" }));
    const body = (await res.json()) as { data: { type: string; status: string } };

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ type: "email_notify", status: "revoked" });
  });

  it("RPC คืน array หลักเดียว (r8-N2) → คลี่แล้ว 200", async () => {
    mockClient({ updateResult: { data: [{ type: "marketing", status: "granted" }], error: null } });
    const res = await PATCH(patchRequest({ type: "marketing", action: "grant" }));
    const body = (await res.json()) as { data: { type: string; status: string } };
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ type: "marketing", status: "granted" });
  });
});

describe("PATCH /profile/consents — 401/400 ก่อนยิง RPC", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient({ session: false });
    const res = await PATCH(patchRequest({ type: "marketing", action: "grant" }));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("type ที่ไม่ optional (pdpa_essential) → 400 ERR-VAL-001 (ไม่เรียก RPC update)", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ type: "pdpa_essential", action: "grant" }));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_consents_update");
    expect(updateCalls.length).toBe(0);
  });
});

describe("PATCH /profile/consents — error จาก RPC + rate", () => {
  it("action ผิด (\"toggle\") → 400 ERR-VAL-001 (ไม่เรียก RPC update)", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ type: "marketing", action: "toggle" }));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toContain("action");
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_consents_update");
    expect(updateCalls.length).toBe(0);
  });

  it("คีย์เกินที่ root (extra: 1) → 400 strict", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ type: "marketing", action: "grant", extra: 1 }));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_consents_update");
    expect(updateCalls.length).toBe(0);
  });

  it("body parse ไม่ได้ (JSON พัง) → 400 ERR-VAL-001 fields=[\"body\"]", async () => {
    const client = mockClient();
    const res = await PATCH(new Request("http://localhost:3000/api/v1/profile/consents", {
      method: "PATCH",
      headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-4" },
      body: "{bad json",
    }));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.details?.fields).toEqual(["body"]);
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_consents_update");
    expect(updateCalls.length).toBe(0);
  });

  it("RPC โยน '(ERR-VAL-001|unknown_type)' → 400 + details.reason", async () => {
    mockClient({ updateResult: { data: null, error: { message: "type ไม่รองรับ (ERR-VAL-001|unknown_type)" } } });
    const res = await PATCH(patchRequest({ type: "marketing", action: "grant" }));
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.reason).toBe("unknown_type");
  });

  it("RPC error ไม่มีป้าย → 503 ERR-SYS-002 opaque", async () => {
    mockClient({ updateResult: { data: null, error: { message: "SQLSTATE XX000" } } });
    const res = await PATCH(patchRequest({ type: "marketing", action: "grant" }));
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });
});

describe("PATCH /profile/consents — rate READ (§5)", () => {
  it("เกิน 2/min (env ทดสอบ) → 429 ERR-RATE-001 details.group=READ", async () => {
    mockClient();
    let last: Response | null = null;
    for (let i = 0; i < 3; i += 1) {
      last = await PATCH(patchRequest({ type: "marketing", action: "grant" }));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

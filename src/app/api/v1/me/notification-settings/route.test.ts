/**
 * route.test — GET/PATCH /api/v1/me/notification-settings (Wave E Phase 4 · NTF-005 · §3.9)
 *
 * mock ssr client (requireUser จริง) + rate-limit จริง ตามแบบ me/credits/route.test.ts —
 * จุดหลัก: RPC my_notification_settings / my_notification_settings_update ด้วย user JWT ·
 * body strict (4 family · boolean · บางส่วนได้) · ตอบค่าใหม่ทั้งก้อน · drift → 503 · rate READ
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
import { FamilySettingsPatch, NotificationSettingsView } from "./schema";
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

/** settings ครบ 4 family (RPC คืน default ครบเสมอ — D-p4-5) */
function settingsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "exam.result": { in_app: true, email: true },
    certificate: { in_app: true, email: true },
    credit: { in_app: true, email: true },
    renewal: { in_app: true, email: false },
    ...overrides,
  };
}

interface RpcSpec {
  data: unknown;
  error: { message: string } | null;
}

interface ClientSpec {
  session: boolean;
  getResult: RpcSpec;
  updateResult: RpcSpec;
}

/** client จำลอง: session + rpc สองตัว (settings/update) + profiles ของ requireUser */
function mockClient(spec: Partial<ClientSpec> = {}) {
  const full: ClientSpec = {
    session: true,
    getResult: { data: settingsFixture(), error: null },
    updateResult: { data: settingsFixture({ "exam.result": { in_app: true, email: false } }), error: null },
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
      if (fn === "my_notification_settings") {
        return Promise.resolve(full.getResult);
      }
      if (fn === "my_notification_settings_update") {
        return Promise.resolve(full.updateResult);
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn(() => profilesBuilder),
    _rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  };
  (client.rpc as ReturnType<typeof vi.fn>).mockImplementation((fn: string, args?: Record<string, unknown>) => {
    client._rpcCalls.push({ fn, args: args ?? {} });
    if (fn === "my_notification_settings") {
      return Promise.resolve(full.getResult);
    }
    if (fn === "my_notification_settings_update") {
      return Promise.resolve(full.updateResult);
    }
    return Promise.resolve({ data: null, error: null });
  });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function getUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/me/notification-settings" + query, {
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-3" },
  });
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/me/notification-settings", {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-3" },
    body: JSON.stringify(body),
  });
}

function patchRaw(body: string): Request {
  return new Request("http://localhost:3000/api/v1/me/notification-settings", {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e14-3" },
    body,
  });
}
beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /me/notification-settings — 200 ทางหลัก", () => {
  it("200 { data: { settings } } — ครบ 4 family + สะท้อน x-request-id + content-type json", async () => {
    mockClient();
    const res = await GET(getUrl());
    const body = (await res.json()) as { data: { settings: Record<string, unknown> } };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e14-3");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(() => NotificationSettingsView.parse(body.data)).not.toThrow();
    expect(Object.keys(body.data.settings).sort()).toEqual(["certificate", "credit", "exam.result", "renewal"]);
  });

  it("RPC คืนก้อน settings ห่อ {settings: {...}} ก็ยัง 200 (คลี่สองรูปตามสัญญาที่ยังล็อกไม่แน่)", async () => {
    mockClient({ getResult: { data: { settings: settingsFixture() }, error: null } });
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { settings: Record<string, unknown> } };
    expect(Object.keys(body.data.settings).length).toBe(4);
  });

  it("ไม่มี MFA gate — staff aal1 → 200", async () => {
    mockClient();
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
  });
});

describe("GET /me/notification-settings — 401/400/503", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient({ session: false });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("query key แปลกปลอม (?user_id=...) → 400 ERR-VAL-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient();
    const res = await GET(getUrl("?user_id=b0000000-0000-4000-8000-000000000099"));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toContain("user_id");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("RPC error → 503 ERR-SYS-002 opaque", async () => {
    mockClient({ getResult: { data: null, error: { message: "SQLSTATE XX000" } } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("drift — RPC คืนขาด family → 503 ERR-SYS-002 reason notification_settings_read_drift", async () => {
    const partial = settingsFixture();
    delete partial["renewal"];
    mockClient({ getResult: { data: partial, error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("notification_settings_read_drift");
  });

  it("drift — RPC คืน array → 503", async () => {
    mockClient({ getResult: { data: [settingsFixture()], error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.details?.reason).toBe("notification_settings_read_drift");
  });

  it("drift — family value ผิดชนิด (in_app เป็น string) → 503", async () => {
    mockClient({ getResult: { data: settingsFixture({ credit: { in_app: "ใช่", email: true } }), error: null } });
    const res = await GET(getUrl());
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

describe("PATCH /me/notification-settings — 200 ทางหลัก", () => {
  it("ส่งบางส่วน { settings: { 'exam.result': { email: false } } } → 200 ค่าใหม่ทั้งก้อน + p_settings ตรง body", async () => {
    const client = mockClient();
    const bodyIn = { settings: { "exam.result": { email: false } } };
    const res = await PATCH(patchRequest(bodyIn));
    const body = (await res.json()) as { data: { settings: Record<string, unknown> } };

    expect(res.status).toBe(200);
    expect(() => NotificationSettingsView.parse(body.data)).not.toThrow();
    expect(body.data.settings["exam.result"]).toEqual({ in_app: true, email: false });
    expect(client._rpcCalls.some((c) => c.fn === "my_notification_settings_update")).toBe(true);
    const updateCall = client._rpcCalls.find((c) => c.fn === "my_notification_settings_update");
    expect(updateCall?.args["p_settings"]).toEqual(bodyIn.settings);
  });

  it("ส่งหลาย family + สองช่องทาง → 200", async () => {
    mockClient();
    const bodyIn = { settings: { credit: { in_app: false, email: false }, renewal: { email: true } } };
    const res = await PATCH(patchRequest(bodyIn));
    expect(res.status).toBe(200);
  });

  it("RPC คืน array หลักเดียว (r8-N2) → คลี่แล้ว 200", async () => {
    mockClient({ updateResult: { data: [settingsFixture({ certificate: { in_app: true, email: false } })], error: null } });
    const res = await PATCH(patchRequest({ settings: { certificate: { email: false } } }));
    const body = (await res.json()) as { data: { settings: Record<string, unknown> } };
    expect(res.status).toBe(200);
    expect(body.data.settings["certificate"]).toEqual({ in_app: true, email: false });
  });
});

describe("PATCH /me/notification-settings — 401/400 ก่อนยิง RPC", () => {
  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    const client = mockClient({ session: false });
    const res = await PATCH(patchRequest({ settings: { credit: { email: false } } }));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("body parse ไม่ได้ (JSON พัง) → 400 ERR-VAL-001 fields=[\"body\"]", async () => {
    const client = mockClient();
    const res = await PATCH(patchRaw("{not json"));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toEqual(["body"]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("family แปลกปลอม → 400 (ไม่เรียก RPC update)", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ settings: { spam: { email: false } } }));
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_notification_settings_update");
    expect(updateCalls.length).toBe(0);
  });

  it("ค่าที่ไม่ใช่ boolean (in_app: \"yes\") → 400", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ settings: { credit: { in_app: "yes" } } }));
    expect(res.status).toBe(400);
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_notification_settings_update");
    expect(updateCalls.length).toBe(0);
  });

  it("family object ว่าง {} → 400 (ต้องมีอย่างน้อย 1 คีย์ต่อ family)", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ settings: { credit: {} } }));
    expect(res.status).toBe(400);
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_notification_settings_update");
    expect(updateCalls.length).toBe(0);
  });

  it("settings ว่าง {} → 400 (ต้องมีอย่างน้อย 1 family)", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ settings: {} }));
    expect(res.status).toBe(400);
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_notification_settings_update");
    expect(updateCalls.length).toBe(0);
  });

  it("คีย์เกินนอก schema (settings เป็น array) → 400", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ settings: [] }));
    expect(res.status).toBe(400);
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_notification_settings_update");
    expect(updateCalls.length).toBe(0);
  });

  it("คีย์เกินที่ root (extra: 1) → 400 strict", async () => {
    const client = mockClient();
    const res = await PATCH(patchRequest({ settings: { credit: { email: true } }, extra: 1 }));
    expect(res.status).toBe(400);
    const updateCalls = client._rpcCalls.filter((c) => c.fn === "my_notification_settings_update");
    expect(updateCalls.length).toBe(0);
  });

  it("FamilySettingsPatch schema: คุณสมบัติ optional ทั้งคู่ + strict ตรวจก่อนถึง handler (สมบัติ schema unit)", () => {
    expect(() => FamilySettingsPatch.parse({})).toThrow();
    expect(() => FamilySettingsPatch.parse({ in_app: true })).not.toThrow();
    expect(() => FamilySettingsPatch.parse({ in_app: true, email: false })).not.toThrow();
    expect(() => FamilySettingsPatch.parse({ in_app: true, other: 1 } as never)).toThrow();
  });
});

describe("PATCH /me/notification-settings — error จาก RPC + rate", () => {
  it("RPC โยน '(ERR-VAL-001|invalid_family)' → 400 + details.reason", async () => {
    mockClient({ updateResult: { data: null, error: { message: "family ไม่ถูกต้อง (ERR-VAL-001|invalid_family)" } } });
    const res = await PATCH(patchRequest({ settings: { credit: { email: false } } }));
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.reason).toBe("invalid_family");
  });

  it("RPC error ไม่มีป้าย → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    mockClient({ updateResult: { data: null, error: { message: "SQLSTATE XX000" } } });
    const res = await PATCH(patchRequest({ settings: { credit: { email: false } } }));
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("drift — RPC ตอบ settings ไม่ครบ 4 family → 503 reason notification_settings_updated_drift", async () => {
    const partial = settingsFixture();
    delete partial["certificate"];
    mockClient({ updateResult: { data: partial, error: null } });
    const res = await PATCH(patchRequest({ settings: { credit: { email: false } } }));
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.details?.reason).toBe("notification_settings_updated_drift");
  });

  it("เกิน 2/min (env ทดสอบ) → 429 ERR-RATE-001 details.group=READ", async () => {
    mockClient();
    let last: Response | null = null;
    for (let i = 0; i < 3; i += 1) {
      last = await PATCH(patchRequest({ settings: { credit: { email: false } } }));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

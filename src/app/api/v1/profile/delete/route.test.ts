/**
 * route.test — POST /api/v1/profile/delete (SEC-012 · D-p5-8 · #90)
 *
 * mock ssr client (requireUser จริง) + mock lib/pdpa/deletion (unit ล้วน) — จุดหลัก:
 * 202 {requestId, expiresAt} เท่านั้น (**ไม่มี token ใน response — D24**) · 401 ·
 * SoD → 403 ERR-RBAC-001 · delete_pending → 409 (override ตามป้าย RPC) ·
 * already_deleted → 400 · drift ขาออก → 503 · rate READ (§5)
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
import { AppError } from "@/lib/errors";
import { requestAccountDeletion } from "@/lib/pdpa/deletion";
import { DeleteRequestView } from "./schema";
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
vi.mock("@/lib/pdpa/deletion", () => ({ requestAccountDeletion: vi.fn() }));

const USER_ID = "b0000000-0000-4000-8000-000000000001";
const REQUEST_ID = "c0000000-0000-4000-8000-000000000009";
const EXPIRES = "2026-09-13T00:00:00+00:00";

interface ClientSpec {
  session: boolean;
}

/** client จำลองของ requireUser — session + profiles aal1 */
function mockClient(spec: Partial<ClientSpec> = {}) {
  const full: ClientSpec = { session: true, ...spec };
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
    from: () => profilesBuilder,
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function postRequest(): Request {
  return new Request("http://localhost:3000/api/v1/profile/delete", {
    method: "POST",
    headers: { "x-forwarded-for": "10.0.0.7", "x-request-id": "req-e15-8" },
  });
}

function okOutcome(): { requestId: string; expiresAt: string } {
  return { requestId: REQUEST_ID, expiresAt: EXPIRES };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(requestAccountDeletion).mockReset();
  vi.mocked(requestAccountDeletion).mockResolvedValue(okOutcome());
  resetRateLimitStore();
});

describe("POST /profile/delete — 202 ทางหลัก", () => {
  it("202 {requestId, expiresAt} + x-request-id + **ไม่มี token** (D24)", async () => {
    mockClient();
    const res = await POST(postRequest());
    const raw = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(202);
    expect(res.headers.get("x-request-id")).toBe("req-e15-8");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(() => DeleteRequestView.parse(raw.data)).not.toThrow();
    expect(raw.data).toEqual({ requestId: REQUEST_ID, expiresAt: EXPIRES });
    expect("token" in (raw.data as object)).toBe(false);
    expect(JSON.stringify(raw).includes("token")).toBe(false);
  });

  it("ส่ง x-request-id เข้า lib ตรงค่า (p_request_id ของ RPC)", async () => {
    mockClient();
    await POST(postRequest());

    expect(vi.mocked(requestAccountDeletion)).toHaveBeenCalledWith("req-e15-8");
  });

  it("ไม่มี x-request-id → lib รับ null", async () => {
    mockClient();
    await POST(new Request("http://localhost:3000/api/v1/profile/delete", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.7" },
    }));

    expect(vi.mocked(requestAccountDeletion)).toHaveBeenCalledWith(null);
  });
});

describe("POST /profile/delete — 401 + error map ตามป้าย", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก lib)", async () => {
    mockClient({ session: false });
    const res = await POST(postRequest());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(vi.mocked(requestAccountDeletion)).not.toHaveBeenCalled();
  });

  it("ป้าย account_delete_sod (AppError 403) → 403 ERR-RBAC-001", async () => {
    mockClient();
    vi.mocked(requestAccountDeletion).mockRejectedValue(
      new AppError("ERR-RBAC-001", { details: { reason: "account_delete_sod" } }),
    );
    const res = await POST(postRequest());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details?.reason).toBe("account_delete_sod");
  });

  it("ป้าย delete_pending → 409 (override สถานะตาม spec)", async () => {
    mockClient();
    vi.mocked(requestAccountDeletion).mockRejectedValue(
      new AppError("ERR-VAL-001", { details: { reason: "delete_pending" } }),
    );
    const res = await POST(postRequest());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.reason).toBe("delete_pending");
  });

  it("ป้าย already_deleted → 400 (ทะเบียน default ของ ERR-VAL-001)", async () => {
    mockClient();
    vi.mocked(requestAccountDeletion).mockRejectedValue(
      new AppError("ERR-VAL-001", { details: { reason: "already_deleted" } }),
    );
    const res = await POST(postRequest());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("ล้ม ERR-SYS-002 → 503 opaque", async () => {
    mockClient();
    vi.mocked(requestAccountDeletion).mockRejectedValue(
      new AppError("ERR-SYS-002", { details: { reason: "deletion_request_failed" } }),
    );
    const res = await POST(postRequest());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("drift — lib คืนคีย์เกิน → 503 reason delete_request_view_drift", async () => {
    mockClient();
    vi.mocked(requestAccountDeletion).mockResolvedValue({
      requestId: REQUEST_ID,
      expiresAt: EXPIRES,
      extra: 1,
    } as never);
    const res = await POST(postRequest());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("delete_request_view_drift");
  });
});

describe("POST /profile/delete — rate READ (§5)", () => {
  it("เกิน 2/min (env ทดสอบ) → 429 ERR-RATE-001 details.group=READ", async () => {
    mockClient();
    let last: Response | null = null;
    for (let i = 0; i < 3; i += 1) {
      last = await POST(postRequest());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

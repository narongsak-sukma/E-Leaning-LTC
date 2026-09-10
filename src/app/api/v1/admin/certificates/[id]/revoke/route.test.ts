/**
 * route.test — POST /api/v1/admin/certificates/:id/revoke (Wave D-4 · SoD T9 + reason contract)
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
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});
vi.mock("@/lib/certificates/revoke", () => ({
  MIN_REASON_LENGTH: 10,
  revokeCertificate: vi.fn(),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { revokeCertificate } from "@/lib/certificates/revoke";
import { POST } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";

const revoked = {
  id: CERT_ID,
  certNo: "LTC-2026-000123",
  status: "revoked",
  revokedAt: "2026-09-08T05:00:00+00:00",
  revokedReason: "ตรวจพบการทุจริตในการสอบ",
};

function mockAuth(roles: readonly string[], aal: "aal1" | "aal2" = "aal2") {
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: STAFF_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: aal }, error: null })),
      },
    },
    rpc: vi.fn(async (fn: string) => (fn === "my_roles" ? { data: roles, error: null } : { data: null, error: null })),
    from: vi.fn(() => profilesBuilder),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
}

function revokeUrl(id = CERT_ID): Request {
  return new Request(`http://localhost:3000/api/v1/admin/certificates/${id}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d4-3" },
    body: JSON.stringify({ reason: "ตรวจพบการทุจริตในการสอบ" }),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.mocked(revokeCertificate).mockReset();
  resetRateLimitStore();
});

describe("SoD T9 — staff:exam ห้ามเพิกถอน", () => {
  it("staff:exam ไม่มี certificate:revoke → 403 ERR-RBAC-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:exam"]);
    const res = await POST(revokeUrl(), ctx(CERT_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("certificate:revoke");
    expect(revokeCertificate).not.toHaveBeenCalled();
  });
});

describe("POST :id/revoke — contract", () => {
  it(":id ไม่ใช่ uuid → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:registrar"]);
    const res = await POST(revokeUrl("nope"), ctx("nope"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(revokeCertificate).not.toHaveBeenCalled();
  });

  it("reason สั้นกว่า 10 → 400 ERR-VAL-001 (schema ที่ route ไม่ให้ถึง lib)", async () => {
    mockAuth(["staff:registrar"]);
    const request = new Request(`http://localhost:3000/api/v1/admin/certificates/${CERT_ID}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1" },
      body: JSON.stringify({ reason: "สั้น" }),
    });
    const res = await POST(request, ctx(CERT_ID));
    expect(res.status).toBe(400);
    expect(revokeCertificate).not.toHaveBeenCalled();
  });

  it("body ไม่ใช่ JSON → 400", async () => {
    mockAuth(["staff:registrar"]);
    const request = new Request(`http://localhost:3000/api/v1/admin/certificates/${CERT_ID}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1" },
      body: "not-json",
    });
    const res = await POST(request, ctx(CERT_ID));
    expect(res.status).toBe(400);
  });

  it("registrar → 200 { data } + lib รับ certificateId/reason/requestId ถูกต้อง", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(revokeCertificate).mockResolvedValue(revoked as never);
    const res = await POST(revokeUrl(), ctx(CERT_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-d4-3");
    const body = (await res.json()) as { data: { id: string; status: string } };
    expect(body.data.id).toBe(CERT_ID);
    expect(body.data.status).toBe("revoked");
    expect(vi.mocked(revokeCertificate).mock.calls[0]?.[0]).toMatchObject({
      actorId: STAFF_ID,
      certificateId: CERT_ID,
      reason: "ตรวจพบการทุจริตในการสอบ",
      requestId: "req-d4-3",
    });
  });

  it("lib โยน ERR-NF-001 → 404", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(revokeCertificate).mockRejectedValue(new AppError("ERR-NF-001", { details: { field: "certificateId" } }));
    const res = await POST(revokeUrl(), ctx(CERT_ID));
    expect(res.status).toBe(404);
  });

  it("lib โยน ERR-VAL-001 (not_valid) → 400", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(revokeCertificate).mockRejectedValue(
      new AppError("ERR-VAL-001", { details: { field: "certificateId", reason: "not_valid" } }),
    );
    const res = await POST(revokeUrl(), ctx(CERT_ID));
    expect(res.status).toBe(400);
  });
});

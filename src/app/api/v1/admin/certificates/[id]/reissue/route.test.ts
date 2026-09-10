/**
 * route.test — POST /api/v1/admin/certificates/:id/reissue (Wave D-4)
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
vi.mock("@/lib/certificates/reissue", () => ({ reissueCertificate: vi.fn() }));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { reissueCertificate } from "@/lib/certificates/reissue";
import { POST } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const NEW_CERT_ID = "c0000000-0000-4000-8000-000000000009";

const reissued = {
  newCertificate: {
    id: NEW_CERT_ID,
    certNo: "LTC-2026-000999",
    verifyCode: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
    enrollmentId: "e0000000-0000-4000-8000-000000000001",
    userId: "f0000000-0000-4000-8000-000000000001",
    courseId: "b0000000-0000-4000-8000-000000000001",
    holderNameSnapshot: "สมชาย ใจดี",
    courseTitleSnapshot: "หลักสูตรทดสอบ",
    creditSnapshot: null,
    status: "valid",
    issuedAt: "2026-09-08T06:00:00+00:00",
    pdfMediaId: null,
  },
  oldCertificateId: CERT_ID,
  oldStatus: "superseded",
  oldSupersededBy: NEW_CERT_ID,
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

function reissueUrl(id = CERT_ID): Request {
  return new Request(`http://localhost:3000/api/v1/admin/certificates/${id}/reissue`, {
    method: "POST",
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d4-4" },
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.mocked(reissueCertificate).mockReset();
  resetRateLimitStore();
});

describe("SoD T9 — staff:exam ห้ามออกใบใหม่", () => {
  it("staff:exam ไม่มี certificate:revoke → 403 ERR-RBAC-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:exam"]);
    const res = await POST(reissueUrl(), ctx(CERT_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("certificate:revoke");
    expect(reissueCertificate).not.toHaveBeenCalled();
  });
});

describe("POST :id/reissue — contract", () => {
  it(":id ไม่ใช่ uuid → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:registrar"]);
    const res = await POST(reissueUrl("nope"), ctx("nope"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(reissueCertificate).not.toHaveBeenCalled();
  });

  it("registrar → 201 { data } + lib รับ certificateId ถูกต้อง", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(reissueCertificate).mockResolvedValue(reissued as never);
    const res = await POST(reissueUrl(), ctx(CERT_ID));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toBe("req-d4-4");
    const body = (await res.json()) as { data: { newCertificate: { id: string }; oldStatus: string } };
    expect(body.data.newCertificate.id).toBe(NEW_CERT_ID);
    expect(body.data.oldStatus).toBe("superseded");
    expect(vi.mocked(reissueCertificate).mock.calls[0]?.[0]).toMatchObject({
      actorId: STAFF_ID,
      certificateId: CERT_ID,
      requestId: "req-d4-4",
    });
  });

  it("lib โยน ERR-VAL-001 (not_valid) → 400", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(reissueCertificate).mockRejectedValue(
      new AppError("ERR-VAL-001", { details: { field: "certificateId", reason: "not_valid" } }),
    );
    const res = await POST(reissueUrl(), ctx(CERT_ID));
    expect(res.status).toBe(400);
  });
});

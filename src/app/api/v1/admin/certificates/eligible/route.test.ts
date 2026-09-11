/**
 * route.test — GET /api/v1/admin/certificates/eligible (Wave D-4)
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
vi.mock("@/lib/certificates/issue", () => ({ listEligibleAttempts: vi.fn() }));
vi.mock("@/lib/certificates/shared", () => ({
  auditCertificateEvent: vi.fn(async () => ({ written: true, reason: "audit_written" })),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { auditCertificateEvent } from "@/lib/certificates/shared";
import { listEligibleAttempts } from "@/lib/certificates/issue";
import { GET } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "d0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";

const page = {
  data: [
    {
      attemptId: ATTEMPT_ID,
      enrollmentId: "e0000000-0000-4000-8000-000000000001",
      userId: "f0000000-0000-4000-8000-000000000001",
      courseId: COURSE_ID,
      holderName: "สมชาย ใจดี",
      scorePct: 90,
      submittedAt: "2026-09-01T00:00:00+00:00",
    },
  ],
  page: { nextCursor: null, hasMore: false },
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

function getUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/certificates/eligible" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d4-2" },
  });
}

beforeEach(() => {
  vi.mocked(listEligibleAttempts).mockReset();
  vi.mocked(auditCertificateEvent).mockClear();
  resetRateLimitStore();
});

describe("SoD T9 — staff:exam ห้ามเห็นคิวงาน (ชื่อผู้ถือ)", () => {
  it("staff:exam → 403 ERR-RBAC-001 (certificate:issue) + ไม่เรียก lib และไม่ audit", async () => {
    mockAuth(["staff:exam"]);
    const res = await GET(getUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("certificate:issue");
    expect(listEligibleAttempts).not.toHaveBeenCalled();
    expect(auditCertificateEvent).not.toHaveBeenCalled();
  });
});

describe("GET eligible — query contract (§3.8 endpoint 82)", () => {
  it("registrar + limit/cursor/courseId ถูกต้อง → 200 { data, page } + audit PII_ACCESS", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(listEligibleAttempts).mockResolvedValue(page as never);
    const res = await GET(getUrl("?limit=5&courseId=" + COURSE_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ holderName: string }>; page: { hasMore: boolean } };
    expect(body.data[0]?.holderName).toBe("สมชาย ใจดี");
    expect(body.page.hasMore).toBe(false);
    expect(auditCertificateEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditCertificateEvent).mock.calls[0]?.[0]).toMatchObject({
      action: "PII_ACCESS",
      entityType: "assessment_attempt",
      entityId: ATTEMPT_ID,
      context: {
        endpoint: "/api/v1/admin/certificates/eligible",
        purpose: "certificate_issue_queue",
      },
    });
    expect(vi.mocked(listEligibleAttempts).mock.calls[0]?.[0]).toMatchObject({
      limit: 5,
      courseId: COURSE_ID,
    });
  });

  it("ไม่มี courseId → lib รับ courseId null", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(listEligibleAttempts).mockResolvedValue(page as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    expect(vi.mocked(listEligibleAttempts).mock.calls[0]?.[0]).toMatchObject({ courseId: null });
  });

  it("courseId ไม่ใช่ uuid → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:registrar"]);
    const res = await GET(getUrl("?courseId=not-a-uuid"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(listEligibleAttempts).not.toHaveBeenCalled();
  });

  it("limit=abc → 400 ERR-VAL-001", async () => {
    mockAuth(["staff:registrar"]);
    const res = await GET(getUrl("?limit=abc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("key แปลกปลอมใน query → 400 ERR-VAL-001", async () => {
    mockAuth(["staff:registrar"]);
    const res = await GET(getUrl("?foo=bar"));
    expect(res.status).toBe(400);
  });
});

// r6-L1: ขาออกตรวจ strict ทุกแถว — แถวเดียวมีคีย์นอกสัญญา = drift → 503 ไม่ strip เงียบ
describe("GET eligible — outbound drift (r6-L1)", () => {
  it("แถวเดียวมีคีย์แปลกปลอม (เช่น holder_email) → 503 ERR-SYS-002 eligible_attempt_drift", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(listEligibleAttempts).mockResolvedValue({
      ...page,
      data: [{ ...page.data[0]!, holder_email: "x@y.z" }],
    } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("eligible_attempt_drift");
  });

  it("scorePct เกิน 100 (ผิด domain) → 503 เช่นกัน", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(listEligibleAttempts).mockResolvedValue({
      ...page,
      data: [{ ...page.data[0]!, scorePct: 150 }],
    } as never);
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
  });
});

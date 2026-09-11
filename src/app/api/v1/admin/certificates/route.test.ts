/**
 * route.test — POST/GET /api/v1/admin/certificates (Wave D-4 + Wave E PB-20)
 *
 * mock lib/certificates (D36-O3: route เรียก lib เท่านั้น) + mock ssr client สำหรับ
 * requirePermission ตามแบบ admin/courses/route.test.ts — staff:exam ไม่มี certificate:issue
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
vi.mock("@/lib/certificates/issue", () => ({ issueCertificate: vi.fn() }));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { errorDefinition } from "@/lib/errors";
import { issueCertificate } from "@/lib/certificates/issue";
import { GET, POST } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const ENROLL_ID = "e0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";

const issued = {
  id: CERT_ID,
  certNo: "LTC-2026-000123",
  verifyCode: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
  enrollmentId: ENROLL_ID,
  userId: "f0000000-0000-4000-8000-000000000001",
  courseId: "b0000000-0000-4000-8000-000000000001",
  holderNameSnapshot: "สมชาย ใจดี",
  courseTitleSnapshot: "หลักสูตรทดสอบ",
  creditSnapshot: null,
  status: "valid",
  issuedAt: "2026-09-08T04:00:00+00:00",
  pdfMediaId: null,
};

/** client จำลองสำหรับ requirePermission — roles/aal ตั้งต่อ test */
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

function postUrl(): Request {
  return new Request("http://localhost:3000/api/v1/admin/certificates", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1", "x-request-id": "req-d4-1" },
    body: JSON.stringify({ enrollmentId: ENROLL_ID }),
  });
}

beforeEach(() => {
  vi.mocked(issueCertificate).mockReset();
  resetRateLimitStore();
});

describe("SoD T9 — staff:exam ห้ามออกประกาศนียบัตร", () => {
  it("staff:exam ไม่มี certificate:issue → 403 ERR-RBAC-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:exam"]);
    const res = await POST(postUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("certificate:issue");
    expect(issueCertificate).not.toHaveBeenCalled();
  });

  it("citizen/lawyer ก็ถูกปฏิเสธเช่นกัน", async () => {
    for (const roles of [["citizen"], ["lawyer"], ["staff:viewer"]]) {
      mockAuth(roles);
      const res = await POST(postUrl());
      expect(res.status).toBe(403);
      expect(vi.mocked(issueCertificate).mock.calls).toHaveLength(0);
    }
  });
});

describe("POST /admin/certificates — 400 contract", () => {
  it("registrar ผ่านสิทธิ์ → body ไม่ใช่ JSON → 400 ERR-VAL-001", async () => {
    mockAuth(["staff:registrar"]);
    const request = new Request("http://localhost:3000/api/v1/admin/certificates", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1" },
      body: "not-json",
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("enrollmentId ไม่ใช่ uuid / key แปลกปลอม → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:registrar"]);
    for (const body of [{}, { enrollmentId: "nope" }, { enrollmentId: ENROLL_ID, extra: 1 }]) {
      const request = new Request("http://localhost:3000/api/v1/admin/certificates", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1" },
        body: JSON.stringify(body),
      });
      const res = await POST(request);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("ERR-VAL-001");
    }
    expect(issueCertificate).not.toHaveBeenCalled();
  });
});

describe("POST /admin/certificates — 201 + envelope", () => {
  it("registrar → 201 { data } + x-request-id สะท้อน + lib รับ enrollmentId/requestId", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(issueCertificate).mockResolvedValue(issued as never);
    const res = await POST(postUrl());
    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toBe("req-d4-1");
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(CERT_ID);
    expect(vi.mocked(issueCertificate).mock.calls[0]?.[0]).toMatchObject({
      actorId: STAFF_ID,
      enrollmentId: ENROLL_ID,
      requestId: "req-d4-1",
    });
  });

  it("super_admin ก็ออกได้", async () => {
    mockAuth(["super_admin"]);
    vi.mocked(issueCertificate).mockResolvedValue(issued as never);
    const res = await POST(postUrl());
    expect(res.status).toBe(201);
  });

  it("lib โยน ERR-NF-001 → 404 ผ่าน jsonErrorResponse ตรงตาม errorDefinition", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(issueCertificate).mockRejectedValue(new AppError("ERR-NF-001", { details: { field: "enrollmentId" } }));
    const res = await POST(postUrl());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.message).toBe(errorDefinition("ERR-NF-001").message);
  });
});

// r6-L1: ขาออกตรวจ strict — resource จาก lib มีคีย์นอกสัญญา = drift → 503 ไม่ strip เงียบ
describe("POST /admin/certificates — outbound drift (r6-L1)", () => {
  it("lib คืนคีย์แปลกปลอม (เช่น holder_email) → 503 ERR-SYS-002 issued_certificate_drift", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(issueCertificate).mockResolvedValue({ ...issued, holder_email: "x@y.z" } as never);
    const res = await POST(postUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("issued_certificate_drift");
  });

  it("pdfMediaId ผิดชนิด (ไม่ใช่ uuid/null) → 503 เช่นกัน", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(issueCertificate).mockResolvedValue({ ...issued, pdfMediaId: "not-a-uuid" } as never);
    const res = await POST(postUrl());
    expect(res.status).toBe(503);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * GET /admin/certificates — ทะเบียนใบ (Wave E · PB-20 · D55-2)
 * - mock เฉพาะ listCertificates (role-gate จริงผ่าน ssr client จำลองข้างบน)
 * ════════════════════════════════════════════════════════════════════════ */

vi.mock("@/lib/certificates/list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/certificates/list")>();
  return { ...actual, listCertificates: vi.fn() };
});

const CERT_ROW = {
  id: "c0000000-0000-4000-8000-000000000009",
  certNo: "LTC-2026-000123",
  verifyCode: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
  status: "valid",
  issuedAt: "2026-09-08T04:00:00+00:00",
  userId: "f0000000-0000-4000-8000-000000000001",
  holderName: "สมชาย ใจดี",
  courseId: "b0000000-0000-4000-8000-000000000001",
  courseTitle: "หลักสูตรทดสอบ",
};

function listUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/admin/certificates" + query, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e3-1" },
  });
}

describe("GET /admin/certificates — role-gate D55-2", () => {
  it("staff:exam → 403 ERR-RBAC-001 (role-gate ตรง — ไม่ยืม certificate:issue)", async () => {
    mockAuth(["staff:exam"]);
    const res = await GET(listUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("citizen/lawyer/staff:viewer/staff:content → 403 เช่นกัน", async () => {
    for (const roles of [["citizen"], ["lawyer"], ["staff:viewer"], ["staff:content"]]) {
      mockAuth(roles);
      const res = await GET(listUrl());
      expect(res.status).toBe(403);
    }
  });

  it("registrar ที่ยังไม่ยืนยัน MFA (aal1) → 403 ERR-AUTH-004", async () => {
    mockAuth(["staff:registrar"], "aal1");
    const res = await GET(listUrl());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("registrar/super_admin ผ่าน gate → lib รับ actorId ตรง", async () => {
    for (const roles of [["staff:registrar"], ["super_admin"]]) {
      mockAuth(roles);
      const { listCertificates } = await import("@/lib/certificates/list");
      vi.mocked(listCertificates).mockResolvedValue({ data: [], page: { nextCursor: null, hasMore: false } } as never);
      const res = await GET(listUrl());
      expect(res.status).toBe(200);
      expect(vi.mocked(listCertificates).mock.calls.at(-1)?.[0]).toMatchObject({ actorId: STAFF_ID });
    }
  });
});

describe("GET /admin/certificates — 200 + envelope", () => {
  it("registrar → 200 { data, page } + x-request-id สะท้อน", async () => {
    mockAuth(["staff:registrar"]);
    const { listCertificates } = await import("@/lib/certificates/list");
    vi.mocked(listCertificates).mockResolvedValue({
      data: [CERT_ROW],
      page: { nextCursor: "abc.cursor", hasMore: true },
    } as never);
    const res = await GET(listUrl("?limit=20"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e3-1");
    const body = (await res.json()) as { data: unknown[]; page: { hasMore: boolean } };
    expect(body.data).toHaveLength(1);
    expect(body.page.hasMore).toBe(true);
  });

  it("lib โยน ERR-SYS-002 → 503 ผ่าน jsonErrorResponse", async () => {
    mockAuth(["staff:registrar"]);
    const { listCertificates } = await import("@/lib/certificates/list");
    const { AppError } = await import("@/lib/errors");
    vi.mocked(listCertificates).mockRejectedValue(
      new AppError("ERR-SYS-002", { details: { reason: "cert_list_row_drift" } }),
    );
    const res = await GET(listUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.details["reason"]).toBe("cert_list_row_drift");
  });

  it("แถว drift (status นอก enum) → 503 certificate_list_row_drift (r6-L1)", async () => {
    mockAuth(["staff:registrar"]);
    const { listCertificates } = await import("@/lib/certificates/list");
    vi.mocked(listCertificates).mockResolvedValue({
      data: [{ ...CERT_ROW, status: "กู้คืนไม่ได้" }],
      page: { nextCursor: null, hasMore: false },
    } as never);
    const res = await GET(listUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details["reason"]).toBe("certificate_list_row_drift");
  });
});

describe("GET /admin/certificates — query strict 400", () => {
  it("limit/status/uuid/วันที่ ผิดรูป + key แปลกปลอม → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:registrar"]);
    const { listCertificates } = await import("@/lib/certificates/list");
    vi.mocked(listCertificates).mockReset();
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=nope",
      "?status=deleted",
      "?after_id=not-uuid",
      "?holder_user_id=not-uuid",
      "?after_issued_at=08-09-2026",
      "?hack=1",
    ]) {
      const res = await GET(listUrl(query));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("ERR-VAL-001");
    }
    expect(vi.mocked(listCertificates).mock.calls).toHaveLength(0);
  });

  it("keyset ครึ่งเดี่ยว (after_issued_at XOR after_id) → 400 ERR-VAL-001 (MINOR-7)", async () => {
    mockAuth(["staff:registrar"]);
    const { listCertificates } = await import("@/lib/certificates/list");
    vi.mocked(listCertificates).mockReset();
    for (const query of [
      "?after_id=c0000000-0000-4000-8000-000000000009",
      "?after_issued_at=2026-09-08T04:00:00%2B00:00",
    ]) {
      const res = await GET(listUrl(query));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error.code).toBe("ERR-VAL-001");
      expect(body.error.details["fields"]).toEqual(["after_issued_at", "after_id"]);
    }
    expect(vi.mocked(listCertificates).mock.calls).toHaveLength(0);
  });

  it("ค่าว่าง = ไม่ระบุ (ฟอร์ม GET) → ผ่านและ lib ไม่รับ filter", async () => {
    mockAuth(["staff:registrar"]);
    const { listCertificates } = await import("@/lib/certificates/list");
    vi.mocked(listCertificates).mockResolvedValue({ data: [], page: { nextCursor: null, hasMore: false } } as never);
    const res = await GET(listUrl("?cert_no=&verify_code=&status=&limit=20"));
    expect(res.status).toBe(200);
    const { listCertificates: lib } = await import("@/lib/certificates/list");
    expect(vi.mocked(lib).mock.calls.at(-1)?.[0]).toMatchObject({
      query: expect.objectContaining({ limit: 20, certNo: undefined }),
    });
  });

  it("query ถูกรูปทั้งชุด → lib รับครบ (map snake→camel)", async () => {
    mockAuth(["staff:registrar"]);
    const { listCertificates } = await import("@/lib/certificates/list");
    vi.mocked(listCertificates).mockResolvedValue({ data: [], page: { nextCursor: null, hasMore: false } } as never);
    const res = await GET(
      listUrl("?cert_no=LTC-2026-&status=valid&course_id=b0000000-0000-4000-8000-000000000001&limit=50"),
    );
    expect(res.status).toBe(200);
    const { listCertificates: lib } = await import("@/lib/certificates/list");
    expect(vi.mocked(lib).mock.calls.at(-1)?.[0]).toMatchObject({
      query: {
        certNo: "LTC-2026-",
        status: "valid",
        courseId: "b0000000-0000-4000-8000-000000000001",
        limit: 50,
      },
    });
  });
});

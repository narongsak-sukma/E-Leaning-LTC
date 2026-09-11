/**
 * route.test — POST /api/v1/admin/certificates/bulk (Wave E — E-4 · DCR-8)
 *
 * mock lib/certificates/bulk (D36-O3: route เรียก lib เท่านั้น — คง schema จริงไว้ด้วย
 * importOriginal เพื่อให้ขาออก parseOutgoingView ยังทำงาน) + mock ssr client สำหรับ
 * requirePermission ตามแบบ admin/certificates/route.test.ts
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
vi.mock("@/lib/certificates/bulk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/certificates/bulk")>();
  return { ...actual, createBulkJob: vi.fn() };
});

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { errorDefinition } from "@/lib/errors";
import { createBulkJob } from "@/lib/certificates/bulk";
import { POST } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const JOB_ID = "50000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";

/** ผลที่ lib คืนเมื่อรัน job จบ (camelCase — ตรง BulkJobResultResource) */
const jobResult = {
  jobId: JOB_ID,
  status: "completed",
  totalAttempts: 12,
  issuedCount: 10,
  failedCount: 2,
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
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: aal },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles" ? { data: roles, error: null } : { data: null, error: null },
    ),
    from: vi.fn(() => profilesBuilder),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/admin/certificates/bulk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "10.5.0.1",
      "x-request-id": "req-e4-1",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(createBulkJob).mockReset();
  resetRateLimitStore();
});

describe("SoD T9 — staff:exam ห้ามออกใบเป็นชุด", () => {
  it("staff:exam ไม่มี certificate:issue → 403 ERR-RBAC-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:exam"]);
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("certificate:issue");
    expect(createBulkJob).not.toHaveBeenCalled();
  });

  it("citizen/lawyer/staff:viewer → 403 เช่นกัน", async () => {
    for (const roles of [["citizen"], ["lawyer"], ["staff:viewer"]]) {
      mockAuth(roles);
      const res = await POST(postRequest({ courseId: null }));
      expect(res.status).toBe(403);
      expect(vi.mocked(createBulkJob).mock.calls).toHaveLength(0);
    }
  });
});

describe("POST bulk — 400 contract (body strict)", () => {
  it("registrar ผ่านสิทธิ์ → body ไม่ใช่ JSON → 400 ERR-VAL-001", async () => {
    mockAuth(["staff:registrar"]);
    const request = new Request("http://localhost:3000/api/v1/admin/certificates/bulk", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1" },
      body: "not-json",
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("missing/ผิดชนิด/key เกิน → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:registrar"]);
    for (const body of [{}, { courseId: "nope" }, { courseId: null, extra: 1 }]) {
      const res = await POST(postRequest(body));
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("ERR-VAL-001");
    }
    expect(createBulkJob).not.toHaveBeenCalled();
  });
});

describe("POST bulk — 202 + envelope", () => {
  it("registrar + courseId null → 202 { data } ครบ + x-request-id สะท้อน + lib รับครบ", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(createBulkJob).mockResolvedValue(jobResult as never);
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(202);
    expect(res.headers.get("x-request-id")).toBe("req-e4-1");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      jobId: JOB_ID,
      status: "completed",
      totalAttempts: 12,
      issuedCount: 10,
      failedCount: 2,
    });
    expect(vi.mocked(createBulkJob).mock.calls[0]?.[0]).toMatchObject({
      actorId: STAFF_ID,
      courseId: null,
      requestId: "req-e4-1",
    });
  });

  it("super_admin + courseId uuid → 202 เช่นกัน", async () => {
    mockAuth(["super_admin"]);
    vi.mocked(createBulkJob).mockResolvedValue(jobResult as never);
    const res = await POST(postRequest({ courseId: COURSE_ID }));
    expect(res.status).toBe(202);
    expect(vi.mocked(createBulkJob).mock.calls[0]?.[0]).toMatchObject({ courseId: COURSE_ID });
  });

  it("lib โยน ERR-VAL-001 (RPC แจ้ง job จบแล้ว) → 400 ข้อความไทยตามทะเบียน", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(createBulkJob).mockRejectedValue(new AppError("ERR-VAL-001"));
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.message).toBe(errorDefinition("ERR-VAL-001").message);
  });

  it("lib โยน ERR-NF-001 (RPC แจ้งไม่พบ job) → 404", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(createBulkJob).mockRejectedValue(new AppError("ERR-NF-001"));
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
  });

  it("lib โยน ERR-SYS-002 (insert/RPC ล้ม fail-closed) → 503", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(createBulkJob).mockRejectedValue(new AppError("ERR-SYS-002"));
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("throw ไม่รู้จัก → 500 ERR-SYS-001 (catch-all opaque)", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(createBulkJob).mockRejectedValue(new Error("boom"));
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-001");
  });
});

// r6-L1: ขาออกตรวจ strict — resource จาก lib มีคีย์/ค่านอกสัญญา = drift → 503 ไม่ strip เงียบ
describe("POST bulk — outbound drift (r6-L1)", () => {
  it("lib คืนคีย์แปลกปลอม → 503 ERR-SYS-002 bulk_job_result_drift", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(createBulkJob).mockResolvedValue({ ...jobResult, holder_email: "x@y.z" } as never);
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("bulk_job_result_drift");
  });

  it("failedCount ผิดชนิด (string) → 503 เช่นกัน", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(createBulkJob).mockResolvedValue({ ...jobResult, failedCount: "2" } as never);
    const res = await POST(postRequest({ courseId: null }));
    expect(res.status).toBe(503);
  });
});

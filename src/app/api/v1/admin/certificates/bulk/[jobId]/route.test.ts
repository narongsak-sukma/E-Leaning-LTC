/**
 * route.test — GET /api/v1/admin/certificates/bulk/:jobId (Wave E — E-4 · DCR-8)
 *
 * mock lib/certificates/bulk (D36-O3) คง schema จริงไว้ด้วย importOriginal — ทดสอบ
 * role gate + การเห็น (เจ้าของ/super_admin/registrar อื่น) + สัญญาขาออก + drift
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
  return { ...actual, getBulkJob: vi.fn() };
});

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { errorDefinition } from "@/lib/errors";
import { getBulkJob } from "@/lib/certificates/bulk";
import { GET } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const JOB_ID = "50000000-0000-4000-8000-000000000001";
const T1 = "2026-09-08T04:00:00+00:00";

/** ผลที่ lib คืน (camelCase — ตรง BulkJobStatusResource) */
const jobStatus = {
  jobId: JOB_ID,
  status: "completed",
  totalAttempts: 12,
  issuedCount: 10,
  failedCount: 2,
  lastError: null,
  createdAt: T1,
  finishedAt: T1,
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

function getRequest(jobId = JOB_ID): Request {
  return new Request(`http://localhost:3000/api/v1/admin/certificates/bulk/${jobId}`, {
    headers: { "x-forwarded-for": "10.5.0.1", "x-request-id": "req-e4-2" },
  });
}

function ctx(jobId: string): { params: Promise<{ jobId: string }> } {
  return { params: Promise.resolve({ jobId }) };
}

beforeEach(() => {
  vi.mocked(getBulkJob).mockReset();
  resetRateLimitStore();
});

describe("SoD T9 — staff:exam ห้ามเห็นสถานะ job", () => {
  it("staff:exam ไม่มี certificate:issue → 403 ERR-RBAC-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:exam"]);
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(body.error.details["permission"]).toBe("certificate:issue");
    expect(getBulkJob).not.toHaveBeenCalled();
  });
});

describe("GET bulk status — การเห็น (เจ้าของ / super_admin / registrar อื่น)", () => {
  it("เจ้าของ → 200 ครบทุกฟิลด์ + lib รับ viewerId/isSuperAdmin ตรง", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(getBulkJob).mockResolvedValue(jobStatus as never);
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e4-2");
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      jobId: JOB_ID,
      status: "completed",
      totalAttempts: 12,
      issuedCount: 10,
      failedCount: 2,
      lastError: null,
      createdAt: T1,
      finishedAt: T1,
    });
    expect(vi.mocked(getBulkJob).mock.calls[0]?.[0]).toEqual({
      jobId: JOB_ID,
      viewerId: STAFF_ID,
      isSuperAdmin: false,
    });
  });

  it("super_admin เห็น job ของคนอื่น → 200 + lib รับ isSuperAdmin true", async () => {
    mockAuth(["super_admin"]);
    vi.mocked(getBulkJob).mockResolvedValue({ ...jobStatus, lastError: "เพดานรอบ (ERR-SYS-002|bulk_round_limit)" } as never);
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(200);
    expect(vi.mocked(getBulkJob).mock.calls[0]?.[0]).toEqual({
      jobId: JOB_ID,
      viewerId: STAFF_ID,
      isSuperAdmin: true,
    });
    const body = (await res.json()) as { data: { lastError: string | null } };
    expect(body.data.lastError).toContain("bulk_round_limit");
  });

  it("registrar คนอื่นเจอ job ของเพื่อน (lib โยน ERR-NF-001) → 404 ไม่เฉลยว่ามีจริง", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(getBulkJob).mockRejectedValue(new AppError("ERR-NF-001"));
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
  });
});

describe("GET bulk status — 400/404 contract", () => {
  it("jobId ไม่ใช่ uuid → 400 ERR-VAL-001 (ไม่เรียก lib)", async () => {
    mockAuth(["staff:registrar"]);
    const res = await GET(getRequest("not-a-uuid"), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.message).toBe(errorDefinition("ERR-VAL-001").message);
    expect(getBulkJob).not.toHaveBeenCalled();
  });

  it("ไม่มี job (lib โยน ERR-NF-001) → 404", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(getBulkJob).mockRejectedValue(new AppError("ERR-NF-001"));
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
  });
});

// r6-L1: ขาออกตรวจ strict — drift (คีย์เกิน/ผิดชนิด) → 503 ไม่ strip เงียบ
describe("GET bulk status — fail-closed (r6-L1)", () => {
  it("lib โยน ERR-SYS-002 (แถว drift ขาเข้า) → 503 พร้อม reason ต้นทาง", async () => {
    mockAuth(["staff:registrar"]);
    const { AppError } = await import("@/lib/errors");
    vi.mocked(getBulkJob).mockRejectedValue(
      new AppError("ERR-SYS-002", { details: { reason: "cert_bulk_job_row_drift" } }),
    );
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("cert_bulk_job_row_drift");
  });

  it("lib คืนคีย์แปลกปลอม → 503 ERR-SYS-002 bulk_job_status_drift", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(getBulkJob).mockResolvedValue({ ...jobStatus, extra_key: 1 } as never);
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details["reason"]).toBe("bulk_job_status_drift");
  });

  it("lastError ยาวเกิน 200 (lib ตัดทอนไม่สำเร็จ) → 503 ไม่ส่งออกเกินสัญญา", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(getBulkJob).mockResolvedValue({ ...jobStatus, lastError: "ก".repeat(300) } as never);
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(503);
  });

  it("status นอก enum (ทั้งที่ row บอกว่า job กำลังรัน) → 503 เช่นกัน", async () => {
    mockAuth(["staff:registrar"]);
    vi.mocked(getBulkJob).mockResolvedValue({ ...jobStatus, status: "queued" } as never);
    const res = await GET(getRequest(), ctx(JOB_ID));
    expect(res.status).toBe(503);
  });
});

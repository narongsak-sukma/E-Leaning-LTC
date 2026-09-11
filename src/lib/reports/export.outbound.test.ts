/**
 * export.outbound.test — ขาออกของ runExport ต้องผ่านสัญญา strict ก่อน serialize
 * (gate p1-r1 MINOR-4) · export ไม่ได้ตอบผ่าน parseOutgoingView ของ route จึงตรวจเอง
 *
 * mock ทั้ง views (ให้คืน resource ที่ drift โดยตรง — reader จริง parse strict อยู่แล้ว
 * จึงจำลอง drift ได้เฉพาะที่ชั้น boundary นี้) และ service client (insert + audit)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => ({ createSupabaseSsrClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/reports/views", () => ({
  listEnrollmentProgress: vi.fn(),
  listAssessmentStatistics: vi.fn(),
  listCreditBalances: vi.fn(),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { runExport } from "./export";
import { listEnrollmentProgress } from "./views";

/** uuid ทดสอบ */
const E1 = "e1000000-0000-4000-8000-000000000001";
const U1 = "f1000000-0000-4000-8000-000000000001";
const C1 = "c1000000-0000-4000-8000-000000000001";
const X1 = "7e000000-0000-4000-8000-000000000011";

/** service client จำลอง — insert สำเร็จ + audit สำเร็จ (ไม่ใช่ประเด็นของไฟล์นี้) */
function setupServiceOk() {
  const builder = {
    insert: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn(async () => ({ data: { id: X1 }, error: null })),
  };
  const client = {
    from: vi.fn(() => builder),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
}

beforeEach(() => {
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  vi.mocked(listEnrollmentProgress).mockReset();
});

describe("runExport — ขาออก strict ก่อน serialize (MINOR-4)", () => {
  it("resource มีคีย์นอกสัญญา → ERR-SYS-002 enrollments_outbound_row_drift (ไม่ serialize เงียบ ๆ)", async () => {
    setupServiceOk();
    vi.mocked(listEnrollmentProgress).mockResolvedValue({
      rows: [
        {
          enrollmentId: E1,
          userId: U1,
          courseId: C1,
          lessonTotal: 10,
          lessonCompleted: 4,
          progressPct: 40,
          holder_email: "leak@x.y", // คีย์นอกสัญญา — ห้ามไหลไปไฟล์/audit
        },
      ] as never,
      truncated: false,
    });
    await expect(runExport({
      type: "enrollments",
      format: "csv",
      requestedBy: "staff-1",
      requestId: null,
    })).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "enrollments_outbound_row_drift" },
    });
  });

  it("resource ขาดฟิลด์ (null แทน number) → fail เช่นกัน", async () => {
    setupServiceOk();
    vi.mocked(listEnrollmentProgress).mockResolvedValue({
      rows: [
        {
          enrollmentId: E1,
          userId: U1,
          courseId: C1,
          lessonTotal: null, // drift ชนิด — สัญญากำหนด int
          lessonCompleted: 4,
          progressPct: 40,
        },
      ] as never,
      truncated: false,
    });
    await expect(runExport({
      type: "enrollments",
      format: "json",
      requestedBy: "staff-1",
      requestId: null,
    })).rejects.toMatchObject({
      details: { reason: "enrollments_outbound_row_drift" },
    });
  });

  it("แถวตรงสัญญา → ผ่าน (แถวที่ A2 ไม่เกี่ยว — ใช้ enrollments ครบทุกฟิลด์)", async () => {
    setupServiceOk();
    vi.mocked(listEnrollmentProgress).mockResolvedValue({
      rows: [
        {
          enrollmentId: E1,
          userId: U1,
          courseId: C1,
          lessonTotal: 10,
          lessonCompleted: 4,
          progressPct: 40,
        },
      ] as never,
      truncated: false,
    });
    const result = await runExport({
      type: "enrollments",
      format: "csv",
      requestedBy: "staff-1",
      requestId: null,
    });
    expect(result.rowCount).toBe(1);
    expect(result.body).toContain(E1);
  });
});

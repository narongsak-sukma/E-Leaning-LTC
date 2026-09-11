/**
 * views.test — อ่าน views รายงานผ่าน user-JWT client (Wave E · D55-6)
 * ตรวจ: ตาราง/คอลัมน์ select ตรง view จริง · ตัวกรอง · truncated (limit+1) ·
 * error → ERR-SYS-002 opaque · แถว drift → fail-closed
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

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { listAssessmentStatistics, listCreditBalances, listEnrollmentProgress } from "./views";

/** uuid ทดสอบ */
const U = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** builder จำลอง PostgREST — ทุก method คืน builder (chain ได้) และ await ได้ผ่าน then */
function makeBuilder(result: { data: unknown; error: unknown }) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    gte: vi.fn(() => b),
    lte: vi.fn(() => b),
    lt: vi.fn(() => b),
    in: vi.fn(() => b),
    not: vi.fn(() => b),
    order: vi.fn(() => b),
    limit: vi.fn(() => b),
    then: vi.fn((onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled as never, undefined as never),
    ),
  };
  return b;
}

/** client จำลอง — from(table) คืน builder ต่อตาราง (เก็บ builder ไว้ inspect) */
function mockClient(table: string, result: { data: unknown; error: unknown }) {
  const builder = makeBuilder(result);
  const client = {
    from: vi.fn((t: string) => (t === table ? builder : makeBuilder({ data: [], error: null }))),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return builder;
}

const ENROLLMENT_ROW = {
  enrollment_id: U(1),
  user_id: U(2),
  course_id: U(3),
  lesson_total: 10,
  lesson_completed: 4,
  progress_pct: 40,
};

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
});

describe("listEnrollmentProgress — v_enrollment_progress", () => {
  it("เรียกตารางถูก + select คอลัมน์ exact + order enrollment_id + limit สั่ง limit+1", async () => {
    const builder = mockClient("v_enrollment_progress", { data: [ENROLLMENT_ROW], error: null });
    const out = await listEnrollmentProgress({ limit: 10 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual({
      enrollmentId: U(1),
      userId: U(2),
      courseId: U(3),
      lessonTotal: 10,
      lessonCompleted: 4,
      progressPct: 40,
    });
    expect(builder.select).toHaveBeenCalledWith(
      "enrollment_id, user_id, course_id, lesson_total, lesson_completed, progress_pct",
    );
    expect(builder.order).toHaveBeenCalledWith("enrollment_id", { ascending: true });
    expect(builder.limit).toHaveBeenCalledWith(11);
    expect(out.truncated).toBe(false);
  });
  it("courseId → .eq(course_id)", async () => {
    const builder = mockClient("v_enrollment_progress", { data: [], error: null });
    await listEnrollmentProgress({ limit: 5, courseId: U(3) });
    expect(builder.eq).toHaveBeenCalledWith("course_id", U(3));
  });
  it("query error → ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    mockClient("v_enrollment_progress", { data: null, error: { message: "secret sql" } });
    await expect(listEnrollmentProgress({ limit: 5 })).rejects.toMatchObject({
      code: "ERR-SYS-002",
    });
  });
  it("ได้ limit+1 แถว → truncated=true + คืนแค่ limit แถว", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      ...ENROLLMENT_ROW,
      enrollment_id: U(10 + i),
    }));
    mockClient("v_enrollment_progress", { data: rows, error: null });
    const out = await listEnrollmentProgress({ limit: 3 });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(3);
  });
});

describe("listAssessmentStatistics — v_assessment_statistics", () => {
  it("คืน resource camelCase + truncated เมื่อได้ limit+1 แถว", async () => {
    const row = {
      assessment_id: U(4),
      attempt_total: 8,
      attempt_passed: 6,
      pass_rate_pct: 75,
    };
    const builder = mockClient("v_assessment_statistics", { data: [row, row], error: null });
    const out = await listAssessmentStatistics({ limit: 1 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual({
      assessmentId: U(4),
      attemptTotal: 8,
      attemptPassed: 6,
      passRatePct: 75,
    });
    expect(builder.limit).toHaveBeenCalledWith(2);
    expect(out.truncated).toBe(true);
  });
  it("แถว drift (คอลัมน์แปลกปลอม) → ERR-SYS-002 v_assessment_statistics_row_drift", async () => {
    const row = {
      assessment_id: U(4),
      attempt_total: 8,
      attempt_passed: 6,
      pass_rate_pct: 75,
      extra_col: 1,
    };
    mockClient("v_assessment_statistics", { data: [row], error: null });
    await expect(listAssessmentStatistics({ limit: 5 })).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "v_assessment_statistics_row_drift" },
    });
  });
});

describe("listCreditBalances — v_credit_balance", () => {
  it("order last_entry_at desc (nullsFirst false) + user_id asc · from/to → gte/lte", async () => {
    const builder = mockClient("v_credit_balance", { data: [], error: null });
    const out = await listCreditBalances({ limit: 5, from: "2026-01-01T00:00:00+00:00", to: "2026-02-01T00:00:00+00:00" });
    expect(out.rows).toEqual([]);
    expect(builder.order).toHaveBeenNthCalledWith(1, "last_entry_at", { ascending: false, nullsFirst: false });
    expect(builder.order).toHaveBeenNthCalledWith(2, "user_id", { ascending: true });
    expect(builder.gte).toHaveBeenCalledWith("last_entry_at", "2026-01-01T00:00:00+00:00");
    expect(builder.lte).toHaveBeenCalledWith("last_entry_at", "2026-02-01T00:00:00+00:00");
  });
});

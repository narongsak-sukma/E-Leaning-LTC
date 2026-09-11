/**
 * views.test — อ่าน views รายงานผ่าน user-JWT client (Wave E · D55-6)
 * ตรวจ: ตาราง/คอลัมน์ select ตรง view จริง · ตัวกรอง · truncated (limit+1) ·
 * error → ERR-SYS-002 opaque · แถว/container drift → fail-closed ·
 * batch loop ข้ามหน้าเอาชนะ PGRST_API_MAX_ROWS (gate p1-r1 MAJOR-2)
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

/**
 * builder จำลอง PostgREST — ทุก method คืน builder (chain ได้) และ await ได้ผ่าน then ·
 * เลียนพฤติกรรม .range() จริง: คืนเฉพาะช่วง [from..to] ของ result.data เหมือน
 * PostgREST ตัดตามหน้า (gate p1-r1 MAJOR-2 — เทสต์ batch loop ต้องเห็น "หน้า" จริง)
 */
function makeBuilder(result: { data: unknown; error: unknown }) {
  let rangeFrom = 0;
  let rangeTo = Number.POSITIVE_INFINITY;
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    gte: vi.fn(() => b),
    lte: vi.fn(() => b),
    lt: vi.fn(() => b),
    in: vi.fn(() => b),
    not: vi.fn(() => b),
    order: vi.fn(() => b),
    range: vi.fn((from: number, to: number) => {
      rangeFrom = from;
      rangeTo = to;
      return b;
    }),
    limit: vi.fn(() => b),
    then: vi.fn((onFulfilled: (v: unknown) => unknown) => {
      const data =
        Array.isArray(result.data) && rangeTo !== Number.POSITIVE_INFINITY
          ? result.data.slice(rangeFrom, rangeTo + 1)
          : result.data;
      return Promise.resolve({ ...result, data }).then(onFulfilled as never, undefined as never);
    }),
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

/** แถว enrollment หลายแถว (id ต่างกัน — ลำดับ offset คงที่) */
const enrollmentRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ...ENROLLMENT_ROW, enrollment_id: U(10 + i) }));

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
});

describe("listEnrollmentProgress — v_enrollment_progress", () => {
  it("เรียกตารางถูก + select คอลัมน์ exact + order enrollment_id + หน้าแรกขอ limit+1 แถว", async () => {
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
    expect(builder.range).toHaveBeenCalledWith(0, 10);
    expect(builder.limit).not.toHaveBeenCalled();
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
      details: { reason: "v_enrollment_progress_query_failed" },
    });
  });
  it("ได้ limit+1 แถวในหน้าเดียว → truncated=true + คืนแค่ limit แถว", async () => {
    mockClient("v_enrollment_progress", { data: enrollmentRows(4), error: null });
    const out = await listEnrollmentProgress({ limit: 3 });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(3);
  });
});

describe("listEnrollmentProgress — batch loop ข้ามหน้า (MAJOR-2)", () => {
  it("เกิน PGRST_API_MAX_ROWS 1000 แถว → อ่านต่อหน้าจนครบ limit+1 + truncated=true", async () => {
    // จำลอง: ตารางมี 1001 แถว · limit=1000 → หน้า 1 (0..999) ได้ 1000 เต็มหน้า ·
    // หน้า 2 ขออีก 1 แถว (sentinel) → truncated — แบบเก่า request เดียวจะโดน
    // PGRST_API_MAX_ROWS ตัดเหลือ 1000 เงียบ ๆ แล้วตอบ truncated:false ผิด
    const builder = mockClient("v_enrollment_progress", { data: enrollmentRows(1001), error: null });
    const out = await listEnrollmentProgress({ limit: 1000 });
    expect(builder.range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(builder.range).toHaveBeenNthCalledWith(2, 1000, 1000);
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(1000);
    // ลำดับ offset คงที่: แถวสุดท้ายที่คืนคือ id ลำดับที่ 1000 ไม่หลุด/ซ้ำข้ามหน้า
    expect(out.rows[999]?.enrollmentId).toBe(U(10 + 999));
  });
  it("หลายหน้าเต็มแล้วหมดกลางหน้าสุดท้าย → truncated=false (อ่านครบจริง)", async () => {
    // 2501 แถวในตาราง · limit=2500 → หน้า 1,2 เต็ม 1000 · หน้า 3 ได้ 501 = limit+1
    const builder = mockClient("v_enrollment_progress", { data: enrollmentRows(2501), error: null });
    const out = await listEnrollmentProgress({ limit: 2500 });
    expect(builder.range).toHaveBeenCalledTimes(3);
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(2500);
  });
  it("limit ใหญ่กว่าข้อมูลจริง → หน้าสุดท้ายสั้น = หมดจริง truncated=false", async () => {
    const builder = mockClient("v_enrollment_progress", { data: enrollmentRows(1500), error: null });
    const out = await listEnrollmentProgress({ limit: 2000 });
    expect(builder.range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(builder.range).toHaveBeenNthCalledWith(2, 1000, 1999);
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(1500);
  });
});

describe("listEnrollmentProgress — fail-closed container/แถว (MINOR-3)", () => {
  it("data:null โดยไม่มี error → ERR-SYS-002 container_drift (ห้ามตีตกเป็นว่าง)", async () => {
    mockClient("v_enrollment_progress", { data: null, error: null });
    await expect(listEnrollmentProgress({ limit: 5 })).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "v_enrollment_progress_container_drift" },
    });
  });
  it("data เป็น object ไม่ใช่ array → container_drift เช่นกัน", async () => {
    mockClient("v_enrollment_progress", { data: { message: "PGRST123" }, error: null });
    await expect(listEnrollmentProgress({ limit: 5 })).rejects.toMatchObject({
      details: { reason: "v_enrollment_progress_container_drift" },
    });
  });
  it("แถว sentinel ตัวที่ limit+1 drift ก็ต้อง fail — ตรวจก่อน slice เสมอ", async () => {
    const rows = enrollmentRows(3);
    // sentinel = แถวที่ 2 (index 1) มีคอลัมน์แปลกปลอม — เก่า slice ทิ้งก่อนตรวจจะหลุด
    (rows[1] as Record<string, unknown>)["evil_col"] = 1;
    mockClient("v_enrollment_progress", { data: rows, error: null });
    await expect(listEnrollmentProgress({ limit: 1 })).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "v_enrollment_progress_row_drift" },
    });
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
    expect(builder.range).toHaveBeenCalledWith(0, 1);
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
  it("data:null ไม่มี error → container_drift (MINOR-3)", async () => {
    mockClient("v_assessment_statistics", { data: null, error: null });
    await expect(listAssessmentStatistics({ limit: 5 })).rejects.toMatchObject({
      details: { reason: "v_assessment_statistics_container_drift" },
    });
  });
});

describe("listCreditBalances — v_credit_balance", () => {
  it("order last_entry_at desc + tiebreaker ครบ grain (user/renewal/credit_type) + gte/lte", async () => {
    const builder = mockClient("v_credit_balance", { data: [], error: null });
    const out = await listCreditBalances({ limit: 5, from: "2026-01-01T00:00:00+00:00", to: "2026-02-01T00:00:00+00:00" });
    expect(out.rows).toEqual([]);
    expect(builder.order).toHaveBeenNthCalledWith(1, "last_entry_at", { ascending: false, nullsFirst: false });
    expect(builder.order).toHaveBeenNthCalledWith(2, "user_id", { ascending: true });
    expect(builder.order).toHaveBeenNthCalledWith(3, "renewal_cycle_id", { ascending: true });
    expect(builder.order).toHaveBeenNthCalledWith(4, "credit_type", { ascending: true });
    expect(builder.gte).toHaveBeenCalledWith("last_entry_at", "2026-01-01T00:00:00+00:00");
    expect(builder.lte).toHaveBeenCalledWith("last_entry_at", "2026-02-01T00:00:00+00:00");
  });
  it("data:null ไม่มี error → container_drift (MINOR-3)", async () => {
    mockClient("v_credit_balance", { data: null, error: null });
    await expect(listCreditBalances({ limit: 5 })).rejects.toMatchObject({
      details: { reason: "v_credit_balance_container_drift" },
    });
  });
});

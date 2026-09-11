/**
 * monitoring.test — คิวมอนิเตอร์ + สถิติผลสอบ (Wave E · D55-6)
 * ตรวจ: aggregate ฝั่ง DB (id.count()/score_pct.avg()) · overdue = lt(expires_at) ·
 * กลุ่มตาม course_id จาก assessments lookup · ไม่มี user_id รายคน · merge avg เข้า view
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
import { getExamMonitoring, getExamStatistics } from "./monitoring";

/** builder จำลอง PostgREST (chainable + awaitable — บันทึกการเรียกทุก method) ·
 *  .range() ตัดข้อมูลตามหน้าเหมือน PostgREST จริง (getExamStatistics เรียกผ่าน
 *  listAssessmentStatistics ของ views ซึ่งเป็น batch loop — gate p1-r1 MAJOR-2) */
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

type Builder = ReturnType<typeof makeBuilder>;
type Result = { data: unknown; error: unknown };

/**
 * client จำลอง — from(table) สร้าง builder ใหม่ทุกครั้งโดยไล่ลำดับการเรียกต่อตาราง
 * (callIndex 0,1,2...) — resolver ตัดสินผลลัพธ์ (รองรับ query เดิมซ้ำหลายรอบ เช่น agg 2 รอบ)
 */
function setupClient(resolver: (table: string, callIndex: number) => Result) {
  const made: Array<{ table: string; builder: Builder }> = [];
  const counts = new Map<string, number>();
  const client = {
    from: vi.fn((table: string) => {
      const idx = counts.get(table) ?? 0;
      counts.set(table, idx + 1);
      const builder = makeBuilder(resolver(table, idx));
      made.push({ table, builder });
      return builder;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return {
    buildersFor: (table: string): Builder[] =>
      made.filter((m) => m.table === table).map((m) => m.builder),
  };
}

/** PostgREST aggregate rows — รูปแบบตาม select string ของ monitoring.ts */
const A2 = "a2000000-0000-4000-8000-000000000002";
const A1 = "a1000000-0000-4000-8000-000000000001";
const C1 = "c1000000-0000-4000-8000-000000000001";
const AGG_ROW = { assessmentId: A1, inProgress: 3 };
const OVERDUE_ROW = { assessmentId: A1, overdue: 2 };

/** resolver กลางของคิวมอนิเตอร์ — ครั้งที่ 0 = in_progress agg · ครั้งที่ 1 = overdue agg */
function monitoringResolver(table: string, idx: number): Result {
  if (table === "assessment_attempts") {
    return idx === 0 ? { data: [AGG_ROW], error: null } : { data: [OVERDUE_ROW], error: null };
  }
  if (table === "assessments") {
    return { data: [{ id: A1, courseId: C1 }], error: null };
  }
  return { data: [], error: null };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
});

describe("getExamMonitoring — คิวสอบ (aggregate ฝั่ง DB)", () => {
  it("ใช้ PostgREST aggregate + กรอง status=in_progress · overdue เพิ่ม lt(expires_at)", async () => {
    const { buildersFor } = setupClient(monitoringResolver);
    await getExamMonitoring();
    const [inProgress, overdue] = buildersFor("assessment_attempts");
    expect(inProgress!.select).toHaveBeenCalledWith("assessmentId:assessment_id,inProgress:id.count()");
    expect(inProgress!.eq).toHaveBeenCalledWith("status", "in_progress");
    expect(inProgress!.order).toHaveBeenCalledWith("assessment_id", { ascending: true });
    expect(inProgress!.lt).not.toHaveBeenCalled();
    expect(overdue!.select).toHaveBeenCalledWith("assessmentId:assessment_id,overdue:id.count()");
    expect(overdue!.lt).toHaveBeenCalledTimes(1);
    const ltArgs = overdue!.lt.mock.calls[0]! as unknown as [string, string];
    expect(ltArgs[0]).toBe("expires_at");
    expect(typeof ltArgs[1]).toBe("string");
  });

  it("summary/byAssessment/byCourse ตรง aggregate + lookup assessments (id, course_id)", async () => {
    const { buildersFor } = setupClient(monitoringResolver);
    const out = await getExamMonitoring();
    expect(out.summary).toEqual({ inProgressCount: 3, overdueCount: 2 });
    expect(out.byAssessment).toEqual([{ assessmentId: A1, inProgress: 3, overdue: 2 }]);
    expect(out.byCourse).toEqual([{ courseId: C1, inProgress: 3, overdue: 2 }]);
    expect(out.generatedAt).toBeTruthy();
    const [lookup] = buildersFor("assessments");
    expect(lookup!.select).toHaveBeenCalledWith("id, courseId:course_id");
    expect(lookup!.in).toHaveBeenCalledWith("id", [A1]);
  });

  it("ไม่มี user_id รายคนใน payload (aggregate เท่านั้น)", async () => {
    setupClient(monitoringResolver);
    const out = await getExamMonitoring();
    const json = JSON.stringify(out);
    expect(json).not.toContain("userId");
    expect(json).not.toContain("user_id");
  });
});

describe("getExamStatistics — view + avg (merge)", () => {
  it("merge avg เข้าแถว view · avg ไม่เจอ → null", async () => {
    const { buildersFor } = setupClient((table, idx) => {
      if (table === "v_assessment_statistics") {
        return { data: [{ assessment_id: A1, attempt_total: 10, attempt_passed: 4, pass_rate_pct: 40 }], error: null };
      }
      if (table === "assessment_attempts") {
        return idx === 0 ? { data: [{ assessmentId: A1, avgScore: 82.5 }], error: null } : { data: [], error: null };
      }
      return { data: [], error: null };
    });
    const out = await getExamStatistics({ limit: 10 });
    expect(out.rows[0]).toEqual({
      assessmentId: A1,
      attemptTotal: 10,
      attemptPassed: 4,
      passRatePct: 40,
      avgScorePct: 82.5,
    });
    expect(out.truncated).toBe(false);
    const avg = buildersFor("assessment_attempts")[0]!;
    expect(avg.select).toHaveBeenCalledWith("assessmentId:assessment_id,avgScore:score_pct.avg()");
    expect(avg.not).toHaveBeenCalledWith("submitted_at", "is", null);
    expect(avg.in).toHaveBeenCalledWith("assessment_id", [A1]);
  });

  it("view มี 2 assessment แต่ avg คืนแค่ตัวเดียว → อีกตัว avgScorePct null", async () => {
    setupClient((table) => {
      if (table === "v_assessment_statistics") {
        return {
          data: [
            { assessment_id: A1, attempt_total: 10, attempt_passed: 4, pass_rate_pct: 40 },
            { assessment_id: A2, attempt_total: 5, attempt_passed: 1, pass_rate_pct: 20 },
          ],
          error: null,
        };
      }
      if (table === "assessment_attempts") {
        return { data: [{ assessmentId: A1, avgScore: 70 }], error: null };
      }
      return { data: [], error: null };
    });
    const out = await getExamStatistics({ limit: 10 });
    expect(out.rows.map((r) => r.avgScorePct)).toEqual([70, null]);
  });
});

/**
 * export.test — runExport + report_exports + audit ADMIN_EXPORT (Wave E · D55-6)
 * ตรวจ: อ่านผ่าน user-JWT client · เขียน report_exports ผ่าน service client (fail-closed) ·
 * audit best-effort (42501 = WARN ไม่ล้ม) · CSV BOM/header ไทย · JSON · cap/truncated · filename
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

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { CSV_BOM } from "./csv";
import {
  EXPORT_CSV_HEADERS,
  EXPORT_ROW_CAP,
  filtersToContextValue,
  parseExportQuery,
  parseReportTypeParam,
  runExport,
} from "./export";

/** uuid ทดสอบ */
const A2 = "a2000000-0000-4000-8000-000000000002";
const E1 = "e1000000-0000-4000-8000-000000000001";
const U1 = "f1000000-0000-4000-8000-000000000001";
const C1 = "c1000000-0000-4000-8000-000000000001";
/** id ของแถว report_exports — ต้องเป็น uuid จริง (MINOR-4 ตรวจ strict) */
const X1 = "7e000000-0000-4000-8000-000000000001";
const X2 = "7e000000-0000-4000-8000-000000000002";
const X3 = "7e000000-0000-4000-8000-000000000003";
const X4 = "7e000000-0000-4000-8000-000000000004";

/** builder จำลอง PostgREST (chainable + awaitable) — .range() ตัดข้อมูลตามหน้า
 *  เหมือน PostgREST จริง (MAJOR-2) · .single() คืนผล insert ทั้งชุด */
function makeBuilder(result: { data: unknown; error: unknown }) {
  let rangeFrom = 0;
  let rangeTo = Number.POSITIVE_INFINITY;
  const b = {
    insert: vi.fn((payload: Record<string, unknown>) => { void payload; return singleOf(b); }),
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
    rpc: vi.fn(async () => ({ data: null, error: null })),
    single: vi.fn(async () => result),
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

/** helper: chain ของ insert ต้องกลับมาที่ builder เดิม */
function singleOf(b: ReturnType<typeof makeBuilder>) {
  return b;
}

/** service client จำลอง — rpc บันทึก error ที่ตั้งค่าได้ · from().insert() คืน builder */
function setupService(options: {
  insertResult: { data: unknown; error: unknown };
  rpcError?: unknown;
}) {
  const builder = makeBuilder(options.insertResult);
  const client = {
    from: vi.fn(() => builder),
    rpc: vi.fn(async () => (options.rpcError === undefined ? { data: null, error: null } : { data: null, error: options.rpcError })),
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return { builder, client };
}

/** user-JWT client จำลอง — from(table) dispatch ผลลัพธ์ตามตาราง */
function setupSsr(tableResults: Record<string, { data: unknown; error: unknown }>) {
  const builders: Record<string, ReturnType<typeof makeBuilder>> = {};
  const client = {
    from: vi.fn((t: string) => {
      if (builders[t] === undefined) {
        builders[t] = makeBuilder(tableResults[t] ?? { data: [], error: null });
      }
      return builders[t]!;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return builders;
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
});

describe("parseReportTypeParam / parseExportQuery / filtersToContextValue", () => {
  it("type ไม่รู้จัก → ERR-NF-001 (404)", () => {
    try {
      parseReportTypeParam("unknown");
      expect.unreachable("ต้อง throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ERR-NF-001");
    }
  });
  it("type รู้จักคืนตามลำดับ REPORT_TYPES", () => {
    expect(parseReportTypeParam("enrollments")).toBe("enrollments");
  });
  it("format default csv · json รับได้ · format แปลกปลอม → ERR-VAL-001", () => {
    const q = parseExportQuery("assessments", new URLSearchParams(""));
    expect(q.format).toBe("csv");
    const q2 = parseExportQuery("assessments", new URLSearchParams("format=json"));
    expect(q2.format).toBe("json");
    expect(() => parseExportQuery("assessments", new URLSearchParams("format=xml"))).toThrow();
  });
  it("enrollments รับ courseId · credits รับ from/to · คีย์แปลกปลอม → ERR-VAL-001", () => {
    expect(parseExportQuery("enrollments", new URLSearchParams(`courseId=${C1}`)).courseId).toBe(C1);
    const q = parseExportQuery("credits", new URLSearchParams("from=2026-01-01T00:00:00%2B00:00"));
    expect(q.from).toBe("2026-01-01T00:00:00+00:00");
    expect(() =>
      parseExportQuery("credits", new URLSearchParams(`courseId=${C1}`)),
    ).toThrow();
  });
  it("filtersToContextValue — เรียง courseId;from;to · ว่าง = \"-\"", () => {
    expect(filtersToContextValue({ courseId: C1 })).toBe(`courseId=${C1}`);
    expect(filtersToContextValue({ from: "F", to: "T" })).toBe("from=F;to=T");
    expect(filtersToContextValue({})).toBe("-");
  });
});

describe("runExport — enrollments (CSV)", () => {
  it("อ่าน view → CSV BOM + header ไทย + report_exports (params ไม่มี PII) + audit", async () => {
    setupSsr({
      v_enrollment_progress: {
        data: [{
          enrollment_id: E1,
          user_id: U1,
          course_id: C1,
          lesson_total: 10,
          lesson_completed: 4,
          progress_pct: 40,
        }],
        error: null,
      },
    });
    const { builder, client } = setupService({
      insertResult: { data: { id: X1 }, error: null },
    });
    const result = await runExport({
      type: "enrollments",
      format: "csv",
      requestedBy: "staff-1",
      requestId: null,
    });
    expect(result.rowCount).toBe(1);
    expect(result.contentType).toBe("text/csv; charset=utf-8");
    expect(result.body.startsWith(CSV_BOM + EXPORT_CSV_HEADERS.enrollments.join(","))).toBe(true);
    expect(result.filename).toMatch(/^ltc-report-enrollments-\d{8}\.csv$/);
    expect(result.truncated).toBe(false);
    // report_exports — insert payload ไม่มี PII (params = courseId เท่านั้น)
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      requested_by: "staff-1",
      report_type: "enrollments",
      format: "csv",
      status: "completed",
      expires_at: null,
    }));
    const inserted = builder.insert.mock.calls[0]![0] as unknown as { params: Record<string, string> };
    expect(inserted.params).toEqual({});
    expect(builder.single).toHaveBeenCalled();
    // audit — best-effort ผ่าน rpc append_audit_event (คีย์ context ตาม design)
    expect(client.rpc).toHaveBeenCalledWith("append_audit_event", expect.objectContaining({
      p_action: "ADMIN_EXPORT",
      p_entity_type: "report_export",
      p_entity_id: X1,
      // 0025 lead fix: actor ต้องอยู่ใน context.user_id — RPC ยกเป็น p_actor_id
      // แล้ว strip (ไม่ใส่ = แถว audit ไร้ "ใคร" ผิด 5W §1.2)
      p_context: expect.objectContaining({ user_id: "staff-1" }),
    }));
    expect(vi.mocked(createSupabaseServiceRoleClient).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runExport — JSON + truncated + fail-closed", () => {
  it("format json → body JSON parse ได้ตามสัญญา + contentType json", async () => {
    setupSsr({ v_assessment_statistics: { data: [{
      assessment_id: A2,
      attempt_total: 8,
      attempt_passed: 6,
      pass_rate_pct: 75,
    }], error: null } });
    setupService({ insertResult: { data: { id: X2 }, error: null } });
    const result = await runExport({
      type: "assessments",
      format: "json",
      requestedBy: "staff-1",
      requestId: null,
    });
    const parsed = JSON.parse(result.body) as { data: { reportType: string; rowCount: number; truncated: boolean; rows: Array<Record<string, unknown>> } };
    expect(parsed.data.reportType).toBe("assessments");
    expect(parsed.data.rowCount).toBe(1);
    expect(parsed.data.truncated).toBe(false);
    expect(parsed.data.rows[0]).toEqual({
      assessmentId: A2,
      attemptTotal: 8,
      attemptPassed: 6,
      passRatePct: 75,
    });
    expect(result.contentType).toBe("application/json; charset=utf-8");
    expect(result.filename.endsWith(".json")).toBe(true);
  });
  it("ได้ cap+1 แถว → truncated=true + แถว = cap เท่านั้น (x-ltc-truncated ที่ route)", async () => {
    const rows = Array.from({ length: EXPORT_ROW_CAP + 1 }, (_, i) => ({
      assessment_id: A2,
      attempt_total: i,
      attempt_passed: i,
      pass_rate_pct: 50,
    }));
    setupSsr({ v_assessment_statistics: { data: rows, error: null } });
    setupService({ insertResult: { data: { id: X3 }, error: null } });
    const result = await runExport({
      type: "assessments",
      format: "csv",
      requestedBy: "staff-1",
      requestId: null,
    });
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(EXPORT_ROW_CAP);
  });
  it("report_exports คืน id ไม่ใช่ uuid → ERR-SYS-002 report_exports_row_drift (MINOR-4 — ไม่เอา id เพี้ยนไปเป็น entity_id ของ audit)", async () => {
    setupSsr({ v_assessment_statistics: { data: [], error: null } });
    setupService({ insertResult: { data: { id: "not-an-uuid" }, error: null } });
    await expect(runExport({
      type: "assessments",
      format: "csv",
      requestedBy: "staff-1",
      requestId: null,
    })).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "report_exports_row_drift" } });
  });
  it("report_exports เขียนไม่ได้ → ERR-SYS-002 (fail-closed — ไม่ส่งข้อมูลออก)", async () => {
    setupSsr({ v_assessment_statistics: { data: [], error: null } });
    setupService({ insertResult: { data: null, error: { message: "rls" } } });
    await expect(runExport({
      type: "assessments",
      format: "csv",
      requestedBy: "staff-1",
      requestId: null,
    })).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "report_exports_write_failed" } });
  });
  it("audit โดน allowlist ปฏิเสธ (42501) → written:false + ไม่ล้ม export (best-effort)", async () => {
    setupSsr({ v_assessment_statistics: { data: [], error: null } });
    const { client } = setupService({
      insertResult: { data: { id: X4 }, error: null },
      rpcError: { code: "42501", message: "action not allowed" },
    });
    const result = await runExport({
      type: "assessments",
      format: "csv",
      requestedBy: "staff-1",
      requestId: null,
    });
    expect(result.exportId).toBe(X4);
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
});

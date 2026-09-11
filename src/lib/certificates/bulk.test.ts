/**
 * Unit tests: src/lib/certificates/bulk.ts — bulk job ออกใบเป็นชุด (Wave E — E-4)
 *
 * ครอบ: createBulkJob = insert cert_bulk_jobs → RPC admin_cert_bulk_issue_run เดียว
 * (mutation+audit ฝั่ง DB) · getBulkJob = select แถวเดียว + การเห็นเจ้าของ/super_admin
 * · drift fail-closed ทุกชั้น (created-row/ผล RPC/แถวตาราง) — ERR-SYS-002 ไม่ strip
 * เงียบ · last_error ตัดทอน 200 ตัวอักษร
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import { createBulkJob, getBulkJob, LAST_ERROR_MAX } from "./bulk";

type Row = Record<string, unknown>;
type Resolve = { data: unknown; error: Record<string, unknown> | null };

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const OTHER_ID = "a0000000-0000-4000-8000-000000000009";
const JOB_ID = "50000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";
const T1 = "2026-09-08T04:00:00+00:00";

/** แถว cert_bulk_jobs ตรง 10 คอลัมน์ของ 0023 (snake_case ตาม DDL) */
function jobRow(overrides: Row = {}): Row {
  return {
    id: JOB_ID,
    created_by: STAFF_ID,
    course_id: COURSE_ID, // null = ทุกหลักสูตร (patch ใน test ได้)
    status: "completed",
    total_attempts: 3,
    issued_count: 2,
    failed_count: 1,
    last_error: "ข้อมูลไม่ถูกต้อง: ผู้ถือใบยังไม่มีชื่อ (ERR-VAL-001|holder_name_missing)",
    created_at: T1,
    finished_at: T1,
    ...overrides,
  };
}

/** jsonb ที่ admin_cert_bulk_issue_run คืน (0026 — 5 คีย์ exact) */
function runResult(overrides: Row = {}): Row {
  return {
    job_id: JOB_ID,
    status: "completed",
    total_attempts: 3,
    issued_count: 2,
    failed_count: 1,
    ...overrides,
  };
}

/**
 * spec ของ fake service client — rpc dispatch ตามชื่อฟังก์ชัน · from() จำลอง builder
 * สองรูปที่ bulk.ts ใช้: insert().select().single() และ select().eq().maybeSingle()
 */
interface FakeSpec {
  /** ผลของ .single() หลัง insert — default { data: { id: JOB_ID }, error: null } */
  insertJob?: () => Resolve;
  /** dispatch rpc ตามชื่อ — default สำเร็จด้วย runResult() */
  rpc?: (fn: string) => Resolve;
  /** แถวที่ .maybeSingle() คืน — null = data null (ไม่พบ) · default jobRow() */
  selectJob?: () => Row | null;
  /** error ฝั่ง query ของ select แทนแถว */
  selectError?: () => { message: string };
}

function serviceClient(spec: FakeSpec = {}) {
  const rpc = vi.fn(async (fn: string) =>
    spec.rpc !== undefined
      ? spec.rpc(fn)
      : { data: runResult(), error: null },
  );
  const inserted: Array<{ table: string; values: Row; selectColumns: string }> = [];
  const selected: Array<{ table: string; columns: string; eqColumn: string; eqValue: unknown }> = [];
  const from = vi.fn((table: string) => ({
    insert: (values: Row) => ({
      select: (selectColumns: string) => ({
        single: async () => {
          inserted.push({ table, values, selectColumns });
          return spec.insertJob !== undefined
            ? spec.insertJob()
            : { data: { id: JOB_ID }, error: null };
        },
      }),
    }),
    select: (columns: string) => ({
      eq: (eqColumn: string, eqValue: unknown) => ({
        maybeSingle: async () => {
          selected.push({ table, columns, eqColumn, eqValue });
          if (spec.selectError !== undefined) {
            return { data: null, error: spec.selectError() };
          }
          const row = spec.selectJob !== undefined ? spec.selectJob() : jobRow();
          return { data: row, error: null };
        },
      }),
    }),
  }));
  const client = { rpc, from };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return { rpc, from, inserted, selected };
}

beforeEach(() => {
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
});

describe("createBulkJob — insert cert_bulk_jobs + RPC admin_cert_bulk_issue_run", () => {
  it("happy path: insert created_by/course_id/status ถูกต้อง → rpc ชื่อ+พารามิเตอร์ถูกต้อง → map camelCase ครบ", async () => {
    const ctx = serviceClient();
    const job = await createBulkJob({ actorId: STAFF_ID, courseId: COURSE_ID, requestId: "req-1" });
    expect(job).toEqual({
      jobId: JOB_ID,
      status: "completed",
      totalAttempts: 3,
      issuedCount: 2,
      failedCount: 1,
    });
    expect(ctx.inserted).toEqual([
      {
        table: "cert_bulk_jobs",
        values: { created_by: STAFF_ID, course_id: COURSE_ID, status: "pending" },
        selectColumns: "id",
      },
    ]);
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    expect(ctx.rpc).toHaveBeenCalledWith("admin_cert_bulk_issue_run", {
      p_job_id: JOB_ID,
      p_request_id: "req-1",
    });
  });

  it("courseId null (ทุกหลักสูตร) + requestId ไม่ระบุ → course_id null + p_request_id null", async () => {
    const ctx = serviceClient();
    const job = await createBulkJob({ actorId: STAFF_ID, courseId: null });
    expect(job.status).toBe("completed");
    expect(ctx.inserted[0]?.values).toEqual({
      created_by: STAFF_ID,
      course_id: null,
      status: "pending",
    });
    expect(ctx.rpc).toHaveBeenCalledWith("admin_cert_bulk_issue_run", {
      p_job_id: JOB_ID,
      p_request_id: null,
    });
  });

  it("PostgREST wrap scalar เป็น array หลักเดียว → unwrap ได้ (แบบเดียวกับ issue.ts)", async () => {
    serviceClient({ rpc: () => ({ data: [runResult()], error: null }) });
    const job = await createBulkJob({ actorId: STAFF_ID, courseId: null });
    expect(job.jobId).toBe(JOB_ID);
  });

  it.each([
    ["ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|bulk_job_not_found)", "ERR-NF-001", "bulk_job_not_found"],
    [
      "ข้อมูลไม่ถูกต้อง: job นี้จบไปแล้ว สร้าง job ใหม่เพื่อออกส่วนที่เหลือ (ERR-VAL-001|bulk_job_already_finished)",
      "ERR-VAL-001",
      "bulk_job_already_finished",
    ],
    ["ข้อมูลไม่ถูกต้อง: ต้องระบุ job (ERR-VAL-001|job_id_required)", "ERR-VAL-001", "job_id_required"],
  ])("RPC error มีป้าย → map ตรง: %s", async (message, code, reason) => {
    serviceClient({ rpc: () => ({ data: null, error: { message } }) });
    const error = await createBulkJob({ actorId: STAFF_ID, courseId: null }).catch(
      (e: unknown) => e,
    );
    expect(error, message).toBeInstanceOf(AppError);
    expect((error as AppError).code, message).toBe(code);
    expect((error as AppError).details, message).toEqual({ reason });
  });

  it("RPC error ไม่มีป้าย → ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    serviceClient({ rpc: () => ({ data: null, error: { code: "XX000", message: "boom" } }) });
    const error = await createBulkJob({ actorId: STAFF_ID, courseId: null }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_bulk_run_failed" });
  });

  it("insert ล้ม → ERR-SYS-002 fail-closed ก่อนเรียก RPC (ไม่รัน job ที่ไม่มีแถว)", async () => {
    const ctx = serviceClient({ insertJob: () => ({ data: null, error: { message: "rls denied" } }) });
    const error = await createBulkJob({ actorId: STAFF_ID, courseId: null }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_bulk_job_insert_failed" });
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["แถวไม่มี id (data null)", null],
    ["id ไม่ใช่ uuid", { id: "not-a-uuid" }],
    ["แถวมีคีย์เกิน", { id: JOB_ID, extra_key: 1 }],
    ["แถวมีหลาย id", { id: JOB_ID, id2: JOB_ID }],
  ])("created-row drift: %s → ERR-SYS-002 ไม่เอาไปเป็น p_job_id", async (_label, row) => {
    const ctx = serviceClient({ insertJob: () => ({ data: row, error: null }) });
    const error = await createBulkJob({ actorId: STAFF_ID, courseId: null }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_bulk_job_insert_row_drift" });
    expect(ctx.rpc).not.toHaveBeenCalled();
  });
});

describe("getBulkJob — select แถวเดียว + การเห็นเจ้าของ/super_admin", () => {
  it("เจ้าของ → map ครบทุกฟิลด์ + select eq(id) + คอลัมน์ครบ 10 คอลัมน์", async () => {
    const ctx = serviceClient();
    const job = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false });
    expect(job).toEqual({
      jobId: JOB_ID,
      status: "completed",
      totalAttempts: 3,
      issuedCount: 2,
      failedCount: 1,
      lastError: "ข้อมูลไม่ถูกต้อง: ผู้ถือใบยังไม่มีชื่อ (ERR-VAL-001|holder_name_missing)",
      createdAt: T1,
      finishedAt: T1,
    });
    expect(ctx.selected[0]?.columns.split(",").map((c) => c.trim())).toEqual([
      "id",
      "created_by",
      "course_id",
      "status",
      "total_attempts",
      "issued_count",
      "failed_count",
      "last_error",
      "created_at",
      "finished_at",
    ]);
    expect(ctx.selected[0]?.eqColumn).toBe("id");
    expect(ctx.selected[0]?.eqValue).toBe(JOB_ID);
  });

  it("super_admin เห็น job ของคนอื่น → 200 ครบ (isSuperAdmin bypass การเป็นเจ้าของ)", async () => {
    serviceClient({ selectJob: () => jobRow({ created_by: OTHER_ID }) });
    const job = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: true });
    expect(job.jobId).toBe(JOB_ID);
  });

  it("registrar คนอื่นเจอ job ของเพื่อน → ERR-NF-001 (ตอบเหมือนไม่พบ ไม่เฉลยว่ามีจริง)", async () => {
    serviceClient({ selectJob: () => jobRow({ created_by: OTHER_ID }) });
    const error = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("ERR-NF-001");
  });

  it("ไม่มี job (data null) → ERR-NF-001 (ไม่ตก drift — ไม่พบ ≠ แถวเพี้ยน)", async () => {
    serviceClient({ selectJob: () => null });
    const error = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("ERR-NF-001");
  });

  it("query ล้ม (RLS/เครือข่าย) → ERR-SYS-002 cert_bulk_job_query_failed", async () => {
    serviceClient({ selectError: () => ({ message: "connection lost" }) });
    const error = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_bulk_job_query_failed" });
  });

  it("สถานะ pending/running ผ่าน enum ครบชุด (job กำลังรันยังอ่านสถานะได้)", async () => {
    serviceClient({ selectJob: () => jobRow({ status: "running" }) });
    const job = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false });
    expect(job.status).toBe("running");
  });

  it("lastError null → null จริง (ไม่ fabricate ข้อความ)", async () => {
    serviceClient({ selectJob: () => jobRow({ last_error: null, finished_at: null }) });
    const job = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false });
    expect(job.lastError).toBeNull();
    expect(job.finishedAt).toBeNull();
  });

  it(`lastError ยาว > ${LAST_ERROR_MAX} → ตัดทอนเหลือ ${LAST_ERROR_MAX} ตัวอักษร`, async () => {
    const long = "ก".repeat(300);
    serviceClient({ selectJob: () => jobRow({ last_error: long }) });
    const job = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false });
    expect(job.lastError).toHaveLength(LAST_ERROR_MAX);
    expect(job.lastError).toBe(long.slice(0, LAST_ERROR_MAX));
  });

  it.each([
    ["ขาดคอลัมน์ issued_count", (row: Row) => {
      delete row.issued_count;
      return row;
    }],
    ["คอลัมน์เกิน (course_title รั่ว)", (row: Row) => ({ ...row, course_title: "x" })],
    ["total_attempts ผิดชนิด (string)", (row: Row) => ({ ...row, total_attempts: "3" })],
    ["created_at ไม่ใช่ ISO", (row: Row) => ({ ...row, created_at: "not-a-time" })],
    ["status นอก enum", (row: Row) => ({ ...row, status: "queued" })],
    ["created_by ไม่ใช่ uuid", (row: Row) => ({ ...row, created_by: "nope" })],
  ])("แถว drift: %s → ERR-SYS-002 cert_bulk_job_row_drift (ไม่ serialize เงียบ)", async (_label, patch) => {
    serviceClient({ selectJob: () => patch(jobRow()) });
    const error = await getBulkJob({ jobId: JOB_ID, viewerId: STAFF_ID, isSuperAdmin: false }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_bulk_job_row_drift" });
  });
});

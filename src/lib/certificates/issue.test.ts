/**
 * Unit tests: src/lib/certificates/issue.ts — issue + eligible queue (Wave D, lane D-4)
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
vi.mock("./pdf", () => ({ renderCertificatePdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import { renderCertificatePdf } from "./pdf";
import { issueCertificate, listEligibleAttempts } from "./issue";
import { certLogger } from "./shared";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const ENROLL_ID = "e0000000-0000-4000-8000-000000000001";
const USER_ID = "f0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "d0000000-0000-4000-8000-000000000001";
const MEDIA_ID = "90000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const T1 = "2026-09-01T00:00:00+00:00";

/** สถานะที่ builder จับไว้ — handler ใช้ตัดสินว่าจะ resolve อะไร */
interface BuilderState {
  table: string;
  select?: string;
  eq: Array<[string, unknown]>;
  limit: unknown[];
  inserted?: unknown;
  updated?: unknown;
}

type Resolve = { data: unknown; error: null } | { data: null; error: Record<string, unknown> };

interface FakeSpec {
  /** resolve สำหรับ select/update/await — return {data, error:null} */
  read?: (table: string, st: BuilderState) => Resolve;
  /** resolve สำหรับ insert (payload มาให้) */
  onInsert?: (table: string, payload: Row) => Resolve;
  /** resolve ของ storage.upload */
  upload?: () => Resolve;
}

/** thenable builder จำลอง PostgrestBuilder — จับ state แล้ว resolve ตาม spec */
function makeBuilder(table: string, spec: FakeSpec, st: BuilderState) {
  const builder: Record<string, unknown> = {
    select: vi.fn((s: string) => {
      st.select = s;
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      st.eq.push([column, value]);
      return builder;
    }),
    not: vi.fn(() => builder),
    filter: vi.fn(() => builder),
    or: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn((n: unknown) => {
      st.limit.push(n);
      return builder;
    }),
    update: vi.fn((payload: unknown) => {
      st.updated = payload;
      return builder;
    }),
    insert: vi.fn((payload: unknown) => {
      st.inserted = payload;
      return builder;
    }),
    maybeSingle: vi.fn(async () => resolveFor(table, st, spec)),
    single: vi.fn(async () => resolveFor(table, st, spec)),
    then: (res: (v: Resolve) => unknown) => res(resolveFor(table, st, spec)),
  };
  return builder;
}

/** resolve กลาง — insert → onInsert · อย่างอื่น → read(table, state) */
function resolveFor(table: string, st: BuilderState, spec: FakeSpec): Resolve {
  if (st.inserted !== undefined) {
    return spec.onInsert?.(table, st.inserted as Row) ?? OK;
  }
  return spec.read?.(table, st) ?? OK;
}

const OK: Resolve = { data: null, error: null };

type Row = Record<string, unknown>;

/** mock client ของ service_role — ครบ from/storage ที่ lib ต้องใช้ */
function serviceClient(spec: FakeSpec) {
  const uploads: Array<{ bucket: string; path: string; body: unknown; contentType?: string | undefined }> = [];
  const builderLog: BuilderState[] = [];
  const client = {
    from: vi.fn((table: string) => {
      const st: BuilderState = { table, eq: [], limit: [] };
      builderLog.push(st);
      return makeBuilder(table, spec, st);
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    storage: {
      from: (bucket: string) => ({
        upload: vi.fn(async (path: string, body: unknown, meta: { contentType?: string }) => {
          uploads.push({ bucket, path, body, contentType: meta?.contentType });
          return spec.upload?.() ?? OK;
        }),
      }),
    },
    _builderLog: builderLog,
    _uploads: uploads,
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return client as typeof client & { _builderLog: BuilderState[]; _uploads: typeof uploads };
}

/** แถวจำลองทั้งหมดที่ issueCertificate ต้องอ่าน */
function fixtures(): {
  enrollment: Row;
  attempt: Row;
  profile: Row;
  course: Row;
  certRow: Row;
} {
  const enrollment: Row = {
    id: ENROLL_ID,
    user_id: USER_ID,
    course_id: COURSE_ID,
    status: "completed",
    completed_at: T1,
    deleted_at: null,
  };
  const attempt: Row = { id: ATTEMPT_ID, score_pct: 85, attempt_no: 1 };
  const profile: Row = { display_name: "นายสมชาย", first_name: "สมชาย", last_name: "ใจดี" };
  const course: Row = { title_th: "หลักสูตรทดสอบ" };
  const certRow: Row = {
    id: CERT_ID,
    cert_no: "LTC-2026-000123",
    verify_code: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
    issued_at: "2026-09-08T04:00:00+00:00",
  };
  return { enrollment, attempt, profile, course, certRow };
}

/** read handler มาตรฐานตาม fixtures — table ตัดสินข้อมูล (override ต่อ table ได้) */
function readFrom(
  fx: ReturnType<typeof fixtures>,
  overrides: Record<string, Resolve> = {},
): (table: string) => Resolve {
  const base: Record<string, Resolve> = {
    enrollments: { data: fx.enrollment, error: null },
    assessment_attempts: { data: [fx.attempt], error: null },
    profiles: { data: fx.profile, error: null },
    courses: { data: fx.course, error: null },
    media_assets: { data: { id: MEDIA_ID }, error: null },
  };
  const merged = { ...base, ...overrides };
  return (table: string): Resolve => merged[table] ?? OK;
}

/** insert handler มาตรฐาน — certificates: แถวใบ · media_assets: {id} · จำลอง 23505 ได้ */
function insertFrom(
  fx: ReturnType<typeof fixtures>,
  opts: { uniqueFails?: number; mediaFails?: boolean } = {},
): (table: string, payload: Row) => Resolve {
  let round = 0;
  return (table: string, payload: Row): Resolve => {
    void payload;
    if (table === "media_assets") {
      return opts.mediaFails === true
        ? { data: null, error: { message: "contract" } }
        : { data: { id: MEDIA_ID }, error: null };
    }
    round += 1;
    if (round <= (opts.uniqueFails ?? 0)) {
      return {
        data: null,
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      };
    }
    return { data: fx.certRow, error: null };
  };
}

/** spy warn ของ certLogger — ใช้พิสูจน์ว่า WARN ไม่พา PII เข้า log */
let warnCalls: Array<{ message: string; fields: Record<string, unknown> }> = [];

function captureWarns() {
  warnCalls = [];
  vi.spyOn(certLogger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
    warnCalls.push({ message, fields: fields ?? {} });
    return certLogger;
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  captureWarns();
});

function lastInsertOf(client: ReturnType<typeof serviceClient>, table = "certificates"): Row {
  const inserts = client._builderLog.filter((st) => st.table === table && st.inserted !== undefined);
  const last = inserts.at(-1);
  if (last === undefined) {
    throw new Error(`no insert captured for ${table}`);
  }
  return last.inserted as Row;
}

describe("issueCertificate — happy path (SDS §3.4a)", () => {
  it("คืนใบ valid ครบฟิลด์ + upload เข้า bucket certificates ที่ path ถูก", async () => {
    const fx = fixtures();
    const client = serviceClient({
      read: readFrom(fx),
      onInsert: insertFrom(fx),
      upload: () => OK,
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID, requestId: "req-1" });
    expect(cert.status).toBe("valid");
    expect(cert.certNo).toMatch(/^LTC-\d{4}-\d{6}$/);
    expect(cert.verifyCode).toHaveLength(43);
    expect(cert.holderNameSnapshot).toBe("สมชาย ใจดี");
    expect(cert.courseTitleSnapshot).toBe("หลักสูตรทดสอบ");
    expect(cert.creditSnapshot).toBeNull();
    expect(cert.pdfMediaId).toBe(MEDIA_ID);
    expect(cert.enrollmentId).toBe(ENROLL_ID);
    expect(cert.userId).toBe(USER_ID);
    expect(cert.courseId).toBe(COURSE_ID);
    const upload = client._uploads[0];
    expect(upload).toBeDefined();
    expect(upload?.bucket).toBe("certificates");
    expect(upload?.path).toBe(`certificates-pdf/${cert.certNo}.pdf`);
    expect(upload?.contentType).toBe("application/pdf");
    // audit CERT_ISSUE พยายามเขียนผ่าน RPC เสมอ
    expect(client.rpc).toHaveBeenCalledWith("append_audit_event", expect.objectContaining({ p_action: "CERT_ISSUE" }));
  });

  it("insert payload ครบตามสัญญาตาราง certificates (snapshot ณ วันออก)", async () => {
    const fx = fixtures();
    const client = serviceClient({ read: readFrom(fx), onInsert: insertFrom(fx), upload: () => OK });
    await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    const payload = lastInsertOf(client);
    expect(payload["cert_no"]).toMatch(/^LTC-\d{4}-\d{6}$/);
    expect(payload["verify_code"]).toHaveLength(43);
    expect(payload["enrollment_id"]).toBe(ENROLL_ID);
    expect(payload["user_id"]).toBe(USER_ID);
    expect(payload["course_id"]).toBe(COURSE_ID);
    expect(payload["holder_name_snapshot"]).toBe("สมชาย ใจดี");
    expect(payload["course_title_snapshot"]).toBe("หลักสูตรทดสอบ");
    expect(payload["credit_snapshot"]).toBeNull();
    expect(payload["issued_by"]).toBe(STAFF_ID);
    expect(payload["status"]).toBe("valid");
  });
});

describe("issueCertificate — เงื่อนไขก่อนออกใบ (VAL/NF)", () => {
  it("enrollment ไม่มีจริง → ERR-NF-001", async () => {
    const fx = fixtures();
    serviceClient({
      read: (table, st) =>
        table === "enrollments" && st.eq.some(([, v]) => v === ENROLL_ID)
          ? { data: null, error: null }
          : readFrom(fx)(table),
      onInsert: insertFrom(fx),
    });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("ERR-NF-001");
  });

  it("enrollment ยังไม่ completed → ERR-VAL-001 enrollment_not_completed", async () => {
    const fx = fixtures();
    fx.enrollment["status"] = "active";
    serviceClient({ read: readFrom(fx), onInsert: insertFrom(fx) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-VAL-001");
    expect((error as AppError).details).toMatchObject({ field: "enrollmentId", reason: "enrollment_not_completed" });
  });

  it("enrollment soft-deleted → ERR-VAL-001 enrollment_not_completed", async () => {
    const fx = fixtures();
    fx.enrollment["deleted_at"] = T1;
    serviceClient({ read: readFrom(fx), onInsert: insertFrom(fx) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "enrollment_not_completed" });
  });

  it("มีใบ valid อยู่แล้ว → ERR-VAL-001 valid_certificate_exists", async () => {
    const fx = fixtures();
    serviceClient({
      read: (table) => (table === "certificates" ? { data: { id: CERT_ID }, error: null } : readFrom(fx)(table)),
      onInsert: insertFrom(fx),
    });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "valid_certificate_exists" });
  });

  it("ไม่มี attempt ที่ผ่าน → ERR-VAL-001 no_passed_attempt", async () => {
    const fx = fixtures();
    serviceClient({
      read: (table) =>
        table === "assessment_attempts" ? { data: [], error: null } : readFrom(fx)(table),
      onInsert: insertFrom(fx),
    });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "no_passed_attempt" });
  });

  it("attempt filter ตรง enum จริง: passed=true + status='passed' + submitted_at ไม่ null", async () => {
    const fx = fixtures();
    const client = serviceClient({ read: readFrom(fx), onInsert: insertFrom(fx) });
    await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    const attemptQuery = client._builderLog.find((st) => st.table === "assessment_attempts");
    expect(attemptQuery?.select).toBe("id,score_pct,attempt_no");
    // not()/filter() เป็น no-op ใน fake — ตรวจผ่าน eq ที่จับได้
    expect(attemptQuery?.eq).toEqual(
      expect.arrayContaining([
        ["enrollment_id", ENROLL_ID],
        ["passed", true],
        ["status", "passed"],
      ]),
    );
  });
});

describe("issueCertificate — retry เมื่อชน UNIQUE (23505)", () => {
  it("ชน 2 ครั้งแล้วสำเร็จ → สุ่ม cert_no/verify_code ใหม่ทุกรอบ + คืนสำเร็จ", async () => {
    const fx = fixtures();
    const client = serviceClient({
      read: readFrom(fx),
      onInsert: insertFrom(fx, { uniqueFails: 2 }),
      upload: () => OK,
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.status).toBe("valid");
    const certInserts = client._builderLog.filter((st) => st.table === "certificates" && st.inserted !== undefined);
    expect(certInserts).toHaveLength(3); // 2 พลาด + 1 สำเร็จ
    const certNos = certInserts.map((st) => (st.inserted as Row)["cert_no"]);
    expect(new Set(certNos).size).toBe(3); // สุ่มใหม่ทุกรอบ
    const codes = certInserts.map((st) => (st.inserted as Row)["verify_code"]);
    expect(new Set(codes).size).toBe(3);
  });

  it("ชนครบ 5 รอบ → ERR-SYS-001 cert_code_retry_exhausted", async () => {
    const fx = fixtures();
    serviceClient({
      read: readFrom(fx),
      onInsert: insertFrom(fx, { uniqueFails: 5 }),
    });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-001");
    expect((error as AppError).details).toMatchObject({ reason: "cert_code_retry_exhausted" });
  });

  it("insert error ที่ไม่ใช่ unique → ERR-SYS-002 (ไม่ retry)", async () => {
    const fx = fixtures();
    serviceClient({
      read: readFrom(fx),
      onInsert: () => ({ data: null, error: { code: "23503", message: "fk violation" } }),
    });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
  });
});

describe("issueCertificate — PDF/Storage พัง = คงใบ + pdf_media_id null + WARN", () => {
  it("upload ล้มเหลว → pdfMediaId null + WARN certificate_pdf_upload_failed", async () => {
    const fx = fixtures();
    serviceClient({
      read: readFrom(fx),
      onInsert: insertFrom(fx),
      upload: () => ({ data: null, error: { message: "bucket not found" } }),
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.status).toBe("valid");
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_upload_failed");
  });

  it("media_assets insert ล้มเหลว → WARN certificate_media_insert_failed", async () => {
    const fx = fixtures();
    serviceClient({
      read: readFrom(fx),
      onInsert: insertFrom(fx, { mediaFails: true }),
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_media_insert_failed");
  });

  it("render โยน error → WARN certificate_pdf_render_failed + ยังออกใบได้", async () => {
    const fx = fixtures();
    serviceClient({ read: readFrom(fx), onInsert: insertFrom(fx) });
    vi.mocked(renderCertificatePdf).mockRejectedValueOnce(new Error("font missing"));
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_render_failed");
  });

  it("WARN ทุกข้อความไม่พา PII — อนุญาตเฉพาะ route/user_id (holder_name ห้ามเข้า log)", async () => {
    const fx = fixtures();
    serviceClient({
      read: readFrom(fx),
      onInsert: insertFrom(fx),
      upload: () => ({ data: null, error: { message: "x" } }),
    });
    await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(warnCalls.length).toBeGreaterThan(0);
    for (const w of warnCalls) {
      expect(Object.keys(w.fields).sort()).toEqual(["route", "user_id"]);
      expect(JSON.stringify(w)).not.toContain("\u0e2a\u0e21\u0e0a\u0e32\u0e22");
    }
  });
});

describe("listEligibleAttempts — คิวงาน (endpoint 82)", () => {
  const attemptRow = {
    id: ATTEMPT_ID,
    enrollment_id: ENROLL_ID,
    user_id: USER_ID,
    score_pct: 90,
    submitted_at: T1,
    attempt_no: 1,
    profiles: { first_name: "สมชาย", last_name: "ใจดี", display_name: "นายสมชาย" },
    enrollments: { course_id: COURSE_ID, status: "completed", deleted_at: null },
  };

  function eligibleSpec(rows: Row[], validCertEnrollIds: Row[] = []) {
    return {
      read: (table: string) => {
        if (table === "assessment_attempts") {
          return { data: rows, error: null };
        }
        if (table === "certificates") {
          // st.eq มี [enrollment_id, ids] จาก .in() — fake ไม่จับ in() → แยกด้วย select
          return { data: validCertEnrollIds, error: null };
        }
        return OK;
      },
    };
  }

  it("แถวผ่านเกณฑ์ → map เป็น resource (ชื่อจาก first+last) + ไม่มี valid cert → อยู่ในคิว", async () => {
    serviceClient(eligibleSpec([attemptRow], []));
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
    expect(page.data).toHaveLength(1);
    const first = page.data[0];
    expect(first?.attemptId).toBe(ATTEMPT_ID);
    expect(first?.holderName).toBe("สมชาย ใจดี");
    expect(first?.courseId).toBe(COURSE_ID);
  });

  it("enrollment ที่มีใบ valid แล้ว → ถูก anti-join ตัดออกจากคิว", async () => {
    serviceClient(eligibleSpec([attemptRow], [{ enrollment_id: ENROLL_ID }]));
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.data).toEqual([]);
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("limit+1 แถว → hasMore + nextCursor (submitted_at, id)", async () => {
    const rows = [attemptRow, { ...attemptRow, id: "d0000000-0000-4000-8000-000000000002", submitted_at: "2026-08-01T00:00:00+00:00" }, { ...attemptRow, id: "d0000000-0000-4000-8000-000000000003", submitted_at: "2026-07-01T00:00:00+00:00" }];
    serviceClient(eligibleSpec(rows, []));
    const page = await listEligibleAttempts({ limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).toBeTruthy();
  });

  it("query ของ eligible ผูก !inner + filter ตาม SDS §3.4a", async () => {
    const client = serviceClient(eligibleSpec([], []));
    await listEligibleAttempts({ limit: 5 });
    const q = client._builderLog.find((st) => st.table === "assessment_attempts");
    expect(q?.select).toContain("profiles!inner(");
    expect(q?.select).toContain("enrollments!inner(");
    expect(q?.limit).toContain(6); // limit+1
  });
});

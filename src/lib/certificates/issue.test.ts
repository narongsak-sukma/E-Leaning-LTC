/**
 * Unit tests: src/lib/certificates/issue.ts — issue + eligible queue (Wave D · 0019-r1/r2)
 *
 * 0019-r1 (gate r1 B2/B8): issueCertificate = RPC `admin_issue_certificate` เดียว
 * (ตรวจ enrollment/attempt/ซ้ำ + สุ่มรหัส + INSERT + CERT_ISSUE audit ทั้งหมดใน TX
 * ฝั่ง DB) — BFF เหลือ PDF pipeline (พัง = คงใบ + WARN ตาม D36-O6)
 * 0019-r2 (gate r2 F2/F6): PDF pipeline จบด้วย RPC `admin_attach_certificate_pdf`
 * (media_assets INSERT + certificates UPDATE + CERT_PDF_ATTACH audit TX เดียว —
 * mock จึงต้อง dispatch RPC ตามชื่อฟังก์ชัน) · listEligibleAttempts = RPC
 * `admin_eligible_certificates` เดียว (anti-join ใบ valid + keyset + ตัดหน้าใน
 * SQL — BFF ขอ limit+1 ให้ buildPage เทียบ hasMore)
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

type Row = Record<string, unknown>;
type Resolve = { data: unknown; error: null } | { data: null; error: Record<string, unknown> };
type RpcResult = { data: unknown; error: Record<string, unknown> | null };

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const ENROLL_ID = "e0000000-0000-4000-8000-000000000001";
const USER_ID = "f0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const MEDIA_ID = "90000000-0000-4000-8000-000000000001";
const T1 = "2026-09-08T04:00:00+00:00";

/** คำตอบมาตรฐานของ RPC แนบ PDF (idempotent — ใบมีไฟล์อยู่แล้ว) */
function attachRow(attached: boolean): Row {
  return { pdf_media_id: MEDIA_ID, attached };
}

/**
 * spec ของ fake client — RPC ทั้งหมด dispatch ตามชื่อฟังก์ชัน
 * (issue.ts เรียกถึงสอง RPC: admin_issue_certificate ตามด้วย admin_attach_certificate_pdf)
 */
interface FakeSpec {
  rpc?: (fn: string) => RpcResult;
  upload?: () => Resolve;
}

const OK: Resolve = { data: null, error: null };

function serviceClient(spec: FakeSpec) {
  const rpc = vi.fn(async (fn: string) => spec.rpc?.(fn) ?? { data: null, error: null });
  const uploads: Array<{ bucket: string; path: string; contentType?: string | undefined }> = [];
  const client = {
    rpc,
    storage: {
      from: (bucket: string) => ({
        upload: vi.fn(async (path: string, _body: unknown, meta: { contentType?: string }) => {
          uploads.push({ bucket, path, contentType: meta?.contentType });
          return spec.upload?.() ?? OK;
        }),
      }),
    },
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return { rpc, uploads };
}

/** jsonb ที่ cert_issue_core คืน (ผ่าน admin_issue_certificate) */
function coreRow(): Row {
  return {
    id: CERT_ID,
    cert_no: "LTC-2026-000123",
    verify_code: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
    enrollment_id: ENROLL_ID,
    user_id: USER_ID,
    course_id: COURSE_ID,
    holder_name: "สมชาย ใจดี",
    course_title: "หลักสูตรทดสอบ",
    issued_at: T1,
  };
}

/** spec มาตรฐาน: issue RPC สำเร็จ + attach RPC สำเร็จ + upload สำเร็จ */
function happySpec(): FakeSpec {
  return {
    rpc: (fn) =>
      fn === "admin_attach_certificate_pdf"
        ? { data: attachRow(true), error: null }
        : { data: coreRow(), error: null },
    upload: () => OK,
  };
}

/** spy warn ของ certLogger — ใช้พิสูจน์ว่า WARN ไม่พา PII เข้า log */
let warnCalls: Array<{ message: string; fields: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  warnCalls = [];
  vi.spyOn(certLogger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
    warnCalls.push({ message, fields: fields ?? {} });
    return certLogger;
  });
});

describe("issueCertificate — RPC admin_issue_certificate + admin_attach_certificate_pdf", () => {
  it("happy path: map core jsonb → IssuedCertificate ครบ + PDF ผูกสำเร็จ · RPC สองครั้งตามลำดับ", async () => {
    const ctx = serviceClient(happySpec());
    const cert = await issueCertificate({
      actorId: STAFF_ID,
      enrollmentId: ENROLL_ID,
      requestId: "req-1",
    });
    expect(cert).toEqual({
      id: CERT_ID,
      certNo: "LTC-2026-000123",
      verifyCode: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
      enrollmentId: ENROLL_ID,
      userId: USER_ID,
      courseId: COURSE_ID,
      holderNameSnapshot: "สมชาย ใจดี",
      courseTitleSnapshot: "หลักสูตรทดสอบ",
      creditSnapshot: null,
      status: "valid",
      issuedAt: T1,
      pdfMediaId: MEDIA_ID,
    });
    // B2: mutation+audit ของใบอยู่ใน RPC เดียว — BFF ไม่เขียน append_audit_event เอง
    expect(ctx.rpc).toHaveBeenCalledTimes(2);
    expect(ctx.rpc).toHaveBeenNthCalledWith(1, "admin_issue_certificate", {
      p_actor_user_id: STAFF_ID,
      p_enrollment_id: ENROLL_ID,
      p_request_id: "req-1",
    });
    // F2: แนบ PDF = RPC เดียว (media INSERT + cert UPDATE + audit TX เดียว) —
    // params ครบทุกตัวรวม p_request_id ที่ส่งต่อจากคำขอเดียวกัน
    expect(ctx.rpc).toHaveBeenNthCalledWith(2, "admin_attach_certificate_pdf", {
      p_actor_user_id: STAFF_ID,
      p_certificate_id: CERT_ID,
      p_storage_path: "certificates-pdf/LTC-2026-000123.pdf",
      p_mime_type: "application/pdf",
      p_size_bytes: 4,
      p_request_id: "req-1",
    });
    const upload = ctx.uploads[0];
    expect(upload?.bucket).toBe("certificates");
    expect(upload?.path).toBe("certificates-pdf/LTC-2026-000123.pdf");
    expect(upload?.contentType).toBe("application/pdf");
  });

  it("requestId ไม่ระบุ → p_request_id เป็น null ทั้งสอง RPC · PostgREST wrap array → แกะแถวได้", async () => {
    const ctx = serviceClient({
      ...happySpec(),
      rpc: (fn) =>
        fn === "admin_attach_certificate_pdf"
          ? { data: [attachRow(true)], error: null }
          : { data: [coreRow()], error: null },
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.id).toBe(CERT_ID);
    expect(cert.pdfMediaId).toBe(MEDIA_ID);
    expect(ctx.rpc).toHaveBeenNthCalledWith(1, "admin_issue_certificate", {
      p_actor_user_id: STAFF_ID,
      p_enrollment_id: ENROLL_ID,
      p_request_id: null,
    });
    expect(ctx.rpc).toHaveBeenNthCalledWith(2, "admin_attach_certificate_pdf", {
      p_actor_user_id: STAFF_ID,
      p_certificate_id: CERT_ID,
      p_storage_path: "certificates-pdf/LTC-2026-000123.pdf",
      p_mime_type: "application/pdf",
      p_size_bytes: 4,
      p_request_id: null,
    });
  });

  it.each([
    ["ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|enrollment_not_found)", "ERR-NF-001", "enrollment_not_found"],
    ["ข้อมูลไม่ถูกต้อง: ผู้เรียนยังไม่จบหลักสูตรนี้ (ERR-VAL-001|enrollment_not_completed)", "ERR-VAL-001", "enrollment_not_completed"],
    ["ข้อมูลไม่ถูกต้อง: มีใบ valid อยู่แล้ว (ERR-VAL-001|valid_certificate_exists)", "ERR-VAL-001", "valid_certificate_exists"],
    ["ข้อมูลไม่ถูกต้อง: ไม่พบผลสอบที่ผ่านเกณฑ์ (ERR-VAL-001|no_passed_attempt)", "ERR-VAL-001", "no_passed_attempt"],
    ["ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-001|cert_code_retry_exhausted)", "ERR-SYS-001", "cert_code_retry_exhausted"],
    ["ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|cert_profile_lookup_failed)", "ERR-SYS-002", "cert_profile_lookup_failed"],
  ])("RPC error มีป้าย → map ตรง: %s", async (message, code, reason) => {
    serviceClient({ rpc: () => ({ data: null, error: { message } }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect(error, message).toBeInstanceOf(AppError);
    expect((error as AppError).code, message).toBe(code);
    expect((error as AppError).details, message).toEqual({ reason });
  });

  it("RPC error ไม่มีป้าย → ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    serviceClient({ rpc: () => ({ data: null, error: { code: "XX000", message: "boom" } }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_issue_rpc_failed" });
  });

  it("RPC สำเร็จแต่ data null → ERR-SYS-002 (schema ไม่ผ่าน = drift — r7-M2)", async () => {
    serviceClient({ rpc: () => ({ data: null, error: null }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_core_row_drift" });
  });
});

describe("r7-M2 — issue RPC row drift → ERR-SYS-002 ที่ขาเข้า (ไม่ strip/fabricate เงียบ)", () => {
  it("core jsonb มีคีย์เกิน → cert_core_row_drift", async () => {
    serviceClient({ rpc: () => ({ data: { ...coreRow(), extra_key: "x" }, error: null }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_core_row_drift" });
  });

  it("r8-N2: RPC คืน array ยาว 2 (แถวที่สองต้องหายเงียบไม่ได้) → cert_core_row_drift", async () => {
    serviceClient({ rpc: () => ({ data: [coreRow(), { junk: true }], error: null }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_core_row_drift" });
  });

  it("r8-N2: RPC คืน array เปล่า → cert_core_row_drift (ไม่ fabricate แถวจากค่าว่าง)", async () => {
    serviceClient({ rpc: () => ({ data: [], error: null }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_core_row_drift" });
  });

  it("core jsonb ขาด verify_code → cert_core_row_drift (ไม่ fabricate ค่าว่าง)", async () => {
    const row = coreRow();
    delete row.verify_code;
    serviceClient({ rpc: () => ({ data: row, error: null }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_core_row_drift" });
  });

  it.each([
    ["holder_name ว่าง (RPC ปฏิเสธก่อน mutation แล้วตาม r7-M1 — ถ้าถึงมือ BFF = drift)", { holder_name: "" }],
    ["cert_no ผิดรูปแบบ LTC-YYYY-<6 หลัก>", { cert_no: "not-a-cert-no" }],
    ["issued_at ไม่ใช่ ISO datetime", { issued_at: "not-a-time" }],
  ])("ค่าผิดสัญญา: %s → cert_core_row_drift", async (_label, patch) => {
    serviceClient({ rpc: () => ({ data: { ...coreRow(), ...patch }, error: null }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_core_row_drift" });
  });
});

describe("issueCertificate — PDF/Storage/attach พัง = คงใบ + pdf_media_id null + WARN (D36-O6)", () => {
  it("upload ล้มเหลว → pdfMediaId null + WARN certificate_pdf_upload_failed (ไม่ถึง attach RPC)", async () => {
    const ctx = serviceClient({ ...happySpec(), upload: () => ({ data: null, error: { message: "bucket not found" } }) });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.status).toBe("valid");
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_upload_failed");
    expect(ctx.rpc).toHaveBeenCalledTimes(1); // มีแต่ issue — attach ไม่ถูกเรียก
  });

  it("attach RPC ล้มเหลว (F2) → WARN certificate_pdf_attach_failed + คงใบ (ใบ valid ยัง verify ได้)", async () => {
    serviceClient({
      ...happySpec(),
      rpc: (fn) =>
        fn === "admin_attach_certificate_pdf"
          ? { data: null, error: { code: "42501", message: "permission denied" } }
          : { data: coreRow(), error: null },
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.status).toBe("valid");
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_attach_failed");
  });

  it("attach RPC สำเร็จแต่ data null (contract drift) → WARN certificate_pdf_attach_failed ไม่เดาค่า", async () => {
    serviceClient({
      ...happySpec(),
      rpc: (fn) =>
        fn === "admin_attach_certificate_pdf"
          ? { data: null, error: null }
          : { data: coreRow(), error: null },
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_attach_failed");
  });

  it("attach idempotent (ใบมี pdf_media_id อยู่แล้ว → attached=false) → คืน id เดิมไม่ throw", async () => {
    serviceClient({
      ...happySpec(),
      rpc: (fn) =>
        fn === "admin_attach_certificate_pdf"
          ? { data: attachRow(false), error: null }
          : { data: coreRow(), error: null },
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.pdfMediaId).toBe(MEDIA_ID);
    expect(warnCalls).toEqual([]);
  });

  it("render โยน error → WARN certificate_pdf_render_failed + ยังออกใบได้", async () => {
    serviceClient(happySpec());
    vi.mocked(renderCertificatePdf).mockRejectedValueOnce(new Error("font missing"));
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_render_failed");
  });

  it("WARN ทุกข้อความไม่พา PII — อนุญาตเฉพาะ route/user_id (holder_name ห้ามเข้า log)", async () => {
    serviceClient({ ...happySpec(), upload: () => ({ data: null, error: { message: "x" } }) });
    await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(warnCalls.length).toBeGreaterThan(0);
    for (const w of warnCalls) {
      expect(Object.keys(w.fields).sort()).toEqual(["route", "user_id"]);
      expect(JSON.stringify(w)).not.toContain("สมชาย");
    }
  });
});

describe("listEligibleAttempts — RPC admin_eligible_certificates (F6: filter ใน SQL ก่อนตัดหน้า)", () => {
  /** แถว RPC (snake_case) ที่ admin_eligible_certificates คืน — seq กำหนด id + เวลาส่ง (มาก = เก่ากว่า) */
  function eligibleRow(seq: number): Row {
    const suffix = String(seq).padStart(12, "0");
    return {
      attempt_id: `d0000000-0000-4000-8000-${suffix}`,
      enrollment_id: `e0000000-0000-4000-8000-${suffix}`,
      user_id: USER_ID,
      course_id: COURSE_ID,
      holder_name: "สมชาย ใจดี",
      score_pct: 90,
      submitted_at: new Date(Date.UTC(2026, 8, 1) - seq * 60_000).toISOString(),
    };
  }

  /** spec ที่ RPC eligible คืนแถวที่กำหนด (RPC อื่นไม่เกี่ยว — ฟังก์ชันนี้ไม่เรียกอะไรอื่น) */
  function eligibleSpec(rows: Row[]): FakeSpec {
    return { rpc: () => ({ data: rows, error: null }) };
  }

  it("แถว snake_case → map เป็น EligibleAttempt ครบ (holder_name คำนวณฝั่ง SQL แล้ว)", async () => {
    serviceClient(eligibleSpec([eligibleRow(1)]));
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
    expect(page.data).toHaveLength(1);
    const first = page.data[0];
    expect(first).toEqual({
      attemptId: "d0000000-0000-4000-8000-000000000001",
      enrollmentId: "e0000000-0000-4000-8000-000000000001",
      userId: USER_ID,
      courseId: COURSE_ID,
      holderName: "สมชาย ใจดี",
      scorePct: 90,
      submittedAt: new Date(Date.UTC(2026, 8, 1) - 60_000).toISOString(),
    });
  });

  it("คิวว่าง → หน้าเปล่า + hasMore false (RPC ตัด 'ออกใบแล้ว' ใน SQL แล้ว)", async () => {
    serviceClient(eligibleSpec([]));
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.data).toEqual([]);
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("ได้เกิน limit → hasMore + nextCursor (BFF ขอ limit+1 ให้ buildPage เทียบ)", async () => {
    serviceClient(eligibleSpec([eligibleRow(1), eligibleRow(2), eligibleRow(3)]));
    const page = await listEligibleAttempts({ limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.data[0]?.attemptId).toBe("d0000000-0000-4000-8000-000000000001");
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).toBeTruthy();
  });

  it("param-shape: RPC ครั้งเดียวชื่อ admin_eligible_certificates + limit+1 + courseId + cursor แรกเป็น null", async () => {
    const ctx = serviceClient(eligibleSpec([]));
    await listEligibleAttempts({ limit: 5, courseId: COURSE_ID });
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    expect(ctx.rpc).toHaveBeenCalledWith("admin_eligible_certificates", {
      p_after_submitted_at: null,
      p_after_id: null,
      p_course_id: COURSE_ID,
      p_limit: 6,
    });
  });

  it("cursor จากหน้าแรก → หน้าสองส่ง keyset (submitted_at, id) ของแถวสุดท้ายหน้าแรก", async () => {
    serviceClient(eligibleSpec([eligibleRow(1), eligibleRow(2), eligibleRow(3)]));
    const first = await listEligibleAttempts({ limit: 2 });
    expect(first.page.nextCursor).toBeTruthy();
    // RPC เดียวกันถูกเรียกอีกครั้งด้วย cursor ที่ได้ — p_after_* = แถวที่ 2 (สุดท้ายของหน้า)
    const ctx = serviceClient(eligibleSpec([eligibleRow(3)]));
    await listEligibleAttempts({ limit: 2, cursor: first.page.nextCursor });
    expect(ctx.rpc).toHaveBeenCalledWith("admin_eligible_certificates", {
      p_after_submitted_at: eligibleRow(2).submitted_at,
      p_after_id: "d0000000-0000-4000-8000-000000000002",
      p_course_id: null,
      p_limit: 3,
    });
  });

  it("RPC คิวล้ม → ERR-SYS-002 cert_eligible_query_failed (ไม่ leak SQL)", async () => {
    serviceClient({ rpc: () => ({ data: null, error: { code: "XX000", message: "boom" } }) });
    const error = await listEligibleAttempts({ limit: 20 }).catch((e: unknown) => e);
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_eligible_query_failed" });
  });

  describe("r7-M2 — container/แถว drift → ERR-SYS-002 (ไม่ใช่ 200 หน้าว่าง/ค่า fabricated)", () => {
    it("container ไม่ใช่ array (object) → cert_eligible_rows_not_array — เดิม `?? []` กลืนเป็นหน้าว่าง", async () => {
      serviceClient({ rpc: () => ({ data: { rows: [eligibleRow(1)] }, error: null }) });
      const error = await listEligibleAttempts({ limit: 20 }).catch((e: unknown) => e);
      expect((error as AppError).code).toBe("ERR-SYS-002");
      expect((error as AppError).details).toEqual({ reason: "cert_eligible_rows_not_array" });
    });

    it("container เป็น null → cert_eligible_rows_not_array (null ≠ array ว่าง)", async () => {
      serviceClient({ rpc: () => ({ data: null, error: null }) });
      const error = await listEligibleAttempts({ limit: 20 }).catch((e: unknown) => e);
      expect((error as AppError).details).toEqual({ reason: "cert_eligible_rows_not_array" });
    });

    it("แถวขาดคีย์ score_pct (ไม่ใช่ null จริง) → eligible_row_drift ไม่ fabricate null", async () => {
      const row = eligibleRow(1);
      delete row.score_pct;
      serviceClient(eligibleSpec([row]));
      const error = await listEligibleAttempts({ limit: 20 }).catch((e: unknown) => e);
      expect((error as AppError).code).toBe("ERR-SYS-002");
      expect((error as AppError).details).toEqual({ reason: "eligible_row_drift" });
    });

    it("แถวมีคีย์เกิน → eligible_row_drift", async () => {
      serviceClient(eligibleSpec([{ ...eligibleRow(1), extra_key: 1 }]));
      const error = await listEligibleAttempts({ limit: 20 }).catch((e: unknown) => e);
      expect((error as AppError).code).toBe("ERR-SYS-002");
      expect((error as AppError).details).toEqual({ reason: "eligible_row_drift" });
    });

    it("score_pct: null จริง → ผ่าน schema เป็น scorePct null (missing ≠ null ตาม r7-M2)", async () => {
      serviceClient(eligibleSpec([{ ...eligibleRow(1), score_pct: null }]));
      const page = await listEligibleAttempts({ limit: 20 });
      expect(page.data[0]?.scorePct).toBeNull();
    });

    it("holder_name '' (โปรไฟล์ยังไม่กรอกชื่อ) → ผ่าน — คิวยังแสดงให้ registrar เห็น (r7-M1)", async () => {
      serviceClient(eligibleSpec([{ ...eligibleRow(1), holder_name: "" }]));
      const page = await listEligibleAttempts({ limit: 20 });
      expect(page.data[0]?.holderName).toBe("");
    });
  });
});

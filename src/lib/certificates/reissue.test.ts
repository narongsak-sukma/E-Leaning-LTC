/**
 * Unit tests: src/lib/certificates/reissue.ts — ออกใบใหม่แทนใบเดิม (Wave D · 0019-r1/r2)
 *
 * 0019-r1 (gate r1 B7): supersede + issue + lineage + CERT_ISSUE/CERT_REISSUE audit
 * ทั้งหมดอยู่ใน RPC `admin_reissue_certificate` TX เดียว — BFF เรียก RPC แล้ว render
 * PDF ใบใหม่ (พัง = คงใบ pdf_media_id null ตาม D36-O6) ไม่มี lineage UPDATE หรือ
 * compensating revert ฝั่ง BFF อีกต่อไป
 * 0019-r2 (gate r2 F2): PDF ผูกด้วย RPC `admin_attach_certificate_pdf` (mutation +
 * CERT_PDF_ATTACH audit TX เดียว) พร้อมส่ง requestId ต่อจากคำขอ reissue เดียวกัน
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
import { reissueCertificate } from "./reissue";
import { certLogger } from "./shared";

type Row = Record<string, unknown>;
type Resolve = { data: unknown; error: null } | { data: null, error: Record<string, unknown> };
type RpcResult = { data: unknown; error: Record<string, unknown> | null };

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const OLD_CERT_ID = "c0000000-0000-4000-8000-000000000001";
const NEW_CERT_ID = "c0000000-0000-4000-8000-000000000009";
const ENROLL_ID = "e0000000-0000-4000-8000-000000000001";
const USER_ID = "f0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";
const MEDIA_ID = "90000000-0000-4000-8000-000000000001";
const T1 = "2026-09-08T04:00:00+00:00";

const OK: Resolve = { data: null, error: null };

/** RPC ทั้งหมด dispatch ตามชื่อฟังก์ชัน (reissue RPC ตามด้วย attach RPC ของ PDF) */
interface Spec {
  rpc?: (fn: string) => RpcResult;
  upload?: () => Resolve;
}

/** jsonb ที่ admin_reissue_certificate คืน — core ของใบใหม่ + superseded_cert_id (ใบเดิม) */
function reissueRow(): Row {
  return {
    id: NEW_CERT_ID,
    cert_no: "LTC-2026-000999",
    verify_code: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
    enrollment_id: ENROLL_ID,
    user_id: USER_ID,
    course_id: COURSE_ID,
    holder_name: "สมชาย ใจดี",
    course_title: "หลักสูตรทดสอบ",
    issued_at: T1,
    superseded_cert_id: OLD_CERT_ID,
  };
}

function reissueClient(spec: Spec) {
  const rpc = vi.fn(async (fn: string) => spec.rpc?.(fn) ?? { data: null, error: null });
  const uploads: Array<{ bucket: string; path: string }> = [];
  const client = {
    rpc,
    storage: {
      from: (bucket: string) => ({
        upload: vi.fn(async (path: string) => {
          uploads.push({ bucket, path });
          return spec.upload?.() ?? OK;
        }),
      }),
    },
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return { rpc, uploads };
}

/** spec มาตรฐาน: reissue RPC สำเร็จ + attach RPC สำเร็จ + upload สำเร็จ */
function happySpec(): Spec {
  return {
    rpc: (fn) =>
      fn === "admin_attach_certificate_pdf"
        ? { data: { pdf_media_id: MEDIA_ID, attached: true }, error: null }
        : { data: reissueRow(), error: null },
    upload: () => OK,
  };
}

describe("reissueCertificate — RPC TX เดียว (B7) + attach RPC ของ PDF (F2)", () => {
  let warns: Array<{ message: string; fields: Record<string, unknown> }> = [];

  beforeEach(() => {
    vi.mocked(createSupabaseServiceRoleClient).mockReset();
    warns = [];
    vi.spyOn(certLogger, "warn").mockImplementation((message, fields) => {
      warns.push({ message, fields: fields ?? {} });
      return certLogger;
    });
  });

  it("happy path: ใบใหม่ครบฟิลด์ + lineage จาก RPC + PDF ผูกสำเร็จ · RPC สองครั้งตามลำดับ", async () => {
    const ctx = reissueClient(happySpec());
    const result = await reissueCertificate({
      actorId: STAFF_ID,
      certificateId: OLD_CERT_ID,
      requestId: "req-3",
    });

    expect(result.oldStatus).toBe("superseded");
    expect(result.oldCertificateId).toBe(OLD_CERT_ID);
    expect(result.oldSupersededBy).toBe(NEW_CERT_ID);
    expect(result.newCertificate).toMatchObject({
      id: NEW_CERT_ID,
      certNo: "LTC-2026-000999",
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

    // B7: mutation+audit+lineage ทั้งหมดใน RPC เดียว — BFF ไม่เขียน lineage เอง
    expect(ctx.rpc).toHaveBeenCalledTimes(2);
    expect(ctx.rpc).toHaveBeenNthCalledWith(1, "admin_reissue_certificate", {
      p_actor_user_id: STAFF_ID,
      p_certificate_id: OLD_CERT_ID,
      p_request_id: "req-3",
    });
    // F2: attach RPC ผูก PDF ใบ "ใหม่" พร้อม requestId เดียวกับคำขอ reissue (audit ผูกกัน)
    expect(ctx.rpc).toHaveBeenNthCalledWith(2, "admin_attach_certificate_pdf", {
      p_actor_user_id: STAFF_ID,
      p_certificate_id: NEW_CERT_ID,
      p_storage_path: "certificates-pdf/LTC-2026-000999.pdf",
      p_mime_type: "application/pdf",
      p_size_bytes: 4,
      p_request_id: "req-3",
    });
    const upload = ctx.uploads[0];
    expect(upload?.bucket).toBe("certificates");
    expect(upload?.path).toBe("certificates-pdf/LTC-2026-000999.pdf");
  });

  it("PostgREST wrap jsonb เป็น array หลักเดียว → แกะแถวได้", async () => {
    reissueClient({
      ...happySpec(),
      rpc: (fn) =>
        fn === "admin_attach_certificate_pdf"
          ? { data: [{ pdf_media_id: MEDIA_ID, attached: true }], error: null }
          : { data: [reissueRow()], error: null },
    });
    const result = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID });
    expect(result.newCertificate.id).toBe(NEW_CERT_ID);
    expect(result.oldCertificateId).toBe(OLD_CERT_ID);
  });

  it.each([
    ["ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)", "ERR-NF-001", "certificate_not_found"],
    ["ข้อมูลไม่ถูกต้อง: ใบนี้ไม่ได้อยู่ในสถานะออกใบแล้ว (ERR-VAL-001|not_valid)", "ERR-VAL-001", "not_valid"],
  ])("RPC error มีป้าย → map ตรง: %s", async (message, code, reason) => {
    reissueClient({ rpc: () => ({ data: null, error: { message } }) });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect(error, message).toBeInstanceOf(AppError);
    expect((error as AppError).code, message).toBe(code);
    expect((error as AppError).details, message).toEqual({ reason });
  });

  it("RPC error ไม่มีป้าย → ERR-SYS-002 opaque", async () => {
    reissueClient({ rpc: () => ({ data: null, error: { code: "XX000", message: "boom" } }) });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_reissue_rpc_failed" });
  });

  it("RPC สำเร็จแต่ data null → ERR-SYS-002 reissue_row_drift (schema ไม่ผ่าน = drift — r7-M2)", async () => {
    reissueClient({ rpc: () => ({ data: null, error: null }) });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "reissue_row_drift" });
  });

  it("r8-N2: RPC คืน array ยาว 2 (แถวที่สองต้องหายเงียบไม่ได้) → reissue_row_drift", async () => {
    reissueClient({ rpc: () => ({ data: [reissueRow(), { junk: true }], error: null }) });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "reissue_row_drift" });
  });

  it("แถว RPC มีคีย์เกิน → reissue_row_drift (ไม่ strip เงียบ ๆ — r7-M2)", async () => {
    reissueClient({ rpc: () => ({ data: { ...reissueRow(), extra_key: "x" }, error: null }) });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "reissue_row_drift" });
  });

  it("แถว RPC ขาด superseded_cert_id → reissue_row_drift (ไม่ fabricate lineage)", async () => {
    const row = reissueRow();
    delete row.superseded_cert_id;
    reissueClient({ rpc: () => ({ data: row, error: null }) });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "reissue_row_drift" });
  });

  it("PDF upload ล้ม → ใบใหม่ยังครบ (pdfMediaId null) + WARN — ไม่ย้อนกลับใบเดิม (D36-O6)", async () => {
    const ctx = reissueClient({
      ...happySpec(),
      upload: () => ({ data: null, error: { message: "bucket not found" } }),
    });
    const result = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID });
    expect(result.newCertificate.id).toBe(NEW_CERT_ID);
    expect(result.newCertificate.pdfMediaId).toBeNull();
    expect(result.oldStatus).toBe("superseded"); // RPC สำเร็จแล้ว — PDF ไม่พากลับไปแก้สถานะ
    expect(warns.map((w) => w.message)).toContain("certificate_pdf_upload_failed");
    expect(ctx.rpc).toHaveBeenCalledTimes(1); // มีแต่ reissue — attach ไม่ถูกเรียก
  });

  it("attach RPC ล้ม → ใบใหม่ยัง supersede แล้ว (pdfMediaId null) + WARN certificate_pdf_attach_failed", async () => {
    const ctx = reissueClient({
      ...happySpec(),
      rpc: (fn) =>
        fn === "admin_attach_certificate_pdf"
          ? { data: null, error: { code: "42501", message: "permission denied" } }
          : { data: reissueRow(), error: null },
    });
    const result = await reissueCertificate({ actorId: STAFF_ID, certificateId: OLD_CERT_ID });
    expect(result.oldStatus).toBe("superseded");
    expect(result.newCertificate.pdfMediaId).toBeNull();
    expect(warns.map((w) => w.message)).toContain("certificate_pdf_attach_failed");
    expect(ctx.rpc).toHaveBeenCalledTimes(2);
  });
});

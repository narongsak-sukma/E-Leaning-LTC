/**
 * issue — ออกประกาศนียบัตร (Wave D — D-4 · SDS §3.4a · 0019-r1/r2)
 *
 * **service_role รวมศูนย์ที่ src/lib/certificates/** (D36-O3)** — route เรียกฟังก์ชัน
 * ของ lib เท่านั้น (ห้าม import service client ตรง)
 *
 * 0019-r1 (gate r1 B2/B7/B8):
 * - การออกใบย้ายไป RPC `admin_issue_certificate` เดียว (cert_issue_core ภายใน):
 *   ตรวจ enrollment completed + ใบ valid ซ้ำ + attempt ผ่าน + snapshot ชื่อ + สุ่ม
 *   cert_no/verify_code (CSPRNG ฝั่ง DB · retry ≤5 เมื่อชน UNIQUE) + INSERT +
 *   **audit CERT_ISSUE ใน TX เดียว** (audit ล้ม = rollback ไม่มีใบที่ไร้ audit — D12-8)
 *   BFF เหลือ PDF pipeline หลัง RPC (render + upload) — พัง = คงใบ pdf_media_id
 *   null + WARN ตามทางเลือก D36-O6 (reissue ได้ภายหลัง)
 * - คิว eligible (endpoint 82): ตัด "ออกใบแล้ว" ก่อนตัดหน้า (B8)
 *
 * 0019-r2 (gate r2 F2/F6):
 * - แนบ PDF = RPC `admin_attach_certificate_pdf` เดียว (media_assets INSERT +
 *   certificates UPDATE + audit CERT_PDF_ATTACH ใน TX เดียว) — เดิมเป็น
 *   PostgREST call แยกสอง call ไม่มี audit คู่ (crash กลางทาง = committed
 *   ไม่มีร่องรอย) · idempotent (ใบมี pdf_media_id อยู่แล้ว → attached=false)
 * - คิว eligible = RPC `admin_eligible_certificates` เดียว (anti-join ใบ valid +
 *   keyset + ตัดหน้าใน SQL) — เดิมสแกน chunk ใน JS แล้ว post-filter ทีหลัง
 *   (F6: คิวที่ถูกออกหมดในช่วงสแกน 10,000 แถว ทำหน้าว่างเท็จ + hasMore=false)
 *
 * ธง: credit_snapshot เป็น null เสมอ — service_role มี INSERT เท่านั้นบน
 * credit_ledger_entries (0010:821-826 ไม่มี SELECT) จึงอ่านยอดไม่ได้ (ห้ามเดา)
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPage, decodeCursor, type CursorPayload } from "@/lib/api/pagination";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { renderCertificatePdf } from "./pdf";
import {
  CERTIFICATE_BUCKET,
  certLogger,
  certRpcError,
  dbFailed,
  rowString,
  unwrapScalarRow,
  type Row,
} from "./shared";
import {
  CertCoreRowSchema,
  EligibleAttemptRowSchema,
  type EligibleAttemptRowParsed,
} from "@/lib/schemas/v1/certificate";

/** ข้อมูลที่ต้องระบุเพื่อออกใบ — actorId มาจาก requirePermission ที่ route ตรวจแล้ว */
export interface IssueCertificateInput {
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly requestId?: string | null;
}

/** ใบที่ออกแล้ว — คืนแบบแคบ (ไม่มีข้อมูลที่ไม่ได้เก็บจริง) */
export interface IssuedCertificate {
  readonly id: string;
  readonly certNo: string;
  readonly verifyCode: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderNameSnapshot: string;
  readonly courseTitleSnapshot: string;
  readonly creditSnapshot: number | null;
  readonly status: "valid";
  readonly issuedAt: string;
  readonly pdfMediaId: string | null;
}

/**
 * jsonb ที่ cert_issue_core คืน (ผ่าน admin_issue/admin_reissue_certificate) —
 * ตรวจชนิดก่อนใช้ fail-closed เหมือนแถวตารางอื่น (ชนิดไม่ตรง = สัญญา DB เพี้ยน)
 */
export interface CertCoreRow {
  readonly id: string;
  readonly certNo: string;
  readonly verifyCode: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderName: string;
  readonly courseTitle: string;
  readonly issuedAt: string;
}

/**
 * RPC jsonb → CertCoreRow — r7-M2: ตรวจ strict ผ่าน CertCoreRowSchema (mirror
 * exact 9 คีย์ของ jsonb_build_object ท้าย cert_issue_core) ก่อน map: คีย์หาย/
 * คีย์เกิน/ค่าผิดชนิด = สัญญา DB เพี้ยน → ERR-SYS-002 ที่ขาเข้า ไม่ใช่ fabricated
 * ค่าว่างหรือตัดคีย์เกินทิ้งเงียบ ๆ · PostgREST อาจ wrap scalar เป็น array —
 * รองรับทั้งสองรูป (รูปอื่น รวม null → schema fail = drift)
 */
export function parseCertCore(data: unknown): CertCoreRow {
  // r8-N2: แกะ array เฉพาะความยาว 1 พอดี — แถวที่สองหายเงียบไม่ได้ (ให้ schema ตีตก)
  const raw = unwrapScalarRow(data);
  const parsed = CertCoreRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw dbFailed("cert_core_row_drift");
  }
  const row = parsed.data;
  return {
    id: row.id,
    certNo: row.cert_no,
    verifyCode: row.verify_code,
    enrollmentId: row.enrollment_id,
    userId: row.user_id,
    courseId: row.course_id,
    holderName: row.holder_name,
    courseTitle: row.course_title,
    issuedAt: row.issued_at,
  };
}

/** ใบที่ RPC ออกแล้ว → resource ของ BFF (creditSnapshot ยัง null — 0010:825 INSERT-only) */
export function toIssuedCertificate(core: CertCoreRow): IssuedCertificate {
  return {
    id: core.id,
    certNo: core.certNo,
    verifyCode: core.verifyCode,
    enrollmentId: core.enrollmentId,
    userId: core.userId,
    courseId: core.courseId,
    holderNameSnapshot: core.holderName,
    courseTitleSnapshot: core.courseTitle,
    creditSnapshot: null,
    status: "valid",
    issuedAt: core.issuedAt,
    pdfMediaId: null,
  };
}

/**
 * PDF + Storage + ผูก media/ใบ + audit — ใช้ร่วม issue/reissue (0019-r2 F2:
 * mutation ทั้งสองและ audit CERT_PDF_ATTACH อยู่ใน RPC `admin_attach_certificate_pdf`
 * TX เดียว) — **พังทุกกระแง = คงใบ + คืน null + WARN** ไม่ throw (ทางเลือก
 * D36-O6: ใบยัง verify ได้ แก้ไขได้ด้วย reissue ภายหลัง)
 */
export async function attachCertificatePdf(
  client: SupabaseClient,
  core: CertCoreRow,
  actorId: string,
  requestId?: string | null,
): Promise<string | null> {
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderCertificatePdf({
      certNo: core.certNo,
      verifyCode: core.verifyCode,
      holderName: core.holderName,
      courseTitle: core.courseTitle,
      issuedAt: new Date(core.issuedAt),
    });
  } catch {
    certLogger.warn("certificate_pdf_render_failed", {
      route: "certificates:issue",
      user_id: actorId,
    });
    return null;
  }
  const storagePath = `${CERTIFICATE_BUCKET}-pdf/${core.certNo}.pdf`;
  try {
    const uploadRes = await client.storage
      .from(CERTIFICATE_BUCKET)
      .upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: false });
    if (uploadRes.error !== null) {
      certLogger.warn("certificate_pdf_upload_failed", {
        route: "certificates:issue",
        user_id: actorId,
      });
      return null;
    }
    const rpc = await client.rpc("admin_attach_certificate_pdf", {
      p_actor_user_id: actorId,
      p_certificate_id: core.id,
      p_storage_path: storagePath,
      p_mime_type: "application/pdf",
      p_size_bytes: pdfBytes.byteLength,
      p_request_id: requestId ?? null,
    });
    if (rpc.error !== null) {
      certLogger.warn("certificate_pdf_attach_failed", {
        route: "certificates:issue",
        user_id: actorId,
      });
      return null;
    }
    const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as Row | null;
    if (row === null) {
      // สัญญา DB เพี้ยน (คำตอบไม่ใช่ object) — คงใบ ไม่เดาค่า (D36-O6)
      certLogger.warn("certificate_pdf_attach_failed", {
        route: "certificates:issue",
        user_id: actorId,
      });
      return null;
    }
    return rowString(row, "pdf_media_id");
  } catch {
    // attach pipeline ล้มเหลวระหว่างทาง (contract drift ของ rowString รวม) — คงใบ
    certLogger.warn("certificate_pdf_attach_failed", {
      route: "certificates:issue",
      user_id: actorId,
    });
    return null;
  }
}

/**
 * ออกประกาศนียบัตรจาก enrollment — สิทธิ์ actor อยู่ที่ route (requirePermission)
 * แล้ว ที่นี่คือ RPC mutation+audit + PDF pipeline ล้วน
 */
export async function issueCertificate(input: IssueCertificateInput): Promise<IssuedCertificate> {
  const client = createSupabaseServiceRoleClient();
  // 1) mutation + audit atomic ใน RPC เดียว (0019-r1): ตรวจ enrollment/attempt/ซ้ำ +
  //    snapshot + สุ่มรหัส + INSERT + CERT_ISSUE — error มีป้าย (ERR-XXX-NNN|reason)
  const rpc = await client.rpc("admin_issue_certificate", {
    p_actor_user_id: input.actorId,
    p_enrollment_id: input.enrollmentId,
    p_request_id: input.requestId ?? null,
  });
  if (rpc.error !== null) {
    throw certRpcError(rpc.error, "cert_issue_rpc_failed");
  }
  const core = parseCertCore(rpc.data);
  // 2) PDF pipeline ฝั่ง TS หลัง RPC — พัง = คงใบ (pdf_media_id null) ตาม D36-O6
  const pdfMediaId = await attachCertificatePdf(client, core, input.actorId, input.requestId);
  return { ...toIssuedCertificate(core), pdfMediaId };
}

/**
 * คิวงานออกประกาศนียบัตร (API-SPECIFICATION endpoint 82 · SDS §3.4a · D12-23) —
 * attempt ผ่านเกณฑ์ + enrollment completed + ยังไม่มีใบ valid ของ enrollment นั้น
 */
export interface EligibleAttempt {
  readonly attemptId: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderName: string;
  readonly scorePct: number | null;
  readonly submittedAt: string;
}

export interface EligibleQuery {
  readonly limit: number;
  readonly cursor?: string | null;
  readonly courseId?: string | null;
  readonly requestId?: string | null;
}

export interface EligiblePage {
  readonly data: readonly EligibleAttempt[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * คิวงานจาก RPC `admin_eligible_certificates` เดียว (0019-r2 F6) — anti-join ใบ
 * valid + keyset (submitted_at, id) desc + ตัดหน้าทั้งหมดใน SQL; BFF ขอ limit+1
 * แถวให้ buildPage เทียบ hasMore (RPC clamp ที่ 101 = client limit 100 + 1)
 */
export async function listEligibleAttempts(query: EligibleQuery): Promise<EligiblePage> {
  const client = createSupabaseServiceRoleClient();
  const cursor: CursorPayload | null =
    query.cursor === undefined || query.cursor === null ? null : decodeCursor(query.cursor);
  const rpc = await client.rpc("admin_eligible_certificates", {
    p_after_submitted_at: cursor?.sortKey ?? null,
    p_after_id: cursor?.id ?? null,
    p_course_id: query.courseId ?? null,
    p_limit: query.limit + 1,
  });
  if (rpc.error !== null) {
    throw dbFailed("cert_eligible_query_failed");
  }
  // r7-M2: container ต้องเป็น array จริง — รูปอื่น (object/null) = สัญญา DB เพี้ยน
  // → ERR-SYS-002 ไม่ใช่ 200 หน้าว่าง (เดิม `?? []` กลืน drift เงียบ ๆ)
  if (!Array.isArray(rpc.data)) {
    throw dbFailed("cert_eligible_rows_not_array");
  }
  // r7-M2: ตรวจทุกแถว strict ตาม returns table 7 คอลัมน์ก่อนตัดหน้า — required
  // + .nullable() จำแนก "ไม่มีคีย์ score_pct" (drift) ออกจาก null จริง (ผ่าน)
  const rows = rpc.data.map((raw) => {
    const parsed = EligibleAttemptRowSchema.safeParse(raw);
    if (!parsed.success) {
      throw dbFailed("eligible_row_drift");
    }
    return parsed.data;
  });
  const built = buildPage({
    rows,
    limit: query.limit,
    sortKeyOf: (row) => row.submitted_at,
    idOf: (row) => row.attempt_id,
  });
  return {
    data: built.data.map(toEligibleAttempt),
    page: built.page,
  };
}

/** แถว RPC ที่ผ่าน EligibleAttemptRowSchema แล้ว (r7-M2) → resource ของคิวงาน —
 *  ตรวจชนิดครบที่ schema แล้ว (missing ≠ null) map ตรง ๆ ไม่ fabricate ค่า */
function toEligibleAttempt(row: EligibleAttemptRowParsed): EligibleAttempt {
  return {
    attemptId: row.attempt_id,
    enrollmentId: row.enrollment_id,
    userId: row.user_id,
    courseId: row.course_id,
    holderName: row.holder_name,
    scorePct: row.score_pct,
    submittedAt: row.submitted_at,
  };
}

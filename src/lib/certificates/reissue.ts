/**
 * reissue — ออกใบใหม่แทนใบเดิม (Wave D — D-4 · SDS §3.4d · CRT-007 · 0019-r1)
 *
 * ทั้งหมดผ่าน RPC `admin_reissue_certificate` เดียว (TX เดียว): ใบเดิม valid →
 * superseded → cert_issue_core ออกใบใหม่ (supersedes_cert_id ชี้ใบเดิม + CERT_ISSUE
 * audit ใน TX) → ใบเดิม superseded_by ชี้ใบใหม่ → CERT_REISSUE audit — ล้มช่วงไหน
 * = rollback ทั้ง TX (gate r1 B7: ทางเดิมเขียน lineage หลัง commit โดยไม่มี compensation
 * เมื่อล้ม = สถานะกึ่งๆ ถาวร + retry ติด not_valid) · PDF ของใบใหม่เรนเดอร์ฝั่ง TS
 * หลัง RPC (พัง = คงใบ pdf_media_id null ตามทางเลือก D36-O6 — ใช้ attachCertificatePdf
 * ร่วมกับ issue)
 * - **ไม่กระทบ credit** (ไม่แตะ credit_ledger_entries — D12-14/15)
 */
import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  attachCertificatePdf,
  toIssuedCertificate,
  type CertCoreRow,
  type IssuedCertificate,
} from "./issue";
import { certRpcError, dbFailed, unwrapScalarRow } from "./shared";
import { ReissueRowSchema } from "@/lib/schemas/v1/certificate";

export interface ReissueCertificateInput {
  readonly actorId: string;
  readonly certificateId: string;
  readonly requestId?: string | null;
}

export interface ReissuedCertificate {
  readonly newCertificate: IssuedCertificate;
  readonly oldCertificateId: string;
  readonly oldStatus: "superseded";
  readonly oldSupersededBy: string;
}

/** ออกใหม่แทนใบเดิม — supersede + issue + lineage + audit TX เดียวใน RPC */
export async function reissueCertificate(
  input: ReissueCertificateInput,
): Promise<ReissuedCertificate> {
  const client = createSupabaseServiceRoleClient();
  const rpc = await client.rpc("admin_reissue_certificate", {
    p_actor_user_id: input.actorId,
    p_certificate_id: input.certificateId,
    p_request_id: input.requestId ?? null,
  });
  if (rpc.error !== null) {
    throw certRpcError(rpc.error, "cert_reissue_rpc_failed");
  }
  // คืน core ของใบใหม่ + superseded_cert_id (ใบเดิม) ใน jsonb เดียว — r7-M2:
  // ตรวจ strict ผ่าน ReissueRowSchema (mirror 10 คีย์ exact = 9 คีย์ของ
  // cert_issue_core + superseded_cert_id) — drift ใด ๆ รวม data null ไม่ใช่ object
  // = ERR-SYS-002 · ห้ามส่งแถว 10 คีย์นี้เข้า parseCertCore (strict 9 คีย์จะเพี้ยนเอง)
  // r8-N2: แกะ array เฉพาะความยาว 1 พอดี — แถวที่สองหายเงียบไม่ได้ (schema ตีตกเอง)
  const parsed = ReissueRowSchema.safeParse(unwrapScalarRow(rpc.data));
  if (!parsed.success) {
    throw dbFailed("reissue_row_drift");
  }
  const row = parsed.data;
  const oldCertificateId = row.superseded_cert_id;
  const core: CertCoreRow = {
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
  // PDF ของใบใหม่ — พัง = คงใบ (pdf_media_id null) ตาม D36-O6 เหมือน issue
  // (attach RPC รับ requestId ด้วย — audit CERT_PDF_ATTACH ผูกกับคำขอเดียวกัน)
  const pdfMediaId = await attachCertificatePdf(client, core, input.actorId, input.requestId);
  return {
    newCertificate: { ...toIssuedCertificate(core), pdfMediaId },
    oldCertificateId,
    oldStatus: "superseded",
    oldSupersededBy: core.id,
  };
}

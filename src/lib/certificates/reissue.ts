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
  parseCertCore,
  toIssuedCertificate,
  type IssuedCertificate,
} from "./issue";
import { certRpcError, dbFailed, rowString, type Row } from "./shared";

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
  // คืน core ของใบใหม่ + superseded_cert_id (ใบเดิม) ใน jsonb เดียว
  const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as Row | null;
  if (row === null) {
    throw dbFailed("cert_reissue_rpc_failed");
  }
  const oldCertificateId = rowString(row, "superseded_cert_id");
  const core = parseCertCore(row);
  // PDF ของใบใหม่ — พัง = คงใบ (pdf_media_id null) ตาม D36-O6 เหมือน issue
  const pdfMediaId = await attachCertificatePdf(client, core, input.actorId);
  return {
    newCertificate: { ...toIssuedCertificate(core), pdfMediaId },
    oldCertificateId,
    oldStatus: "superseded",
    oldSupersededBy: core.id,
  };
}

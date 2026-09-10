/**
 * revoke — เพิกถอนประกาศนียบัตร (Wave D — D-4 · SDS §3.4d · 0019-r1)
 *
 * - บังคับ reason 10-500 ตัวอักษร (trim แล้ว) — ไม่ครบ → ERR-VAL-001 (RPC ตรวจซ้ำอีกชั้น)
 * - ทั้งหมดผ่าน RPC `admin_revoke_certificate` เดียว (0019-r1): SELECT cert_no + conditional
 *   UPDATE (status='valid') + audit CERT_REVOKE ใน **TX เดียว** — audit ล้ม = rollback ทั้ง
 *   (gate r1 B2: ทางเดิม commit ก่อนแล้ว audit พังได้เงียบๆ → mutation ไร้ audit ถาวร)
 * - reason เก็บที่ certificates.revoked_reason เท่านั้น (free-text ห้ามลง audit context —
 *   AUDIT §3.2) · response คืน cert_no/revoked_at จาก TX เดียวกัน
 * - service_role รวมศูนย์ที่ src/lib/certificates/** (D36-O3) — EXECUTE ของ RPC ให้
 *   service_role เท่านั้น (0019) และ route ตรวจ requirePermission ก่อนเรียกแล้ว
 */
import "server-only";
import { AppError } from "@/lib/errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { certRpcError, dbFailed, rowString, type Row } from "./shared";

/** เพดานความยาวเหตุผล (API-SPECIFICATION §3.8 — บังคับ reason) */
export const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

export interface RevokeCertificateInput {
  readonly actorId: string;
  readonly certificateId: string;
  readonly reason: string;
  readonly requestId?: string | null;
}

export interface RevokedCertificate {
  readonly id: string;
  readonly certNo: string;
  readonly status: "revoked";
  readonly revokedAt: string;
  readonly revokedReason: string;
}

/** เพิกถอนใบที่สถานะ valid — mutation + audit TX เดียวใน RPC (คืน id/cert_no/revoked_at) */
export async function revokeCertificate(input: RevokeCertificateInput): Promise<RevokedCertificate> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    throw new AppError("ERR-VAL-001", { details: { field: "reason", reason: "length_10_500" } });
  }

  // RPC เดียว: lookup + conditional UPDATE + CERT_REVOKE audit — atomic (0019-r1 B2)
  const client = createSupabaseServiceRoleClient();
  const rpc = await client.rpc("admin_revoke_certificate", {
    p_actor_user_id: input.actorId,
    p_certificate_id: input.certificateId,
    p_reason: reason,
    p_request_id: input.requestId ?? null,
  });
  if (rpc.error !== null) {
    // ป้าย (ERR-XXX-NNN|reason) ของ RPC → map ตรง; ไม่มีป้าย = ERR-SYS-002 opaque
    throw certRpcError(rpc.error, "cert_revoke_rpc_failed");
  }
  const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as Row | null;
  if (row === null) {
    throw dbFailed("cert_revoke_rpc_failed");
  }
  return {
    id: rowString(row, "id"),
    certNo: rowString(row, "cert_no"),
    status: "revoked",
    revokedAt: rowString(row, "revoked_at"),
    revokedReason: reason,
  };
}

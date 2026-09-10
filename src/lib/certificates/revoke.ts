/**
 * revoke — เพิกถอนประกาศนียบัตร (Wave D — D-4 · SDS §3.4d)
 *
 * - บังคับ reason ≥10 ตัวอักษร (trim แล้ว) — ไม่ครบ → ERR-VAL-001
 * - เพิกถอนได้เฉพาะใบที่สถานะ valid (revoked/superseded เพิกถอนซ้ำไม่ได้)
 * - UPDATE มี guard `.eq("status","valid")` ในตัว UPDATE เอง (กันแข่งกันเพิกถอน —
 *   PostgREST ไม่มี TX ระดับ row lock แบบ RPC จึงใช้ conditional update)
 * - audit CERT_REVOKE (เหตุผลเก็บใน certificates.revoked_reason ของตาราง ไม่ใส่ audit context
 *   เพราะเป็น free-text ที่ต้องผ่าน PII scan ของ DB — AUDIT §3.2)
 * - service_role รวมศูนย์ที่ src/lib/certificates/** (D36-O3) — เหตุผลการใช้ service_role:
 *   RLS กัน authenticated จากการ UPDATE certificates (0010:784-787) แต่ BFF ต้องเขียน
 *   ตามอำนาจ registrar ที่ตรวจสิทธิ์แล้ว (requirePermission ที่ route)
 */
import "server-only";
import { AppError } from "@/lib/errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { appendAuditEvent, dbFailed, rowString, type Row } from "./shared";

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

/**
 * เพิกถอนใบที่สถานะ valid — คืนสถานะใหม่ + เวลาที่เพิกถอน
 */
export async function revokeCertificate(input: RevokeCertificateInput): Promise<RevokedCertificate> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    throw new AppError("ERR-VAL-001", { details: { field: "reason", reason: "length_10_500" } });
  }

  // 1) อ่านใบเป้าหมาย (คอลัมน์แคบ — service_role)
  const client = createSupabaseServiceRoleClient();
  const lookup = await client
    .from("certificates")
    .select("id,cert_no,status,revoked_at")
    .eq("id", input.certificateId)
    .maybeSingle();
  if (lookup.error !== null) {
    throw dbFailed("cert_revoke_lookup_failed");
  }
  const cert = lookup.data as Row | null;
  if (cert === null) {
    throw new AppError("ERR-NF-001", { details: { field: "certificateId" } });
  }
  if (rowString(cert, "status") !== "valid") {
    throw new AppError("ERR-VAL-001", {
      details: { field: "certificateId", reason: "not_valid" },
    });
  }

  // 2) UPDATE แบบมี guard (status='valid') — 0 แถว = มีการเพิกถอนพร้อมกัน → VAL-001
  const revokedAt = new Date().toISOString();
  const updateRes = await client
    .from("certificates")
    .update({ status: "revoked", revoked_at: revokedAt, revoked_reason: reason })
    .eq("id", input.certificateId)
    .eq("status", "valid")
    .select("id,cert_no,status,revoked_at")
    .single();
  if (updateRes.error !== null || updateRes.data === null) {
    throw new AppError("ERR-VAL-001", {
      details: { field: "certificateId", reason: "not_valid" },
    });
  }
  const updated = updateRes.data as Row;

  // 3) audit CERT_REVOKE — certificate_id อยู่ที่ entity_id · `user_id` = actor ผู้เพิกถอน
  //    (0008:476-486) · reason เก็บใน certificates.revoked_reason แล้ว (free-text ไม่ลง
  //    audit context — กัน PII scan ฝั่ง DB ปฏิเสธทั้ง event)
  await appendAuditEvent(client, {
    action: "CERT_REVOKE",
    entityType: "certificate",
    entityId: rowString(updated, "id"),
    context: { user_id: input.actorId },
    actorId: input.actorId,
    requestId: input.requestId ?? null,
  });

  return {
    id: rowString(updated, "id"),
    certNo: rowString(updated, "cert_no"),
    status: "revoked",
    revokedAt: rowString(updated, "revoked_at"),
    revokedReason: reason,
  };
}

/**
 * reissue — ออกใบใหม่แทนใบเดิม (Wave D — D-4 · SDS §3.4d · CRT-007)
 *
 * - ใบเดิม valid → status='superseded' แล้วออกใบใหม่ผ่าน issueCertificate (snapshot ใหม่ ณ วันออก)
 * - lineage: ใบใหม่ `supersedes_cert_id` ชี้ใบเดิม · ใบเดิม `superseded_by` ชี้ใบใหม่
 * - **ไม่กระทบ credit** (ไม่แตะ credit_ledger_entries — D12-14/15)
 * - PostgREST ไม่มี interactive TX — ทำเป็นลำดับแบบมี compensating write:
 *   ถ้าการออกใบใหม่ล้มเหลว → คืนสถานะใบเดิมเป็น valid ก่อน throw ตัวเดิม
 *   (ธง: atomicity ระดับนี้คือข้อจำกัดของ "ไม่มี RPC cert โดยเจตนา — D36-O3")
 */
import "server-only";
import { AppError } from "@/lib/errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { issueCertificate, type IssuedCertificate } from "./issue";
import { appendAuditEvent, dbFailed, rowString, type Row } from "./shared";

/** สถานะของใบเดิมที่ reissue ได้ */
const REISSUABLE_STATUS = "valid";

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

/** ออกใหม่แทนใบเดิม — ใบเดิม superseded + lineage ทั้งสองทิศ */
export async function reissueCertificate(
  input: ReissueCertificateInput,
): Promise<ReissuedCertificate> {
  const client = createSupabaseServiceRoleClient();

  // 1) อ่านใบเดิม (คอลัมน์แคบ) — ต้อง valid
  const lookup = await client
    .from("certificates")
    .select("id,cert_no,enrollment_id,status")
    .eq("id", input.certificateId)
    .maybeSingle();
  if (lookup.error !== null) {
    throw dbFailed("cert_reissue_lookup_failed");
  }
  const oldCert = lookup.data as Row | null;
  if (oldCert === null) {
    throw new AppError("ERR-NF-001", { details: { field: "certificateId" } });
  }
  if (rowString(oldCert, "status") !== REISSUABLE_STATUS) {
    throw new AppError("ERR-VAL-001", {
      details: { field: "certificateId", reason: "not_valid" },
    });
  }
  const oldCertId = rowString(oldCert, "id");

  // 2) ใบเดิม → superseded (guard ด้วย status='valid' ใน UPDATE เดียวกัน)
  const supersedeRes = await client
    .from("certificates")
    .update({ status: "superseded" })
    .eq("id", input.certificateId)
    .eq("status", REISSUABLE_STATUS)
    .select("id,status")
    .single();
  if (supersedeRes.error !== null || supersedeRes.data === null) {
    throw new AppError("ERR-VAL-001", {
      details: { field: "certificateId", reason: "not_valid" },
    });
  }

  // 3) ออกใบใหม่ — snapshot ใหม่ณวันออก (issueCertificate ตรวจ enrollment/attempt ซ้ำเอง)
  let newCertificate: IssuedCertificate;
  try {
    newCertificate = await issueCertificate({
      actorId: input.actorId,
      enrollmentId: rowString(oldCert, "enrollment_id"),
      requestId: input.requestId ?? null,
    });
  } catch (error: unknown) {
    // 4) compensating write — ออกใบใหม่ไม่สำเร็จ → คืนใบเดิมเป็น valid แล้ว throw ตัวเดิม
    await client
      .from("certificates")
      .update({ status: REISSUABLE_STATUS })
      .eq("id", input.certificateId)
      .eq("status", "superseded");
    throw error;
  }

  // 5) lineage — ใบใหม่ supersedes_cert_id ชี้ใบเดิม · ใบเดิม superseded_by ชี้ใบใหม่
  const lineageRes = await client
    .from("certificates")
    .update({ supersedes_cert_id: oldCertId })
    .eq("id", newCertificate.id)
    .select("id")
    .single();
  if (lineageRes.error !== null) {
    throw dbFailed("cert_reissue_lineage_failed");
  }
  const oldByRes = await client
    .from("certificates")
    .update({ superseded_by: newCertificate.id })
    .eq("id", oldCertId)
    .select("id")
    .single();
  if (oldByRes.error !== null) {
    throw dbFailed("cert_reissue_lineage_failed");
  }

  // 6) audit CERT_REISSUE — entityId = ใบใหม่ · `superseded_cert_id` = ใบเดิมที่ถูกแทน
  //    (AUDIT §2.1 "certificate_id เดิม → ใหม่") · `user_id` = actor ผู้สั่งออกใหม่ (0008:476-486)
  await appendAuditEvent(client, {
    action: "CERT_REISSUE",
    entityType: "certificate",
    entityId: newCertificate.id,
    context: {
      enrollment_id: rowString(oldCert, "enrollment_id"),
      superseded_cert_id: oldCertId,
      user_id: input.actorId,
    },
    actorId: input.actorId,
    requestId: input.requestId ?? null,
  });

  return {
    newCertificate,
    oldCertificateId: oldCertId,
    oldStatus: "superseded",
    oldSupersededBy: newCertificate.id,
  };
}

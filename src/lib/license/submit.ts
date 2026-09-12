/**
 * submit — ยื่นคำขอผูกเลขที่ใบอนุญาต (Wave E Phase 5 · D-p5-2 · API-SPEC §3.2 แถว PUT /me/license)
 *
 * ลำดับ (จุดเดียวของระบบ — ห้าม route เรียก storage/insert เอง):
 * 1) validate license_no (zod `^\d{6,9}$`) + ไฟล์หลักฐาน (jpg/png/pdf ≤10MB) อีกชั้น
 * 2) อัปโหลดไฟล์เข้าบักเก็ต private `license-evidence` path
 *    `license-evidence/{user_id}/{uuid}.{ext}` ผ่าน service client (BFF trusted — ไฟล์
 *    อยู่นอก DB TX โดยธรรมชาติ)
 * 3) INSERT media_assets (status 'ready' · uploaded_by = เจ้าของ — RPC ตรวจอีกชั้นว่า
 *    uploaded_by = auth.uid() กันอ้าง media ของคนอื่น)
 * 4) เรียก RPC `my_submit_license_application(p_license_no, p_evidence_media_id, p_request_id)`
 *    **ด้วย user JWT** (ไม่ใช่ service) — แถวคำขอ + audit LICENSE_BIND atomic ใน TX เดียว
 *    (RLS la_insert_owner คุมต่อ)
 * 5) RPC ล้ม = ลบ media คืน (best-effort — spec กำกับ "ถ้า RPC ล้ม BFF ลบ media คืน") แล้ว
 *    แจ้ง error ตามป้าย "(ERR-XXX-NNN|tag)" ผ่าน lib/api/rpc-errors · ไม่มีป้าย =
 *    ERR-SYS-002 opaque (ห้าม leak ข้อความ SQL — SDS §6.1)
 *
 * ห้าม log ไฟล์/เลขที่ใบอนุญาต (D24 — ไม่มี PII ใน log ทุกจุด)
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import { AppError } from "@/lib/errors";
import {
  EvidenceFileSchema,
  LicenseNoSchema,
  SubmittedLicenseApplication,
  type SubmittedLicenseApplicationParsed,
} from "@/lib/schemas/license";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** บักเก็ต private ของหลักฐาน (0035 §2) — ชื่อเดียวกับ path prefix ตามสัญญา spec */
export const LICENSE_EVIDENCE_BUCKET = "license-evidence";

/** นามสกุลจาก mime — คืน null เมื่อชนิดไม่อยู่ในสัญญา (schema กันไว้ก่อนถึงจุดนี้แล้ว) */
export function evidenceExtensionOf(mimeType: string): "jpg" | "png" | "pdf" | null {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "application/pdf") return "pdf";
  return null;
}

/** แถว media_assets ที่เพิ่ง insert (untyped client — อ่าน id อย่างเดียว) */
interface MediaRow {
  readonly id: unknown;
}

/** ลบหลักฐานคืนเมื่อขั้นถัดไปล้ม (best-effort — ล้มเงียบ ไม่ปิดบัง error หลัก) */
async function cleanupEvidence(
  service: ReturnType<typeof createSupabaseServiceRoleClient>,
  input: { readonly mediaId: string | null; readonly path: string },
): Promise<void> {
  try {
    if (input.mediaId !== null) {
      await service.from("media_assets").delete().eq("id", input.mediaId);
    }
    await service.storage.from(LICENSE_EVIDENCE_BUCKET).remove([input.path]);
    return;
  } catch {
    // best-effort ตาม spec — ห้ามทำให้ error หลักเพี้ยน
    return;
  }
}

/** error ของ RPC ยื่นคำขอ → AppError — มีป้ายในทะเบียน = map ตรง · ไม่มีป้าย = opaque 503 */
function mapSubmitRpcError(error: RpcErrorLike): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: "license_submit_failed" } });
}

export interface SubmitLicenseInput {
  /** เจ้าของคำขอ (auth.uid() ของ session) — อยู่ใน path + uploaded_by */
  readonly userId: string;
  readonly licenseNo: string;
  readonly file: File;
  /** x-request-id สะท้อนเข้า audit LICENSE_BIND (SDS §5.4) */
  readonly requestId: string | null;
}

/**
 * ยื่นคำขอ — สำเร็จคืนแถวคำขอ (applicationId/status/submittedAt)
 * โยน AppError: license_no/ไฟล์ไม่ผ่าน = 400 ERR-VAL-001 · storage/media ล้ม = 503 ·
 * RPC มี pending อยู่ = ERR-VAL-001 reason "pending_exists" (route แปลงเป็น 409)
 */
export async function submitLicenseApplication(
  input: SubmitLicenseInput,
): Promise<SubmittedLicenseApplicationParsed> {
  // 1) validate อีกชั้น (route ตรวจแล้ว — lib ต้องพร้อมถูกเรียกตรงจากที่ไหนก็ได้)
  const licenseNoParsed = LicenseNoSchema.safeParse(input.licenseNo);
  if (!licenseNoParsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["license_no"] } });
  }
  const fileParsed = EvidenceFileSchema.safeParse(input.file);
  if (!fileParsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["file"] } });
  }
  const extension = evidenceExtensionOf(input.file.type);
  if (extension === null) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["file"] } });
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await input.file.arrayBuffer();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["file"] } });
  }

  const evidenceId = randomUUID();
  const storagePath = `${LICENSE_EVIDENCE_BUCKET}/${input.userId}/${evidenceId}.${extension}`;
  const service = createSupabaseServiceRoleClient();

  // 2) อัปโหลด storage (service — จุดเดียวของระบบ)
  const { error: uploadError } = await service.storage
    .from("license-evidence")
    .upload(storagePath, bytes, { contentType: input.file.type, upsert: false });
  if (uploadError !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "evidence_upload_failed" } });
  }

  // 3) INSERT media_assets — status 'ready' · uploaded_by = เจ้าของ (RPC ตรวจซ้ำ)
  const { data: mediaData, error: mediaError } = await service
    .from("media_assets")
    .insert({
      provider: "supabase_storage",
      media_type: extension === "pdf" ? "document" : "image",
      bucket: LICENSE_EVIDENCE_BUCKET,
      storage_path: storagePath,
      mime_type: input.file.type,
      size_bytes: bytes.byteLength,
      status: "ready",
      uploaded_by: input.userId,
    })
    .select("id")
    .single();
  if (mediaError !== null || mediaData === null) {
    await cleanupEvidence(service, { mediaId: null, path: storagePath });
    throw new AppError("ERR-SYS-002", { details: { reason: "evidence_media_insert_failed" } });
  }
  const mediaId = (mediaData as unknown as MediaRow).id;
  if (typeof mediaId !== "string") {
    await cleanupEvidence(service, { mediaId: null, path: storagePath });
    throw new AppError("ERR-SYS-002", { details: { reason: "evidence_media_row_drift" } });
  }

  // 4) RPC ด้วย user JWT — แถวคำขอ + audit LICENSE_BIND ใน TX เดียว (D-p5-2 §1.5)
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("my_submit_license_application", {
    p_license_no: licenseNoParsed.data,
    p_evidence_media_id: mediaId,
    p_request_id: input.requestId,
  });
  if (rpc.error !== null) {
    // 5) RPC ล้ม = ลบ media คืน (best-effort — ไฟล์อยู่นอก TX จึงต้องเก็บกวาดเอง)
    await cleanupEvidence(service, { mediaId, path: storagePath });
    throw mapSubmitRpcError(rpc.error);
  }

  // แถว jsonb ที่ RPC คืน — PostgREST อาจ wrap scalar เป็น array หลักเดียว (r8-N2)
  const rawRow: unknown = Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
  if (rawRow === null || typeof rawRow !== "object") {
    await cleanupEvidence(service, { mediaId, path: storagePath });
    throw new AppError("ERR-SYS-002", { details: { reason: "license_application_created_drift" } });
  }
  const record = rawRow as Record<string, unknown>;
  const candidate = {
    applicationId: typeof record["id"] === "string" ? record["id"] : "",
    status: typeof record["status"] === "string" ? record["status"] : "",
    submittedAt: typeof record["submitted_at"] === "string" ? record["submitted_at"] : "",
  };
  const parsed = SubmittedLicenseApplication.safeParse(candidate);
  if (!parsed.success) {
    await cleanupEvidence(service, { mediaId, path: storagePath });
    throw new AppError("ERR-SYS-002", { details: { reason: "license_application_created_drift" } });
  }
  return parsed.data;
}

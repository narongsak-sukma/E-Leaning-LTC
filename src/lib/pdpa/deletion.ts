/**
 * deletion — SEC-012 soft-delete ของบัญชี (D-p5-8 · #90) — จุดเดียวของระบบที่
 * "ขอลบ + ยืนยันลบ" จริง
 *
 * ขอลบ (POST /profile/delete — user JWT):
 * - RPC `my_request_account_deletion(p_request_id)` ด้วย user-JWT client —
 *   RPC สร้างแถว account_deletion_requests + token CSPRNG 43 อักขระ (เก็บ
 *   sha256 เท่านั้น อายุ 24 ชม. · guard SoD บทบาทผู้สอน/เจ้าหน้าที่ ห้ามลบเอง)
 *   แล้วคืน token ตัวจริงทาง return "ครั้งเดียว" — ไฟล์นี้เป็นผู้ถือ token คนเดียว
 *   และแทรกลง vars.confirm_url ของอีเมลธุรกรรม `account.delete.confirm` เท่านั้น
 *   (**ห้าม log / ห้ามคืนใน response — D24**)
 * - อีเมล = แทรก email_outbox ตรงด้วย service client (0035 §9: account.* =
 *   ธุรกรรมบังคับ NTF-005 ไม่ผ่าน dispatch_tick จึงไม่มีแถว in_app) รูป payload
 *   เดียวกับที่ tick ผลิต: {notification_id, user_id, vars} — notification_id
 *   ใช้ requestId (uuid ของคำขอ — email_complete cast เป็น uuid เสมอ)
 *
 * ยืนยันลบ (GET /profile/delete/confirm — สาธารณะ ไม่มี session):
 * - RPC `confirm_account_deletion(p_token, p_request_id)` ด้วย service client
 *   (ตัวตนคือ token เอง — 0036 §6) — single-use · soft-delete ทั้งหมดใน TX เดียว
 *   (deleted_at + display_name → "บัญชีที่ขอลบแล้ว" + audit PROFILE_DELETE)
 * - หลัง RPC สำเร็จ: GoTrue ban (บังคับจริง — revoke session) + อีเมล
 *   `account.deleted` — ทั้งสอง best-effort แจ้ง warn แบบไม่มี PII (การลบ
 *   durable แล้วใน DB · session layer บล็อกต่อด้วย deleted_at เสมอ)
 *
 * กติกา log (D24/SDS §6.2): ห้าม log token / ลิงก์ confirm / อีเมล — log เฉพาะ
 * user_id + รหัส static
 */
import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** template ธุรกรรมบังคับ (seed 0035 §9 — email เท่านั้น) */
export const DELETE_CONFIRM_TEMPLATE = "account.delete.confirm";
export const DELETED_TEMPLATE = "account.deleted";

/** อายุ ban หลังยืนยันลบ — 10 ปี (ชั่วโมง — รูปแบบ GoTrue ban_duration) */
export const ACCOUNT_DELETE_BAN_DURATION = "87600h";

/**
 * แถวคำขอที่ RPC คืน — strict ตามสัญญา 0036 §5 {requestId, token, expiresAt}
 * (token 43 อักขระ base64url — ผ่าน zod เท่านั้น ไม่แตะ log)
 */
export const DeletionRequestRow = z
  .object({
    requestId: z.uuid(),
    token: z.string().min(40).max(60),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** ผลการยืนยัน — confirmed พร้อม userId จาก RPC · token_invalid = ไม่เฉลยสถานะคำขอ */
export type ConfirmAccountDeletionOutcome =
  | { readonly outcome: "confirmed"; readonly userId: string; readonly emailQueued: boolean }
  | { readonly outcome: "token_invalid" };

/** แถวโปรไฟล์ที่ใช้แต่งอีเมล — เฉพาะฟิลด์ที่ต้องใช้จริง (email + display_name) */
const ProfileForEmail = z
  .object({ email: z.string().min(3), display_name: z.string() })
  .strict();

/** map error ของ RPC → AppError — มีป้าย = map ตรง · ไม่มีป้าย = ERR-SYS-002 opaque */
function mapDeletionRpcError(error: RpcErrorLike, fallbackReason: string): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: fallbackReason } });
}

/** PostgREST อาจห่อ scalar/jsonb เป็น array หลักเดียว (r8-N2) — คลี่ก่อนตรวจ strict */
function unwrapScalarRow(data: unknown): unknown {
  return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

/** อ่าน email + display_name ด้วย service client — ใช้แต่งอีเมลเท่านั้น ห้าม log */
async function readProfileForEmail(
  client: SupabaseClient,
  userId: string,
): Promise<{ email: string; displayName: string } | null> {
  const { data, error } = await client
    .from("profiles")
    .select("email,display_name")
    .eq("id", userId)
    .maybeSingle();
  if (error !== null || data === null) {
    return null;
  }
  const parsed = ProfileForEmail.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  return { email: parsed.data.email, displayName: parsed.data.display_name };
}

/**
 * requestAccountDeletion — ผู้ใช้ขอลบบัญชี: RPC ด้วย user JWT → ถือ token ครั้งเดียว
 * → แทรกอีเมลยืนยัน `account.delete.confirm` (ลิงก์ `${base}/profile/delete/confirm
 * ?token=…`) · คืนข้อมูลสำหรับ response {requestId, expiresAt} — token ไม่ออกจาก
 * ไฟล์นี้ (D24)
 */
export async function requestAccountDeletion(
  requestId: string | null,
): Promise<{ readonly requestId: string; readonly expiresAt: string }> {
  const logger = createLogger(getConfig().logLevel);

  // 1) RPC ด้วย user JWT — RPC ตรวจ SoD/guard/pending เองใน DB (auth.uid())
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("my_request_account_deletion", { p_request_id: requestId });
  if (rpc.error !== null) {
    throw mapDeletionRpcError(rpc.error as RpcErrorLike, "deletion_request_failed");
  }
  const row = DeletionRequestRow.safeParse(unwrapScalarRow(rpc.data));
  if (!row.success) {
    // drift ของสัญญา RPC — fail-closed (แถวคำขอถูกสร้างแล้ว แต่ไม่มีทางส่ง token ได้
    // อย่างปลอดภัย → 503 ให้ผู้ใช้ลองใหม่; คำขอเดิมรอหมดอายุ 24 ชม. ตาม migration)
    throw new AppError("ERR-SYS-002", { details: { reason: "deletion_request_drift" } });
  }
  const { requestId: rid, token, expiresAt } = row.data;

  // 2) ผู้รับอีเมล — service client อ่านเฉพาะ email + display_name (justified: อีเมลธุรกรรม)
  const service = createSupabaseServiceRoleClient();
  const profile = await readProfileForEmail(service, rid);
  if (profile === null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "deletion_profile_read_failed" } });
  }

  // 3) อีเมลธุรกรรม — แทรก email_outbox ตรง (NTF-005 · payload รูปเดียวกับ tick 0035 §11)
  const base = getConfig().publicBaseUrl;
  const vars = {
    full_name: profile.displayName,
    confirm_url: `${base}/profile/delete/confirm?token=${encodeURIComponent(token)}`,
  };
  const insert = await service.from("email_outbox").insert({
    recipient_user_id: rid,
    to_email: profile.email,
    template_key: DELETE_CONFIRM_TEMPLATE,
    payload: { notification_id: rid, user_id: rid, vars },
    locale: "th",
  });
  if (insert.error !== null) {
    logger.warn("pdpa_delete_confirm_email_enqueue_failed", { route: "pdpa:delete", user_id: rid });
    throw new AppError("ERR-SYS-002", { details: { reason: "deletion_email_enqueue_failed" } });
  }
  logger.info("pdpa_delete_confirm_email_queued", { route: "pdpa:delete", user_id: rid });
  return { requestId: rid, expiresAt };
}

/**
 * confirmAccountDeletion — ยืนยันลบด้วย token จากอีเมล (สาธารณะ ไม่มี session) —
 * service client เรียก RPC single-use แล้ว GoTrue ban + อีเมลยืนยันการลบ
 * (best-effort — การลบ durable ใน TX ของ RPC แล้ว)
 */
export async function confirmAccountDeletion(
  token: string,
  requestId: string | null,
): Promise<ConfirmAccountDeletionOutcome> {
  const logger = createLogger(getConfig().logLevel);
  const client = createSupabaseServiceRoleClient();

  // 1) RPC single-use — token ถูก/หมดอายุ/ใช้แล้ว = คืน token_invalid (ไม่เฉลยสถานะ
  //    คำขอตาม spec §3.2 — หน้าผลเดียวทุกกรณี) · error อื่น = ระบบ (โยนต่อ)
  const rpc = await client.rpc("confirm_account_deletion", {
    p_token: token,
    p_request_id: requestId,
  });
  if (rpc.error !== null) {
    const parsed = parseRpcErrorCodeDetailed(rpc.error as RpcErrorLike);
    if (
      parsed !== undefined &&
      (parsed.reason === "token_required" ||
        parsed.reason === "token_not_found" ||
        parsed.reason === "token_used" ||
        parsed.reason === "token_expired")
    ) {
      logger.warn("pdpa_delete_confirm_token_invalid", {
        route: "pdpa:delete:confirm",
        status: parsed.reason,
      });
      return { outcome: "token_invalid" };
    }
    throw mapDeletionRpcError(rpc.error as RpcErrorLike, "confirm_deletion_failed");
  }

  const row = z
    .object({ userId: z.uuid(), confirmed: z.literal(true) })
    .strict()
    .safeParse(unwrapScalarRow(rpc.data));
  if (!row.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "confirm_deletion_drift" } });
  }
  const userId = row.data.userId;

  // 2) GoTrue ban — บังคับจริง (revoke session/refresh) · ล้ม = warn อย่างเดียว
  //    (deleted_at ถูกเขียนแล้วใน TX — session layer บล็อก login ต่อให้เอง)
  const ban = await client.auth.admin.updateUserById(userId, {
    ban_duration: ACCOUNT_DELETE_BAN_DURATION,
  });
  if (ban.error !== null) {
    logger.warn("pdpa_delete_gotrue_ban_failed", { route: "pdpa:delete:confirm", user_id: userId });
  }

  // 3) อีเมลยืนยันการลบ (account.deleted — ธุรกรรมบังคับ NTF-005) — best-effort
  //    เพราะการลบเกิดขึ้นจริงแล้ว · display_name หลัง anonymize = ชื่อเรียกที่เป็น
  //    กลาง/ซื่อตรงต่อสถานะบัญชี (ไม่มี PII เดิมหลงเหลือในอีเมลลบ)
  const profile = await readProfileForEmail(client, userId);
  if (profile === null) {
    logger.warn("pdpa_deleted_email_profile_read_failed", {
      route: "pdpa:delete:confirm",
      user_id: userId,
    });
    return { outcome: "confirmed", userId, emailQueued: false };
  }
  const insert = await client.from("email_outbox").insert({
    recipient_user_id: userId,
    to_email: profile.email,
    template_key: DELETED_TEMPLATE,
    payload: {
      notification_id: userId,
      user_id: userId,
      vars: { full_name: profile.displayName },
    },
    locale: "th",
  });
  if (insert.error !== null) {
    logger.warn("pdpa_deleted_email_enqueue_failed", {
      route: "pdpa:delete:confirm",
      user_id: userId,
    });
    return { outcome: "confirmed", userId, emailQueued: false };
  }
  return { outcome: "confirmed", userId, emailQueued: true };
}

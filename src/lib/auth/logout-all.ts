/**
 * logout-all — logic กลางของ POST /api/v1/auth/logout-all (AUTH-010 · Wave G P1)
 *
 * - route ของ logout-all เลียนแบบ logout เดิมทั้งหมด (fail-closed: ยืนยัน GoTrue
 *   revoke สำเร็จก่อนจึงล้าง cookie — ไม่ยืนยัน = 503) แต่ revoke ด้วย
 *   `scope=global` = ยกเลิกทุกเซสชัน (ทุกเครื่อง) ของผู้ใช้นั้น — logic ส่วนที่
 *   "โทนเดียวกันกับ logout เดิมแต่ต่าง scope" export จากไฟล์นี้ เพื่อให้**ไฟล์
 *   logout เดิมไม่ถูกแตะ** (ทำซ้ำเล็กน้อยเพื่อความ disjoint ตามสัญญา lane)
 * - สำเร็จ (ยืนยัน revoke แล้ว) = audit `AUTH_SESSION_REVOKE` ผ่าน service-role
 *   RPC `append_audit_event` (แบบแผน 1.1.2 B7 เดียวกับ src/lib/admin/users.ts):
 *   context ตรง allowlist 0008:474 `['session_id','reason']` — actor ยกจาก
 *   context.user_id (uuid) แล้ว RPC strip ออกเอง · ล้ม = retry อีกครั้งเดียว ·
 *   ยังล้ม → WARN บรรทัดเดียว (ไม่มี PII) แล้ว throw ERR-SYS-002 (503)
 */
import "server-only";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { getConfig } from "@/lib/config";

const logoutAllLogger = createLogger(getConfig().logLevel);

/** เหตุผลที่บันทึกใน audit context.reason — ค่าคงที่ (free text ผ่าน audit_free_text_ok) */
export const LOGOUT_ALL_REASON = "logout_all";

/** uuid (เวอร์ชันใดก็ได้) — กันค่าปลอมเข้า allowlist ของ audit (session_id ต้องเป็น uuid) */
export function isUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value,
  );
}

/**
 * อ่าน claim `session_id` จาก access token (JWT payload — GoTrue ใส่ uuid ของ
 * session มาให้ทุก token) — ไม่มี claim / รูปแบบไม่ใช่ uuid / decode ไม่ได้ = null
 * (audit context.session_id เป็น "แถม" — ขาดได้ ไม่ทำให้การ revoke ล้ม)
 */
export function sessionIdFromAccessToken(accessToken: string): string | null {
  const part = accessToken.split(".")[1] ?? "";
  if (part === "") {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    ) as { session_id?: unknown };
    const sid = payload.session_id;
    if (typeof sid === "string" && isUuid(sid)) {
      return sid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * เรียก GoTrue `/auth/v1/logout?scope=global` เอง (fetch ตรง — เหตุผลเดียวกับ
 * logout เดิม: _signOut ของ SDK กลืน 401/403/404 เป็น error:null ทางเดียวที่รู้ผล
 * revoke จริงคืออ่าน status เอง) — network ล้ม/ค้าง = upstream ล้ม (ERR-SYS-002)
 */
export async function revokeAllSessions(
  url: string,
  apiKey: string,
  accessToken: string,
): Promise<Response> {
  try {
    return await fetch(`${url}/auth/v1/logout?scope=global`, {
      method: "POST",
      headers: { apikey: apiKey, authorization: `Bearer ${accessToken}` },
      // หมดเวลาแบบกำหนด — connection ค้างกลายเป็น transient แทนที่จะค้างเปิดไว้
      // (เช่นเดียวกับ revokeSession ของ logout route เดิม)
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError("ERR-SYS-002");
  }
}

/** input ของ auditSessionRevokeFailClosed — ตรง allowlist ของ AUTH_SESSION_REVOKE (0008:474) */
export interface SessionRevokeAuditInput {
  /** เจ้าของ session ที่ถูก revoke — ใส่ใน context.user_id (RPC ยกเป็น actor เอง) */
  readonly userId: string;
  /** session_id ของ token ที่ใช้เรียก (uuid หรือ null เมื่ออ่าน claim ไม่ได้) */
  readonly sessionId: string | null;
  /** x-request-id จาก middleware (BFF trusted — service_role path บันทึกได้) */
  readonly requestId: string | null;
}

/**
 * audit AUTH_SESSION_REVOKE — fail-closed (แบบแผนเดียวกับ auditUsersPiiAccessFailClosed):
 * เขียนผ่าน service-role RPC `append_audit_event` (allowlist เปิด AUTH_SESSION_REVOKE
 * ให้ service_role แล้ว — 0008:457-458) · ล้ม = retry อีกครั้งเดียว · ยังล้ม →
 * WARN บรรทัดเดียว (ไม่มี PII) แล้ว throw ERR-SYS-002 (503) — ผู้เรียก (route)
 * จึงตอบ 503 ไม่ล้าง cookie ให้ลองใหม่ (session ฝั่ง GoTrue ตายแล้ว กดซ้ำจะได้
 * 204 ทาง idempotent ของ route เอง)
 */
export async function auditSessionRevokeFailClosed(input: SessionRevokeAuditInput): Promise<void> {
  const service = createSupabaseServiceRoleClient();
  const context: Record<string, string> = {
    // actor ของ 5W "ใคร" — RPC (service_role path) ยกเป็น actor_user_id แล้ว strip ออกเอง
    user_id: input.userId,
    reason: LOGOUT_ALL_REASON,
  };
  if (input.sessionId !== null) {
    context["session_id"] = input.sessionId;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await service.rpc("append_audit_event", {
      p_action: "AUTH_SESSION_REVOKE",
      p_entity_type: "user",
      p_entity_id: input.userId,
      p_before: null,
      p_after: null,
      p_context: context,
      p_actor_roles: null, // เมินโดย DB — derive ฝั่ง server (0008:411 D15-N1)
      p_ip_hash: null, // ไม่มี helper hash ฝั่งแอป ณ wave นี้ — คง null ตามแบบแผน admin
      p_user_agent: null,
      p_request_id: input.requestId,
    });
    if (error === null) {
      return;
    }
    lastError = error;
  }
  void lastError; // รายละเอียด DB ห้ามออก log/response (SDS §6.1)
  logoutAllLogger.warn("logout_all_audit_rpc_denied", {
    route: "auth:logout_all",
  });
  throw new AppError("ERR-SYS-002", {
    details: { reason: "logout_all_audit_unavailable" },
  });
}

/**
 * users — service lib ของโดเมน admin-users (Wave E Phase 5 · [#90] D-p5-6 + D-p5-5)
 *
 * จุดรวมศูนย์เดียวของ:
 * - RPC ฝั่ง user-JWT: admin_list_users / admin_grant_role / admin_revoke_role (0035) —
 *   mutation+audit atomic ใน TX เดียวฝั่ง DB (ROLE_GRANT/ROLE_REVOKE เขียนใน RPC เอง)
 * - GoTrue admin API จาก service client (invite + ban/unban — D-p5-6 "service lib จุดเดียว")
 * - PII_ACCESS แบบ fail-closed (retry ครั้งเดียว ยังล้ม = 503 ERR-SYS-002 — แบบแผน 1.1.2 B7
 *   เดียวกับ GET /admin/credits/{userId})
 * - audit USER_CREATE/USER_DISABLE/USER_UPDATE แบบ **durable atomic** (gate p5-r1 B4 —
 *   migration 0038): RPC admin_audit_user_created + admin_set_user_active ฝั่ง user-JWT
 *   เขียน audit ผ่าน append_audit_event_internal (path ของ business functions เหมือน
 *   ROLE_GRANT/ROLE_REVOKE — เดิมเรียก append_audit_event ชั้นนอกที่ allowlist ปฏิเสธ
 *   USER_* ทุกครั้ง = audit หลุดทั้งเส้น เหลือ WARN เก็บแค่ route) · BFF ทำ retry จำกัด
 *   (transient เยียวยา · guard 4xx ไม่ retry) · ค้าง = 503 fail-closed + WARN มี target
 *
 * - ห้าม log PII (D24) — logger ตัดฟิลด์นอก allowlist ทิ้งก่อนเขียนทุกบรรทัด (SDS §6.2)
 * - GoTrue อยู่นอก Postgres TX โดยธรรมชาติ — ลำดับที่ปลอดภัยคือ ban ก่อน profiles.update
 *   (ล้มหลัง ban = บัญชีค้างสถานะ "ถูกแบน" ซึ่ง fail-closed ทางความปลอดภัย แล้ว WARN)
 */
import "server-only";
import { z } from "zod";
import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** logger ของโดเมน — ฟิลด์ผ่าน allowlist ของ repo (SDS §6.2) จึงเขียน PII ไม่ได้แม้ส่งผิดพลาด */
const adminUsersLogger = createLogger(getConfig().logLevel);

/** ban แบบยาว 100 ปี — ตัวอย่าง "ปิดใช้งานเชิงถาวร" ทางการของ supabase-js (GoTrue ban_duration) */
export const BAN_DURATION_DISABLE = "876000h";

/** GoTrue: ค่า ban_duration "none" = ยกเลิกการแบน (เปิดใช้งานบัญชี) */
export const BAN_DURATION_ENABLE = "none";

/**
 * error ของ RPC → AppError — มีป้าย "(ERR-XXX-NNN|tag)" ที่อยู่ในทะเบียน = map ตรง
 * (สถานะ + ข้อความไทยจากทะเบียน lib/errors) · ไม่มีป้าย / code นอกทะเบียน =
 * ERR-SYS-002 opaque (ห้าม leak ข้อความ SQL ออก client — SDS §6.1) — pattern เดียวกับ
 * /admin/credit-rules
 */
export function mapAdminRpcError(error: RpcErrorLike, fallbackReason: string): AppError {
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

/**
 * jsonb scalar ของ RPC — ยอมรับ object ตรง ๆ หรือ array ความยาว 1 พอดี (PostgREST อาจ
 * wrap scalar เป็น array หลักเดียว — r8-N2) · รูปอื่น = drift ของ DB contract
 */
export function unwrapScalarJsonb(data: unknown): unknown {
  if (Array.isArray(data) && data.length === 1) {
    return data[0];
  }
  return data;
}

/** envelope ของ admin_list_users / admin_list_audit_logs (0035/0036 — jsonb_build_object) */
const RpcListEnvelope = z
  .object({
    data: z.array(z.unknown()),
    nextCursor: z
      .object({ createdAt: z.string().min(1), id: z.uuid() })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * ผลจริงของ admin_list_audit_logs ใช้คีย์ occurredAt — normalize เป็น shape เดียว
 * (createdAt ทางชนิด) โดย caller ตีความ sortKey เอง
 */
const RpcAuditListEnvelope = z
  .object({
    data: z.array(z.unknown()),
    nextCursor: z
      .object({ occurredAt: z.string().min(1), id: z.uuid() })
      .strict()
      .nullable(),
  })
  .strict();

/** ผลของ RPC บทบาท (0035 §6 — jsonb_build_object camelCase) */
const RpcGrantResult = z
  .object({ userId: z.uuid(), role: z.string().min(1), granted: z.boolean() })
  .strict();

const RpcRevokeResult = z
  .object({ userId: z.uuid(), role: z.string().min(1), revoked: z.boolean() })
  .strict();

/** envelope ของผลลัพธ์ที่ RPC คืน — parse ไม่ผ่าน = contract ของ DB เพี้ยน (fail-closed 503) */
function parseRpcEnvelope<T extends z.ZodType>(schema: T, data: unknown, reason: string): z.output<T> {
  const result = schema.safeParse(unwrapScalarJsonb(data));
  if (!result.success) {
    throw new AppError("ERR-SYS-002", { details: { reason } });
  }
  return result.data;
}

/** input ของ listUsersViaRpc — ค่าตรงพารามิเตอร์ p_* ของ admin_list_users (0035 §7) */
export interface AdminListUsersInput {
  /** คำค้น (prefix match บน display_name หรือ email — RPC ทำเอง) · null = ไม่กรอง */
  readonly query: string | null;
  /** 'active' | 'deleted' | null (ทุกสถานะ) — RPC ตรวจชุดค่าเอง */
  readonly status: "active" | "deleted" | null;
  /** keyset cursor (created_at, id) — null = หน้าแรก */
  readonly cursorCreatedAt: string | null;
  readonly cursorId: string | null;
  /** 1..100 (RPC clamp เอง — BFF ตรวจก่อนแล้ว) */
  readonly limit: number;
  readonly requestId: string | null;
}

export interface AdminListUsersResult {
  /** แถวดิบ (row_to_json — snake_case) — route ตรวจ strict ขาออกต่อเอง */
  readonly data: readonly unknown[];
  /** cursor ถัดไป (created_at, id) ของแถวสุดท้าย — null = หมดหน้า */
  readonly nextCursor: { readonly createdAt: string; readonly id: string } | null;
}

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
export const IsoTimestamp = z.iso.datetime({ offset: true });

/**
 * resource ขาออกของแถวผู้ใช้ GET /admin/users (camelCase · strict) — คอลัมน์ตรง jsonb
 * ของ RPC admin_list_users (0035 §7) · 0041 (Wave F · D-f-5) เพิ่ม additive:
 *   isBanned    = สถานะแบน GoTrue ยังไม่หมดอายุ (is_banned ของ RPC)
 *   bannedUntil = ค่า banned_until จริงจาก auth.users — **อาจเป็นวันในอดีต** (แบนหมด
 *                 อายุแล้ว GoTrue คงค่าไว้) — ห้ามตีความเป็น "ยังถูกแบน" ที่ UI
 */
export const AdminUserResource = z
  .object({
    id: z.uuid(),
    displayName: z.string().min(1),
    email: z.email(),
    deletedAt: IsoTimestamp.nullable(),
    createdAt: IsoTimestamp,
    roles: z.array(z.string().min(1)),
    hasVerifiedLicense: z.boolean(),
    isBanned: z.boolean(),
    bannedUntil: IsoTimestamp.nullable(),
  })
  .strict();

export type AdminUserResourceParsed = z.output<typeof AdminUserResource>;

/** แถวดิบจาก RPC (row_to_json — snake_case) — ตรงตามตัวอักษรของ 0035 §7 + 0041 */
export interface AdminUserDbRow {
  readonly id: string;
  readonly display_name: string;
  readonly email: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly roles: readonly string[];
  readonly has_verified_license: boolean;
  /** 0041: แบนยังไม่หมดอายุ (banned_until > now()) */
  readonly is_banned: boolean;
  /** 0041: ค่าจริงจาก auth.users — null ได้ · ค่าในอดีต = แบนหมดอายุแล้ว */
  readonly banned_until: string | null;
}

/** แถวดิบ (snake_case) → resource (camelCase) — map ตรง ไม่ fabricate ค่า */
export function toAdminUserResource(row: AdminUserDbRow): AdminUserResourceParsed {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    roles: [...row.roles],
    hasVerifiedLicense: row.has_verified_license,
    isBanned: row.is_banned,
    bannedUntil: row.banned_until,
  };
}

/**
 * เรียก RPC admin_list_users (0035 §7) ด้วย user-JWT client — RLS/guard ของ RPC
 * (admin_users_staff_guard: login + aal2 + sv/sr/sa) เป็นชั้นที่สองเสมอ
 */
export async function listUsersViaRpc(input: AdminListUsersInput): Promise<AdminListUsersResult> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("admin_list_users", {
    p_query: input.query,
    p_status: input.status,
    p_cursor_created_at: input.cursorCreatedAt,
    p_cursor_id: input.cursorId,
    p_limit: input.limit,
  });
  if (rpc.error !== null) {
    throw mapAdminRpcError(rpc.error as RpcErrorLike, "admin_list_users_failed");
  }
  const envelope = parseRpcEnvelope(RpcListEnvelope, rpc.data, "admin_list_users_envelope_drift");
  return { data: envelope.data, nextCursor: envelope.nextCursor };
}

/** input ของ listAuditLogsViaRpc — ตรงพารามิเตอร์ p_* ของ admin_list_audit_logs (0036 §8) */
export interface AdminListAuditLogsInput {
  /** prefix match เช่น 'ROLE_' — null = ไม่กรอง */
  readonly action: string | null;
  readonly actor: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  /** keyset cursor (occurred_at, id) — null = หน้าแรก */
  readonly cursorOccurredAt: string | null;
  readonly cursorId: string | null;
  readonly limit: number;
  readonly requestId: string | null;
}

export interface AdminListAuditLogsResult {
  readonly data: readonly unknown[];
  readonly nextCursor: { readonly occurredAt: string; readonly id: string } | null;
}

/**
 * เรียก RPC admin_list_audit_logs (0036 §8) ด้วย user-JWT client — role-gate
 * audit_log:view (staff:viewer + super_admin) ตรวจใน RPC เป็นชั้นที่สอง
 */
export async function listAuditLogsViaRpc(
  input: AdminListAuditLogsInput,
): Promise<AdminListAuditLogsResult> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("admin_list_audit_logs", {
    p_action: input.action,
    p_actor: input.actor,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_from: input.from,
    p_to: input.to,
    p_cursor_occurred_at: input.cursorOccurredAt,
    p_cursor_id: input.cursorId,
    p_limit: input.limit,
  });
  if (rpc.error !== null) {
    throw mapAdminRpcError(rpc.error as RpcErrorLike, "admin_list_audit_logs_failed");
  }
  const envelope = parseRpcEnvelope(
    RpcAuditListEnvelope,
    rpc.data,
    "admin_list_audit_logs_envelope_drift",
  );
  return { data: envelope.data, nextCursor: envelope.nextCursor };
}

/** ผลของ RPC admin_dashboard_stats (0036 §7 — jsonb camelCase ตรง resource ขาออก) */
export const DashboardStatsRpcSchema = z
  .object({
    range: z.object({ from: z.iso.date(), to: z.iso.date() }).strict(),
    users: z.object({ new: z.number().int().min(0), total: z.number().int().min(0) }).strict(),
    enrollments: z.object({ new: z.number().int().min(0) }).strict(),
    exams: z
      .object({
        attempts: z.number().int().min(0),
        passed: z.number().int().min(0),
        passRatePct: z.number().min(0).max(100).nullable(),
      })
      .strict(),
    certificates: z.object({ issued: z.number().int().min(0) }).strict(),
    credits: z.object({ issued: z.number() }).strict(),
    })  .strict();

/** input ของ dashboardStatsViaRpc — p_from ≤ p_to (ISO date) · null = default 30 วันล่าสุดของ RPC */
export interface DashboardStatsInput {
  readonly from: string | null;
  readonly to: string | null;
  readonly requestId: string | null;
}

/**
 * เรียก RPC admin_dashboard_stats (0036 §7) ด้วย user-JWT client — aggregate สด
 * (lag ≤15 นาที) · role-gate report:view (sv/se/sr/sa) ตรวจใน RPC เป็นชั้นที่สอง
 */
export async function dashboardStatsViaRpc(input: DashboardStatsInput): Promise<z.output<typeof DashboardStatsRpcSchema>> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("admin_dashboard_stats", {
    p_from: input.from,
    p_to: input.to,
  });
  if (rpc.error !== null) {
    throw mapAdminRpcError(rpc.error as RpcErrorLike, "admin_dashboard_stats_failed");
  }
  return parseRpcEnvelope(DashboardStatsRpcSchema, rpc.data, "admin_dashboard_stats_drift");
}

/** input ของ grantRoleViaRpc/revokeRoleViaRpc — ตรง p_* ของ 0035 §6 */
export interface RoleRpcInput {
  readonly targetUserId: string;
  readonly role: string;
  /** เหตุผล 10-500 อักขระ (RPC บังคับ btrim ≥10 — BFF ตรวจก่อนแล้ว) */
  readonly reason: string;
  readonly requestId: string | null;
}

/** เรียก RPC admin_grant_role (0035 §6) ด้วย user-JWT — mutation + audit ROLE_GRANT ใน TX เดียว */
export async function grantRoleViaRpc(input: RoleRpcInput): Promise<z.output<typeof RpcGrantResult>> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("admin_grant_role", {
    p_user_id: input.targetUserId,
    p_role: input.role,
    p_reason: input.reason,
    p_request_id: input.requestId,
  });
  if (rpc.error !== null) {
    throw mapAdminRpcError(rpc.error as RpcErrorLike, "admin_grant_role_failed");
  }
  return parseRpcEnvelope(RpcGrantResult, rpc.data, "admin_grant_role_row_drift");
}

/** เรียก RPC admin_revoke_role (0035 §6) ด้วย user-JWT — mutation + audit ROLE_REVOKE ใน TX เดียว */
export async function revokeRoleViaRpc(input: RoleRpcInput): Promise<z.output<typeof RpcRevokeResult>> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("admin_revoke_role", {
    p_user_id: input.targetUserId,
    p_role: input.role,
    p_reason: input.reason,
    p_request_id: input.requestId,
  });
  if (rpc.error !== null) {
    throw mapAdminRpcError(rpc.error as RpcErrorLike, "admin_revoke_role_failed");
  }
  return parseRpcEnvelope(RpcRevokeResult, rpc.data, "admin_revoke_role_row_drift");
}

/** input ของ auditUsersPiiAccessFailClosed — context keys ตรง allowlist PII_ACCESS (0008) */
export interface PiiAccessAuditInput {
  readonly endpoint: string;
  /** เป้าหมายรายคน (null = aggregate เช่นคิวค้นหา) — ต้องเป็น uuid เมื่อไม่ null */
  readonly targetUserId: string | null;
  readonly purpose: string;
  readonly actorId: string;
  readonly requestId: string | null;
  /**
   * ip_hash = sha256(ip + salt) จาก request จริง (D76) — ipHashOf(@/lib/auth/
   * password-reset) กับ clientIpFrom(@/lib/rate-limit) ของ handler เป็นผู้คำนวณ —
   * ห้ามเก็บ IP ดิบลงตาราง append-only · ค่าที่ RPC รับ type text (ไม่มี format check)
   */
  readonly ipHash: string;
  /** user_agent_hash = sha256(ua.trim() + salt) จาก request จริง · null = ไม่มี header */
  readonly userAgentHash: string | null;
}

/**
 * audit PII_ACCESS — fail-closed (แบบแผน 1.1.2 B7 เดียวกับ GET /admin/credits/{userId}):
 * เขียนผ่าน service client RPC append_audit_event (allowlist เปิด PII_ACCESS ให้
 * service_role แล้ว — 0025) · ล้ม = retry อีกครั้งเดียว · ยังล้ม → WARN บรรทัดเดียว
 * (ไม่มี PII) แล้ว throw ERR-SYS-002 (503) — ห้าม disclosure ข้อมูลผู้ใช้โดยไม่มี audit
 * · context.user_id ถูก RPC ยกเป็น actor แล้ว strip ออกก่อนเก็บ (0008 — 5W "ใคร")
 */
export async function auditUsersPiiAccessFailClosed(input: PiiAccessAuditInput): Promise<void> {
  const service = createSupabaseServiceRoleClient();
  const context: Record<string, string> = {
    endpoint: input.endpoint,
    purpose: input.purpose,
    user_id: input.actorId,
  };
  if (input.targetUserId !== null) {
    context["target_user_id"] = input.targetUserId;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await service.rpc("append_audit_event", {
      p_action: "PII_ACCESS",
      p_entity_type: "user",
      p_entity_id: input.targetUserId,
      p_before: null,
      p_after: null,
      p_context: context,
      p_actor_roles: null, // เมินโดย DB — derive ฝั่ง server (0008:411 D15-N1)
      // D76: hash จาก request จริงของ handler (ipHashOf + userAgentHashOf) —
      // ไม่มี header user-agent = null ตาม helper (ไม่ hash ค่าว่าง)
      p_ip_hash: input.ipHash,
      p_user_agent: input.userAgentHash,
      p_request_id: input.requestId,
    });
    if (error === null) {
      return;
    }
    lastError = error;
  }
  void lastError; // รายละเอียด DB ห้ามออก log/response (SDS §6.1)
  adminUsersLogger.warn("admin_users_pii_audit_rpc_denied", {
    route: "admin:users",
  });
  throw new AppError("ERR-SYS-002", {
    details: { reason: "admin_users_pii_audit_unavailable" },
  });
}

/** filters ของ AUDIT_READ — คีย์ตรง allowlist ของ RPC (0008 §3.2) · เก็บเฉพาะคีย์ที่มีจริง */
export type AuditReadFilters = {
  readonly action?: string;
  readonly actor_id?: string;
  readonly entity_type?: string;
  readonly entity_id?: string;
  readonly occurred_from?: string;
  readonly occurred_to?: string;
};

/** input ของ auditAuditReadFailClosed — row_count บันทึกจำนวนแถวที่อ่านจริง */
export interface AuditReadAuditInput {
  readonly filters: AuditReadFilters;
  readonly rowCount: number;
  readonly requestId: string | null;
}

/**
 * audit AUDIT_READ หลังอ่าน audit_logs สำเร็จ — fail-closed (แบบแผน 1.1.2 B7):
 * เขียนผ่าน **user-JWT client** (allowlist ของ authenticated รับ AUDIT_READ — 0008 §4 ·
 * DB ตัด request_id/ip_hash ทิ้งเองเมื่อเป็นชั้นผู้ใช้) · ล้ม = retry อีกครั้งเดียว ·
 * ยังล้ม → WARN บรรทัดเดียว (ไม่มี PII) แล้ว throw ERR-SYS-002 (503) — ห้ามส่งผลการอ่าน
 * ผ่านหน้าบัญชี admin โดยไม่มี audit ตามมา
 */
export async function auditAuditReadFailClosed(input: AuditReadAuditInput): Promise<void> {
  const userClient = await createSupabaseSsrClient();
  const context: Record<string, unknown> = {
    filters: input.filters,
    row_count: input.rowCount,
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await userClient.rpc("append_audit_event", {
      p_action: "AUDIT_READ",
      p_entity_type: "audit_log",
      p_entity_id: null,
      p_before: null,
      p_after: null,
      p_context: context,
      p_actor_roles: null, // เมินโดย DB — derive ฝั่ง server (0008:411 D15-N1)
      p_ip_hash: null,
      p_user_agent: null,
      p_request_id: input.requestId, // ชั้น authenticated: DB override เป็น null เสมอ
    });
    if (error === null) {
      return;
    }
    lastError = error;
  }
  void lastError; // รายละเอียด DB ห้ามออก log/response (SDS §6.1)
  adminUsersLogger.warn("admin_audit_read_rpc_denied", {
    route: "admin:audit-logs",
  });
  throw new AppError("ERR-SYS-002", {
    details: { reason: "audit_read_unavailable" },
  });
}

/** ผลของ RPC admin_decide_course (0035 §9 — jsonb_build_object camelCase) */
const RpcDecideCourseResult = z
  .object({ courseId: z.uuid(), status: z.string().min(1) })
  .strict();

/** input ของ decideCourseViaRpc — ตรง p_* ของ admin_decide_course (0035 §9) */
export interface DecideCourseInput {
  readonly courseId: string;
  readonly action: "publish" | "unpublish" | "return";
  /** บังคับ 10-500 เมื่อ action = "return" (route ตรวจก่อนแล้ว · RPC ตรวจซ้ำ) */
  readonly comment: string | null;
  readonly requestId: string | null;
}

/**
 * เรียก RPC admin_decide_course (0035 §9) ด้วย user-JWT — transition ของสถานะคอร์ส +
 * audit COURSE_PUBLISH/COURSE_UNPUBLISH/COURSE_RETURN เขียน **atomic ใน TX ของ RPC** ·
 * guard admin_course_staff_guard (staff:content + super_admin + aal2) ตรวจใน RPC
 */
export async function decideCourseViaRpc(input: DecideCourseInput): Promise<z.output<typeof RpcDecideCourseResult>> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc("admin_decide_course", {
    p_course_id: input.courseId,
    p_action: input.action,
    p_comment: input.comment,
    p_request_id: input.requestId,
  });
  if (rpc.error !== null) {
    throw mapAdminRpcError(rpc.error as RpcErrorLike, "admin_decide_course_failed");
  }
  return parseRpcEnvelope(RpcDecideCourseResult, rpc.data, "admin_decide_course_row_drift");
}

/** ผล RPC admin_audit_user_created (0038 §1) — strict ตามสัญญา */
const RpcUserCreatedAuditResult = z
  .object({ userId: z.uuid(), role: z.string().min(1), audited: z.literal(true) })
  .strict();

/** ผล RPC admin_set_user_active (0038 §2) — strict ตามสัญญา */
const RpcSetUserActiveResult = z
  .object({ userId: z.uuid(), isActive: z.boolean() })
  .strict();

/** ครั้งที่ลอง RPC ฝั่ง DB รวมครั้งแรก (gate p5-r1 B4: success/failure/retry ชัดเจน) */
const DB_RPC_ATTEMPTS = 3;

/** ถอยหลังระหว่าง retry (250ms → 600ms) — เยียวยา transient สั้น ๆ ไม่ถ่วง route นาน */
function retryDelayMs(attempt: number): number {
  return attempt === 1 ? 250 : 600;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * ครั้งเดียวของ RPC user-JWT พร้อมการจำแนก error: มีป้าย "(ERR-…|tag)" = ความผิด
 * สัญญา/guard ถาวร → โยนทันที (retry ไม่ช่วย) · ไม่มีป้าย (network/5xx) = transient
 * → คืนให้ caller retry ตาม DB_RPC_ATTEMPTS (การแลกเปลี่ยนที่ยอมรับ: response
 * หายหลัง DB commit อาจซ้ำแถว audit ได้ ≤1 แถว — append-only เก็บได้ ไม่ใช่การสูญ)
 */
async function rpcOnceWithClassification(
  fn: string,
  args: Record<string, unknown>,
): Promise<
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "transient"; readonly error: RpcErrorLike }
> {
  const supabase = await createSupabaseSsrClient();
  const rpc = await supabase.rpc(fn, args);
  if (rpc.error === null) {
    return { kind: "ok", data: rpc.data };
  }
  const error = rpc.error as RpcErrorLike;
  if (parseRpcErrorCodeDetailed(error) !== undefined) {
    throw mapAdminRpcError(error, `${fn}_failed`);
  }
  return { kind: "transient", error };
}

/**
 * durable audit USER_CREATE (0038 §1) — เรียกหลัง GoTrue invite + admin_grant_role
 * สำเร็จ: การสร้างบัญชีใน GoTrue เป็นระบบภายนอกจึงไม่มี TX ร่วม แต่ audit ต้อง
 * durable — retry จำกัด · ค้าง = 503 ERR-SYS-002\|user_create_audit_failed
 * (บัญชีถูกสร้างแล้ว ซองบอกให้ตรวจซ้ำ — ไม่ใช่ WARN เงียบแล้วอ้างว่าเขียนสำเร็จ)
 */
export async function auditUserCreatedViaRpc(input: {
  readonly targetUserId: string;
  readonly role: string;
  readonly reason: string;
  readonly requestId: string | null;
}): Promise<void> {
  const args = {
    p_target_user_id: input.targetUserId,
    p_role: input.role,
    p_reason: input.reason,
    p_request_id: input.requestId,
  };
  for (let attempt = 1; attempt <= DB_RPC_ATTEMPTS; attempt += 1) {
    const outcome = await rpcOnceWithClassification("admin_audit_user_created", args);
    if (outcome.kind === "ok") {
      const row = RpcUserCreatedAuditResult.safeParse(unwrapScalarJsonb(outcome.data));
      if (!row.success) {
        throw new AppError("ERR-SYS-002", { details: { reason: "user_create_audit_row_drift" } });
      }
      return;
    }
    if (attempt < DB_RPC_ATTEMPTS) {
      await sleep(retryDelayMs(attempt));
    }
  }
  adminUsersLogger.warn("admin_users_create_audit_persist_failed", {
    route: "admin:users:USER_CREATE",
    user_id: input.targetUserId,
  });
  throw new AppError("ERR-SYS-002", { details: { reason: "user_create_audit_failed" } });
}

/**
 * profiles.is_active + audit USER_DISABLE/USER_UPDATE **atomic ใน TX ของ RPC**
 * (0038 §2) — แทน update ตรง + best-effort แยกสองจังหวะเดิม · retry จำกัด ·
 * ค้าง = 503 ERR-SYS-002\|user_active_update_failed (บัญชีค้างถูกแบนตาม GoTrue
 * ที่ทำไปก่อนหน้า = ทิศ fail-closed เดิม)
 */
export async function setUserActiveViaRpc(input: {
  readonly targetUserId: string;
  readonly isActive: boolean;
  readonly reason: string | null;
  readonly requestId: string | null;
}): Promise<void> {
  const args = {
    p_target_user_id: input.targetUserId,
    p_is_active: input.isActive,
    p_reason: input.reason,
    p_request_id: input.requestId,
  };
  for (let attempt = 1; attempt <= DB_RPC_ATTEMPTS; attempt += 1) {
    const outcome = await rpcOnceWithClassification("admin_set_user_active", args);
    if (outcome.kind === "ok") {
      const row = RpcSetUserActiveResult.safeParse(unwrapScalarJsonb(outcome.data));
      if (!row.success) {
        throw new AppError("ERR-SYS-002", { details: { reason: "set_user_active_row_drift" } });
      }
      return;
    }
    if (attempt < DB_RPC_ATTEMPTS) {
      await sleep(retryDelayMs(attempt));
    }
  }
  adminUsersLogger.warn("admin_users_active_persist_failed", {
    route: "admin:users:USER_ACTIVE",
    user_id: input.targetUserId,
  });
  throw new AppError("ERR-SYS-002", { details: { reason: "user_active_update_failed" } });
}

/** input ของ createStaffUser — role เป็นชุดมอบได้ของ endpoint นี้ (super_admin เท่านั้น) */
export interface CreateStaffUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly role: "instructor" | "staff:viewer" | "staff:content" | "staff:exam" | "staff:registrar";
  readonly actorId: string;
  /** เหตุผล 10-500 อักขระ — เป็น p_reason ของ RPC มอบบทบาทเริ่มต้นด้วย */
  readonly reason: string;
  readonly requestId: string | null;
}

export interface CreatedStaffUser {
  readonly userId: string;
  readonly role: string;
  /** อีเมล normalized (lowercase) — GoTrue normalize ให้เอง · ห้าม log (D24) */
  readonly email: string;
  readonly displayName: string;
  /** true = มอบบทบาทเริ่มต้นสำเร็จ · false = ถือ role นี้อยู่แล้ว (RPC idempotent) */
  readonly granted: boolean;
  /** invited_at จาก GoTrue (null เมื่อ GoTrue ไม่คืน) */
  readonly invitedAt: string | null;
}

/**
 * GoTrue error → AppError — 422 "already registered" = อีเมลซ้ำ (ERR-VAL-001 + reason) ·
 * อื่น ๆ = ERR-SYS-002 opaque (ห้ามส่งข้อความ GoTrue ออก client — SDS §6.1)
 */
function mapGoTrueError(error: { readonly status?: unknown }, fallbackReason: string): AppError {
  if (error.status === 422) {
    return new AppError("ERR-VAL-001", { details: { reason: "email_already_registered" } });
  }
  return new AppError("ERR-SYS-002", { details: { reason: fallbackReason } });
}

/**
 * สร้างบัญชีเจ้าหน้าที่ (D-p5-6 — POST /admin/users · super_admin เท่านั้น):
 * 1) GoTrue admin inviteUserByEmail — ส่งอีเมลเชิญ (invite semantics ตาม spec) · trigger
 *    on_auth_user_created (0003) สร้าง profiles + role citizen ให้เอง
 * 2) มอบบทบาทเริ่มต้นผ่าน RPC admin_grant_role ด้วย user-JWT ของผู้เรียก — audit
 *    ROLE_GRANT ถูกเขียน **atomic ใน TX ของ RPC** (0035 §6) ไม่ใช่ best-effort
 * 3) durable audit USER_CREATE ผ่าน RPC admin_audit_user_created (0038) พร้อม retry
 *    จำกัด — ค้าง = 503 user_create_audit_failed (บัญชีถูกสร้างแล้ว ให้ตรวจซ้ำ)
 *
 * บังคับ MFA ตั้งแต่วันแรก = กลไกเดิมของ rbac.ts (staff:* และ instructor ถือบทบาทบังคับ MFA —
 * requirePermission ปฏิเสธ aal1 ทันที) ไม่ต้องตั้งค่าเพิ่มที่ GoTrue
 */
export async function createStaffUser(input: CreateStaffUserInput): Promise<CreatedStaffUser> {
  const service = createSupabaseServiceRoleClient();
  const invited = await service.auth.admin.inviteUserByEmail(input.email, {
    data: { display_name: input.displayName },
  });
  if (invited.error !== null || invited.data.user === null) {
    throw mapGoTrueError(
      invited.error ?? {},
      "staff_user_invite_failed",
    );
  }
  const userId = invited.data.user.id;
  // มอบบทบาทเริ่มต้นผ่าน RPC (user-JWT) — audit ROLE_GRANT atomic ใน TX เดียว
  const grant = await grantRoleViaRpc({
    targetUserId: userId,
    role: input.role,
    reason: input.reason,
    requestId: input.requestId,
  });
  // durable USER_CREATE (0038) — ล้มค้าง = throw 503 ไม่ใช่ WARN เงียบ (gate p5-r1 B4)
  await auditUserCreatedViaRpc({
    targetUserId: userId,
    role: input.role,
    reason: input.reason,
    requestId: input.requestId,
  });
  const invitedAt =
    typeof invited.data.user.invited_at === "string" ? invited.data.user.invited_at : null;
  return {
    userId,
    role: grant.role,
    email: input.email.toLowerCase(),
    displayName: input.displayName,
    granted: grant.granted,
    invitedAt,
  };
}

/** ผลของ setUserActive — สถานะที่ระบบบังคับจริงหลังเรียกสำเร็จ */
export interface SetUserActiveResult {
  readonly userId: string;
  readonly isActive: boolean;
}

/** input ของ setUserActive — reason บังคับเมื่อ isActive=false (route ตรวจแล้ว) */
export interface SetUserActiveInput {
  readonly targetUserId: string;
  readonly isActive: boolean;
  /** null เมื่อเปิดใช้งานโดยไม่ระบุเหตุผล (รับได้ — บังคับเฉพาะตอนปิด) */
  readonly reason: string | null;
  /** caller ถือ super_admin จริงจาก requirePermission แล้ว — ใช้ตัดสิน guard เป้าหมาย */
  readonly callerIsSuperAdmin: boolean;
  readonly actorId: string;
  readonly requestId: string | null;
}

/**
 * ปิด/เปิดใช้งานบัญชี (D-p5-6 — PATCH /admin/users/{id}):
 * 1) guard เป้าหมาย super_admin (อ่าน role_assignments ผ่าน user-JWT — RLS ra_read 0010
 *    ให้ staff อ่านได้) — เป้าหมายเป็น super_admin เมื่อผู้เรียกไม่ใช่ = 403 (BFF guard
 *    ก่อนแตะ GoTrue)
 * 2) GoTrue ban/unban = **ตัวบังคับจริง** (ban → login ไม่ได้ทันที) — ล้ม = หยุดทันที
 *    profiles ยังไม่แตะ (ไม่เกิดสถานะคลาดเคลื่อน)
 * 3) profiles.is_active + audit USER_DISABLE/USER_UPDATE **atomic ใน TX เดียว** ผ่าน
 *    RPC admin_set_user_active (0038 §2 — gate p5-r1 B4) พร้อม retry จำกัด · ค้าง =
 *    บัญชีค้างถูกแบน (fail-closed ทางความปลอดภัย) + WARN มี target
 */
export async function setUserActive(input: SetUserActiveInput): Promise<SetUserActiveResult> {
  // 1) guard: เป้าหมายเป็น super_admin หรือไม่ — ผู้ไม่ใช่ super_admin ห้ามแตะ (D-p5-6)
  const userClient = await createSupabaseSsrClient();
  const { data: saRow, error: saError } = await userClient
    .from("role_assignments")
    .select("role")
    .eq("user_id", input.targetUserId)
    .eq("role", "super_admin")
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (saError !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "target_roles_query_failed" } });
  }
  if (saRow !== null && !input.callerIsSuperAdmin) {
    throw new AppError("ERR-RBAC-001", { details: { permission: "user:disable" } });
  }
  const service = createSupabaseServiceRoleClient();
  // 2) GoTrue ban/unban — ตัวบังคับจริง (ล้ม = หยุดก่อนแตะ profiles)
  const banned = await service.auth.admin.updateUserById(input.targetUserId, {
    ban_duration: input.isActive ? BAN_DURATION_ENABLE : BAN_DURATION_DISABLE,
  });
  if (banned.error !== null) {
    throw new AppError("ERR-SYS-002", {
      details: { reason: input.isActive ? "gotrue_unban_failed" : "gotrue_ban_failed" },
    });
  }
  // 3) profiles.is_active + audit USER_DISABLE/USER_UPDATE atomic TX เดียว (0038 §2)
  //    retry จำกัด · ค้าง = 503 (บัญชีค้างถูกแบน — ทิศ fail-closed เดิม) + WARN มี target
  await setUserActiveViaRpc({
    targetUserId: input.targetUserId,
    isActive: input.isActive,
    reason: input.reason,
    requestId: input.requestId,
  });
  return { userId: input.targetUserId, isActive: input.isActive };
}

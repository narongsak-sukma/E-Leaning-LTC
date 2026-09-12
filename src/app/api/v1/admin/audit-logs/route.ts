/**
 * GET /api/v1/admin/audit-logs (Wave E Phase 5 · [#90] D-p5-7 · API-SPEC §3.8 แถว 234)
 *
 * - requirePermission("audit_log:view") + **BFF role-scope ก่อนถึง RPC** — RPC
 *   admin_list_audit_logs (0036 §8) เปิดเฉพาะ staff:viewer + super_admin แต่ permission
 *   audit_log:view ถือโดย citizen/lawyer/instructor/staff:* กว้าง จึงต้องตัดที่ BFF:
 *   ผู้เรียกไม่ใช่ staff:viewer/super_admin = 403 ERR-RBAC-001 ก่อนแตะ DB
 * - rate STAFF_WRITE (§5) — หลัง RBAC + role-scope
 * - query strict-zod (คีย์ camelCase ตามข้อตกลงกับ lane F — action/actor/entityType/
 *   entityId/from/to/cursor/limit):
 *   · action = คำนำหน้ารูปแบบ UPPER_SNAKE (^[A-Za-z][A-Za-z0-9_]{0,63}$ + ไม่มีเลขติดกัน
 *     ≥6 ตัว — ให้ผ่าน audit_free_text_ok ของ DB ทุกกรณี) — prefix match ใน RPC
 *   · actor/entityId = uuid · entityType = ^[a-z][a-z0-9_]{0,63}$ + ไม่มีเลขติดกัน ≥6
 *   · from/to = ISO 8601 (มีโซนเวลา) — พารามิเตอร์ timestamptz ของ RPC
 *   · cursor = ลายเซ็น (§1.2) · limit 1..100 ค่าเริ่มต้น 20
 * - 200 { data, page } — keyset (occurred_at, id) DESC · audit AUDIT_READ fail-closed
 *   หลังอ่านสำเร็จ (context: filters ตรง allowlist 0008 §3.2 + row_count · ล้ม = 503)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditAuditReadFailClosed, listAuditLogsViaRpc, type AuditReadFilters } from "@/lib/admin/users";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import {
  jsonErrorResponse,
  jsonPageOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** เวลา ISO 8601 มีโซนเวลา (ยอม Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** uuid แบบยืดหยุ่นตัวพิมพ์ — ตรง regex ของ DB filters allowlist (0008 §3.2) */
const UuidFlexible = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

/** คำนำหน้า action/entity_type ที่ผ่าน DB ได้ทุกกรณี — ตัวอักษร-ตัวเลข-ขีดล่าง และไม่มีเลขติดกัน ≥6 (license_no pattern ของ audit_free_text_ok) */
function isFreeTextSafeToken(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !/\d{6}/.test(value);
}

/** resource ขาออกของแถว audit (camelCase · strict) — ตรง jsonb ของ RPC (0036 §8) */
const AuditLogResource = z
  .object({
    id: z.uuid(),
    occurredAt: IsoTimestamp,
    actorUserId: z.uuid().nullable(),
    actorRoles: z.array(z.string().min(1)).nullable(),
    action: z.string().min(1),
    entityType: z.string().min(1),
    entityId: z.uuid().nullable(),
    context: z.record(z.string(), z.unknown()),
    requestId: z.string().nullable(),
  })
  .strict();

/** แถวดิบจาก RPC (snake_case) — ตรงตามตัวอักษรของ 0036 §8 */
interface AuditLogDbRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly actor_user_id: string | null;
  readonly actor_roles: readonly string[] | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly context: Record<string, unknown>;
  readonly request_id: string | null;
}

/** แถวดิบ → resource (map ตรง ไม่ fabricate — null คง null) */
function toAuditLogResource(row: AuditLogDbRow): z.output<typeof AuditLogResource> {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    actorRoles: row.actor_roles === null ? null : [...row.actor_roles],
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    context: row.context,
    requestId: row.request_id,
  };
}

/** query — strict (คีย์ camelCase ตามข้อตกลง lane F · ผิดรูป → 400 ERR-VAL-001) */
const AuditListQuerySchema = z
  .object({
    action: z
      .string()
      .refine(isFreeTextSafeToken)
      .optional(),
    actor: UuidFlexible.optional(),
    entityType: z
      .string()
      .refine(isFreeTextSafeToken)
      .optional(),
    entityId: UuidFlexible.optional(),
    from: IsoTimestamp.optional(),
    to: IsoTimestamp.optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/** บทบาทที่เข้าถึง audit ทั้งระบบได้ — ตรง guard ของ RPC admin_list_audit_logs (0036 §8) */
const AUDIT_ROLE_SCOPE: readonly string[] = ["staff:viewer", "super_admin"];

/**
 * BFF role-scope ก่อนถึง RPC — audit_log:view ถือกว้าง (citizen/lawyer/instructor/staff:*
 * ตาม RBAC §2) แต่ RPC เปิดเฉพาะ staff:viewer + super_admin; BFF ต้องตัดก่อน (D-p5-7)
 */
function assertAuditScope(roles: readonly string[]): void {
  if (!roles.some((role) => AUDIT_ROLE_SCOPE.includes(role))) {
    throw new AppError("ERR-RBAC-001", { details: { permission: "audit_log:view" } });
  }
}

/** query → parsed (ค่าว่าง = ไม่ระบุ · ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ credit-rules) */
function parseAuditQuery(searchParams: URLSearchParams): z.output<typeof AuditListQuerySchema> {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  for (const key of Object.keys(raw)) {
    if (raw[key] === "") {
      delete raw[key];
    }
  }
  const parsed = AuditListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : "query";
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return parsed.data;
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — อ่าน audit_logs ฝั่ง admin (200 + keyset page · audit AUDIT_READ fail-closed) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — audit_log:view + BFF role-scope (sv/sa เท่านั้น) ก่อนแตะ RPC
    const { userId, roles } = await requirePermission("audit_log:view");
    assertAuditScope(roles);
    // 2) rate STAFF_WRITE — หลัง RBAC + role-scope
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict + keyset cursor
    const query = parseAuditQuery(new URL(request.url).searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    // 4) RPC ผ่าน user-JWT — role-gate ของ RPC เป็นชั้นที่สอง
    const result = await listAuditLogsViaRpc({
      action: query.action ?? null,
      actor: query.actor ?? null,
      entityType: query.entityType ?? null,
      entityId: query.entityId ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      cursorOccurredAt: cursorPayload?.sortKey ?? null,
      cursorId: cursorPayload?.id ?? null,
      limit: query.limit,
      requestId: options.requestId ?? null,
    });
    // 5) ขาออก strict ทุกแถว (r6-L1) — drift แถวเดียว = 503 ไม่ strip เงียบ
    const resources = result.data.map((row) =>
      parseOutgoingView(
        AuditLogResource,
        toAuditLogResource(row as unknown as AuditLogDbRow),
        "audit_log_row_drift",
      ),
    );
    // 6) audit AUDIT_READ fail-closed หลังอ่านสำเร็จ — filters เก็บเฉพาะคีย์ที่มีจริง
    //    (คีย์ snake_case ตรง allowlist 0008 §3.2 · ล้ม = 503 ไม่คืนผลอ่าน)
    const filters: AuditReadFilters = {
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.actor !== undefined ? { actor_id: query.actor } : {}),
      ...(query.entityType !== undefined ? { entity_type: query.entityType } : {}),
      ...(query.entityId !== undefined ? { entity_id: query.entityId } : {}),
      ...(query.from !== undefined ? { occurred_from: query.from } : {}),
      ...(query.to !== undefined ? { occurred_to: query.to } : {}),
    };
    await auditAuditReadFailClosed({
      filters,
      rowCount: resources.length,
      requestId: options.requestId ?? null,
    });
    // 7) keyset page — nextCursor เซ็นจาก (occurred_at, id) ของแถวสุดท้าย
    const nextCursor =
      result.nextCursor === null
        ? null
        : encodeCursor({ sortKey: result.nextCursor.occurredAt, id: result.nextCursor.id });
    return jsonPageOk(
      {
        data: resources,
        page: { nextCursor, hasMore: result.nextCursor !== null },
      },
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}
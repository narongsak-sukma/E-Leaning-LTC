/**
 * /api/v1/admin/users (Wave E Phase 5 · [#90] D-p5-6 · API-SPECIFICATION §3.7 แถว 210-211)
 *
 * GET — ค้นหา/กรองผู้ใช้ (display_name/email/สถานะ — keyset ผ่าน RPC admin_list_users 0035 §7)
 * - requirePermission("user:view") — staff:viewer / staff:registrar / super_admin (ตรงตาราง §3.7)
 * - rate STAFF_WRITE (§5 — เรียกเองใน handler หลัง RBAC)
 * - query strict-zod: query · status (active/deleted) · limit · cursor (signed) —
 *   ผิดรูป → 400 ERR-VAL-001 (รูปแบบ fields เดียวกับ credit-rules)
 * - 200 { data, page: { nextCursor, hasMore } } — keyset (created_at, id) DESC ใน RPC
 * - audit PII_ACCESS fail-closed ก่อนคืนแถว (retry ครั้งเดียว ยังล้ม = 503 — แบบแผน 1.1.2 B7)
 *
 * POST — สร้างบัญชีเจ้าหน้าที่ (แถว 211 — super_admin เท่านั้น)
 * - body strict: email · displayName · role (instructor|staff:*) · reason (10-500 —
 *   RPC admin_grant_role ของบทบาทเริ่มต้นบังคับเหตุผล) — GoTrue invite + RPC ผ่าน
 *   service lib จุดเดียว (src/lib/admin/users.ts) · 201 { data }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  auditUsersPiiAccessFailClosed,
  createStaffUser,
  listUsersViaRpc,
} from "@/lib/admin/users";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import {
  jsonCreated,
  jsonErrorResponse,
  jsonPageOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** ความยาวคำค้นสูงสุด — ตรงขอบเขตที่ RPC admin_list_users ตรวจ (ERR-VAL-001|query_length) */
const QUERY_MAX_LENGTH = 100;

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** สถานะบัญชีที่กรองได้ — ตรง p_status ของ RPC (active/deleted · ไม่ระบุ = ทุกสถานะ) */
const StatusFilter = z.enum(["active", "deleted"]);

/**
 * ชุดบทบาทเริ่มต้นที่มอบได้ — "สร้างบัญชีเจ้าหน้าที่" ตาม spec แถว 211 · super_admin ไม่อยู่
 * ในชุด (bootstrap เท่านั้น — fail-closed D-p5-5) · citizen/lawyer สมัคร/ยืนยันใบเอง
 */
const STAFF_ROLE_CHOICES = [
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
] as const;

/** resource ขาออกของแถวผู้ใช้ (camelCase · strict) — คอลัมน์ตรง jsonb ของ RPC (0035 §7) */
const AdminUserResource = z
  .object({
    id: z.uuid(),
    displayName: z.string().min(1),
    email: z.email(),
    deletedAt: IsoTimestamp.nullable(),
    createdAt: IsoTimestamp,
    roles: z.array(z.string().min(1)),
    hasVerifiedLicense: z.boolean(),
  })
  .strict();

type AdminUserResourceParsed = z.infer<typeof AdminUserResource>;

/** แถวดิบจาก RPC (row_to_json — snake_case) — ตรงตามตัวอักษรของ 0035 §7 */
interface AdminUserDbRow {
  readonly id: string;
  readonly display_name: string;
  readonly email: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly roles: readonly string[];
  readonly has_verified_license: boolean;
}

/** resource ขาออกของ POST สร้างบัญชี (strict) — ห้าม log email ทุกจุด (D24) */
const StaffUserResource = z
  .object({
    userId: z.uuid(),
    email: z.email(),
    displayName: z.string().min(1),
    role: z.string().min(1),
    granted: z.boolean(),
    invitedAt: IsoTimestamp.nullable(),
  })
  .strict();

/** query ของ GET — strict (key แปลกปลอม → 400 ERR-VAL-001) */
const ListUsersQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(QUERY_MAX_LENGTH).optional(),
    status: StatusFilter.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** query → parsed (ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ credit-rules) */
function parseListQuery(searchParams: URLSearchParams): {
  query?: string | undefined;
  status?: "active" | "deleted" | undefined;
  limit: number;
  cursor?: string | undefined;
} {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  // ค่าว่าง = "ไม่ระบุ" (ฟอร์ม GET ของหน้า admin ส่งช่องว่างเมื่อไม่เลือก) — ตัดก่อน parse
  for (const key of Object.keys(raw)) {
    if (raw[key] === "") {
      delete raw[key];
    }
  }
  const parsed = ListUsersQuerySchema.safeParse(raw);
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

/** แถวดิบ (snake_case) → resource (camelCase) — map ตรง ไม่ fabricate ค่า */
function toAdminUserResource(row: AdminUserDbRow): AdminUserResourceParsed {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    roles: [...row.roles],
    hasVerifiedLicense: row.has_verified_license,
  };
}

/** GET — ค้นหา/กรองผู้ใช้ (200 + keyset page · audit PII_ACCESS fail-closed) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — user:view (sv/sr/sa) — RPC admin_users_staff_guard ตรวจซ้ำชั้นที่สอง
    const { userId } = await requirePermission("user:view");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict — ผิดรูป → 400 ERR-VAL-001
    const query = parseListQuery(new URL(request.url).searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    // 4) RPC ผ่าน user-JWT — guard ของ RPC เป็นชั้นที่สอง
    const result = await listUsersViaRpc({
      query: query.query ?? null,
      status: query.status ?? null,
      cursorCreatedAt: cursorPayload?.sortKey ?? null,
      cursorId: cursorPayload?.id ?? null,
      limit: query.limit,
      requestId: options.requestId ?? null,
    });
    // 5) ขาออก strict ทุกแถว (r6-L1) — drift แถวเดียว = 503 ไม่ strip เงียบ
    const resources = result.data.map((row) =>
      parseOutgoingView(
        AdminUserResource,
        toAdminUserResource(row as unknown as AdminUserDbRow),
        "admin_user_row_drift",
      ),
    );
    // 6) audit PII_ACCESS fail-closed — ก่อนคืนแถว (แบบแผน 1.1.2 B7)
    await auditUsersPiiAccessFailClosed({
      endpoint: "/api/v1/admin/users",
      targetUserId: null,
      purpose: "admin_users_search",
      actorId: userId,
      requestId: options.requestId ?? null,
    });
    // 7) keyset page — nextCursor เซ็น (§1.2) จาก (created_at, id) ของแถวสุดท้าย
    const nextCursor =
      result.nextCursor === null
        ? null
        : encodeCursor({ sortKey: result.nextCursor.createdAt, id: result.nextCursor.id });
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

/** body ของ POST — strict (role ไม่รับ super_admin — bootstrap เท่านั้น D-p5-5) */
const CreateStaffUserBody = z
  .object({
    email: z.email().trim().toLowerCase(),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(STAFF_ROLE_CHOICES),
    // เหตุผล 10-500 — บังคับเพราะ RPC admin_grant_role ของบทบาทเริ่มต้นบังคับ (0035 §6)
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

/** JSON body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parseCreateBody(request: Request): Promise<z.infer<typeof CreateStaffUserBody>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { field: "body" } });
  }
  const parsed = CreateStaffUserBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** POST — สร้างบัญชีเจ้าหน้าที่ (201 · super_admin เท่านั้น) */
export async function POST(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — user:create (super_admin เท่านั้น)
    const { userId } = await requirePermission("user:create");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) body strict — ผิดรูป → 400 ERR-VAL-001
    const body = await parseCreateBody(request);
    // 4) service lib จุดเดียว (D-p5-6): invite GoTrue + grant RPC + audit best-effort
    const created = await createStaffUser({
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      actorId: userId,
      reason: body.reason,
      requestId: options.requestId ?? null,
    });
    // 5) ขาออก strict ก่อนตอบ — drift → 503 ไม่ strip เงียบ (r6-L1)
    const resource = parseOutgoingView(
      StaffUserResource,
      {
        userId: created.userId,
        email: created.email,
        displayName: created.displayName,
        role: created.role,
        granted: created.granted,
        invitedAt: created.invitedAt,
      },
      "staff_user_created_drift",
    );
    return jsonCreated(resource, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

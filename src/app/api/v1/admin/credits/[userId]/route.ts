/**
 * GET /api/v1/admin/credits/{userId} — บัญชีเครดิต (ledger) ของผู้ใช้รายคน
 * (Wave E Phase 3 · Credit Bank · API-SPECIFICATION §3.7 แถว 201 v1.1.0 — เส้นตาม doc
 * คือ /admin/users/{id}/credits แต่กรรมสิทธิ์ไฟล์ของงานนี้กำหนด /admin/credits/[userId])
 *
 * - requirePermission("credit_ledger:view") + role-scope ซ้ำชั้นที่สอง (แบบเดียวกับ
 *   reports/access) — staff:registrar / staff:viewer / super_admin เท่านั้น: permission
 *   credit_ledger:view ถือครองเพิ่มโดย lawyer/instructor (บริบท owner-view ของตนเอง)
 *   ซึ่งไม่อยู่ในตาราง §3.7 ของ endpoint admin นี้ — BFF ต้องเข้มกว่า DB เสมอ
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method)
 * - :userId ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB
 * - query strict-zod: after_created_at/after_id (keyset ตรง — ต้องมาเป็นคู่ ครึ่งเดี่ยว →
 *   400 ERR-VAL-001) · limit (1..100 default 20) · cursor (signed) — รูปแบบเดียวกับ
 *   GET /admin/certificates
 * - แถว credit_ledger_entries ของ userId (join renewal_cycles เอา cycle_no) เรียง
 *   created_at DESC + id tiebreaker · keyset (created_at, id) DESC · cursor signed
 *   (encode/decode ผ่าน lib/api/pagination)
 * - อ่านผ่าน user-JWT client — RLS credits_self_read (0010) เป็นชั้นที่สอง
 * - audit PII_ACCESS fail-closed (API-SPECIFICATION §3.7 v1.1.1) — หลัง query ledger
 *   สำเร็จ เขียน event ทาง service_role (allowlist เปิดอยู่แล้ว: v_keys ของ PII_ACCESS =
 *   endpoint/target_user_id/purpose — context.user_id ถูก RPC lift เป็น actor แล้ว strip)
 *   · RPC ล้ม = retry อีกครั้งเดียว ยังล้ม → WARN กลาง (ไม่มี PII) + 503 ERR-SYS-002 —
 *   ห้ามเปิดเผย ledger โดยไม่มี audit (gate r1 BLOCKER-7)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import { jsonErrorResponse, jsonPageOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { requirePermission, type Role } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** entry_type = enum ledger_entry_type จริงของ DB (0001) — ครบ 4 ค่า */
const LedgerEntryType = z.enum(["accrual", "adjustment", "reversal", "expiry"]);

/** รูปแบบ uuid ของ :userId — ผิดรูป → 400 ก่อนแตะ DB */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * บทบาทที่อ่าน ledger ของผู้อื่นได้ — ตาราง §3.7 แถว 201 (ตรงตัวอักษร) ·
 * lawyer/instructor ถือ credit_ledger:view เฉพาะบริบท owner-view ไม่รวม endpoint admin
 */
const CREDIT_LEDGER_STAFF_ROLES: readonly Role[] = ["staff:registrar", "staff:viewer", "super_admin"];

/** select ของ ledger — join renewal_cycles เอา cycle_no (คอลัมน์แคบตามสัญญา endpoint) */
const LEDGER_SELECT =
  "id,renewal_cycle_id,entry_type,credit_type,amount,source_type,reason,created_by,created_at," +
  "renewal_cycles(cycle_no)";

/** แถวดิบจาก DB — ตรวจชนิดก่อน map (untyped client ตามแบบแผน repo) */
interface LedgerDbRow {
  readonly id: string;
  readonly renewal_cycle_id: string;
  readonly entry_type: "accrual" | "adjustment" | "reversal" | "expiry";
  readonly credit_type: string;
  readonly amount: number;
  readonly source_type: string;
  readonly reason: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly renewal_cycles: { readonly cycle_no: number } | null;
}

/** resource ขาออก (camelCase · strict) — คอลัมน์ตรงตามสัญญา endpoint (ไม่มี PII) */
const LedgerRowResource = z
  .object({
    id: z.string().uuid(),
    cycleNo: z.number().int().min(1),
    entryType: LedgerEntryType,
    creditType: z.string().min(1).max(50),
    amount: z.number(),
    sourceType: z.string().min(1).max(64),
    reason: z.string().nullable(),
    createdBy: z.string().uuid().nullable(),
    createdAt: IsoTimestamp,
  })
  .strict();

type LedgerRowResourceParsed = z.infer<typeof LedgerRowResource>;

/** query ของ GET — strict (key แปลกปลอม → 400 ERR-VAL-001) */
const ListLedgerQuerySchema = z
  .object({
    after_created_at: z.iso.datetime({ offset: true }).optional(),
    after_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/**
 * query → parsed (ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ parsePageQuery §4 #12) ·
 * keyset เป็น "คู่" — ครึ่งเดี่ยวทำ tuple comparison ใน SQL ได้คำตอบว่างเงียบ ๆ ไม่ใช่
 * 400 (gate p1-r1 MINOR-7) จึงตรวจ XOR หลัง parse ก่อนส่งให้ query
 */
function parseListQuery(searchParams: URLSearchParams): {
  afterCreatedAt?: string | undefined;
  afterId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
} {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  // ค่าว่าง = "ไม่ระบุ" (ฟอร์ม GET ของหน้า admin ส่งช่องว่างเมื่อไม่กรอก) — ตัดก่อน parse
  for (const key of Object.keys(raw)) {
    if (raw[key] === "") {
      delete raw[key];
    }
  }
  const parsed = ListLedgerQuerySchema.safeParse(raw);
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
  if ((parsed.data.after_created_at !== undefined) !== (parsed.data.after_id !== undefined)) {
    throw new AppError("ERR-VAL-001", {
      details: { fields: ["after_created_at", "after_id"] },
    });
  }
  return {
    afterCreatedAt: parsed.data.after_created_at,
    afterId: parsed.data.after_id,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  };
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** :userId ผิดรูป uuid → 400 ERR-VAL-001 ก่อนแตะ DB */
function parseUserId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new AppError("ERR-VAL-001", { details: { field: "userId" } });
  }
  return raw;
}

/** แถว DB → resource (map ตรง ไม่ fabricate ค่า) */
function toLedgerRowResource(row: LedgerDbRow): LedgerRowResourceParsed {
  return {
    id: row.id,
    cycleNo: row.renewal_cycles?.cycle_no ?? 0,
    entryType: row.entry_type,
    creditType: row.credit_type,
    amount: row.amount,
    sourceType: row.source_type,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** or-filter เลื่อน cursor แบบ row-wise (created_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  return `created_at.lt.${payload.sortKey},and(created_at.eq.${payload.sortKey},id.lt.${payload.id})`;
}

/**
 * audit PII_ACCESS — fail-closed (gate r1 BLOCKER-7): RPC ล้ม (strict-key reject 22023 /
 * DB ล่ม) = retry อีกครั้งเดียว · ยังล้ม → WARN กลางบรรทัดเดียว (ไม่มี PII) แล้ว throw
 * ERR-SYS-002 (503) — ห้าม disclosure ledger โดยไม่มี audit · context.user_id ถูก RPC
 * ยกเป็น actor แล้ว strip ออกก่อนเก็บ (0008/0019 — 5W "ใคร")
 */
async function auditLedgerPiiAccess(input: {
  readonly targetUserId: string;
  readonly actorId: string;
  readonly requestId: string | null;
}): Promise<void> {
  const service = createSupabaseServiceRoleClient();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await service.rpc("append_audit_event", {
      p_action: "PII_ACCESS",
      p_entity_type: "user",
      p_entity_id: input.targetUserId,
      p_before: null,
      p_after: null,
      p_context: {
        endpoint: "/api/v1/admin/credits/{userId}",
        target_user_id: input.targetUserId,
        purpose: "credit_ledger_view",
        user_id: input.actorId,
      },
      p_actor_roles: null,
      p_ip_hash: null,
      p_user_agent: null,
      p_request_id: input.requestId,
    });
    if (error === null) {
      return;
    }
    lastError = error;
  }
  void lastError; // รายละเอียด DB ห้ามออก log/response (SDS §6.1)
  const logger = createLogger(getConfig().logLevel);
  logger.warn("credit_ledger_pii_audit_rpc_denied", {
    route: "credits:ledger_view",
  });
  throw new AppError("ERR-SYS-002", {
    details: { reason: "credit_ledger_pii_audit_unavailable" },
  });
}

/** GET — บัญชีเครดิตของผู้ใช้รายคน (200 + keyset page) */
export async function GET(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — credit_ledger:view + role-scope ซ้ำชั้นที่สอง (staff เท่านั้น)
    const { userId: actorId, roles } = await requirePermission("credit_ledger:view");
    if (!roles.some((role) => (CREDIT_LEDGER_STAFF_ROLES as readonly string[]).includes(role))) {
      throw new AppError("ERR-RBAC-001", { details: { permission: "credit_ledger:view" } });
    }
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: actorId });
    // 3) :userId ผิดรูป uuid → 400 ก่อนแตะ DB
    const targetUserId = parseUserId((await context.params).userId);
    // 4) query strict — ผิดรูป → 400 ERR-VAL-001
    const query = parseListQuery(new URL(request.url).searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    // 5) อ่านผ่าน user-JWT client — RLS credits_self_read (0010) เป็นชั้นที่สอง
    const supabase = await createSupabaseSsrClient();
    let builder = supabase
      .from("credit_ledger_entries")
      .select(LEDGER_SELECT)
      .eq("user_id", targetUserId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit + 1);
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    } else if (query.afterCreatedAt !== undefined && query.afterId !== undefined) {
      builder = builder.or(cursorFilterOf({ sortKey: query.afterCreatedAt, id: query.afterId }));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "ledger_query_failed" } });
    }
    const rows = (data ?? []) as unknown as readonly LedgerDbRow[];
    // 6) หน้า + ขาออก strict ทุกแถว (r6-L1) — drift แถวเดียว = 503 ไม่ strip เงียบ
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => row.created_at,
      idOf: (row) => row.id,
    });
    // 7) ขาออก strict ทุกแถวก่อน (drift → 503 = ไม่มี disclosure = ไม่เขียน audit)
    const resources = page.data.map((row) =>
      parseOutgoingView(LedgerRowResource, toLedgerRowResource(row), "ledger_row_drift"),
    );
    // 8) audit PII_ACCESS fail-closed — ล้ม = 503 ไม่มี disclosure (ดูหัวไฟล์)
    await auditLedgerPiiAccess({
      targetUserId: targetUserId,
      actorId: actorId,
      requestId: options.requestId ?? null,
    });
    return jsonPageOk(
      {
        data: resources,
        page: page.page,
      },
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

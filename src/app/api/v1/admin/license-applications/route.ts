/**
 * /api/v1/admin/license-applications — GET list (Wave E Phase 5 · API-SPEC §3.8 แถว 228 ·
 * สัญญาแถวตรงหน้า admin ของ lane F: { id, displayName, email|null, licenseNo, status,
 * submittedAt, decidedAt|null, reason|null, evidenceUrl|null })
 *
 * GET — รายการคำขอ (รอตรวจ/ตัดสินแล้ว)
 * - requirePermission("license:verify") — staff:registrar / super_admin
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method — เรียกเองใน handler)
 * - query strict-zod: status (pending/approved/rejected) · limit (1..100 default 20) ·
 *   cursor (signed) — ผิดรูป → 400 ERR-VAL-001
 * - keyset (submitted_at, id) DESC — cursor encode/decode ผ่าน lib/api/pagination
 * - อ่านผ่าน user-JWT — RLS la_read (0010: registrar/super_admin เห็นทุกแถว) เป็นชั้นที่สอง
 * - evidenceUrl = signed URL อายุ 5 นาที ของไฟล์หลักฐานในบักเก็ต private (ลงนามด้วย
 *   user-JWT client — storage policy 0035 ให้ registrar เท่านั้น · ไม่มีไฟล์/ลงนามไม่
 *   สำเร็จ = null — เอนริชเมนต์ ไม่ใช่การเปิดเผยข้อมูล)
 * - audit PII_ACCESS fail-closed (แบบแผน B7 เดียวกับ ledger GET): หลัง strict ขาออกผ่าน
 *   ทุกแถว เขียน event ทาง service_role (retry ครั้งเดียว ยังล้ม = 503 — ห้าม disclosure
 *   โดยไม่มี audit) · context ไม่มี PII (endpoint/purpose/actor เท่านั้น — คีย์อื่นนอก
 *   allowlist {endpoint,target_user_id,purpose} โดน RPC ปฏิเสธ 22023 ตาม AUDIT §3.2)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import { jsonErrorResponse, jsonPageOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { ipHashOf } from "@/lib/auth/password-reset";
import { AdminLicenseApplicationRow } from "@/lib/schemas/license";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { getConfig } from "@/lib/config";
import { requirePermission } from "@/lib/rbac";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { userAgentHashOf } from "@/lib/security/hash";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select + embed (profiles/media_assets ผ่าน FK — แถวใดฝั่ง RLS มองไม่เห็น = null)
 *  ต้องระบุ !fk hint ทุก embed — license_applications มี FK ไป profiles สองเส้น
 *  (user_id + decided_by) จึง ambiguous ใน PostgREST (PGRST201 300 — พิสูจน์กับ
 *  REST จริง: ไม่มี hint โดน 300 ทุกคำขอ = 503 license_applications_query_failed) */
const LICENSE_APPLICATION_SELECT =
  "id,user_id,license_no,status,submitted_at,decided_at,rejected_reason," +
  "profiles!license_applications_user_id_fkey(display_name,email)," +
  "media_assets!license_applications_evidence_media_id_fkey(storage_path)";

/** อายุ signed URL หลักฐาน — 5 นาที (เพียงพอให้ registrar เปิดดูต่อหน้า ไม่ค้างรั่ว) */
const EVIDENCE_URL_TTL_SEC = 300;

/** สถานะ lifecycle ของคำขอ (enum 0001) */
const ApplicationStatus = z.enum(["pending", "approved", "rejected"]);

/** query ของ GET — strict (key แปลกปลอม → 400 ERR-VAL-001) */
const ListApplicationsQuerySchema = z
  .object({
    status: ApplicationStatus.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** query → parsed (ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ parsePageQuery §4 #12) */
function parseListQuery(searchParams: URLSearchParams): {
  status?: "pending" | "approved" | "rejected" | undefined;
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
  const parsed = ListApplicationsQuerySchema.safeParse(raw);
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
  return { status: parsed.data.status, limit: parsed.data.limit, cursor: parsed.data.cursor };
}

function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** or-filter เลื่อน cursor แบบ row-wise (submitted_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  return `submitted_at.lt.${payload.sortKey},and(submitted_at.eq.${payload.sortKey},id.lt.${payload.id})`;
}

/** แถวดิบจาก DB (untyped client — ตรวจชนิดเองก่อนใช้) */
interface ApplicationDbRow {
  readonly id: unknown;
  readonly license_no: unknown;
  readonly status: unknown;
  readonly submitted_at: unknown;
  readonly decided_at: unknown;
  readonly rejected_reason: unknown;
  readonly profiles: unknown;
  readonly media_assets: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** ลงนาม URL หลักฐาน (user-JWT — storage policy 0035 คุม) · ล้มเหลว = null */
async function evidenceUrlOf(
  supabase: Awaited<ReturnType<typeof createSupabaseSsrClient>>,
  row: ApplicationDbRow,
): Promise<string | null> {
  const media = row.media_assets;
  if (media === null || typeof media !== "object") {
    return null;
  }
  const storagePath = asString((media as Record<string, unknown>)["storage_path"]);
  if (storagePath === null) {
    return null;
  }
  try {
    const signed = await supabase.storage.from("license-evidence").createSignedUrl(storagePath, EVIDENCE_URL_TTL_SEC);
    const url = (signed.data as Record<string, unknown> | null)?.["signedUrl"];
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * audit PII_ACCESS — fail-closed (แบบแผน B7 ของ ledger GET): ล้ม = retry อีกครั้งเดียว ·
 * ยังล้ม → WARN กลางบรรทัดเดียว (ไม่มี PII) แล้ว throw ERR-SYS-002 (503) — ห้าม disclosure
 * รายการคำขอโดยไม่มี audit
 */
async function auditApplicationsPiiAccess(input: {
  readonly actorId: string;
  readonly requestId: string | null;
  /** D76: ip_hash จาก request จริง — ipHashOf(clientIpFrom(request)) ของ handler */
  readonly ipHash: string;
  /** D76: user_agent_hash จาก request จริง — null = ไม่มี header user-agent */
  readonly userAgentHash: string | null;
}): Promise<void> {
  const service = createSupabaseServiceRoleClient();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await service.rpc("append_audit_event", {
      p_action: "PII_ACCESS",
      p_entity_type: "license_application",
      p_entity_id: null,
      p_before: null,
      p_after: null,
      // context ⊆ {endpoint, target_user_id, purpose} + user_id (ช่องทาง actor ทางการ
      // ของ service_role — RPC ยกเป็น actor แล้ว strip ก่อนตรวจ strict keys) · เดิมใส่
      // status_filter โดน 22023 "คีย์นอก schema ของ event PII_ACCESS" → 503 ทุกคำขอ
      // (พิสูจน์กับ RPC จริง — ตัวกรองสถานะจึงไม่ลง audit ตาม AUDIT §3.2 แต่ค่ากรอง
      // ปรากฏใน query log ของ BFF/PostgREST อยู่แล้ว)
      p_context: {
        endpoint: "/api/v1/admin/license-applications",
        purpose: "license_applications_list",
        user_id: input.actorId,
      },
      p_actor_roles: null,
      // D76: hash จาก request จริงของ handler — ไม่มี header user-agent = null
      // (ตาม userAgentHashOf — ไม่ hash ค่าว่าง)
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
  const logger = createLogger(getConfig().logLevel);
  logger.warn("license_applications_pii_audit_rpc_denied", {
    route: "license_applications:list",
  });
  throw new AppError("ERR-SYS-002", { details: { reason: "license_applications_pii_audit_unavailable" } });
}

/** GET — รายการคำขอผูกเลขที่ใบอนุญาต (200 + keyset page) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — license:verify (staff:registrar / super_admin)
    const { userId } = await requirePermission("license:verify");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict — ผิดรูป → 400 ERR-VAL-001
    const query = parseListQuery(new URL(request.url).searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    // 4) อ่านผ่าน user-JWT — RLS la_read (0010) เป็นชั้นที่สอง
    const supabase = await createSupabaseSsrClient();
    let builder = supabase
      .from("license_applications")
      .select(LICENSE_APPLICATION_SELECT)
      .order("submitted_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit + 1);
    if (query.status !== undefined) {
      builder = builder.eq("status", query.status);
    }
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "license_applications_query_failed" } });
    }
    const rows = (data ?? []) as unknown as readonly ApplicationDbRow[];
    // 5) หน้า + ขาออก strict ทุกแถว (r6-L1) — drift แถวเดียว = 503 ไม่ strip เงียบ
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => asString(row.submitted_at) ?? "",
      idOf: (row) => asString(row.id) ?? "",
    });
    const resources = await Promise.all(
      page.data.map(async (row) =>
        parseOutgoingView(
          AdminLicenseApplicationRow,
          {
            id: asString(row.id),
            displayName: asString(
              (row.profiles !== null && typeof row.profiles === "object"
                ? (row.profiles as Record<string, unknown>)["display_name"]
                : null),
            ),
            email: asString(
              (row.profiles !== null && typeof row.profiles === "object"
                ? (row.profiles as Record<string, unknown>)["email"]
                : null),
            ),
            licenseNo: asString(row.license_no),
            status: asString(row.status),
            submittedAt: asString(row.submitted_at),
            decidedAt: asString(row.decided_at),
            reason: asString(row.rejected_reason),
            evidenceUrl: await evidenceUrlOf(supabase, row),
          },
          "license_application_row_drift",
        ),
      ),
    );
    // 6) audit PII_ACCESS fail-closed — ล้ม = 503 ไม่มี disclosure (ดูหัวไฟล์) · D76:
    //    hash จาก request จริง (ip_hash + user_agent_hash) — ไม่ส่ง null เหมือนเดิมอีก
    await auditApplicationsPiiAccess({
      actorId: userId,
      requestId: options.requestId ?? null,
      ipHash: ipHashOf(clientIpFrom(request)),
      userAgentHash: userAgentHashOf(request),
    });
    return jsonPageOk({ data: resources, page: page.page }, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

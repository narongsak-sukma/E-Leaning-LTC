/**
 * list — GET /admin/certificates · ทะเบียนใบประกาศนียบัตรที่ออกแล้ว (Wave E · PB-20)
 *
 * - อ่านผ่าน RPC `admin_list_certificates` เดียว (0023 · DCR-7) — keyset (issued_at, id)
 *   DESC ทั้งหมดใน SQL · อ่าน snapshot (holder_name_snapshot/course_title_snapshot) ไม่
 *   live-join · EXECUTE ให้ service_role เท่านั้น — **service_role รวมศูนย์ที่ lib นี้**
 *   (D36-O3 · route ห้าม import service client ตรง)
 * - **role-gate ตรง (D55-2): staff:registrar + super_admin เท่านั้น** — ไม่สร้าง permission
 *   ใหม่ ไม่ยืม certificate:issue (list = การอ่านทะเบียน ไม่ใช่การออกใบ) · ประกอบจาก
 *   helper canonical ของ rbac (loadSessionFromSupabase/loadMyRolesFromDb/requiresMfa) —
 *   MFA fail-closed เหมือน requirePermission (ERR-AUTH-004 เมื่อ aal ≠ aal2)
 * - rate อยู่ที่ route (STAFF_WRITE — กลุ่ม canonical ของ /admin/* ตาม §5 ไม่มีกลุ่ม
 *   STAFF_READ); ขาเข้า/ขาออก strict ทั้งสองชั้น (row drift → ERR-SYS-002)
 * - audit PII_ACCESS **ทุกครั้งที่ list สำเร็จ** (แสดงชื่อผู้ถือใบ — D12-23) — แบบแผน
 *   เดียวกับคิว eligible: context keys ตรง allowlist DB ของ event นี้ (endpoint/purpose
 *   + user_id ที่ RPC ยกเป็น actor — 0008/0019 strict keys) · เขียนไม่สำเร็จ = WARN ไม่
 *   ล้ม read (access event — ไม่ปลอมว่าเขียนสำเร็จ)
 */
import "server-only";
import { z } from "zod";
import { buildPage, decodeCursor, type CursorPayload } from "@/lib/api/pagination";
import { AppError } from "@/lib/errors";
import {
  loadMyRolesFromDb,
  loadSessionFromSupabase,
  requiresMfa,
  type MyRolesFetcher,
  type SessionFetcher,
} from "@/lib/rbac";
import { CertificateStatus } from "@/lib/schemas/v1/certificate";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { appendAuditEvent, dbFailed } from "./shared";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** แถวของ admin_list_certificates (0023 — returns table 9 คอลัมน์ exact · .strict() จับ
 *  คีย์เกิน/คีย์หาย/ค่าผิดชนิด — drift = ERR-SYS-002 ที่ขาเข้า ไม่ใช่ 200 ที่ payload เพี้ยน) */
export const CertificateListRowSchema = z
  .object({
    id: z.string().uuid(),
    cert_no: z.string().min(1),
    verify_code: z.string().min(1),
    status: CertificateStatus,
    issued_at: IsoTimestamp,
    user_id: z.string().uuid(),
    holder_name: z.string(),
    course_id: z.string().uuid(),
    course_title: z.string().min(1),
  })
  .strict();

export type CertificateListRowParsed = z.infer<typeof CertificateListRowSchema>;

/**
 * resource ขาออกของ GET /admin/certificates (CertificateListRow — camelCase แบบเดียวกับ
 * IssuedCertificateResource) · holder_name เป็น z.string() ไม่ .min(1) — เหตุผลเดียวกับ
 * EligibleAttemptResource (r7-M1): ห้ามให้ผู้ถือใบคนเดียวที่ snapshot ว่างทำทั้งหน้า 503
 */
export const CertificateListRowResource = z
  .object({
    id: z.string().uuid(),
    certNo: z.string().min(1),
    verifyCode: z.string().min(1),
    status: CertificateStatus,
    issuedAt: IsoTimestamp,
    userId: z.string().uuid(),
    holderName: z.string(),
    courseId: z.string().uuid(),
    courseTitle: z.string().min(1),
  })
  .strict();

export type CertificateListRow = z.infer<typeof CertificateListRowResource>;

/** บทบาทที่อ่านทะเบียนใบได้ — D55-2 (ตรงตาม API-SPECIFICATION v1.0.4 endpoint นี้) */
export const CERTIFICATE_LIST_ROLES: readonly string[] = ["staff:registrar", "super_admin"];

/** inject loader ของ gate (unit test) — default จาก rbac canonical เหมือน requirePermission */
export interface RequireCertificateRegistryRoleOptions {
  readonly loadSession?: SessionFetcher;
  readonly loadMyRoles?: MyRolesFetcher;
}

export interface RequireCertificateRegistryRoleResult {
  readonly userId: string;
  readonly roles: readonly string[];
}

/**
 * role-gate ตรงของ GET /admin/certificates (D55-2) — staff:registrar/super_admin เท่านั้น
 * ลำดับเดียวกับ requirePermission: ไม่มี session → ERR-AUTH-001 (401) · บทบาทบังคับ MFA
 * แต่ aal ≠ aal2 → ERR-AUTH-004 (403) · บทบาทไม่อยู่ในชุด → ERR-RBAC-001 (403)
 */
export async function requireCertificateRegistryRole(
  options: RequireCertificateRegistryRoleOptions = {},
): Promise<RequireCertificateRegistryRoleResult> {
  const loadSession = options.loadSession ?? loadSessionFromSupabase;
  const session = await loadSession();
  if (session === null) {
    throw new AppError("ERR-AUTH-001");
  }
  const loadMyRoles = options.loadMyRoles ?? loadMyRolesFromDb;
  const roles = await loadMyRoles();
  if (requiresMfa(roles) && session.aal !== "aal2") {
    throw new AppError("ERR-AUTH-004");
  }
  const allowed = CERTIFICATE_LIST_ROLES.some((role) => roles.includes(role));
  if (!allowed) {
    // ไม่มี permission เจาะจงให้อ้าง (D55-2 ห้ามสร้าง/ยืม) — รายงานชุดบทบาทที่ต้องมีแทน
    throw new AppError("ERR-RBAC-001", {
      details: { roles: CERTIFICATE_LIST_ROLES.join(",") },
    });
  }
  return { userId: session.userId, roles };
}

/** query ของ GET /admin/certificates — route parse ขาเข้าแล้ว map snake→camel ให้ lib */
export interface ListCertificatesQuery {
  /** 1..100 (default 20) — canonical PageQuery §4 #12; lib ขอ limit+1 ให้ buildPage
   *  เทียบ hasMore (แบบเดียวกับ eligible — 101 พอดี clamp ของ RPC) */
  readonly limit: number;
  /** signed cursor (encodeCursor แบบเดียวกับ eligible — sortKey = issued_at, id) —
   *  มาก่อน after_* ตรง เสมอ (cursor = HMAC-signed จึงเชื่อถือได้กว่า) */
  readonly cursor?: string | undefined;
  /** keyset ตรง — ใช้เมื่อไม่ส่ง cursor (ตรง p_after_issued_at/p_after_id ของ RPC) */
  readonly afterIssuedAt?: string | undefined;
  readonly afterId?: string | undefined;
  /** เลขที่ใบ — prefix ilike (RPC ต่อ '%' ให้เอง) */
  readonly certNo?: string | undefined;
  /** รหัสตรวจสอบ — ตรงตัว */
  readonly verifyCode?: string | undefined;
  readonly status?: CertificateListRow["status"] | undefined;
  readonly holderUserId?: string | undefined;
  readonly courseId?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface ListCertificatesInput {
  /** actor ผู้อ่านทะเบียน (จาก gate) — ลง audit PII_ACCESS */
  readonly actorId: string;
  readonly query: ListCertificatesQuery;
}

export interface CertificateListPage {
  readonly data: readonly CertificateListRow[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/** แถว RPC ที่ผ่าน CertificateListRowSchema แล้ว → resource — map ตรง ๆ ไม่ fabricate ค่า */
function toCertificateListRow(row: CertificateListRowParsed): CertificateListRow {
  return {
    id: row.id,
    certNo: row.cert_no,
    verifyCode: row.verify_code,
    status: row.status,
    issuedAt: row.issued_at,
    userId: row.user_id,
    holderName: row.holder_name,
    courseId: row.course_id,
    courseTitle: row.course_title,
  };
}

/**
 * ทะเบียนใบจาก RPC `admin_list_certificates` เดียว (0023) — ตัดหน้า/กรอง/keyset ทั้งหมด
 * ใน SQL · BFF ขอ limit+1 แถวให้ buildPage ตัด (แบบเดียวกับ listEligibleAttempts) ·
 * สำเร็จ = เขียน audit PII_ACCESS ทุกครั้งก่อนคืนผล
 */
export async function listCertificates(
  input: ListCertificatesInput,
): Promise<CertificateListPage> {
  const client = createSupabaseServiceRoleClient();
  const query = input.query;
  const cursor: CursorPayload | null =
    query.cursor === undefined || query.cursor === null ? null : decodeCursor(query.cursor);
  const rpc = await client.rpc("admin_list_certificates", {
    p_after_issued_at: cursor?.sortKey ?? query.afterIssuedAt ?? null,
    p_after_id: cursor?.id ?? query.afterId ?? null,
    p_cert_no: query.certNo ?? null,
    p_verify_code: query.verifyCode ?? null,
    p_status: query.status ?? null,
    p_holder_user_id: query.holderUserId ?? null,
    p_course_id: query.courseId ?? null,
    p_limit: query.limit + 1,
  });
  if (rpc.error !== null) {
    throw dbFailed("cert_list_query_failed");
  }
  // ตามแบบแผน r7-M2 ของ eligible — container ต้องเป็น array จริง (null/object = drift)
  if (!Array.isArray(rpc.data)) {
    throw dbFailed("cert_list_rows_not_array");
  }
  const rows = rpc.data.map((raw) => {
    const parsed = CertificateListRowSchema.safeParse(raw);
    if (!parsed.success) {
      throw dbFailed("cert_list_row_drift");
    }
    return parsed.data;
  });
  const built = buildPage({
    rows,
    limit: query.limit,
    sortKeyOf: (row) => row.issued_at,
    idOf: (row) => row.id,
  });
  // audit PII_ACCESS ทุกครั้งที่ list สำเร็จ — คีย์ context ตรง allowlist DB ของ event
  // (endpoint/target_user_id/purpose — 0008/0019 strict keys; user_id ถูก RPC ยกเป็น
  // actor แล้ว strip ออกก่อนเก็บ) · entityId = id แถวแรกของหน้า (null เมื่อหน้าว่าง —
  // ไม่ใส่ค่าปลอม) · เขียนไม่สำเร็จ = WARN ใน appendAuditEvent ไม่ล้ม read (แบบ eligible)
  await appendAuditEvent(client, {
    action: "PII_ACCESS",
    entityType: "certificate",
    entityId: built.data[0]?.id ?? null,
    context: {
      endpoint: "/api/v1/admin/certificates",
      purpose: "certificate_registry_view",
      user_id: input.actorId,
    },
    actorId: input.actorId,
    requestId: input.query.requestId ?? null,
  });
  return {
    data: built.data.map(toCertificateListRow),
    page: built.page,
  };
}

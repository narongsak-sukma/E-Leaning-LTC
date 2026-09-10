/**
 * issue — ออกประกาศนียบัตร (Wave D — D-4 · SDS §3.4a · 0019-r1)
 *
 * **service_role รวมศูนย์ที่ src/lib/certificates/** (D36-O3)** — route เรียกฟังก์ชัน
 * ของ lib เท่านั้น (ห้าม import service client ตรง)
 *
 * 0019-r1 (gate r1 B2/B7/B8):
 * - การออกใบย้ายไป RPC `admin_issue_certificate` เดียว (cert_issue_core ภายใน):
 *   ตรวจ enrollment completed + ใบ valid ซ้ำ + attempt ผ่าน + snapshot ชื่อ + สุ่ม
 *   cert_no/verify_code (CSPRNG ฝั่ง DB · retry ≤5 เมื่อชน UNIQUE) + INSERT +
 *   **audit CERT_ISSUE ใน TX เดียว** (audit ล้ม = rollback ไม่มีใบที่ไร้ audit — D12-8)
 *   BFF เหลือ PDF pipeline หลัง RPC (render + upload + media_assets + pdf_media_id) —
 *   พัง = คงใบ pdf_media_id null + WARN ตามทางเลือก D36-O6 (reissue ได้ภายหลัง)
 * - คิว eligible (endpoint 82): สแกนแบบ chunk — ดึงทีละก้อนเรียง (submitted_at,id) desc
 *   แล้ว **ตัด "ออกใบแล้ว" ก่อนตัดหน้า** (B8: แบบเดิม limit ก่อน filter ทำให้หน้าแรก
 *   ว่างเปล่าทั้งที่ยังมีผู้มีสิทธิ์เก่ากว่า) สะสมจนได้เกิน limit หรือคิวหมด
 *
 * ธง: credit_snapshot เป็น null เสมอ — service_role มี INSERT เท่านั้นบน
 * credit_ledger_entries (0010:821-826 ไม่มี SELECT) จึงอ่านยอดไม่ได้ (ห้ามเดา)
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPage, decodeCursor, type CursorPayload } from "@/lib/api/pagination";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { renderCertificatePdf } from "./pdf";
import {
  CERTIFICATE_BUCKET,
  certLogger,
  certRpcError,
  dbFailed,
  holderNameOf,
  rowNumberOrNull,
  rowString,
  type Row,
} from "./shared";

/** ข้อมูลที่ต้องระบุเพื่อออกใบ — actorId มาจาก requirePermission ที่ route ตรวจแล้ว */
export interface IssueCertificateInput {
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly requestId?: string | null;
}

/** ใบที่ออกแล้ว — คืนแบบแคบ (ไม่มีข้อมูลที่ไม่ได้เก็บจริง) */
export interface IssuedCertificate {
  readonly id: string;
  readonly certNo: string;
  readonly verifyCode: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderNameSnapshot: string;
  readonly courseTitleSnapshot: string;
  readonly creditSnapshot: number | null;
  readonly status: "valid";
  readonly issuedAt: string;
  readonly pdfMediaId: string | null;
}

/**
 * jsonb ที่ cert_issue_core คืน (ผ่าน admin_issue/admin_reissue_certificate) —
 * ตรวจชนิดก่อนใช้ fail-closed เหมือนแถวตารางอื่น (ชนิดไม่ตรง = สัญญา DB เพี้ยน)
 */
export interface CertCoreRow {
  readonly id: string;
  readonly certNo: string;
  readonly verifyCode: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderName: string;
  readonly courseTitle: string;
  readonly issuedAt: string;
}

/** RPC jsonb → CertCoreRow (PostgREST อาจ wrap scalar เป็น array — รองรับทั้งสองรูป) */
export function parseCertCore(data: unknown): CertCoreRow {
  const row = (Array.isArray(data) ? data[0] : data) as Row | null;
  if (row === null) {
    throw dbFailed("cert_rpc_contract_mismatch");
  }
  return {
    id: rowString(row, "id"),
    certNo: rowString(row, "cert_no"),
    verifyCode: rowString(row, "verify_code"),
    enrollmentId: rowString(row, "enrollment_id"),
    userId: rowString(row, "user_id"),
    courseId: rowString(row, "course_id"),
    holderName: rowString(row, "holder_name"),
    courseTitle: rowString(row, "course_title"),
    issuedAt: rowString(row, "issued_at"),
  };
}

/** ใบที่ RPC ออกแล้ว → resource ของ BFF (creditSnapshot ยัง null — 0010:825 INSERT-only) */
export function toIssuedCertificate(core: CertCoreRow): IssuedCertificate {
  return {
    id: core.id,
    certNo: core.certNo,
    verifyCode: core.verifyCode,
    enrollmentId: core.enrollmentId,
    userId: core.userId,
    courseId: core.courseId,
    holderNameSnapshot: core.holderName,
    courseTitleSnapshot: core.courseTitle,
    creditSnapshot: null,
    status: "valid",
    issuedAt: core.issuedAt,
    pdfMediaId: null,
  };
}

/**
 * PDF + Storage + media_assets + ผูก pdf_media_id — ใช้ร่วม issue/reissue (0019-r1 แยก
 * ออกจาก issueCertificate เดิม) — **พังทุกกระแง = คงใบ + คืน null + WARN** ไม่ throw
 * (ทางเลือก D36-O6: ใบยัง verify ได้ แก้ไขได้ด้วย reissue ภายหลัง)
 */
export async function attachCertificatePdf(
  client: SupabaseClient,
  core: CertCoreRow,
  actorId: string,
): Promise<string | null> {
  let pdfMediaId: string | null = null;
  try {
    const pdfBytes = await renderCertificatePdf({
      certNo: core.certNo,
      verifyCode: core.verifyCode,
      holderName: core.holderName,
      courseTitle: core.courseTitle,
      issuedAt: new Date(core.issuedAt),
    });
    const storagePath = `${CERTIFICATE_BUCKET}-pdf/${core.certNo}.pdf`;
    const uploadRes = await client.storage
      .from(CERTIFICATE_BUCKET)
      .upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: false });
    if (uploadRes.error !== null) {
      certLogger.warn("certificate_pdf_upload_failed", {
        route: "certificates:issue",
        user_id: actorId,
      });
      return null;
    }
    const mediaRes = await client
      .from("media_assets")
      .insert({
        provider: "supabase_storage",
        media_type: "document",
        bucket: CERTIFICATE_BUCKET,
        storage_path: storagePath,
        mime_type: "application/pdf",
        size_bytes: pdfBytes.byteLength,
        status: "ready",
        uploaded_by: actorId,
      })
      .select("id")
      .single();
    if (mediaRes.error !== null) {
      certLogger.warn("certificate_media_insert_failed", {
        route: "certificates:issue",
        user_id: actorId,
      });
      return null;
    }
    pdfMediaId = rowString(mediaRes.data as Row, "id");
    const updateRes = await client
      .from("certificates")
      .update({ pdf_media_id: pdfMediaId })
      .eq("id", core.id);
    if (updateRes.error !== null) {
      certLogger.warn("certificate_pdf_link_update_failed", {
        route: "certificates:issue",
        user_id: actorId,
      });
      return null;
    }
    return pdfMediaId;
  } catch {
    // เรนเดอร์/อัปโหลดล้มเหลว — คงใบไว้แบบไม่มี PDF (ทางเลือก D36-O6)
    certLogger.warn("certificate_pdf_render_failed", {
      route: "certificates:issue",
      user_id: actorId,
    });
    return null;
  }
}

/**
 * ออกประกาศนียบัตรจาก enrollment — สิทธิ์ actor อยู่ที่ route (requirePermission)
 * แล้ว ที่นี่คือ RPC mutation+audit + PDF pipeline ล้วน
 */
export async function issueCertificate(input: IssueCertificateInput): Promise<IssuedCertificate> {
  const client = createSupabaseServiceRoleClient();
  // 1) mutation + audit atomic ใน RPC เดียว (0019-r1): ตรวจ enrollment/attempt/ซ้ำ +
  //    snapshot + สุ่มรหัส + INSERT + CERT_ISSUE — error มีป้าย (ERR-XXX-NNN|reason)
  const rpc = await client.rpc("admin_issue_certificate", {
    p_actor_user_id: input.actorId,
    p_enrollment_id: input.enrollmentId,
    p_request_id: input.requestId ?? null,
  });
  if (rpc.error !== null) {
    throw certRpcError(rpc.error, "cert_issue_rpc_failed");
  }
  const core = parseCertCore(rpc.data);
  // 2) PDF pipeline ฝั่ง TS หลัง RPC — พัง = คงใบ (pdf_media_id null) ตาม D36-O6
  const pdfMediaId = await attachCertificatePdf(client, core, input.actorId);
  return { ...toIssuedCertificate(core), pdfMediaId };
}

/** select ของคิวงาน (eligible) — embed profiles/enrollments + คอลัมน์แคบ (SDS §5.2) */
const ELIGIBLE_SELECT =
  "id,enrollment_id,user_id,score_pct,submitted_at,attempt_no," +
  "profiles!inner(first_name,last_name,display_name)," +
  "enrollments!inner(course_id,status,deleted_at)";

/**
 * คิวงานออกประกาศนียบัตร (API-SPECIFICATION endpoint 82 · SDS §3.4a · D12-23) —
 * attempt ผ่านเกณฑ์ + enrollment completed + ยังไม่มีใบ valid ของ enrollment นั้น
 * (filter "ยังไม่มีใบ valid" เป็น anti-join ใน JS เพราะ PostgREST ไม่มี NOT EXISTS)
 */
export interface EligibleAttempt {
  readonly attemptId: string;
  readonly enrollmentId: string;
  readonly userId: string;
  readonly courseId: string;
  readonly holderName: string;
  readonly scorePct: number | null;
  readonly submittedAt: string;
}

export interface EligibleQuery {
  readonly limit: number;
  readonly cursor?: string | null;
  readonly courseId?: string | null;
  readonly requestId?: string | null;
}

export interface EligiblePage {
  readonly data: readonly EligibleAttempt[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/** ขนาด chunk ของการสแกนคิว (ไม่ใช่ขนาดหน้า — หน้าคือ query.limit) */
const ELIGIBLE_CHUNK_SIZE = 200;

/** เพดาน chunk ต่อคำขอ — กันการไล่คิวไม่รู้จบ (200 × 50 = 10,000 แถวต่อคำขอ) */
const MAX_ELIGIBLE_CHUNKS = 50;

/**
 * สแกนคิวเป็น chunk เรียง (submitted_at,id) desc: ตัด "ออกใบแล้ว" ของทุกแถวใน chunk
 * ก่อนสะสม (gate r1 B8 — exclusion ต้องมาก่อนการตัดหน้า) หยุดเมื่อสะสมเกิน limit
 * (ได้ extra row สำหรับ hasMore ของ buildPage) หรือคิวหมด · cursor เลื่อนไปหลัง
 * แถวสุดท้ายของ chunk (รวมแถวที่ถูกตัด — ไม่มีทางวนซ้ำ)
 */
export async function listEligibleAttempts(query: EligibleQuery): Promise<EligiblePage> {
  const client = createSupabaseServiceRoleClient();
  const collected: Row[] = [];
  let cursor: CursorPayload | null =
    query.cursor === undefined || query.cursor === null ? null : decodeCursor(query.cursor);
  for (
    let chunk = 0;
    chunk < MAX_ELIGIBLE_CHUNKS && collected.length <= query.limit;
    chunk += 1
  ) {
    let builder = client
      .from("assessment_attempts")
      .select(ELIGIBLE_SELECT)
      .eq("passed", true)
      .eq("status", "passed")
      .not("submitted_at", "is", null)
      .eq("enrollments.status", "completed")
      .filter("enrollments.deleted_at", "is", null)
      .not("enrollments.completed_at", "is", null)
      .order("submitted_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(ELIGIBLE_CHUNK_SIZE);
    if (query.courseId !== undefined && query.courseId !== null) {
      builder = builder.eq("enrollments.course_id", query.courseId);
    }
    if (cursor !== null) {
      builder = builder.or(cursorFilter(cursor));
    }
    const res = await builder;
    if (res.error !== null) {
      throw dbFailed("cert_eligible_query_failed");
    }
    const rows = (res.data ?? []) as unknown as Row[];
    if (rows.length === 0) {
      break; // คิวหมด
    }
    // anti-join ใบ valid ที่มีอยู่ (คอลัมน์เดียว) — ตัดรายการที่ออกใบแล้วก่อนสะสม
    const issuedEnrollmentIds = await fetchValidCertEnrollmentIds(
      client,
      rows.map((row) => rowString(row, "enrollment_id")),
    );
    for (const row of rows) {
      if (!issuedEnrollmentIds.has(rowString(row, "enrollment_id"))) {
        collected.push(row);
      }
    }
    if (rows.length < ELIGIBLE_CHUNK_SIZE) {
      break; // อ่านครบทั้งคิวแล้ว — ไม่มีแถวถัดไป
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      break;
    }
    cursor = { sortKey: rowString(last, "submitted_at"), id: rowString(last, "id") };
  }
  const built = buildPage({
    rows: collected,
    limit: query.limit,
    sortKeyOf: (row) => rowString(row, "submitted_at"),
    idOf: (row) => rowString(row, "id"),
  });
  return {
    data: built.data.map(toEligibleAttempt),
    page: built.page,
  };
}

/** ids ของ enrollment ที่มีใบ valid อยู่แล้ว (คอลัมน์เดียว — SELECT แคบ) */
async function fetchValidCertEnrollmentIds(
  client: SupabaseClient,
  enrollmentIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(enrollmentIds)];
  if (ids.length === 0) {
    return new Set();
  }
  const res = await client
    .from("certificates")
    .select("enrollment_id")
    .in("enrollment_id", ids)
    .eq("status", "valid");
  if (res.error !== null) {
    throw dbFailed("cert_eligible_validcert_lookup_failed");
  }
  return new Set((res.data ?? []).map((row) => rowString(row as Row, "enrollment_id")));
}

/** แถว attempt → resource ของคิวงาน (ชื่อจาก snapshot ณ วันออกของข้อมูลปัจจุบัน) */
function toEligibleAttempt(row: Row): EligibleAttempt {
  const profile = row["profiles"] as Row | null;
  const enrollmentRow = row["enrollments"] as Row | null;
  if (profile === null || enrollmentRow === null) {
    throw dbFailed("cert_eligible_embed_missing");
  }
  return {
    attemptId: rowString(row, "id"),
    enrollmentId: rowString(row, "enrollment_id"),
    userId: rowString(row, "user_id"),
    courseId: rowString(enrollmentRow, "course_id"),
    holderName: holderNameOf(profile),
    scorePct: rowNumberOrNull(row, "score_pct"),
    submittedAt: rowString(row, "submitted_at"),
  };
}

/** or-filter เลื่อน cursor แบบ row-wise (submitted_at, id) < (sortKey, id) — เรียง DESC */
function cursorFilter(payload: CursorPayload): string {
  return `submitted_at.lt.${payload.sortKey},and(submitted_at.eq.${payload.sortKey},id.lt.${payload.id})`;
}

/**
 * issue — ออกประกาศนียบัตร (Wave D — D-4 · SDS §3.4a)
 *
 * **service_role รวมศูนย์ที่ src/lib/certificates/** (D36-O3)** — ทุก query ใช้
 * createSupabaseServiceRoleClient แบบ SELECT คอลัมน์แคบ + เหตุผลกำกับทุกจุด (SDS §5.2);
 * route เรียกฟังก์ชันของ lib เท่านั้น (ห้าม import service client ตรง)
 *
 * ลำดับงาน (ไม่มี RPC cert โดยเจตนา — D36-O3):
 * 1) หา enrollment ต้อง completed + ไม่ soft-delete · 2) กันซ้ำด้วยการอ่านใบ valid ที่มีอยู่
 * (DB กันซ้ำจริงด้วย partial UNIQUE(enrollment_id) WHERE status='valid' — 0006) ·
 * 3) หา attempt ที่ผ่าน (passed=true + status='passed' — enum จริงของ 0001:118; grading ทันที
 * ตาม DCR-4 ทำให้ 'passed' คือสถานะจบจริงที่ผ่าน) · 4) snapshot ชื่อ/ชื่อหลักสูตรณวันออก ·
 * 5) INSERT ใบ (cert_no/verify_code สุ่ม CSPRNG + retry ≤5 เมื่อชน UNIQUE 23505) ·
 * 6) เรนเดอร์ PDF + upload Storage + ผูก pdf_media_id (พัง = คงใบ pdf_media_id null + WARN —
 * ทางเลือกที่เลือกตามใบงาน: reissue ได้ภายหลัง) · 7) audit CERT_ISSUE
 *
 * ธง: credit_snapshot เป็น null เสมอ — service_role มี INSERT เท่านั้นบน credit_ledger_entries
 * (0010:821-826 ไม่มี SELECT) และไม่มี RPC อ่าน credit ราย attempt จึงอ่านยอดไม่ได้ (ห้ามเดา)
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors";
import { buildPage, decodeCursor, type CursorPayload } from "@/lib/api/pagination";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { renderCertificatePdf } from "./pdf";
import {
  appendAuditEvent,
  CERTIFICATE_BUCKET,
  certLogger,
  dbFailed,
  generateCertNo,
  generateVerifyCode,
  holderNameOf,
  isUniqueViolation,
  MAX_CODE_ATTEMPTS,
  rowNumberOrNull,
  rowString,
  type Row,
} from "./shared";

/** จำนวนรอบสุ่มรหัสสูงสุด — เกิน = สถานการณ์ผิดปกติของระบบ (ERR-SYS-001) */

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

/** select ของคิวงาน (eligible) — embed profiles/enrollments + คอลัมน์แคบ (SDS §5.2) */
const ELIGIBLE_SELECT =
  "id,enrollment_id,user_id,score_pct,submitted_at,attempt_no," +
  "profiles!inner(first_name,last_name,display_name)," +
  "enrollments!inner(course_id,status,deleted_at)";

/**
 * คิวงานออกประกาศนียบัตร (API-SPECIFICATION endpoint 82 · SDS §3.4a · D12-23) —
 * attempt ผ่านเกณฑ์ + enrollment completed + ยังไม่มีใบ valid ของ enrollment นั้น
 * (filter "ยังไม่มีใบ valid" ทำเป็น anti-join ใน JS เพราะ PostgREST ไม่มี NOT EXISTS)
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

export async function listEligibleAttempts(query: EligibleQuery): Promise<EligiblePage> {
  const client = createSupabaseServiceRoleClient();
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
    .limit(query.limit + 1);
  if (query.courseId !== undefined && query.courseId !== null) {
    builder = builder.eq("enrollments.course_id", query.courseId);
  }
  if (query.cursor !== undefined && query.cursor !== null) {
    const cursorPayload = decodeCursor(query.cursor);
    builder = builder.or(cursorFilter(cursorPayload));
  }
  const res = await builder;
  if (res.error !== null) {
    throw dbFailed("cert_eligible_query_failed");
  }
  const rows = (res.data ?? []) as unknown as Row[];
  // anti-join ใบ valid ที่มีอยู่ (คอลัมน์เดียว) — ตัดรายการที่ออกใบแล้วออกจากคิว
  const issuedEnrollmentIds = await fetchValidCertEnrollmentIds(
    client,
    rows.map((row) => rowString(row, "enrollment_id")),
  );
  const eligible = rows.filter(
    (row) => !issuedEnrollmentIds.has(rowString(row, "enrollment_id")),
  );
  const built = buildPage({
    rows: eligible,
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

/**
 * ออกประกาศนียบัตรจาก enrollment ที่จบหลักสูตรและมี attempt ที่ผ่าน —
 * ตรวจสิทธิ์ actor อยู่ที่ route (requirePermission) แล้ว ที่นี่เป็นส่วน DB/PDF/audit ล้วน
 */
export async function issueCertificate(input: IssueCertificateInput): Promise<IssuedCertificate> {
  const client = createSupabaseServiceRoleClient();
  // 1) enrollment — ต้อง completed + ไม่ soft-delete (SDS §3.4a)
  const enrollmentRes = await client
    .from("enrollments")
    .select("id,user_id,course_id,status,completed_at,deleted_at")
    .eq("id", input.enrollmentId)
    .maybeSingle();
  if (enrollmentRes.error !== null) {
    throw dbFailed("cert_enrollment_lookup_failed");
  }
  const enrollment = enrollmentRes.data as Row | null;
  if (enrollment === null) {
    throw new AppError("ERR-NF-001", { details: { field: "enrollmentId" } });
  }
  if (rowString(enrollment, "status") !== "completed" || enrollment["deleted_at"] != null) {
    throw new AppError("ERR-VAL-001", {
      details: { field: "enrollmentId", reason: "enrollment_not_completed" },
    });
  }

  // 2) กันออกซ้ำ — ใบ valid ที่มีอยู่ (DB กันซ้ำจริงด้วย partial UNIQUE ที่ 0006)
  const existingRes = await client
    .from("certificates")
    .select("id")
    .eq("enrollment_id", input.enrollmentId)
    .eq("status", "valid")
    .maybeSingle();
  if (existingRes.error !== null) {
    throw dbFailed("cert_existing_lookup_failed");
  }
  if (existingRes.data !== null) {
    throw new AppError("ERR-VAL-001", {
      details: { field: "enrollmentId", reason: "valid_certificate_exists" },
    });
  }

  // 3) attempt ที่ผ่าน (best = attempt_no สูงสุด) — เงื่อนไข eligible ตาม SDS §3.4a
  const attemptRes = await client
    .from("assessment_attempts")
    .select("id,score_pct,attempt_no")
    .eq("enrollment_id", input.enrollmentId)
    .eq("passed", true)
    .eq("status", "passed")
    .not("submitted_at", "is", null)
    .order("attempt_no", { ascending: false })
    .limit(1);
  if (attemptRes.error !== null) {
    throw dbFailed("cert_attempt_lookup_failed");
  }
  const attempt = (attemptRes.data as Row[] | null)?.[0] as Row | undefined;
  if (attempt === undefined) {
    throw new AppError("ERR-VAL-001", {
      details: { field: "enrollmentId", reason: "no_passed_attempt" },
    });
  }
  // 4) snapshot ณ วันออก — ชื่อจาก first/last แล้ว fallback display_name (SDS §3.4a)
  const profileRes = await client
    .from("profiles")
    .select("display_name,first_name,last_name")
    .eq("id", rowString(enrollment, "user_id"))
    .maybeSingle();
  if (profileRes.error !== null || profileRes.data === null) {
    throw dbFailed("cert_profile_lookup_failed");
  }
  const holderName = holderNameOf(profileRes.data as Row);

  const courseRes = await client
    .from("courses")
    .select("title_th")
    .eq("id", rowString(enrollment, "course_id"))
    .maybeSingle();
  if (courseRes.error !== null || courseRes.data === null) {
    throw dbFailed("cert_course_lookup_failed");
  }
  const courseTitle = rowString(courseRes.data as Row, "title_th");

  // 5) INSERT ใบ — สุ่มรหัสใหม่ทุกรอบเมื่อชน UNIQUE (23505) แล้ว retry ≤5 รอบ
  const issuedAt = new Date();
  let inserted: Row | null = null;
  for (let round = 1; round <= MAX_CODE_ATTEMPTS; round += 1) {
    const certNo = generateCertNo(issuedAt);
    const verifyCode = generateVerifyCode();
    const insertRes = await client
      .from("certificates")
      .insert({
        cert_no: certNo,
        verify_code: verifyCode,
        enrollment_id: rowString(enrollment, "id"),
        user_id: rowString(enrollment, "user_id"),
        course_id: rowString(enrollment, "course_id"),
        holder_name_snapshot: holderName,
        course_title_snapshot: courseTitle,
        credit_snapshot: null, // ธง: อ่าน credit_ledger_entries ไม่ได้ (0010:825 INSERT เท่านั้น)
        issued_by: input.actorId,
        status: "valid",
      })
      .select("id,cert_no,verify_code,issued_at")
      .single();
    if (insertRes.error === null) {
      inserted = insertRes.data as Row;
      break;
    }
    if (!isUniqueViolation(insertRes.error)) {
      throw dbFailed("cert_insert_failed");
    }
  }
  if (inserted === null) {
    throw new AppError("ERR-SYS-001", { details: { reason: "cert_code_retry_exhausted" } });
  }

  // 6) PDF + Storage — พังทุกกระแง = คงใบ + pdf_media_id null + WARN (ไม่มี PII — allowlist logger)
  let pdfMediaId: string | null = null;
  try {
    const pdfBytes = await renderCertificatePdf({
      certNo: rowString(inserted, "cert_no"),
      verifyCode: rowString(inserted, "verify_code"),
      holderName,
      courseTitle,
      issuedAt: new Date(rowString(inserted, "issued_at")),
    });
    const storagePath = `${CERTIFICATE_BUCKET}-pdf/${rowString(inserted, "cert_no")}.pdf`;
    const uploadRes = await client.storage
      .from(CERTIFICATE_BUCKET)
      .upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: false });
    if (uploadRes.error !== null) {
      certLogger.warn("certificate_pdf_upload_failed", {
        route: "certificates:issue",
        ...(input.actorId === undefined ? {} : { user_id: input.actorId }),
      });
    } else {
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
          uploaded_by: input.actorId,
        })
        .select("id")
        .single();
      if (mediaRes.error !== null) {
        certLogger.warn("certificate_media_insert_failed", {
          route: "certificates:issue",
          ...(input.actorId === undefined ? {} : { user_id: input.actorId }),
        });
      } else {
        pdfMediaId = rowString(mediaRes.data as Row, "id");
        const updateRes = await client
          .from("certificates")
          .update({ pdf_media_id: pdfMediaId })
          .eq("id", rowString(inserted, "id"));
        if (updateRes.error !== null) {
          pdfMediaId = null;
          certLogger.warn("certificate_pdf_link_update_failed", {
            route: "certificates:issue",
            ...(input.actorId === undefined ? {} : { user_id: input.actorId }),
          });
        }
      }
    }
  } catch {
    // เรนเดอร์/อัปโหลดล้มเหลว — คงใบไว้แบบไม่มี PDF (ธง: ทางเลือกที่เลือกตามใบงาน)
    pdfMediaId = null;
    certLogger.warn("certificate_pdf_render_failed", {
      route: "certificates:issue",
      ...(input.actorId === undefined ? {} : { user_id: input.actorId }),
    });
  }

  // 7) audit CERT_ISSUE — context ตาม AUDIT §2.1 (certificate_id = entity_id · code · attempt_id ·
  //    ผู้ออก) + `user_id` = actor ผู้ออกใบ (0008:476-486 service_role ยก context.user_id เป็น
  //    actor_user_id ก่อน strict-keys — ไม่ส่ง = actor หายจากแถว audit)
  await appendAuditEvent(client, {
    action: "CERT_ISSUE",
    entityType: "certificate",
    entityId: rowString(inserted, "id"),
    context: {
      code: rowString(inserted, "cert_no"),
      attempt_id: rowString(attempt, "id"),
      enrollment_id: rowString(enrollment, "id"),
      user_id: input.actorId,
    },
    actorId: input.actorId,
    requestId: input.requestId ?? null,
  });

  return {
    id: rowString(inserted, "id"),
    certNo: rowString(inserted, "cert_no"),
    verifyCode: rowString(inserted, "verify_code"),
    enrollmentId: rowString(enrollment, "id"),
    userId: rowString(enrollment, "user_id"),
    courseId: rowString(enrollment, "course_id"),
    holderNameSnapshot: holderName,
    courseTitleSnapshot: courseTitle,
    creditSnapshot: null,
    status: "valid",
    issuedAt: rowString(inserted, "issued_at"),
    pdfMediaId,
  };
}

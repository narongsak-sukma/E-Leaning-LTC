/**
 * export — แกน worker ส่งออกข้อมูลส่วนบุคคล PDPA (IDENT-008/SEC-011 · D-p5-7 · #90)
 *
 * จุดเดียวของระบบที่ "ประกอบไฟล์ export จริง" — เรียกโดย
 * /api/internal/jobs/pdpa-export (แบบแผน email-dispatch · dev = mailer loop 30 วิ ·
 * prod = Vercel Cron):
 *
 * 1) claim: RPC `claim_data_export_job()` (service client — ตาราง data_export_jobs
 *    REVOKE write ตรงจากทุกบทบาท JWT ตาม 0036 — path เดียวคือ RPC) คืน
 *    {jobId, userId, claimToken} หรือ {jobId: null} เมื่อคิวว่าง (FOR UPDATE SKIP
 *    LOCKED) · claimToken = ตัวปิดกั้น worker เก่า (gate p5-r2 M1 — complete/fail
 *    ผูกกับรอบการถือครอง lease ปัจจุบันเท่านั้น)
 * 2) compose: อ่านข้อมูลของเจ้าของครบทุกก้อน (9 chunks — profiles+roles, consents,
 *    enrollments, lesson_progress, quiz_attempts, assessment_attempts, certificates,
 *    credit ledger, notifications) ด้วย service client จุดเดียวของไฟล์นี้
 * 3) upload: JSON ก้อนเดียว → bucket ส่วนตัว `pdpa-exports`
 *    object key ในบักเก็ต = `{user_id}/{job_id}.json` ขณะที่ media_assets.
 *    storage_path เก็บ path เต็ม `pdpa-exports/{user_id}/{job_id}.json` (bucket
 *    private — ดาวน์โหลดผ่าน signed URL อายุ 7 วันที่ email worker ลงนามตอนส่ง)
 * 4) media_assets INSERT (status ready · uploaded_by = เจ้าของข้อมูล) → RPC
 *    `complete_data_export_job(job, media, chunks, request_id, claim_token)` — audit
 *    DATA_EXPORT_DONE + event `data_export.ready` เกิดใน TX เดียวของ RPC (0036)
 * 5) ทุกทางล้มเหลว → RPC `fail_data_export_job` ด้วยข้อความ static ไม่มี PII
 *    (left(error,500) ที่ฝั่ง SQL ตัดอีกชั้น) — ห้าม throw ทิ้งคิว
 *
 * กติกา log (D24/SDS §6.2): ห้าม log signed URL / เนื้อหาไฟล์ / ข้อมูลส่วนบุคคล —
 * log เฉพาะ user_id + รหัสสถานะ static
 */
import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

/** bucket ส่วนตัวของไฟล์ export (D-p5-7 · DD §3.1 data_export_jobs) */
export const PDPA_EXPORT_BUCKET = "pdpa-exports";

/** จำนวน job สูงสุดต่อ tick หนึ่งรอบ (กัน cron รันยาว — D-p5-7 cap 10) */
export const PDPA_EXPORT_MAX_JOBS_PER_TICK = 10;

/** แถวที่ claim ได้ — strict: คีย์เกิน/ค่าเพี้ยน = drift ปฏิเสธงานนั้น
 *  · claimToken (gate p5-r2 M1) = ตัวป้องกัน worker เก่า: complete/fail ต้องแนบ
 *    token ของ "รอบการถือครองล่าสุด" — lease ถูกยึดคืนแล้ว token เก่าใช้ปิดงานไม่ได้ */
export const ClaimedExportJobSchema = z
  .object({ jobId: z.uuid(), userId: z.uuid(), claimToken: z.uuid() })
  .strict();

/** คิวว่าง — {jobId: null} เท่านั้น */
const EmptyClaimSchema = z.object({ jobId: z.literal(null) }).strict();

/** ผลของ complete/fail RPC — {jobId, status} ครบสองคีย์ */
const JobOutcomeSchema = z
  .object({ jobId: z.uuid(), status: z.enum(["done", "failed", "processing"]) })
  .strict();

/** งานที่ claim แล้ว — ใช้เรียก processDataExportJob ตรง ๆ (unit test / reuse) */
export interface DataExportTask {
  readonly jobId: string;
  readonly userId: string;
  readonly claimToken: string;
}

/** สรุปผลหนึ่ง tick — ตัวเลขเมตาเท่านั้น (response ของ internal job route) */
export interface DataExportRunSummary {
  readonly claimed: number;
  readonly done: number;
  readonly failed: number;
}

/** ข้อความ error ที่ลงคอลัมน์ data_export_jobs.error — static token ไม่มี PII เด็ดขาด */
export type ExportFailReason =
  | "export_claim_drift"
  | "export_compose_failed"
  | "export_upload_failed"
  | "export_media_insert_failed"
  | "export_complete_failed"
  | "export_fail_rpc_failed";

/** ก้อนข้อมูล 9 chunks ตามสัญญา D-p5-7 (profiles+roles รวมก้อนเดียว) */
interface ExportChunks {
  readonly profile: { readonly account: unknown; readonly roles: readonly unknown[] };
  readonly consents: readonly unknown[];
  readonly enrollments: readonly unknown[];
  readonly lesson_progress: readonly unknown[];
  readonly quiz_attempts: readonly unknown[];
  readonly assessment_attempts: readonly unknown[];
  readonly certificates: readonly unknown[];
  readonly credit_ledger: readonly unknown[];
  readonly notifications: readonly unknown[];
}

/** helper อ่านตาราง eq user_id คืน array — error/schema เพี้ยน = throw (fail-closed ต่อ job) */
async function rowsOf(
  client: SupabaseClient,
  table: string,
  column: string,
  value: string,
  select = "*",
): Promise<unknown[]> {
  const { data, error } = await client.from(table).select(select).eq(column, value);
  if (error !== null || !Array.isArray(data)) {
    throw new Error(`export_read_failed:${table}`);
  }
  return data;
}

/**
 * ประกอบข้อมูลส่วนบุคคลของผู้ใช้คนเดียวครบทุกก้อน → object JSON เดียวพร้อม
 * chunk_count — อ่านด้วย service client เท่านั้น (RLS ไม่คุม service_role —
 * เหตุผลการใช้ตาม SDS §5.2a: background job export ของเจ้าของข้อมูล)
 * อ่านก้อนใดล้ม = throw (ผู้เรียก fail job — ไม่มีทางได้ไฟล์ครึ่งก้อน)
 */
export async function composePersonalDataExport(
  client: SupabaseClient,
  userId: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  // ก้อน 1 — profile + roles (คนละตาราง รวม chunk เดียวตามสัญญา 9 chunks)
  const profileRes = await client
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (profileRes.error !== null) {
    throw new Error("export_read_failed:profiles");
  }
  const roles = await rowsOf(client, "role_assignments", "user_id", userId);

  // ก้อน 4 — enrollments ก่อน เพื่อเอา id ไปอ่าน lesson_progress (ตารางลูกผ่าน enrollment_id)
  const enrollments = await rowsOf(client, "enrollments", "user_id", userId);
  const enrollmentIds = enrollments
    .map((row) => (typeof row === "object" && row !== null ? (row as Record<string, unknown>)["id"] : null))
    .filter((id): id is string => typeof id === "string");
  const lessonProgress =
    enrollmentIds.length > 0
      ? await rowsIn(client, "lesson_progress", "enrollment_id", enrollmentIds)
      : [];

  const [consents, quizAttempts, assessmentAttempts, certificates, creditLedger, notifications] =
    await Promise.all([
      rowsOf(client, "consents", "user_id", userId),
      rowsOf(client, "quiz_attempts", "user_id", userId),
      rowsOf(client, "assessment_attempts", "user_id", userId),
      rowsOf(client, "certificates", "user_id", userId),
      rowsOf(client, "credit_ledger_entries", "user_id", userId),
      rowsOf(client, "notification_recipients", "user_id", userId, "*, notification:notifications(*)"),
    ]);

  const chunks: ExportChunks = {
    profile: { account: profileRes.data, roles },
    consents,
    enrollments,
    lesson_progress: lessonProgress,
    quiz_attempts: quizAttempts,
    assessment_attempts: assessmentAttempts,
    certificates,
    credit_ledger: creditLedger,
    // แถวผู้รับแจ้งเตือน + เนื้อหา notification ที่อ้าง (embed n-to-1 ของ PostgREST)
    notifications,
  };

  return {
    schema: "ltc.pdpa-export.v1",
    generated_at: new Date().toISOString(),
    job_id: jobId,
    user_id: userId,
    chunk_count: Object.keys(chunks).length,
    chunks,
  };
}

/** เหมือน rowsOf แต่ in() — สำหรับ lesson_progress ผ่าน enrollment ids */
async function rowsIn(
  client: SupabaseClient,
  table: string,
  column: string,
  values: readonly string[],
): Promise<unknown[]> {
  const { data, error } = await client.from(table).select("*").in(column, [...values]);
  if (error !== null || !Array.isArray(data)) {
    throw new Error(`export_read_failed:${table}`);
  }
  return data;
}

/**
 * ที่อยู่เต็มของไฟล์ใน `media_assets.storage_path` — `pdpa-exports/{user_id}/{job_id}.json`
 * (สัญญา D-p5-7 · รวม prefix บักเก็ตเหมือน license-evidence ของ API-SPEC §3.2)
 *
 * gate p5-r2 BLOCKER-1: ห้ามส่งค่านี้ตรง ๆ ให้ `storage.from(bucket).upload()` —
 * storage-js เติม bucketId ให้อีกชั้น (`_getFinalPath` = `{bucket}/{path}`) ทำให้
 * object จริงไปอยู่ที่ `pdpa-exports/pdpa-exports/…` คนละชื่อกับที่ email worker
 * ลงนาม ({bucket} + storage_path ตัด prefix) → signed_url_failed · ตัวส่งให้
 * `.upload()` ต้องเป็น key ในบักเก็ต (`{user_id}/{job_id}.json`) เท่านั้น
 */
export function exportStoragePath(userId: string, jobId: string): string {
  return `${PDPA_EXPORT_BUCKET}/${userId}/${jobId}.json`;
}

/** key ของ object "ใน" บักเก็ต (ไม่รวม prefix) — ตัวที่ส่งให้ .upload() จริง */
function exportObjectKey(userId: string, jobId: string): string {
  return `${userId}/${jobId}.json`;
}

/**
 * ประมวลผลงานเดียว claim แล้ว (compose → upload → media → complete) — ไม่ throw:
 * ทุกความล้มเหลวกลับเป็น RPC `fail_data_export_job` + คืน "failed" เพื่อไม่ให้
 * แถวค้าง status 'processing' นิรันดร์ · คืน "done" เมื่อ complete RPC ผ่าน
 */
export async function processDataExportJob(
  client: SupabaseClient,
  task: DataExportTask,
  requestId?: string | null,
): Promise<"done" | "failed"> {
  const logger = createLogger(getConfig().logLevel);
  try {
    // 1) compose — อ่านครบทุกก้อน (ล้มก้อนใด = fail ทั้ง job)
    const document = await composePersonalDataExport(client, task.userId, task.jobId);

    // 2) upload JSON ก้อนเดียวเข้า bucket ส่วนตัว — key "ใน" บักเก็ต (ไม่รวม prefix
    //    — gate p5-r2 B1: storage-js เติม bucketId เอง ส่ง path เต็มจะได้ object
    //    ซ้อนสองชั้น) · media_assets.storage_path เก็บ path เต็มตามสัญญา
    const path = exportStoragePath(task.userId, task.jobId);
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    const upload = await client.storage
      .from(PDPA_EXPORT_BUCKET)
      .upload(exportObjectKey(task.userId, task.jobId), bytes, {
        contentType: "application/json",
        upsert: false,
      });
    if (upload.error !== null) {
      throw new Error("export_upload_failed");
    }

    // 3) media_assets — status ready · uploaded_by = เจ้าของข้อมูล (ไม่ใช่ระบบ)
    const mediaInsert = await client
      .from("media_assets")
      .insert({
        provider: "supabase_storage",
        media_type: "document",
        bucket: PDPA_EXPORT_BUCKET,
        storage_path: path,
        mime_type: "application/json",
        size_bytes: bytes.byteLength,
        status: "ready",
        uploaded_by: task.userId,
      })
      .select("id")
      .single();
    if (mediaInsert.error !== null || mediaInsert.data === null || typeof mediaInsert.data.id !== "string") {
      throw new Error("export_media_insert_failed");
    }
    const mediaId: string = mediaInsert.data.id;

    // 4) complete — audit DATA_EXPORT_DONE + event data_export.ready ใน TX เดียวของ RPC
    //    · p_claim_token (gate p5-r2 M1): RPC ตรวจว่าเรายังเป็นผู้ถือ lease ปัจจุบัน
    const complete = await client.rpc("complete_data_export_job", {
      p_job_id: task.jobId,
      p_file_media_id: mediaId,
      p_chunks: document["chunk_count"],
      p_request_id: requestId ?? null,
      p_claim_token: task.claimToken,
    });
    if (complete.error !== null || JobOutcomeSchema.safeParse(complete.data).success === false) {
      throw new Error("export_complete_failed");
    }
    return "done";
  } catch (error: unknown) {
    // ห้าม PII ใน error ที่ลง DB — ใช้เฉพาะ static token ที่โค้ดโยนเอง
    const reason: ExportFailReason =
      error instanceof Error && error.message.startsWith("export_read_failed")
        ? "export_compose_failed"
        : error instanceof Error && isFailReason(error.message)
          ? (error.message as ExportFailReason)
          : "export_compose_failed";
    logger.warn("pdpa_export_job_failed", { route: "pdpa:export", user_id: task.userId, status: reason });
    const fail = await client.rpc("fail_data_export_job", {
      p_job_id: task.jobId,
      p_error: reason,
      p_claim_token: task.claimToken,
    });
    if (fail.error !== null) {
      // fail RPC เองล้ม (เช่นแถวไม่อยู่สถานะ processing — ถูก worker อื่นแตะ) — แจ้งเตือนเงียบ
      logger.warn("pdpa_export_fail_rpc_failed", { route: "pdpa:export", user_id: task.userId });
    }
    return "failed";
  }
}

function isFailReason(message: string): message is ExportFailReason {
  return [
    "export_claim_drift",
    "export_compose_failed",
    "export_upload_failed",
    "export_media_insert_failed",
    "export_complete_failed",
    "export_fail_rpc_failed",
  ].includes(message);
}

/**
 * runPersonalDataExportLoop — หนึ่ง tick ของ worker: วน claim → process จน
 * claim คืนว่างหรือครบ cap (10 งาน/tick — D-p5-7) · ไม่ throw เพื่อให้ cron
 * ได้ 200 เสมอเมื่อผ่าน secret (แบบแผน runEmailDispatch)
 */
export async function runPersonalDataExportLoop(
  options: { maxJobs?: number } = {},
): Promise<DataExportRunSummary> {
  const maxJobs = options.maxJobs ?? PDPA_EXPORT_MAX_JOBS_PER_TICK;
  const client = createSupabaseServiceRoleClient();
  let claimed = 0;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < maxJobs; i += 1) {
    const claim = await client.rpc("claim_data_export_job");
    if (claim.error !== null) {
      // RPC claim ล้ม (DB ไม่พร้อม) — เลิก tick นี้ รอบหน้ามาใหม่ (at-least-once)
      break;
    }
    const raw: unknown = Array.isArray(claim.data) ? claim.data[0] : claim.data;
    const empty = EmptyClaimSchema.safeParse(raw);
    if (empty.success) {
      break;
    }
    const parsed = ClaimedExportJobSchema.safeParse(raw);
    if (!parsed.success) {
      // drift ของสัญญา claim — นับ claimed ไม่ได้ ตัดจบ tick (fail-closed ไม่เดา)
      break;
    }
    claimed += 1;
    const outcome = await processDataExportJob(client, parsed.data);
    if (outcome === "done") {
      done += 1;
    } else {
      failed += 1;
    }
  }
  return { claimed, done, failed };
}

/**
 * bulk — ออกประกาศนียบัตรเป็นชุด (Wave E Phase 2 — E-4 · D36-O4 · D55-5 · DCR-8)
 *
 * **service_role รวมศูนย์ที่ src/lib/certificates/** (D36-O3)** — route เรียกฟังก์ชัน
 * ของ lib เท่านั้น (ห้าม import service client ตรง)
 *
 * - POST /admin/certificates/bulk (โมเดล worker ของ 0027 ตาม codex gate r1 M1/M2):
 *   BFF insert แถว `cert_bulk_jobs` (0023 — RLS เปิด fail-closed เหลือ service_role
 *   เท่านั้น) created_by = ผู้เรียก status 'pending' แล้วตอบ 202 ทันที — **ไม่รันใน
 *   request** (เดิม 0026 รอ RPC จบ job ใน TX เดียว = ความคืบหน้าไม่ durable) ·
 *   worker `admin_cert_bulk_issue_step` (pg_cron `ltc-cert-bulk-step` ทุกนาที —
 *   PostgREST CALL procedure ไม่ได้ จึงอยู่ฝั่ง cron ล้วน) หยิบ job มารัน commit
 *   ต่อใบ: ใบ + audit CERT_ISSUE mode='bulk' + counts ของ job เป็น TX เดียว *ต่อใบ*
 *   และเดินผ่านแถวที่ล้มด้วย cursor (M1) — BFF ไม่เขียน audit ซ้ำอยู่ดี
 * - GET /admin/certificates/bulk/{jobId}: select แถว job เดียว — เห็นความคืบหน้าสด
 *   ระหว่าง worker รัน (commit ต่อใบ) · **การเห็น: เจ้าของ job (created_by = ผู้เรียก)
 *   หรือ super_admin เท่านั้น** (registrar คนอื่นเจอ job ของเพื่อน = ตอบเหมือนไม่พบ
 *   ไม่เฉลยว่ามีจริง — กัน enumeration)
 * - ขาเข้า (แถวตาราง) และขาออก (resource ของ route) ตรวจ zod .strict() ทั้งสองชั้น — drift = ERR-SYS-002 fail-closed ไม่ strip/fabricate เงียบ ๆ (แบบแผน
 *   r6-L1/r7-M2 เดียวกับ issue/list)
 */
import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { dbFailed } from "./shared";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** สถานะ job — CHECK ของ cert_bulk_jobs (0023) · 0027: POST ตอบ 'pending' ตอนสร้าง
 *  (worker เป็นผู้เปลี่ยนเป็น running/completed/failed หลังจากนั้น) */
export const BULK_JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;

/**
 * ความยาวสูงสุดของ lastError ที่ออกทาง GET (สัญญา API §3.6 — "last_error ตัดทอน")
 * — DB เก็บได้ถึง 500 อักขระ (left(sqlerrm, 500) ใน 0027) แต่ resource ตัดที่ 200
 */
export const LAST_ERROR_MAX = 200;

/* ─── ขาเข้า: แถว/ผลลัพธ์จาก DB — .strict() จับคีย์หาย/คีย์เกิน/ค่าผิดชนิด (drift) ─── */

/**
 * แถวที่ INSERT .select(...) คืน — สถานะเริ่มต้นของ job 5 คีย์ exact (id + status +
 * counts ศูนย์ — worker ของ 0027 เป็นคนเพิ่ม counts ภายหลัง) · แบบแผน created-row
 * zod ของ export.ts
 */
export const BulkJobCreatedRowSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(BULK_JOB_STATUSES),
    total_attempts: z.number().int().min(0),
    issued_count: z.number().int().min(0),
    failed_count: z.number().int().min(0),
  })
  .strict();

/** แถว `cert_bulk_jobs` (0023 — 10 คอลัมน์ exact) · nullable แยก "ไม่มีคีย์" (fail)
 *  จาก null จริง (ผ่าน) ตาม r7-M2 · last_error/finished_at/course_id nullable จริง */
export const BulkJobRowSchema = z
  .object({
    id: z.string().uuid(),
    created_by: z.string().uuid(),
    course_id: z.string().uuid().nullable(),
    status: z.enum(BULK_JOB_STATUSES),
    total_attempts: z.number().int().min(0),
    issued_count: z.number().int().min(0),
    failed_count: z.number().int().min(0),
    last_error: z.string().nullable(),
    created_at: IsoTimestamp,
    finished_at: IsoTimestamp.nullable(),
  })
  .strict();

export type BulkJobRowParsed = z.infer<typeof BulkJobRowSchema>;

/* ─── ขาออก: resource ของ route — route ครอบด้วย parseOutgoingView อีกชั้น ─── */

/** ผลสร้าง job (POST /admin/certificates/bulk → 202) — camelCase strict · 0027:
 *  สถานะเริ่มต้น 'pending' + counts ศูนย์ (worker รันต่อ — ตามผลด้วย GET) */
export const BulkJobResultResource = z
  .object({
    jobId: z.string().uuid(),
    status: z.enum(BULK_JOB_STATUSES),
    totalAttempts: z.number().int().min(0),
    issuedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
  })
  .strict();

/** สถานะ job (GET /admin/certificates/bulk/{jobId} → 200) — camelCase strict ·
 *  lastError ตัดทอน ≤ LAST_ERROR_MAX (เหตุผลเดียวกับ .max ของ last_error ใน SQL) */
export const BulkJobStatusResource = z
  .object({
    jobId: z.string().uuid(),
    status: z.enum(BULK_JOB_STATUSES),
    totalAttempts: z.number().int().min(0),
    issuedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    lastError: z.string().max(LAST_ERROR_MAX).nullable(),
    createdAt: IsoTimestamp,
    finishedAt: IsoTimestamp.nullable(),
  })
  .strict();

export type BulkJobResult = z.infer<typeof BulkJobResultResource>;
export type BulkJobStatus = z.infer<typeof BulkJobStatusResource>;

/** ข้อมูลสร้าง job — actorId มาจาก requirePermission ที่ route ตรวจแล้ว · 0027:
 *  ไม่มี requestId — การรันเกิดฝั่ง worker ไม่ผูก request ใด */
export interface CreateBulkJobInput {
  readonly actorId: string;
  /** null = ทุกหลักสูตร (course_id nullable ตาม DDL 0023) */
  readonly courseId: string | null;
}

/** อ่านสถานะ job — ผู้เรียกต้องผ่าน role gate ที่ route แล้ว · การเห็นกำหนดที่นี่:
 *  เจ้าของ (created_by) หรือ super_admin เท่านั้น */
export interface GetBulkJobInput {
  readonly jobId: string;
  readonly viewerId: string;
  readonly isSuperAdmin: boolean;
}

/**
 * สร้าง job (cert_bulk_jobs) — **insert อย่างเดียว ไม่รันใน request** (0027 · M2) —
 * สิทธิ์ actor อยู่ที่ route (requirePermission) แล้ว ที่นี่คือ service_role query ล้วน
 *
 * - worker `admin_cert_bulk_issue_step` (pg_cron `ltc-cert-bulk-step` ทุกนาที) หยิบ
 *   job 'pending'/'running' มารัน: ใบ + audit mode='bulk' + counts ของ job commit เป็น
 *   TX เดียว *ต่อใบ* (ความคืบหน้า durable — GET เห็นสดระหว่างรัน · job หยุดกลางคัน
 *   ถูก resume อัตโนมัติโดยรอบถัดไป · anti-join กันออกซ้ำ)
 * - insert ล้ม = ERR-SYS-002 fail-closed · created-row ตรวจ strict 5 คีย์ (id ไม่ใช่
 *   uuid = drift ของแถวที่เขียนไว้ ห้ามตอบออกไป)
 */
export async function createBulkJob(input: CreateBulkJobInput): Promise<BulkJobResult> {
  const client = createSupabaseServiceRoleClient();
  const inserted = await client
    .from("cert_bulk_jobs")
    .insert({
      created_by: input.actorId,
      course_id: input.courseId,
      status: "pending",
    })
    .select("id, status, total_attempts, issued_count, failed_count")
    .single();
  if (inserted.error !== null) {
    throw dbFailed("cert_bulk_job_insert_failed");
  }
  const row = BulkJobCreatedRowSchema.safeParse(inserted.data);
  if (!row.success) {
    throw dbFailed("cert_bulk_job_insert_row_drift");
  }
  return {
    jobId: row.data.id,
    status: row.data.status,
    totalAttempts: row.data.total_attempts,
    issuedCount: row.data.issued_count,
    failedCount: row.data.failed_count,
  };
}

/**
 * อ่านสถานะ job — ไม่พบ / ไม่ใช่เจ้าของและไม่ใช่ super_admin → ERR-NF-001 (404) เหมือน
 * กันทั้งสองกรณี (ไม่เฉลยว่า job มีจริง — กัน enumeration ระหว่าง registrar)
 */
export async function getBulkJob(input: GetBulkJobInput): Promise<BulkJobStatus> {
  const client = createSupabaseServiceRoleClient();
  const res = await client
    .from("cert_bulk_jobs")
    .select(
      "id, created_by, course_id, status, total_attempts, issued_count, failed_count, last_error, created_at, finished_at",
    )
    .eq("id", input.jobId)
    .maybeSingle();
  if (res.error !== null) {
    throw dbFailed("cert_bulk_job_query_failed");
  }
  // maybeSingle: data null + error null = ไม่พบ → 404 (ไม่ตก drift — ไม่พบไม่ใช่แถวเพี้ยน)
  if (res.data === null) {
    throw new AppError("ERR-NF-001");
  }
  const row = BulkJobRowSchema.safeParse(res.data);
  if (!row.success) {
    throw dbFailed("cert_bulk_job_row_drift");
  }
  const job = row.data;
  if (job.created_by !== input.viewerId && !input.isSuperAdmin) {
    // registrar คนอื่นเจอ job ของเพื่อน → ตอบเหมือนไม่พบ (ไม่เฉลยว่ามีจริง — กัน enumeration)
    throw new AppError("ERR-NF-001");
  }
  return toBulkJobStatus(job);
}

/** แถว cert_bulk_jobs ที่ผ่าน BulkJobRowSchema แล้ว → resource — map ตรง ๆ ไม่ fabricate
 *  ค่า · lastError ตัดทอนที่ LAST_ERROR_MAX อักขระ (SQL เก็บได้ถึง 500 — resource แคบกว่า) */
function toBulkJobStatus(row: BulkJobRowParsed): BulkJobStatus {
  return {
    jobId: row.id,
    status: row.status,
    totalAttempts: row.total_attempts,
    issuedCount: row.issued_count,
    failedCount: row.failed_count,
    lastError: row.last_error === null ? null : row.last_error.slice(0, LAST_ERROR_MAX),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

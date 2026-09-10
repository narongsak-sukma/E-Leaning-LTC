/**
 * schemas/v1/enrollment — contract ของการลงทะเบียนเรียน (Wave C-3)
 *
 * - POST /courses/{id}/enroll — EnrollParams ตรงตัวอักษร API-SPECIFICATION 1.0.1 §4 #4
 * - resource (camelCase ตาม convention §1.1 + ตัวอย่าง §4) คอลัมน์ตาม DATA-DICTIONARY 1.0.0 §3.2
 *   `enrollments` เท่านั้น — ไม่รวมคอลัมน์ภายใน (source/created_by/deleted_at)
 * - สถานะตรง enum `enrollment_status` (migration 0001_extensions.sql L100:
 *   active/completed/expired/cancelled)
 * - การเขียนเกิดผ่าน RPC `enroll()` เท่านั้น (DD §4.7 / D12-1) — schema ชุดนี้เป็นฝั่งอ่าน/ตอบ
 */
import { z } from "zod";

/** path param ของ POST /courses/{id}/enroll (API-SPECIFICATION §4 #4 ตรงตัวอักษร) */
export const EnrollParams = z.object({ courseId: z.string().uuid() }).strict();

export type EnrollParamsParsed = z.infer<typeof EnrollParams>;

/** สถานะการลงทะเบียน — enum enrollment_status (DD §3.2 · migration 0001 L100) */
export const ENROLLMENT_STATUSES = ["active", "completed", "expired", "cancelled"] as const;

export const EnrollmentStatus = z.enum(ENROLLMENT_STATUSES);

export type EnrollmentStatusValue = (typeof ENROLLMENT_STATUSES)[number];

/** เวลา ISO 8601 ของ resource (API-SPECIFICATION §1.1 — ยอมทั้ง Z และ +00:00) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** resource ที่ API ตอบกลับของ enrollment (§3.3 — 201 ใหม่ / 200 ซ้ำ / รายการ /me/enrollments) */
export const EnrollmentResource = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
  status: EnrollmentStatus,
  enrolledAt: IsoTimestamp,
  expiresAt: IsoTimestamp.nullable(),
  completedAt: IsoTimestamp.nullable(),
});

export type EnrollmentResourceParsed = z.infer<typeof EnrollmentResource>;

/** แถวจากตาราง enrollments (snake_case ตาม DD §3.2) — เฉพาะคอลัมน์ที่ resource ใช้ */
export interface EnrollmentRow {
  readonly id: string;
  readonly course_id: string;
  readonly status: string;
  readonly enrolled_at: string;
  readonly expires_at: string | null;
  readonly completed_at: string | null;
}

/**
 * map แถว DB → resource (camelCase) — ใช้ร่วมทั้ง POST enroll และ GET /me/enrollments
 * status เป็น cast ได้เพราะ DB enum กำหนดชุดค่าไว้แล้ว (migration 0001 L100)
 */
export function toEnrollmentResource(row: EnrollmentRow): EnrollmentResourceParsed {
  return {
    id: row.id,
    courseId: row.course_id,
    status: row.status as EnrollmentStatusValue,
    enrolledAt: row.enrolled_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

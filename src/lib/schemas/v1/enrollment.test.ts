/**
 * unit tests — src/lib/schemas/v1/enrollment.ts (Wave C-3)
 * contract ตาม API-SPECIFICATION 1.0.1 §3.3 + §4 #4 · DD §3.2 enrollments
 */
import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_STATUSES,
  EnrollmentResource,
  EnrollParams,
  toEnrollmentResource,
  type EnrollmentRow,
} from "./enrollment";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const T = "2026-09-10T01:02:03+00:00";

const VALID_ROW: EnrollmentRow = {
  id: UUID,
  course_id: UUID2,
  status: "active",
  enrolled_at: T,
  expires_at: null,
  completed_at: null,
};

describe("EnrollParams (API-SPEC §4 #4 ตรงตัวอักษร)", () => {
  it("uuid ถูกต้องผ่าน", () => {
    const parsed = EnrollParams.safeParse({ courseId: UUID });
    expect(parsed.success).toBe(true);
  });

  it("ไม่ใช่ uuid → ไม่ผ่าน (path param ไม่ถูกรูปแบบ)", () => {
    const parsed = EnrollParams.safeParse({ courseId: "not-a-uuid" });
    expect(parsed.success).toBe(false);
  });

  it("key แปลกปลอม → ไม่ผ่าน (.strict())", () => {
    const parsed = EnrollParams.safeParse({ courseId: UUID, extra: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("EnrollmentResource", () => {
  it("resource ครบชุดผ่าน (validate ด้วย zod — contract-first)", () => {
    const resource = toEnrollmentResource(VALID_ROW);
    expect(() => EnrollmentResource.parse(resource)).not.toThrow();
    expect(resource).toEqual({
      id: UUID,
      courseId: UUID2,
      status: "active",
      enrolledAt: T,
      expiresAt: null,
      completedAt: null,
    });
  });

  it("status ครบทั้ง 4 ค่าตาม enum enrollment_status (DD §3.2)", () => {
    expect(ENROLLMENT_STATUSES).toEqual(["active", "completed", "expired", "cancelled"]);
    for (const status of ENROLLMENT_STATUSES) {
      expect(() =>
        EnrollmentResource.parse({ ...toEnrollmentResource(VALID_ROW), status }),
      ).not.toThrow();
    }
  });

  it("status นอก enum → ไม่ผ่าน", () => {
    expect(() => EnrollmentResource.parse({ ...resource(), status: "pending" })).toThrow();
  });

  it("expiresAt/completedAt เป็น null ได้ · ไม่ใช่ ISO → ไม่ผ่าน", () => {
    expect(() =>
      EnrollmentResource.parse({ ...resource(), expiresAt: "09-2026" }),
    ).toThrow();
  });

  it("id ไม่ใช่ uuid → ไม่ผ่าน", () => {
    expect(() => EnrollmentResource.parse({ ...resource(), id: "abc" })).toThrow();
  });

  function resource() {
    return toEnrollmentResource(VALID_ROW);
  }
});

describe("toEnrollmentResource — map snake_case → camelCase (DD §3.2)", () => {
  it("แปลงคอลัมน์ครบทุกฟิลด์ + คง null ของเวลาที่ยังไม่เกิด", () => {
    const row: EnrollmentRow = {
      id: UUID,
      course_id: UUID2,
      status: "completed",
      enrolled_at: T,
      expires_at: null,
      completed_at: T,
    };
    expect(toEnrollmentResource(row)).toEqual({
      id: UUID,
      courseId: "22222222-2222-4222-8222-222222222222",
      status: "completed",
      enrolledAt: T,
      expiresAt: null,
      completedAt: T,
    });
  });

  it("คง null ของ expires_at (กำหนดเวลาเรียนถ้าหลักสูตรกำหนด — DD §3.2)", () => {
    const mapped = toEnrollmentResource(VALID_ROW);
    expect(mapped.expiresAt).toBeNull();
    expect(mapped.completedAt).toBeNull();
  });
});

/**
 * access.test — กรอบบทบาทต่อ endpoint รายงาน + assertRoleScope (Wave E · D55-6)
 */
import { describe, expect, it } from "vitest";
import {
  MONITORING_ROLE_SCOPE,
  REPORT_ROLE_SCOPES,
  REPORT_TYPES,
  STATISTICS_ROLE_SCOPE,
  assertRoleScope,
} from "./access";

const SV = "staff:viewer";
const SE = "staff:exam";
const SR = "staff:registrar";
const SA = "super_admin";

describe("REPORT_ROLE_SCOPES — ตารางบทบาทตามภารกิจ (D12-23)", () => {
  it("enrollments = sv/sa เท่านั้น", () => {
    expect(REPORT_ROLE_SCOPES.enrollments).toEqual([SV, SA]);
  });
  it("assessments = se/sv/sa", () => {
    expect(REPORT_ROLE_SCOPES.assessments).toEqual([SE, SV, SA]);
  });
  it("credits = sr/sv/sa", () => {
    expect(REPORT_ROLE_SCOPES.credits).toEqual([SR, SV, SA]);
  });
  it("MONITORING_ROLE_SCOPE = se/sa", () => {
    expect(MONITORING_ROLE_SCOPE).toEqual([SE, SA]);
  });
  it("STATISTICS_ROLE_SCOPE = se/sv/sa", () => {
    expect(STATISTICS_ROLE_SCOPE).toEqual([SE, SV, SA]);
  });
  it("REPORT_TYPES ครบ 3 ประเภทตามลำดับ", () => {
    expect(REPORT_TYPES).toEqual(["enrollments", "assessments", "credits"]);
  });
});

describe("assertRoleScope — fail-closed ชั้นที่ 2 ของ BFF", () => {
  it("บทบาทในขอบเขต = ผ่าน (ไม่ throw)", () => {
    expect(() => assertRoleScope([SV], REPORT_ROLE_SCOPES.enrollments, "report:view")).not.toThrow();
    expect(() => assertRoleScope([SE], REPORT_ROLE_SCOPES.assessments, "report:view")).not.toThrow();
    expect(() => assertRoleScope([SR], REPORT_ROLE_SCOPES.credits, "report:view")).not.toThrow();
    expect(() => assertRoleScope([SA], REPORT_ROLE_SCOPES.enrollments, "report:view")).not.toThrow();
  });
  it("บทบาทนอกขอบเขต → throw AppError code ERR-RBAC-001", () => {
    for (const [roles, allowed, permission] of [
      [[SE], REPORT_ROLE_SCOPES.enrollments, "report:view"],
      [[SR], REPORT_ROLE_SCOPES.assessments, "report:view"],
      [[SV], MONITORING_ROLE_SCOPE, "attempt:view"],
    ] as const) {
      try {
        assertRoleScope(roles as unknown as string[], allowed, permission as "report:view");
        expect.unreachable("ต้อง throw");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("ERR-RBAC-001");
      }
    }
  });
  it("หลายบทบาท — มีบทบาทใดบทบาทหนึ่งอยู่ในขอบเขต = ผ่าน — ไม่ throw", () => {
    expect(() => assertRoleScope([SV, SE], REPORT_ROLE_SCOPES.enrollments, "report:view")).not.toThrow();
  });
});

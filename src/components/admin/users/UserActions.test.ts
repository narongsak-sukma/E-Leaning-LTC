/**
 * unit tests — users/UserActions (Wave E Phase 5 · lane F · ADM-002)
 * ครอบ pure helpers ทั้งหมดที่โมดัลใช้ตัดสิน: reason ≥10 · บอดี้/path ต่อ endpoint ·
 * สิทธิ์ต่อบทบาท (disable/roles/create) · ฟอร์มสร้างบัญชีเจ้าหน้าที่
 */
import { describe, expect, it } from "vitest";

import {
  buildCreateStaffBody,
  buildDisableBody,
  buildEnableBody,
  buildGrantRoleBody,
  buildRevokeRoleBody,
  canCreateStaffUser,
  canDisableUser,
  canManageRoles,
  isUuid,
  REASON_MIN_LENGTH,
  reasonValid,
  roleLabelOf,
  roleOptionsForCaller,
  roleRevokePath,
  userActionPath,
  userStatusKeyOf,
  userStatusViewOf,
  validateCreateStaffForm,
} from "./UserActions";

describe("reasonValid", () => {
  it("trim แล้วยาว ≥10 → true · สั้น/ช่องว่างล้วน → false", () => {
    expect(reasonValid("หลักฐานการใช้ในทางมิชอบ")).toBe(true);
    expect(reasonValid("   หลักฐานชัดเจน   ")).toBe(true);
    expect(reasonValid("สั้นเกิน")).toBe(false);
    expect(reasonValid("          ")).toBe(false);
    expect(reasonValid("")).toBe(false);
    expect(REASON_MIN_LENGTH).toBe(10);
  });
});

describe("userStatusViewOf / userStatusKeyOf / roleLabelOf", () => {
  it("สถานะที่รู้จักได้ป้าย+โทน · ค่าแปลกปลอมแสดงเป็นกลาง (ไม่เดา)", () => {
    expect(userStatusViewOf("active")).toEqual({ label: "ใช้งาน", tone: "success" });
    expect(userStatusViewOf("deleted")).toEqual({ label: "ถูกลบแล้ว", tone: "danger" });
    const unknown = userStatusViewOf("frozen");
    expect(unknown.label).toBe("frozen");
    expect(unknown.tone).toBe("neutral");
  });

  it("userStatusKeyOf — deletedAt null = active · มีค่า = deleted", () => {
    expect(userStatusKeyOf(null)).toBe("active");
    expect(userStatusKeyOf("2026-09-01T00:00:00Z")).toBe("deleted");
  });

  it("บทบาทในทะเบียนได้ป้ายไทย · นอกทะเบียนคืนรหัสเดิม", () => {
    expect(roleLabelOf("lawyer")).toBe("ทนายความ");
    expect(roleLabelOf("staff:registrar")).toBe("เจ้าหน้าที่ (ทะเบียน)");
    expect(roleLabelOf("mystery_role")).toBe("mystery_role");
  });
});

describe("roleOptionsForCaller", () => {
  it("super_admin ได้ 6 บทบาท (ไม่มี super_admin)", () => {
    const options = roleOptionsForCaller(["super_admin"]);
    expect(options).toHaveLength(6);
    expect(options.includes("super_admin")).toBe(false);
  });

  it("staff:registrar ได้เฉพาะ lawyer · บทบาทอื่นได้ []", () => {
    expect(roleOptionsForCaller(["staff:registrar"])).toEqual(["lawyer"]);
    expect(roleOptionsForCaller(["staff:viewer"])).toEqual([]);
    expect(roleOptionsForCaller(["super_admin", "staff:registrar"])).toHaveLength(6);
  });
});

describe("สิทธิ์ต่อ action", () => {
  it("disable/enable — super_admin และ staff:registrar เท่านั้น", () => {
    expect(canDisableUser(["super_admin"])).toBe(true);
    expect(canDisableUser(["staff:registrar"])).toBe(true);
    expect(canDisableUser(["staff:viewer"])).toBe(false);
    expect(canDisableUser([])).toBe(false);
  });

  it("จัดการบทบาท — super_admin และ staff:registrar · สร้างบัญชี — super_admin เท่านั้น", () => {
    expect(canManageRoles(["super_admin"])).toBe(true);
    expect(canManageRoles(["staff:registrar"])).toBe(true);
    expect(canManageRoles(["staff:viewer"])).toBe(false);
    expect(canCreateStaffUser(["super_admin"])).toBe(true);
    expect(canCreateStaffUser(["staff:registrar"])).toBe(false);
    expect(canCreateStaffUser([])).toBe(false);
  });
});

describe("bodies/paths ต่อ endpoint", () => {
  it("disable → {is_active:false, reason trim} · enable → {is_active:true}", () => {
    expect(buildDisableBody("  เหตุผลยาวพอควรสำหรับการปิด  ")).toEqual({
      is_active: false,
      reason: "เหตุผลยาวพอควรสำหรับการปิด",
    });
    expect(buildEnableBody()).toEqual({ is_active: true });
  });

  it("grant/revoke ส่ง role+reason ใน body (trim) · revoke path ไม่มี query", () => {
    expect(buildGrantRoleBody("lawyer", "  ผ่านการยืนยันใบอนุญาตแล้ว  ")).toEqual({
      role: "lawyer",
      reason: "ผ่านการยืนยันใบอนุญาตแล้ว",
    });
    expect(buildRevokeRoleBody("lawyer", "  พ้นสภาทนายความแล้ว  ")).toEqual({
      role: "lawyer",
      reason: "พ้นสภาทนายความแล้ว",
    });
    expect(roleRevokePath("u-1")).toBe("/api/v1/admin/users/u-1/roles");
  });

  it("path ต่อผู้ใช้ encode id · isUuid คัด id มั่ว", () => {
    expect(userActionPath("u 1")).toBe("/api/v1/admin/users/u%201");
    expect(isUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

describe("validateCreateStaffForm / buildCreateStaffBody", () => {
  const VALID = {
    email: "new.staff@lawcouncil.go.th",
    displayName: "สมหญิง รักเรียน",
    role: "staff:viewer",
    reason: "ขอสร้างบัญชีเจ้าหน้าที่ดูข้อมูลสำหรับหน่วยงาน",
  };

  it("ครบถ้วน → {} (ผ่าน) และบอดี้ trim แล้วครบ 4 คีย์", () => {
    expect(validateCreateStaffForm(VALID)).toEqual({});
    const built = buildCreateStaffBody(VALID);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body).toEqual({
        email: "new.staff@lawcouncil.go.th",
        displayName: "สมหญิง รักเรียน",
        role: "staff:viewer",
        reason: "ขอสร้างบัญชีเจ้าหน้าที่ดูข้อมูลสำหรับหน่วยงาน",
      });
    }
  });

  it("อีเมล/ชื่อ/บทบาท/เหตุผลผิด → ข้อความไทยต่อช่อง · buildCreateStaffBody → { ok: false }", () => {
    const errors = validateCreateStaffForm({ email: "no-at", displayName: "", role: "", reason: "" });
    expect(errors["email"]).toBe("รูปแบบอีเมลไม่ถูกต้อง");
    expect(errors["displayName"]).toBe("ชื่อ-นามสกุลต้องยาว 1-120 ตัวอักษร");
    expect(errors["role"]).toBe("เลือกบทบาทเริ่มต้นของบัญชี");
    expect(errors["reason"]).toBe("ระบุเหตุผลให้ยาวอย่างน้อย 10 ตัวอักษร");
    expect(buildCreateStaffBody({ ...VALID, email: "broken@" }).ok).toBe(false);
    expect(buildCreateStaffBody({ ...VALID, reason: "สั้น" }).ok).toBe(false);
  });
});

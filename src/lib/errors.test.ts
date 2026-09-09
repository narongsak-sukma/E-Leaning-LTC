import { describe, expect, it } from "vitest";
import {
  ERROR_REGISTRY,
  errorDefinition,
  AppError,
  toErrorBody,
  fromUnknown,
  type ErrorCode,
} from "./errors";

/** ทะเบียนตาม API-SPECIFICATION §2 — เพิ่ม/ลด code ใน doc ต้องแก้ไฟล์นี้ด้วย (และตรงข้าม) */
const DOC_CODES: readonly ErrorCode[] = [
  "ERR-AUTH-001",
  "ERR-AUTH-002",
  "ERR-AUTH-003",
  "ERR-AUTH-004",
  "ERR-AUTH-005",
  "ERR-RBAC-001",
  "ERR-VAL-001",
  "ERR-VAL-002",
  "ERR-NF-001",
  "ERR-RATE-001",
  "ERR-IDM-001",
  "ERR-SYS-001",
  "ERR-SYS-002",
  "ERR-PRF-001",
  "ERR-PRF-002",
  "ERR-CRS-001",
  "ERR-ENR-001",
  "ERR-ENR-002",
  "ERR-LRN-001",
  "ERR-LRN-002",
  "ERR-ASM-001",
  "ERR-ASM-002",
  "ERR-ASM-003",
  "ERR-ASM-004",
  "ERR-ASM-005",
  "ERR-ASM-006",
  "ERR-CERT-001",
  "ERR-CERT-002",
  "ERR-CRD-001",
  "ERR-CRD-002",
  "ERR-ADM-001",
];

describe("ERROR_REGISTRY — ตรงกับ API-SPECIFICATION §2", () => {
  it("มี code ครบทุกตัวใน doc และไม่มีเกิน", () => {
    expect(Object.keys(ERROR_REGISTRY).sort()).toEqual([...DOC_CODES].sort());
  });

  it("code ที่ยังใช้งาน: httpStatus อยู่ในช่วง 400–599 และมีข้อความไทย", () => {
    for (const [code, def] of Object.entries(ERROR_REGISTRY)) {
      if ("retired" in def && def.retired) continue;
      expect(def.httpStatus, code).toBeGreaterThanOrEqual(400);
      expect(def.httpStatus, code).toBeLessThanOrEqual(599);
      expect(def.message.length, code).toBeGreaterThan(0);
    }
  });

  it("ERR-CERT-001 / ERR-CERT-002 เป็น retired — ไม่มี httpStatus", () => {
    for (const code of ["ERR-CERT-001", "ERR-CERT-002"] as const) {
      expect(errorDefinition(code).retired).toBe(true);
      expect(errorDefinition(code).httpStatus).toBeNull();
    }
  });
});

describe("AppError", () => {
  it("ดึง httpStatus + ข้อความไทยจากทะเบียนโดยอัตโนมัติ", () => {
    const err = new AppError("ERR-RBAC-001");
    expect(err.code).toBe("ERR-RBAC-001");
    expect(err.httpStatus).toBe(403);
    expect(err.message).toBe("คุณไม่มีสิทธิ์ดำเนินการนี้");
  });

  it("override ข้อความได้ตามบริบท แต่ code/httpStatus คงที่", () => {
    const err = new AppError("ERR-VAL-001", { message: "รหัสหลักสูตรไม่ถูกต้อง" });
    expect(err.message).toBe("รหัสหลักสูตรไม่ถูกต้อง");
    expect(err.code).toBe("ERR-VAL-001");
    expect(err.httpStatus).toBe(400);
  });

  it("ตรวจสิทธิ์ไม่ผ่าน → ERR-RBAC-001 พร้อม details.permission", () => {
    const err = new AppError("ERR-RBAC-001", { details: { permission: "certificate:issue" } });
    expect(err.details).toEqual({ permission: "certificate:issue" });
  });
});

describe("toErrorBody — error envelope ตาม API-SPEC §1.3", () => {
  it("มีรูป { error: { code, message, details } } เสมอ", () => {
    const body = toErrorBody(new AppError("ERR-NF-001"), "req-123");
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.message).toBe("ไม่พบข้อมูลที่ต้องการ");
    expect(body.error.details).toEqual({ request_id: "req-123" });
  });

  it("ไม่ใส่ request_id เมื่อไม่ได้ส่งมา แต่ details ยังเป็น object", () => {
    const body = toErrorBody(new AppError("ERR-RATE-001"));
    expect(body.error.details).toEqual({});
  });

  it("details เสริมจาก AppError ถูกรวมไว้กับ request_id", () => {
    const err = new AppError("ERR-RBAC-001", { details: { permission: "course:delete" } });
    const body = toErrorBody(err, "req-abc");
    expect(body.error.details).toEqual({ request_id: "req-abc", permission: "course:delete" });
  });
});

describe("fromUnknown — ป้องกัน leak ข้อผิดพลาดภายใน (SDS §6.1)", () => {
  it("แปลง error ไม่รู้จักเป็น ERR-SYS-001 แบบ opaque", () => {
    const err = fromUnknown(new Error("SQL: select * from users where email = 'x'"));
    expect(err.code).toBe("ERR-SYS-001");
    expect(err.message).not.toContain("SQL");
    expect(err.message).toBe("เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่");
  });

  it("AppError ที่โยนเข้ามาไม่ถูกแปลง", () => {
    const original = new AppError("ERR-ENR-001");
    expect(fromUnknown(original)).toBe(original);
  });
});

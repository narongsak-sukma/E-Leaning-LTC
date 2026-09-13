/**
 * mfa.test.ts — unit tests ของห้องเครื่อง MFA (Wave F · D-f-1)
 */
import { describe, expect, it } from "vitest";

import {
  BACKUP_CODE_COUNT,
  MFA_PENDING_COOKIE,
  MFA_PENDING_COOKIE_MAX_AGE,
  assertMfaDisableAllowed,
  backupCodeHash,
  base32Decode,
  decodeJwtPayload,
  decodePendingMfaValue,
  encodePendingMfaValue,
  generateBackupCodes,
  hasRecentMfa,
  normalizeBackupCodeInput,
  totpCode,
} from "./mfa";

describe("TOTP RFC 6238", () => {
  // secret "12345678901234567890" (20 ไบต์) ใน base32 — เวกเตอร์มาตรฐานของ RFC 6238 §B
  // (ค่าสาธารณะทุกเครื่องเหมือนกัน — ครอบใน .gitleaks.toml "เวกเตอร์ทดสอบสาธารณะ" ด้วย)
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow

  it("base32Decode ตาม RFC 4648", () => {
    // "1234567890" → GEZDGNBVGY3TQOJQ (16 อักขระ = 80 บิต = 10 ไบต์เต็ม)
    expect(base32Decode("GEZDGNBVGY3TQOJQ").toString("hex")).toBe("31323334353637383930");
    expect(base32Decode("MYRGGQZUGMYRGGZS")).toBeInstanceOf(Buffer);
  });

  it("คืนรหัสตรงเวกเตอร์ RFC (t=59 → 287082)", () => {
    expect(totpCode(RFC_SECRET, 59)).toBe("287082");
  });

  it("คืนรหัสตรงเวกเตอร์ RFC (ชุดเพิ่มเติม)", () => {
    expect(totpCode(RFC_SECRET, 1111111109)).toBe("081804");
    expect(totpCode(RFC_SECRET, 1234567890)).toBe("005924");
    expect(totpCode(RFC_SECRET, 2000000000)).toBe("279037");
  });

  it("รหัสเปลี่ยนทุกหน้าต่าง 30 วินาที", () => {
    expect(totpCode(RFC_SECRET, 59)).not.toBe(totpCode(RFC_SECRET, 89));
  });
});

describe("โค้ดสำรอง (backup codes)", () => {
  it("สร้างชุดละ 8 โค้ด รูป xxxx-xxxx ชุดอักษรถูกต้อง ไม่ซ้ำ", () => {
    const { codes, hashes } = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/);
    }
    expect(hashes).toHaveLength(BACKUP_CODE_COUNT);
  });

  it("hash ตามสัญญา sha256(trim+lowercase) — fixture ที่ lead probe PG↔Node มาแล้ว", () => {
    expect(backupCodeHash("probe-mfa-01")).toBe(
      "8ee88ff07885dcbdb878ee9fa82b21ec18903e69c3e8c6e210e59c63d218c711",
    );
    // lowercase + trim ตามสัญญาเดียวกัน
    expect(backupCodeHash("  PROBE-MFA-01  ")).toBe(backupCodeHash("probe-mfa-01"));
  });
});

describe("normalizeBackupCodeInput", () => {
  it("รับรูปมีขีด/ไม่มีขีด + ตัวใหญ่ แล้วจัดรูป xxxx-xxxx", () => {
    expect(normalizeBackupCodeInput("abcd-ef23")).toBe("abcd-ef23");
    expect(normalizeBackupCodeInput("ABCDEF23")).toBe("abcd-ef23");
  });

  it("ปฏิเสธรูปแปลกปลอม (รวมอักขระที่ไม่มีในชุดโค้ดจริง)", () => {
    expect(normalizeBackupCodeInput("")).toBeNull();
    expect(normalizeBackupCodeInput("1234-5678")).toBeNull(); // 0/1 ไม่อยู่ในชุดอักษร
    expect(normalizeBackupCodeInput("abcd")).toBeNull();
    expect(normalizeBackupCodeInput("abcd-ef23x")).toBeNull();
    expect(normalizeBackupCodeInput("abcd ef23")).toBeNull();
    expect(normalizeBackupCodeInput("aboi-ef23")).toBeNull(); // i/o ไม่อยู่ในชุดอักษร
  });
});

describe("hasRecentMfa (หน้าต่าง 15 นาที)", () => {
  const NOW = 1_800_000_000;
  const amrEntry = (method: string, timestamp: number) => ({ method, timestamp });

  it("ผ่านเมื่อ aal2 + amr mfa/* ภายในหน้าต่าง", () => {
    const payload = { aal: "aal2", amr: [amrEntry("password", NOW - 400), amrEntry("mfa/totp", NOW - 120)] };
    expect(hasRecentMfa(payload, NOW)).toBe(true);
  });

  it("ไม่ผ่านเมื่อเกินหน้าต่าง", () => {
    const payload = { aal: "aal2", amr: [amrEntry("mfa/totp", NOW - 901)] };
    expect(hasRecentMfa(payload, NOW)).toBe(false);
    // ชายเขตพอดี 900 วิ = ยังผ่าน (นับเป็นอายุ <= หน้าต่าง)
    const edge = { aal: "aal2", amr: [amrEntry("mfa/totp", NOW - 900)] };
    expect(hasRecentMfa(edge, NOW)).toBe(true);
  });

  it("ไม่ผ่านเมื่อ aal1 หรือไม่มี amr mfa/*", () => {
    expect(hasRecentMfa({ aal: "aal1", amr: [amrEntry("mfa/totp", NOW)] }, NOW)).toBe(false);
    expect(hasRecentMfa({ aal: "aal2", amr: [amrEntry("password", NOW)] }, NOW)).toBe(false);
    expect(hasRecentMfa({ aal: "aal2" }, NOW)).toBe(false);
    expect(hasRecentMfa(null, NOW)).toBe(false);
  });

  it("อ่าน amr ล่าสุดเท่านั้น (หลายรายการ)", () => {
    const payload = { aal: "aal2", amr: [amrEntry("mfa/totp", NOW - 5000), amrEntry("mfa/totp", NOW - 60)] };
    expect(hasRecentMfa(payload, NOW)).toBe(true);
  });

  it("รับทั้ง amr แบบเอกสาร (mfa/totp) และแบบ GoTrue จริง (totp — probe DCR-14)", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [amrEntry("mfa/totp", NOW - 100)] }, NOW)).toBe(true);
    expect(hasRecentMfa({ aal: "aal2", amr: [amrEntry("totp", NOW - 100)] }, NOW)).toBe(true);
    expect(hasRecentMfa({ aal: "aal2", amr: [amrEntry("mfa/x", NOW - 100)] }, NOW)).toBe(true);
    expect(hasRecentMfa({ aal: "aal2", amr: [amrEntry("otp", NOW - 100)] }, NOW)).toBe(false);
  });
});

describe("assertMfaDisableAllowed", () => {
  it("บทบาทบังคับ MFA ห้ามปิด (ข้อความไทยมีคำ MFA)", () => {
    for (const roles of [["staff:viewer"], ["super_admin"], ["instructor"], ["citizen", "staff:content"]]) {
      expect(() => assertMfaDisableAllowed(roles)).toThrowError(/MFA/);
      try {
        assertMfaDisableAllowed(roles);
      } catch (err) {
        expect((err as { code?: string }).code).toBe("ERR-RBAC-001");
      }
    }
  });

  it("citizen/lawyer ปิดได้", () => {
    expect(() => assertMfaDisableAllowed(["citizen"])).not.toThrow();
    expect(() => assertMfaDisableAllowed(["lawyer"])).not.toThrow();
  });
});

describe("cookie ชั่วคราว (pending)", () => {
  it("ชื่อ+อายุตามสัญญา", () => {
    expect(MFA_PENDING_COOKIE).toBe("ltc_mfa_pending");
    expect(MFA_PENDING_COOKIE_MAX_AGE).toBe(300);
  });

  it("encode/decode ตรงกัน + fail-closed เมื่อค่าเพี้ยน", () => {
    const value = encodePendingMfaValue({ accessToken: "tok-a.b.c", refreshToken: "rt-1" });
    expect(value).not.toBeNull();
    expect(decodePendingMfaValue(value ?? "")).toEqual({ accessToken: "tok-a.b.c", refreshToken: "rt-1" });
    expect(decodePendingMfaValue("not-json")).toBeNull();
    expect(decodePendingMfaValue('{"a":"x"}')).toBeNull(); // ขาด r
    expect(decodePendingMfaValue('{"a":"","r":"y"}')).toBeNull();
    expect(encodePendingMfaValue({ accessToken: "", refreshToken: "y" })).toBeNull();
  });

  it("decodeJwtPayload อ่าน payload แบบ base64url", () => {
    const payload = Buffer.from(JSON.stringify({ aal: "aal2", exp: 1 }), "utf8").toString("base64url");
    const token = `h.${payload}.s`;
    expect(decodeJwtPayload(token)?.["aal"]).toBe("aal2");
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

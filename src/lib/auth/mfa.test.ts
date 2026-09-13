/**
 * mfa.test.ts — unit tests ของห้องเครื่อง MFA (Wave F · D-f-1)
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  BACKUP_CODE_COUNT,
  MFA_PENDING_COOKIE,
  MFA_PENDING_COOKIE_MAX_AGE,
  assertMfaDisableAllowed,
  backupCodeHash,
  base32Decode,
  consumePendingMfaTokens,
  decodeJwtPayload,
  decodePendingStashKey,
  decryptPendingStashPayload,
  encryptPendingStashPayload,
  parsePendingStashCookie,
  generateBackupCodes,
  hasRecentMfa,
  normalizeBackupCodeInput,
  pendingStashAad,
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

describe("cookie ชั่วคราว (pending — stash uuid · gate r1 F2/F5)", () => {
  it("ชื่อ+อายุตามสัญญา", () => {
    expect(MFA_PENDING_COOKIE).toBe("ltc_mfa_pending");
    expect(MFA_PENDING_COOKIE_MAX_AGE).toBe(300);
  });

  it("parsePendingStashCookie รับ uuid v4 เท่านั้น — ค่าอื่น null หมด (fail-closed)", () => {
    expect(parsePendingStashCookie("0f0e0d0c-1b2a-4c3d-8e9f-aabbccddeeff")).toBe(
      "0f0e0d0c-1b2a-4c3d-8e9f-aabbccddeeff",
    );
    // token/JSON ของระบบเดิมต้องถูกปฏิเสธเด็ดขาด (ไม่มีทางเล็ดลอดกลับไปแพ็ก token)
    expect(parsePendingStashCookie('{"a":"eyJ...","r":"rt"}')).toBeNull();
    expect(parsePendingStashCookie("")).toBeNull();
    expect(parsePendingStashCookie("not-a-uuid")).toBeNull();
    // uuid รุ่นอื่น (v1 — หลักตำแหน่ง 13 ไม่ใช่ 4) ไม่รับ
    expect(parsePendingStashCookie("0f0e0d0c-1b2a-1c3d-8e9f-aabbccddeeff")).toBeNull();
  });

  it("encrypt/decrypt stash payload ตรงกัน · ค่าเพี้ยน/คีย์ผิด = null (GCM ตรวจแก้ไข)", () => {
    const key = Buffer.alloc(32, 7);
    const aad = pendingStashAad("u-1", 1_800_000_100);
    const payload = encryptPendingStashPayload({ accessToken: "tok-a.b.c", refreshToken: "rt-1" }, key, aad);
    expect(payload).toMatch(/^v1\./);
    expect(decryptPendingStashPayload(payload ?? "", key, aad)).toEqual({
      accessToken: "tok-a.b.c",
      refreshToken: "rt-1",
    });
    // ผิดรูป
    expect(decryptPendingStashPayload("not-json", key, aad)).toBeNull();
    expect(decryptPendingStashPayload("v2.a.b.c", key, aad)).toBeNull();
    expect(decryptPendingStashPayload("v1.only-three", key, aad)).toBeNull();
    // แก้ ciphertext หนึ่งตัวอักษร = tag ไม่ผ่าน (tamper-evidence ของ GCM)
    const parts = (payload ?? "").split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${(parts[3] ?? "").slice(0, -2)}xx`;
    expect(decryptPendingStashPayload(tampered, key, aad)).toBeNull();
    // คีย์ผิด
    expect(decryptPendingStashPayload(payload ?? "", Buffer.alloc(32, 9), aad)).toBeNull();
    // token ไม่ครบรูป = ไม่เข้ารหัส
    expect(encryptPendingStashPayload({ accessToken: "", refreshToken: "y" }, key, aad)).toBeNull();
  });

  it("AAD (userId:deadlineSec) — เจ้าของแถวหรือ deadline เพี้ยนถอดไม่ได้ (pin G1: re-host)", () => {
    const key = Buffer.alloc(32, 7);
    const tokens = { accessToken: "tok-a.b.c", refreshToken: "rt-1" };
    expect(pendingStashAad("u-1", 1_800_000_100)).toBe("u-1:1800000100");
    const payload = encryptPendingStashPayload(tokens, key, pendingStashAad("victim", 1_800_000_100));
    expect(payload).toMatch(/^v1\./);
    // roundtrip เมื่อ AAD ตรง
    expect(decryptPendingStashPayload(payload ?? "", key, pendingStashAad("victim", 1_800_000_100))).toEqual(tokens);
    // ผู้โจมตีขโมย ciphertext ไป re-host เป็นแถวของตัวเอง (user_id ใหม่ + deadline ใหม่
    // — RPC 0046 ออก deadline ใหม่ให้แถวใหม่เสมอ) = GCM auth ไม่ผ่าน → null
    expect(decryptPendingStashPayload(payload ?? "", key, pendingStashAad("attacker", 1_800_000_100))).toBeNull();
    expect(decryptPendingStashPayload(payload ?? "", key, pendingStashAad("victim", 1_800_000_101))).toBeNull();
    expect(decryptPendingStashPayload(payload ?? "", key, "")).toBeNull();
  });

  it("consumePendingMfaTokens — true เฉพาะ RPC ยืนยัน · false/throw fail-closed (pin G3)", async () => {
    const stashId = "0f0e0d0c-1b2a-4c3d-8e9f-aabbccddeeff";
    // stub client แทน standalone จริง (พารามิเตอร์ client ฉีดได้เพื่อ unit test)
    const stub = (data: unknown, error: { message: string } | null = null) =>
      ({ rpc: async () => ({ data, error }) }) as unknown as SupabaseClient;
    expect(await consumePendingMfaTokens(stashId, stub(true))).toBe(true);
    expect(await consumePendingMfaTokens(stashId, stub(false))).toBe(false);
    // id รูปเพี้ยน = false โดยไม่ยิง RPC เลย
    const never = {
      rpc: async () => {
        throw new Error("must not be called");
      },
    } as unknown as SupabaseClient;
    await expect(consumePendingMfaTokens("not-a-uuid", never)).resolves.toBe(false);
    // RPC ล้ม = throw ERR-SYS-001 (caller ตอบ error ระบบ ไม่ใช่ออก session)
    await expect(consumePendingMfaTokens(stashId, stub(null, { message: "boom" }))).rejects.toMatchObject({
      code: "ERR-SYS-001",
    });
  });

  it("decodePendingStashKey รับ base64 32 ไบต์เท่านั้น", () => {
    expect(decodePendingStashKey(Buffer.alloc(32, 1).toString("base64"))).not.toBeNull();
    expect(decodePendingStashKey(Buffer.alloc(16, 1).toString("base64"))).toBeNull();
    expect(decodePendingStashKey("not base64!")).toBeNull();
  });

  it("decodeJwtPayload อ่าน payload แบบ base64url", () => {
    const payload = Buffer.from(JSON.stringify({ aal: "aal2", exp: 1 }), "utf8").toString("base64url");
    const token = `h.${payload}.s`;
    expect(decodeJwtPayload(token)?.["aal"]).toBe("aal2");
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

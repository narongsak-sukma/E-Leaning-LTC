/**
 * rate-limit.test — unit test ของ src/lib/rate-limit.ts (API-SPECIFICATION §5)
 *
 * ค่า limit ทุกเคสอ้าง getConfig() (canonical จาก config — SRS Appendix A) ไม่ hardcode
 */
import { describe, expect, it, beforeEach } from "vitest";
import { AppError } from "./errors";
import { getConfig } from "./config";
import {
  RATE_LIMIT_GROUPS,
  checkRateLimit,
  enforceRateLimit,
  clientIpFrom,
  resolveRateLimitGroup,
  resetRateLimitStore,
} from "./rate-limit";

// env fixture — ต้องตั้งก่อน getConfig() ครั้งแรก (config แคชผลหลังเรียกครั้งเดียว)
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

beforeEach(() => {
  resetRateLimitStore();
});

describe("ครบทุกกลุ่ม §5 — ค่า limit มาจาก config เท่านั้น", () => {
  it("มีกลุ่มครบ 10 กลุ่มตามตาราง §5", () => {
    expect(RATE_LIMIT_GROUPS).toHaveLength(10);
    expect([...RATE_LIMIT_GROUPS]).toEqual([
      "AUTH", "OTP_REQUEST", "PWD_RESET", "MFA", "PUBLIC_READ",
      "READ", "LEARN_WRITE", "EXAM", "STAFF_WRITE", "EXPORT",
    ]);
  });

  it("limit ของทุกกลุ่มตรง config key ตามคอลัมน์ Appendix A", () => {
    const rl = getConfig().rateLimit;
    expect(checkRateLimit("AUTH", { ip: "1.1.1.1", secondary: "a@x" }).limit).toBe(rl.authPerMin);
    expect(checkRateLimit("OTP_REQUEST", { ip: "1.1.1.1", secondary: "0812345678" }).limit).toBe(rl.otpPerHour);
    expect(checkRateLimit("PWD_RESET", { ip: "1.1.1.1", secondary: "a@x" }).limit).toBe(rl.pwdResetPerHour);
    expect(checkRateLimit("MFA", { ip: "1.1.1.1", secondary: "u1" }).limit).toBe(rl.mfaPerMin);
    expect(checkRateLimit("PUBLIC_READ", { ip: "1.1.1.1" }).limit).toBe(rl.verifyPerMin);
    expect(checkRateLimit("READ", { ip: "1.1.1.1", secondary: "u1" }).limit).toBe(rl.readPerMin);
    expect(checkRateLimit("LEARN_WRITE", { ip: "1.1.1.1", secondary: "u1" }).limit).toBe(rl.learnWritePerMin);
    expect(checkRateLimit("EXAM", { ip: "1.1.1.1", secondary: "u1" }).limit).toBe(rl.examPerMin);
    expect(checkRateLimit("STAFF_WRITE", { ip: "1.1.1.1", secondary: "u1" }).limit).toBe(rl.staffWritePerMin);
    expect(checkRateLimit("EXPORT", { ip: "1.1.1.1", secondary: "u1" }).limit).toBe(rl.exportPerHour);
  });
});

describe("คีย์นับ cumulative IP + คีย์รอง (D12-11)", () => {
  it("คนละ user บน IP เดียว: user counter นับแยก แต่ IP counter สะสมทั้ง IP (D12-11)", () => {
    const limit = getConfig().rateLimit.mfaPerMin;
    for (let i = 0; i < limit - 1; i++) {
      expect(checkRateLimit("MFA", { ip: "9.9.9.9", secondary: "userA" }).allowed).toBe(true);
    }
    // ครั้งที่ limit ยังเป็นของ userA — ครบโควตาตัวเองพอดี (user+IP counter = limit ยังไม่เกิน)
    expect(checkRateLimit("MFA", { ip: "9.9.9.9", secondary: "userA" }).allowed).toBe(true);
    // ครั้งถัดไปของ userA → user counter เกิน → บล็อก
    expect(checkRateLimit("MFA", { ip: "9.9.9.9", secondary: "userA" }).allowed).toBe(false);
    // คนละ user แต่ IP counter เกินแล้ว (สะสมทั้ง IP) → บล็อกเช่นกัน
    expect(checkRateLimit("MFA", { ip: "9.9.9.9", secondary: "userB" }).allowed).toBe(false);
    // ปลายทางอื่น (คนละ IP) ยังผ่านปกติ
    expect(checkRateLimit("MFA", { ip: "9.9.9.10", secondary: "userB" }).allowed).toBe(true);
  });

  it("IP counter ถึงขีดก่อน → บล็อกแม้ user แต่ละคนยังไม่ครบ (ใครถึงก่อนถูกจำกัดก่อน)", () => {
    const limit = getConfig().rateLimit.mfaPerMin;
    for (let i = 0; i < limit; i++) {
      checkRateLimit("MFA", { ip: "8.8.8.8", secondary: "user" + String(i) });
    }
    const res = checkRateLimit("MFA", { ip: "8.8.8.8", secondary: "userX" });
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSec).toBeGreaterThan(0);
  });

  it("PUBLIC_READ นับเฉพาะ IP (ไม่มีคีย์รอง — ตาราง §5)", () => {
    const limit = getConfig().rateLimit.verifyPerMin;
    for (let i = 0; i < limit; i++) {
      checkRateLimit("PUBLIC_READ", { ip: "7.7.7.7" });
    }
    expect(checkRateLimit("PUBLIC_READ", { ip: "7.7.7.7" }).allowed).toBe(false);
    expect(checkRateLimit("PUBLIC_READ", { ip: "7.7.7.8" }).allowed).toBe(true);
  });
});

describe("หน้าต่าง reset ตามกลุ่ม (fixed window)", () => {
  it("กลุ่ม 1 นาที (MFA): เกินแล้วหมดหน้าต่าง → นับใหม่", () => {
    const limit = getConfig().rateLimit.mfaPerMin;
    let t = 1_000_000;
    const now = () => t;
    for (let i = 0; i < limit; i++) {
      checkRateLimit("MFA", { ip: "6.6.6.6", secondary: "u" }, now);
    }
    expect(checkRateLimit("MFA", { ip: "6.6.6.6", secondary: "u" }, now).allowed).toBe(false);
    t += 60_000;
    expect(checkRateLimit("MFA", { ip: "6.6.6.6", secondary: "u" }, now).allowed).toBe(true);
  });

  it("กลุ่ม 1 ชั่วโมง (OTP_REQUEST): คนละหน้าต่างกับ AUTH — หมดชั่วโมงค่อยเริ่มใหม่", () => {
    const limit = getConfig().rateLimit.otpPerHour;
    let t = 2_000_000;
    const now = () => t;
    for (let i = 0; i < limit; i++) {
      checkRateLimit("OTP_REQUEST", { ip: "5.5.5.5", secondary: "0812345678" }, now);
    }
    expect(checkRateLimit("OTP_REQUEST", { ip: "5.5.5.5", secondary: "0812345678" }, now).allowed).toBe(false);
    t += 60_000;
    expect(checkRateLimit("OTP_REQUEST", { ip: "5.5.5.5", secondary: "0812345678" }, now).allowed).toBe(false);
    t += 3_600_000 - 60_000;
    expect(checkRateLimit("OTP_REQUEST", { ip: "5.5.5.5", secondary: "0812345678" }, now).allowed).toBe(true);
  });
});

describe("กติกา specific-wins (D11-13 กติกา 1) — resolveRateLimitGroup", () => {
  it("/auth/otp/request (POST) → OTP_REQUEST ชนะ AUTH", () => {
    expect(resolveRateLimitGroup("POST", "/api/v1/auth/otp/request")).toBe("OTP_REQUEST");
  });

  it("/auth/password-reset/* (POST) → PWD_RESET ชนะ AUTH", () => {
    expect(resolveRateLimitGroup("POST", "/api/v1/auth/password-reset/request")).toBe("PWD_RESET");
  });

  it("/auth/login (POST) → AUTH", () => {
    expect(resolveRateLimitGroup("POST", "/api/v1/auth/login")).toBe("AUTH");
  });

  it("/auth/mfa/* → MFA (แม้ใต้ /auth/)", () => {
    expect(resolveRateLimitGroup("POST", "/api/v1/auth/mfa/enroll")).toBe("MFA");
  });

  it("GET /admin/reports/exam/export → EXPORT ชนะ STAFF_WRITE", () => {
    expect(resolveRateLimitGroup("GET", "/api/v1/admin/reports/exam/export")).toBe("EXPORT");
  });

  it("GET /admin/users → STAFF_WRITE", () => {
    expect(resolveRateLimitGroup("GET", "/api/v1/admin/users")).toBe("STAFF_WRITE");
  });

  it("POST /lessons/{id}/progress → LEARN_WRITE", () => {
    expect(resolveRateLimitGroup("POST", "/api/v1/lessons/abc/progress")).toBe("LEARN_WRITE");
  });

  it("POST /attempts/{id}/answers → EXAM", () => {
    expect(resolveRateLimitGroup("POST", "/api/v1/attempts/abc/answers")).toBe("EXAM");
  });

  it("GET /me/enrollments → READ", () => {
    expect(resolveRateLimitGroup("GET", "/api/v1/me/enrollments")).toBe("READ");
  });

  it("GET /courses → PUBLIC_READ", () => {
    expect(resolveRateLimitGroup("GET", "/api/v1/courses")).toBe("PUBLIC_READ");
  });

  it("POST /courses/{id}/enroll ไม่อยู่ในตาราง §5 → default READ (ช่องว่าง doc — รายงาน lead)", () => {
    expect(resolveRateLimitGroup("POST", "/api/v1/courses/abc/enroll")).toBe("READ");
  });

  it("path แปลกปลอมนอกขอบ → default READ", () => {
    expect(resolveRateLimitGroup("GET", "/api/v1/whatever")).toBe("READ");
  });
});

describe("enforceRateLimit — เกิน → ERR-RATE-001 (429) + retry_after_sec", () => {
  function makeRequest(path: string, ip: string): Request {
    return new Request("http://localhost:3000" + path, {
      method: "GET",
      headers: { "x-forwarded-for": ip },
    });
  }

  it("ยังไม่เกิน → คืนผลลัพธ์ allowed พร้อม limit จาก config", () => {
    const res = enforceRateLimit(makeRequest("/api/v1/me", "3.3.3.3"), { group: "READ", secondaryKey: "u1" });
    expect(res.allowed).toBe(true);
    expect(res.limit).toBe(getConfig().rateLimit.readPerMin);
  });

  it("เกิน (EXPORT) → throw ERR-RATE-001 + retry_after_sec >= 1", () => {
    const limit = getConfig().rateLimit.exportPerHour;
    for (let i = 0; i < limit; i++) {
      enforceRateLimit(makeRequest("/api/v1/profile/export", "4.4.4.4"), { group: "EXPORT", secondaryKey: "u1" });
    }
    const err = (() => {
      try {
        enforceRateLimit(makeRequest("/api/v1/profile/export", "4.4.4.4"), { group: "EXPORT", secondaryKey: "u1" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-RATE-001");
    expect((err as AppError).httpStatus).toBe(429);
    expect((err as AppError).details?.["retry_after_sec"]).toBeGreaterThanOrEqual(1);
  });

  it("clientIpFrom: ใช้ IP แรกของ x-forwarded-for และ fallback x-real-ip", () => {
    const r1 = new Request("http://localhost:3000/api/v1/me", {
      headers: { "x-forwarded-for": "10.0.0.9, 10.0.0.1" },
    });
    expect(clientIpFrom(r1)).toBe("10.0.0.9");
    const r2 = new Request("http://localhost:3000/api/v1/me", { headers: { "x-real-ip": "10.0.0.2" } });
    expect(clientIpFrom(r2)).toBe("10.0.0.2");
    expect(clientIpFrom(new Request("http://localhost:3000/api/v1/me"))).toBe("unknown");
  });
});

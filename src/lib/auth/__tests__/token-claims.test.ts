/**
 * unit tests — token-claims (gate r1 B1/M4 · Wave G P1)
 *
 * ประกอบ JWT ปลอมชิ้นส่วน payload จริง (header.signature ไม่เกี่ยว — helper
 * decode payload อย่างเดียว ไม่ตรวจลายเซ็น) ตรวจ:
 * - sub คืนเฉพาะ uuid จริง
 * - amr อ่าน method ทุก entry · รูปแบบอื่น (ไม่มี amr / entry ไม่ใช่ object /
 *   method ไม่ใช่ string) = null/ชุดว่าง
 * - token ขยะ/ว่าง = null ไม่ throw
 * ค่าอ้างอิงจาก probe จริงของ GoTrue v2.164 (2026-09-14): recovery = otp ·
 * password grant = password · refresh คง method เดิม
 */
import { describe, expect, it } from "vitest";

import { amrMethodsFromAccessToken, subFromAccessToken } from "../token-claims";

const UUID = "cb7ccb09-1111-4222-8333-444455556666";

/** ประกอบ JWT จาก payload (เนื้อหาเท่านั้นที่สำคัญ) */
function jwt(payload: Record<string, unknown>): string {
  const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${part}.signature`;
}

describe("subFromAccessToken", () => {
  it("payload มี sub เป็น uuid → คืนค่า", () => {
    expect(subFromAccessToken(jwt({ sub: UUID }))).toBe(UUID);
  });

  it("sub ไม่ใช่ uuid / ไม่มี / token ขยะ → null ไม่ throw", () => {
    expect(subFromAccessToken(jwt({ sub: "not-a-uuid" }))).toBeNull();
    expect(subFromAccessToken(jwt({ }))).toBeNull();
    expect(subFromAccessToken("")).toBeNull();
    expect(subFromAccessToken("garbage")).toBeNull();
    expect(subFromAccessToken("a.%%%not-base64%%%.c")).toBeNull();
  });
});

describe("amrMethodsFromAccessToken", () => {
  it("amr แบบ GoTrue (recovery จาก probe จริง) → [\"otp\"]", () => {
    const token = jwt({ amr: [{ method: "otp", timestamp: 1789328019 }] });
    expect(amrMethodsFromAccessToken(token)).toEqual(["otp"]);
  });

  it("amr ของ password grant → [\"password\"] (ต้องไม่ผ่าน guard recovery)", () => {
    const token = jwt({ amr: [{ method: "password", timestamp: 1 }] });
    expect(amrMethodsFromAccessToken(token)).toEqual(["password"]);
  });

  it("หลาย entry — คืนครบทุก method ที่เป็น string (ใช้ some() ตรวจที่ route)", () => {
    const token = jwt({
      amr: [
        { method: "password", timestamp: 1 },
        { method: "totp", timestamp: 2 },
      ],
    });
    expect(amrMethodsFromAccessToken(token)).toEqual(["password", "totp"]);
  });

  it("ไม่มี amr / amr ไม่ใช่ array / entry เพี้ยน → null หรือชุดว่าง ไม่ throw", () => {
    expect(amrMethodsFromAccessToken(jwt({}))).toBeNull();
    expect(amrMethodsFromAccessToken(jwt({ amr: "password" }))).toBeNull();
    expect(amrMethodsFromAccessToken(jwt({ amr: [{ nomethod: 1 }, 42, "x"] }))).toEqual([]);
    expect(amrMethodsFromAccessToken("")).toBeNull();
    expect(amrMethodsFromAccessToken("garbage")).toBeNull();
  });
});

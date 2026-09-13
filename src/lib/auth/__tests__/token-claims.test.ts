/**
 * unit tests — token-claims (gate r1 B1/M4 + r2 MINOR-2 · Wave G P1)
 *
 * ประกอบ JWT ปลอมชิ้นส่วน payload จริง (header.signature ไม่เกี่ยว — helper
 * decode payload อย่างเดียว ไม่ตรวจลายเซ็น) ตรวจ:
 * - sub คืนเฉพาะ uuid จริง
 * - amr อ่าน method ทุก entry · รูปแบบอื่น (ไม่มี amr / entry ไม่ใช่ object /
 *   method ไม่ใช่ string) = null/ชุดว่าง
 * - token ขยะ/ว่าง = null ไม่ throw
 * - accessTokenFromAuthCookie: อ่าน access token จาก cookie header ตรง ๆ
 *   (base เดี่ยว + chunk .N ตาม cookieEncoding ของ @supabase/ssr) โดยไม่ผ่าน
 *   SDK getSession — ผิดรูป = null ไม่ throw
 * ค่าอ้างอิงจาก probe จริงของ GoTrue v2.164 (2026-09-14): recovery = otp ·
 * password grant = password · refresh คง method เดิม
 */
import { describe, expect, it } from "vitest";

import {
  accessTokenFromAuthCookie,
  amrMethodsFromAccessToken,
  authCookieBaseName,
  subFromAccessToken,
} from "../token-claims";

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

describe("accessTokenFromAuthCookie (r2 MINOR-2 — ไม่ผ่าน SDK)", () => {
  const KONG = "http://kong:8000";
  const TOKEN = jwt({ sub: UUID });

  /** ค่า cookie ตาม cookieEncoding base64 ของ @supabase/ssr (แบบ tests/integration) */
  function cookieValue(session: Record<string, unknown>): string {
    return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  }

  it("base เดี่ยว — decode ได้ access_token (ท่าจริงของ @supabase/ssr)", () => {
    const header = `other=x; sb-kong-auth-token=${cookieValue({ access_token: TOKEN })}; y=1`;
    expect(accessTokenFromAuthCookie(header, KONG)).toBe(TOKEN);
  });

  it("chunk .0/.1/.2 — prefix base64- ที่หัว .0 เท่านั้น (SDK ใส่ก่อนแบ่ง chunk) · ต่อเนื้อก่อน decode", () => {
    const encoded = `base64-${Buffer.from(JSON.stringify({ access_token: TOKEN })).toString("base64url")}`;
    const cut = [encoded.slice(0, 12), encoded.slice(12, 30), encoded.slice(30)];
    const header = [
      `sb-kong-auth-token.2=${cut[2]}`,
      `sb-kong-auth-token.0=${cut[0]}`,
      `sb-kong-auth-token.1=${cut[1]}`,
    ].join("; ");
    expect(accessTokenFromAuthCookie(header, KONG)).toBe(TOKEN);
  });

  it("มีช่องว่าง (ขาด .1) — หยุดที่ .0 ตาม combineChunks ของ SDK → decode ไม่ผ่าน = null", () => {
    const encoded = `base64-${Buffer.from(JSON.stringify({ access_token: TOKEN })).toString("base64url")}`;
    const header = `sb-kong-auth-token.0=${encoded.slice(0, 12)}; sb-kong-auth-token.2=${encoded.slice(30)}`;
    expect(accessTokenFromAuthCookie(header, KONG)).toBeNull();
  });

  it("gate g-p1-r4 MINOR-1: base ค่าว่าง + chunk .0 สมบูรณ์ — truthiness ของ SDK ถือว่า base ไม่มี → อ่าน chunk ได้ token", () => {
    const encoded = `base64-${Buffer.from(JSON.stringify({ access_token: TOKEN })).toString("base64url")}`;
    const header = `sb-kong-auth-token=; sb-kong-auth-token.0=${encoded}`;
    expect(accessTokenFromAuthCookie(header, KONG)).toBe(TOKEN);
  });

  it("gate g-p1-r4 MINOR-1: chunk .1 ค่าว่างคั่น .0/.2 — SDK หยุดที่ค่าว่าง (ไม่ข้าม) → decode ไม่ผ่าน = null", () => {
    const encoded = `base64-${Buffer.from(JSON.stringify({ access_token: TOKEN })).toString("base64url")}`;
    const cut = [encoded.slice(0, 12), encoded.slice(12)];
    const header = `sb-kong-auth-token.0=${cut[0]}; sb-kong-auth-token.1=; sb-kong-auth-token.2=${cut[1]}`;
    expect(accessTokenFromAuthCookie(header, KONG)).toBeNull();
  });

  it("ไม่มี cookie / ไม่มีชื่อ base / JSON ไม่มี access_token / ขยะ → null ไม่ throw", () => {
    expect(accessTokenFromAuthCookie(null, KONG)).toBeNull();
    expect(accessTokenFromAuthCookie("", KONG)).toBeNull();
    expect(accessTokenFromAuthCookie("sb-other-auth-token=base64-AAAA", KONG)).toBeNull();
    expect(
      accessTokenFromAuthCookie(`sb-kong-auth-token=${cookieValue({ no_token: true })}`, KONG),
    ).toBeNull();
    expect(accessTokenFromAuthCookie("sb-kong-auth-token=base64-%zz", KONG)).toBeNull();
    expect(accessTokenFromAuthCookie("sb-kong-auth-token=", KONG)).toBeNull();
  });

  it("authCookieBaseName — สูตร sb-<host ต้นทาง>-auth-token ตรง ssr.ts", () => {
    expect(authCookieBaseName("http://kong:8000")).toBe("sb-kong-auth-token");
    expect(authCookieBaseName("https://abcd1234.supabase.co")).toBe("sb-abcd1234-auth-token");
  });
});

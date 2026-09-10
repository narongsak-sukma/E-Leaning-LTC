/**
 * unit tests — src/lib/supabase/cookies.ts (hardenedCookieOptions · SDS §5.1)
 *
 * @supabase/ssr ตั้ง default httpOnly:false + ให้ caller ส่ง options ทับได้ทั้งหมด —
 * ทุก flag ด้านล่างจึงต้องถูก "บังคับ" ทับ options ที่ส่งเข้ามาเสมอ (ไม่ merge ตาม)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hardenedCookieOptions } from "./cookies";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hardenedCookieOptions", () => {
  it("options ว่าง → flags เต็มชุด (path=/ httpOnly sameSite=lax)", () => {
    expect(hardenedCookieOptions(undefined)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false, // NODE_ENV=test
    });
  });

  it("บังคับทับ options ของ library ทุก flag (httpOnly:false / strict / path อื่น)", () => {
    const result = hardenedCookieOptions({
      httpOnly: false,
      sameSite: "strict",
      path: "/auth",
      maxAge: 3600,
    });
    expect(result).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    // ค่าอื่นที่ไม่ใช่ flag ความปลอดภัยส่งต่อได้
    expect(result.maxAge).toBe(3600);
  });

  it("secure=true เฉพาะ NODE_ENV=production (dev/test รัน http)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(hardenedCookieOptions(undefined).secure).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(hardenedCookieOptions(undefined).secure).toBe(false);
  });
});

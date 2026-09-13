/**
 * unit tests — establishRecoverySession (AUTH-004 · Wave G P1)
 *
 * เกิดจาก lead verify (gate ก่อน battery): เวอร์ชันแรกเรียก `await checkRateLimit(...)`
 * แล้วทิ้งผลลัพธ์ — checkRateLimit เป็น pure (ไม่ throw แบบ enforceRateLimit) จึงเท่ากับ
 * "นับแล้วปล่อยผ่าน": rate limit ไม่ถูกบังคับ + กิน quota AUTH ของ IP เปล่า ๆ — suite นี้
 * พิสูจน์ว่าเวอร์ชันแก้แล้วบังคับจริง (เกิน = ปฏิเสธก่อนแตะ setSession/GoTrue)
 *
 * mock ขอบตามแบบแผน actions.login-rate-limit.test.ts (W3) — ใช้ checkRateLimit จริง
 * (reset store ทุกเคส) เพื่อพิสูจน์การนับ/ตัดของกลไกเดียวกับ production
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ authPerMin: 3 }));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    supabaseUrl: "http://supabase.test.local",
    supabaseAnonKey: "test-anon-key",
    supabaseServiceRoleKey: "test-service-key",
    logLevel: "error",
    rateLimit: { authPerMin: state.authPerMin },
  }),
}));

const { headerBag, setSessionMock } = vi.hoisted(() => {
  const headerBag = { current: new Headers() };
  // type กว้างพอให้เคส error ใส่ {message} ได้ (ไม่งั้น infer เป็น error: null ค้าง)
  const setSessionMock = vi.fn(
    async (): Promise<{ error: { message: string } | null }> => ({ error: null }),
  );
  return { headerBag, setSessionMock };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerBag.current),
}));

vi.mock("@/lib/supabase/ssr", () => ({
  createSupabaseSsrClient: vi.fn(async () => ({
    auth: { setSession: setSessionMock },
  })),
}));

import { resetRateLimitStore } from "@/lib/rate-limit";
import { establishRecoverySession } from "./actions";

/** คู่ token ที่ผ่าน schema (รูปเดียวกับ fragment ของ GoTrue) */
const TOKENS = { access_token: "at.test.test", refresh_token: "rt-test" };

function setIp(ip: string): void {
  headerBag.current = new Headers({ "x-forwarded-for": ip });
}

beforeEach(() => {
  resetRateLimitStore();
  setSessionMock.mockClear();
  setSessionMock.mockResolvedValue({ error: null });
  setIp("10.88.0.1");
});

describe("establishRecoverySession — rate limit บังคับจริง (lead fix)", () => {
  it("schema ไม่ผ่าน (access_token ว่าง) → ERR-VAL-001 โดยไม่แตะ setSession", async () => {
    const result = await establishRecoverySession({ access_token: "", refresh_token: "rt" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ERR-VAL-001");
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it("ยังไม่ถึงขีด → setSession ถูกเรียก + ok:true", async () => {
    const result = await establishRecoverySession(TOKENS);
    expect(result.ok).toBe(true);
    expect(setSessionMock).toHaveBeenCalledTimes(1);
  });

  it(`เกินขีด AUTH (${3}/นาที จาก mock config) → ครั้งถัดไป ERR-RATE-001 โดย setSession ไม่ถูกเรียกอีก`, async () => {
    // 3 ครั้งแรกผ่าน (authPerMin = 3) — ครั้งที่ 4 ต้องถูกปฏิเสธก่อนแตะ GoTrue
    for (let i = 0; i < 3; i += 1) {
      const ok = await establishRecoverySession(TOKENS);
      expect(ok.ok).toBe(true);
    }
    expect(setSessionMock).toHaveBeenCalledTimes(3);
    const blocked = await establishRecoverySession(TOKENS);
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("ERR-RATE-001");
    // หัวใจของ fix: ไม่ใช่แค่ "นับ" — ต้องไม่ยิง setSession เมื่อเกิน
    expect(setSessionMock).toHaveBeenCalledTimes(3);
  });

  it("คีย์นับ = IP — IP อื่นเริ่มนับใหม่ (ผ่านได้แม้อีก bucket เต็ม)", async () => {
    for (let i = 0; i < 3; i += 1) {
      await establishRecoverySession(TOKENS);
    }
    const blocked = await establishRecoverySession(TOKENS);
    expect(blocked.ok).toBe(false);
    setIp("10.88.9.9");
    const other = await establishRecoverySession(TOKENS);
    expect(other.ok).toBe(true);
    expect(setSessionMock).toHaveBeenCalledTimes(4);
  });

  it("setSession  error (token ปลอม/ใช้แล้ว) → ERR-AUTH-005 ไม่เผยเหตุ", async () => {
    setSessionMock.mockResolvedValueOnce({ error: { message: "bad" } });
    const result = await establishRecoverySession(TOKENS);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ERR-AUTH-005");
  });
});

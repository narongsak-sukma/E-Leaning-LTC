/**
 * unit tests — rate limit ของ loginAction (Wave G P1 — ปิดช่อง server action ไม่มีการจำกัด)
 *
 * mock ทั้งขอบ (next/navigation, next/headers, @/lib/supabase/ssr, @/lib/auth/mfa,
 * @/lib/config) แต่ใช้ checkRateLimit **จริง** (reset ทุกเคส) เพื่อพิสูจน์:
 * - คีย์ = IP + อีเมล normalized นับแยกกัน (D12-11 — "ใครถึงขีดก่อนถูกจำกัดก่อน")
 * - เกิน = redirect /login?error=ERR-RATE-001 (รูปแบบ return เดิมของ action —
 *   หน้า login render ข้อความไทยจากทะเบียน error) โดย**ไม่ยิง GoTrue**
 * - flow login ปกติ + MFA ขั้น 1 ไม่พัง — ยังไม่ถึงขีด = เดินต่อเหมือนเดิมทุกประการ
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ authPerMin: 3 }));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    supabaseUrl: "http://supabase.test.local",
    supabaseAnonKey: "test-anon-key",
    supabaseServiceRoleKey: "test-service-key",
    logLevel: "error",
    rateLimit: { authPerMin: state.authPerMin },
    SIGNUP_CONSENT_POLICY_VERSION: "1",
  }),
}));

/** redirect ของ next/navigation throw เสมอ — จับ URL ที่ action สั่งไป */
const { RedirectError, redirectSpy } = vi.hoisted(() => {
  class RedirectError extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`REDIRECT:${url}`);
      this.url = url;
    }
  }
  const redirectSpy = vi.fn((url: string): never => {
    throw new RedirectError(url);
  });
  return { RedirectError, redirectSpy };
});

const { headerBag, cookieSet } = vi.hoisted(() => {
  const headerBag = { current: new Headers() };
  const cookieSet = vi.fn();
  return { headerBag, cookieSet };
});

vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerBag.current),
  cookies: vi.fn(async () => ({
    getAll: () => [],
    set: cookieSet,
  })),
}));

const { signInWithPasswordMock, listFactorsMock, ssrSetSessionMock } = vi.hoisted(() => ({
  signInWithPasswordMock: vi.fn(),
  listFactorsMock: vi.fn(),
  ssrSetSessionMock: vi.fn(async () => ({ error: null })),
}));

vi.mock("@/lib/auth/mfa", () => ({
  createStandaloneAuthClient: () => ({
    auth: {
      signInWithPassword: signInWithPasswordMock,
      mfa: { listFactors: listFactorsMock },
    },
  }),
  stashPendingMfaTokens: vi.fn(async () => "stash-id-1"),
  MFA_PENDING_COOKIE: "ltc_mfa_pending",
  MFA_PENDING_COOKIE_MAX_AGE: 300,
  firstVerifiedTotpFactor: (
    factors: readonly { factor_type: string; status: string; id: string }[],
  ): { id: string } | null => {
    const found = factors.find((f) => f.factor_type === "totp" && f.status === "verified");
    return found ? { id: found.id } : null;
  },
}));

vi.mock("@/lib/supabase/ssr", () => ({
  createSupabaseSsrClient: vi.fn(async () => ({
    auth: { setSession: ssrSetSessionMock },
  })),
}));

import { loginAction } from "./actions";
import { errorDefinition } from "@/lib/errors";
import { resetRateLimitStore } from "@/lib/rate-limit";

/** FormData ของฟอร์ม login (ไม่ใส่ next = default "/") */
function loginForm(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

/** เรียก loginAction แล้วคืน URL ที่ redirect (ไม่ throw ออกนอก) */
async function callLogin(formData: FormData): Promise<string> {
  try {
    await loginAction(formData);
    throw new Error("loginAction ต้อง redirect เสมอ — ถึงจุดนี้ไม่ได้");
  } catch (err: unknown) {
    if (err instanceof RedirectError) {
      return err.url;
    }
    throw err;
  }
}

/** IP ของ request จำลอง (headers() mock) */
function setIp(ip: string): void {
  headerBag.current = new Headers({ "x-forwarded-for": ip });
}

beforeEach(() => {
  state.authPerMin = 3;
  headerBag.current = new Headers({ "x-forwarded-for": "10.0.0.1" });
  cookieSet.mockClear();
  signInWithPasswordMock.mockReset();
  listFactorsMock.mockReset();
  ssrSetSessionMock.mockClear();
  resetRateLimitStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loginAction rate limit (group AUTH — ip+email)", () => {
  it("รหัสผ่านผิด 3 ครั้ง (จำกัด 3) ผ่านไปยิง GoTrueครบ → ครั้งที่ 4 ถูกตัด ERR-RATE-001 ก่อนแตะ GoTrue", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    // 3 ครั้งแรก: รหัสผ่านผิดตามปกติ — redirect กลับ /login พร้อม ERR-AUTH-002
    for (let i = 0; i < 3; i += 1) {
      const url = await callLogin(loginForm("user@test.dev", "wrong-pass"));
      expect(url).toBe("/login?error=ERR-AUTH-002");
    }
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(3);
    // ครั้งที่ 4: เกิน limit — ตัดก่อน GoTrue (จำนวน call ค้างที่ 3)
    const url4 = await callLogin(loginForm("user@test.dev", "wrong-pass"));
    expect(url4).toBe("/login?error=ERR-RATE-001");
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(3);
  });

  it("error mapping ไทย: ERR-RATE-001 ตามทะเบียน + URL redirect รูปแบบเดิมของ action", async () => {
    expect(errorDefinition("ERR-RATE-001").httpStatus).toBe(429);
    expect(errorDefinition("ERR-RATE-001").message).toBe(
      "มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่",
    );
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    for (let i = 0; i < 3; i += 1) {
      await callLogin(loginForm("user@test.dev", "wrong-pass"));
    }
    const url = await callLogin(loginForm("user@test.dev", "wrong-pass"));
    expect(url).toBe("/login?error=ERR-RATE-001");
  });

  it("คีย์รอง = อีเมล normalized (trim+lowercase) — เคสพิมพ์ต่างกันนับเป็นอีเมลเดียวกัน", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    // 3 ครั้งด้วยตัวพิมพ์ปน ๆ (zod normalize ก่อนเข้าคีย์รอง)
    await callLogin(loginForm("  User@Test.dev  ", "wrong-pass"));
    await callLogin(loginForm("USER@test.dev", "wrong-pass"));
    await callLogin(loginForm("user@TEST.DEV", "wrong-pass"));
    const url = await callLogin(loginForm("user@test.dev", "wrong-pass"));
    expect(url).toBe("/login?error=ERR-RATE-001");
  });

  it("IP เดียวกัน คนละอีเมล — นับรวมที่ IP (โดนตัดเมื่อ IP ถึงขีดก่อน)", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    await callLogin(loginForm("a@test.dev", "wrong-pass"));
    await callLogin(loginForm("b@test.dev", "wrong-pass"));
    await callLogin(loginForm("c@test.dev", "wrong-pass"));
    // อีเมลใหม่ที่ไม่เคยยิง — แต่ IP รวมแล้ว 3 ครั้ง = ถึงขีด
    const url = await callLogin(loginForm("other@test.dev", "wrong-pass"));
    expect(url).toBe("/login?error=ERR-RATE-001");
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(3);
  });

  it("คนละ IP — ไม่แชร์โควตา (IP ที่ถูกตัดไม่กระทบ IP อื่น)", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    for (let i = 0; i < 3; i += 1) {
      await callLogin(loginForm("user@test.dev", "wrong-pass"));
    }
    expect(await callLogin(loginForm("user@test.dev", "wrong-pass"))).toBe(
      "/login?error=ERR-RATE-001",
    );
    // IP อื่น + อีเมลใหม่ — นับของ IP 203.0.113.9 ยังเป็นศูนย์ ยิง GoTrue ได้ตามปกติ
    // (อีเมล user@test.dev เองถูกตัดแยกที่คีย์รองแล้ว — D12-11 นับแยกทั้งคู่)
    setIp("203.0.113.9");
    const url = await callLogin(loginForm("fresh@test.dev", "wrong-pass"));
    expect(url).toBe("/login?error=ERR-AUTH-002");
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(4);
  });

  it("หน้าต่าง 60 วิผ่าน → นับเริ่มใหม่ ใช้ได้อีก (authPerMin=3 · windowSec=60)", async () => {
    vi.useFakeTimers();
    const base = new Date("2026-09-13T10:00:00Z").getTime();
    vi.setSystemTime(base);
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    for (let i = 0; i < 3; i += 1) {
      await callLogin(loginForm("user@test.dev", "wrong-pass"));
    }
    expect(await callLogin(loginForm("user@test.dev", "wrong-pass"))).toBe(
      "/login?error=ERR-RATE-001",
    );
    // +61 วิ — หน้าต่างหมดอายุ นับใหม่
    vi.setSystemTime(base + 61_000);
    const url = await callLogin(loginForm("user@test.dev", "wrong-pass"));
    expect(url).toBe("/login?error=ERR-AUTH-002");
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(4);
  });

  it("login ปกติ (ไม่มี MFA) ไม่พัง — รหัสผ่านถูก → setSession ลง SSR client + redirect ไป next", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: {
        session: {
          access_token: "acc",
          refresh_token: "ref",
          user: { id: "11111111-1111-4111-8111-000000000001" },
        },
      },
      error: null,
    });
    listFactorsMock.mockResolvedValue({
      data: { all: [] },
      error: null,
    });
    const url = await callLogin(loginForm("user@test.dev", "correct-pass"));
    expect(url).toBe("/");
    expect(ssrSetSessionMock).toHaveBeenCalledWith({
      access_token: "acc",
      refresh_token: "ref",
    });
    expect(cookieSet).not.toHaveBeenCalledWith(
      "ltc_mfa_pending",
      expect.anything(),
      expect.anything(),
    );
  });

  it("MFA ขั้น 1 ไม่พัง — factor TOTP verified → เขียน cookie ltc_mfa_pending + พาไป /login/verify (ไม่เขียน session cookie)", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: {
        session: {
          access_token: "acc",
          refresh_token: "ref",
          user: { id: "11111111-1111-4111-8111-000000000001" },
        },
      },
      error: null,
    });
    listFactorsMock.mockResolvedValue({
      data: {
        all: [{ id: "fact-1", factor_type: "totp", status: "verified" }],
      },
      error: null,
    });
    const url = await callLogin(loginForm("mfa-user@test.dev", "correct-pass"));
    expect(url).toBe("/login/verify");
    // token จริงไม่ลง cookie ณ ขั้น password — cookie เก็บ stash uuid อย่างเดียว
    expect(ssrSetSessionMock).not.toHaveBeenCalled();
    expect(cookieSet).toHaveBeenCalledWith(
      "ltc_mfa_pending",
      "stash-id-1",
      expect.objectContaining({ httpOnly: true, path: "/login" }),
    );
  });
});

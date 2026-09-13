/**
 * password-reset.test — unit test ของ src/lib/auth/password-reset.ts (AUTH-004 · Wave G P1)
 *
 * เคสสัญญา (brief): redirect_to ถูก · ≥12 · ข้อความคงที่ · error mapping ไทย ·
 * ลำดับ orchestration (audit-first ของ request; update→logout→clear→audit ของ confirm)
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

import {
  buildResetPasswordUrl,
  classifyGoTruePutUserFailure,
  confirmPasswordReset,
  goTrueErrorCodeOf,
  ipHashOf,
  parsePasswordResetConfirm,
  parsePasswordResetRequest,
  PASSWORD_RESET_CONFIRM_ERROR_CODES,
  PASSWORD_RESET_DONE_MESSAGE,
  PASSWORD_RESET_POLICY_MESSAGE,
  PASSWORD_RESET_REQUEST_MESSAGE,
  requestPasswordReset,
  RESET_PASSWORD_PATH,
} from "../password-reset";
import type {
  PasswordResetConfirmDeps,
  PasswordResetRequestDeps,
} from "../password-reset";

// ─── สัญญาคงที่ (ข้อความ + redirect_to) ──────────────────────────────────────

describe("ข้อความคงที่ + redirect_to", () => {
  it("PASSWORD_RESET_REQUEST_MESSAGE ตรงสัญญา D72 (anti-enumeration)", () => {
    expect(PASSWORD_RESET_REQUEST_MESSAGE).toBe(
      "ถ้าอีเมลนี้มีในระบบ ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว",
    );
  });

  it("PASSWORD_RESET_DONE_MESSAGE ตรงสัญญา", () => {
    expect(PASSWORD_RESET_DONE_MESSAGE).toBe(
      "ตั้งรหัสผ่านใหม่สำเร็จแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่",
    );
  });

  it("PASSWORD_RESET_POLICY_MESSAGE ตรง copy หน้า register", () => {
    expect(PASSWORD_RESET_POLICY_MESSAGE).toBe(
      "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่",
    );
  });

  it("buildResetPasswordUrl ต่อ /reset-password และตัด slash ท้าย", () => {
    expect(buildResetPasswordUrl("http://localhost:3000/")).toBe(
      `http://localhost:3000${RESET_PASSWORD_PATH}`,
    );
  });

  it("RESET_PASSWORD_PATH = /reset-password (สัญญา path ที่ allowlist ครอบ)", () => {
    expect(RESET_PASSWORD_PATH).toBe("/reset-password");
  });
});

// ─── parsers ─────────────────────────────────────────────────────────────────

describe("parsePasswordResetRequest", () => {
  it("อีเมล valid → ok + normalize (trim + lowercase)", () => {
    const parsed = parsePasswordResetRequest({ email: "  User@Example.COM " });
    expect(parsed).toEqual({ ok: true, email: "user@example.com" });
  });

  it("ไม่ใช่ object / อีเมลเพี้ยน → fail", () => {
    expect(parsePasswordResetRequest(null)).toEqual({ ok: false });
    expect(parsePasswordResetRequest("str")).toEqual({ ok: false });
    expect(parsePasswordResetRequest({ email: "not-an-email" })).toEqual({ ok: false });
    expect(parsePasswordResetRequest({ email: 42 })).toEqual({ ok: false });
  });
});

describe("parsePasswordResetConfirm — ขอบเขต ≥12", () => {
  it("11 อักขระ → fail · 12 อักขระ → ok", () => {
    expect(parsePasswordResetConfirm({ password: "abcdefghijk" })).toEqual({ ok: false });
    expect(parsePasswordResetConfirm({ password: "abcdefghijkl" })).toEqual({
      ok: true,
      password: "abcdefghijkl",
    });
  });

  it("body ไม่ใช่ object → fail", () => {
    expect(parsePasswordResetConfirm(null)).toEqual({ ok: false });
    expect(parsePasswordResetConfirm(undefined)).toEqual({ ok: false });
    expect(parsePasswordResetConfirm({ password: 7 })).toEqual({ ok: false });
  });
});

// ─── ipHashOf (PB-13) ────────────────────────────────────────────────────────

describe("ipHashOf", () => {
  it("sha256(ip + anonKey fallback) — ตรงที่คำนวณเอง (salt = anon ชุดที่ตั้งไว้บนหัวไฟล์)", () => {
    const expected = createHash("sha256").update("1.2.3.4" + "anon").digest("hex");
    expect(ipHashOf("1.2.3.4")).toBe(expected);
  });

  it("คืน hex 64 ตัวอักษร", () => {
    expect(ipHashOf("10.1.1.1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── error mapping ───────────────────────────────────────────────────────────

describe("PASSWORD_RESET_CONFIRM_ERROR_CODES", () => {
  it("no_session→ERR-AUTH-001 · expired_link→ERR-AUTH-005 · weak_password→ERR-VAL-001 · system/audit_failed→ERR-SYS-002", () => {
    expect(PASSWORD_RESET_CONFIRM_ERROR_CODES).toEqual({
      no_session: "ERR-AUTH-001",
      expired_link: "ERR-AUTH-005",
      weak_password: "ERR-VAL-001",
      system: "ERR-SYS-002",
      audit_failed: "ERR-SYS-002",
    });
  });
});

describe("classifyGoTruePutUserFailure", () => {
  it("422 + weak_password → weak_password", () => {
    expect(classifyGoTruePutUserFailure(422, "weak_password")).toBe("weak_password");
  });

  it("422 + code อื่น → system", () => {
    expect(classifyGoTruePutUserFailure(422, "over_email_send_rate_limit")).toBe("system");
  });

  it("400/401/403 → expired_link · 429/500 → system · error_code null", () => {
    expect(classifyGoTruePutUserFailure(400, null)).toBe("expired_link");
    expect(classifyGoTruePutUserFailure(401, null)).toBe("expired_link");
    expect(classifyGoTruePutUserFailure(403, null)).toBe("expired_link");
    expect(classifyGoTruePutUserFailure(429, null)).toBe("system");
    expect(classifyGoTruePutUserFailure(500, null)).toBe("system");
  });
});

describe("goTrueErrorCodeOf", () => {
  it("422 + body error_code → ค่านั้น · ที่เหลือ → null", () => {
    expect(goTrueErrorCodeOf(422, '{"error_code":"weak_password","msg":"x"}')).toBe("weak_password");
    expect(goTrueErrorCodeOf(422, "not-json")).toBeNull();
    expect(goTrueErrorCodeOf(400, '{"error_code":"weak_password"}')).toBeNull();
    expect(goTrueErrorCodeOf(422, null)).toBeNull();
  });
});

// ─── requestPasswordReset — audit-first + masking ────────────────────────────

describe("requestPasswordReset", () => {
  const input = {
    email: "user@example.test",
    redirectTo: "http://localhost:3000/reset-password",
    ipHash: "a".repeat(64),
    requestId: "req-1",
  };

  function makeDeps() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        audit: vi.fn<PasswordResetRequestDeps["audit"]>(async () => {
          calls.push("audit");
          return { ok: true };
        }),
        recover: vi.fn<PasswordResetRequestDeps["recover"]>(async (email, redirectTo) => {
          calls.push("recover");
          return { ok: true, email, redirectTo };
        }),
      },
    };
  }

  it("ลำดับ audit → recover · recover ได้ (email, redirectTo) ครบ", async () => {
    const { calls, deps } = makeDeps();
    const result = await requestPasswordReset(input, deps);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["audit", "recover"]);
    expect(deps.audit).toHaveBeenCalledWith("a".repeat(64), "req-1");
    expect(deps.recover).toHaveBeenCalledWith("user@example.test", "http://localhost:3000/reset-password");
  });

  it("recover ผลใด ๆ (429/500/throw) → ok:true เสมอ (masking — anti-enumeration)", async () => {
    const cases: PasswordResetRequestDeps["recover"][] = [
      async () => ({ ok: false, status: 429 }),
      async () => ({ ok: false, status: 500 }),
      async () => {
        throw new Error("network");
      },
    ];
    for (const recover of cases) {
      const { deps } = makeDeps();
      deps.recover = vi.fn(recover);
      const result = await requestPasswordReset(input, deps);
      expect(result).toEqual({ ok: true });
    }
  });

  it("audit ล้ม 2 ครั้ง → ERR-SYS-002 · recover ไม่ถูกเรียก", async () => {
    const { calls, deps } = makeDeps();
    deps.audit = vi.fn<PasswordResetConfirmDeps["audit"]>(async () => {
      calls.push("audit");
      return { ok: false };
    });
    const result = await requestPasswordReset(input, deps);
    expect(result).toEqual({ ok: false, errorCode: "ERR-SYS-002" });
    expect(deps.audit).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["audit", "audit"]);
  });

  it("audit ล้ม 1 ครั้งแล้วสำเร็จ → recover ถูกเรียก", async () => {
    const { calls, deps } = makeDeps();
    let attempt = 0;
    deps.audit = vi.fn<PasswordResetConfirmDeps["audit"]>(async () => {
      attempt += 1;
      calls.push("audit");
      return attempt === 1 ? ({ ok: false } as const) : ({ ok: true } as const);
    });
    const result = await requestPasswordReset(input, deps);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["audit", "audit", "recover"]);
  });
});

// ─── confirmPasswordReset — ลำดับ update→logout→clear→audit ───────────────────

describe("confirmPasswordReset", () => {
  const input = {
    accessToken: "access-token",
    password: "abcdefghijkl",
    ipHash: "b".repeat(64),
    requestId: "req-2",
  };

  function makeDeps() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        updatePassword: vi.fn<PasswordResetConfirmDeps["updatePassword"]>(async () => {
          calls.push("update");
          return "ok";
        }),
        logoutGlobal: vi.fn<PasswordResetConfirmDeps["logoutGlobal"]>(async () => {
          calls.push("logout");
          return "ok";
        }),
        audit: vi.fn<PasswordResetConfirmDeps["audit"]>(async () => {
          calls.push("audit");
          return { ok: true };
        }),
        clearCookies: vi.fn<PasswordResetConfirmDeps["clearCookies"]>(() => {
          calls.push("clear");
        }),
      },
    };
  }

  it("happy path — ลำดับ update→logout→clear→audit ครบตามสัญญา", async () => {
    const { calls, deps } = makeDeps();
    const result = await confirmPasswordReset(input, deps);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["update", "logout", "clear", "audit"]);
    expect(deps.updatePassword).toHaveBeenCalledWith("access-token", "abcdefghijkl");
    expect(deps.audit).toHaveBeenCalledWith("b".repeat(64), "req-2");
  });

  it("update ล้ม (weak_password) → หยุดทันที ไม่ logout/clear/audit", async () => {
    const { calls, deps } = makeDeps();
    deps.updatePassword = vi.fn<PasswordResetConfirmDeps["updatePassword"]>(async () => {
      calls.push("update");
      return "weak_password" as const;
    });
    const result = await confirmPasswordReset(input, deps);
    expect(result).toEqual({ ok: false, failure: "weak_password" });
    expect(calls).toEqual(["update"]);
  });

  it("update ล้ม (expired_link) → หยุดทันที (ลิงก์เสีย — ไม่แตะต้องอะไรต่อ)", async () => {
    const { calls, deps } = makeDeps();
    deps.updatePassword = vi.fn<PasswordResetConfirmDeps["updatePassword"]>(async () => {
      calls.push("update");
      return "expired_link" as const;
    });
    const result = await confirmPasswordReset(input, deps);
    expect(result).toEqual({ ok: false, failure: "expired_link" });
    expect(calls).toEqual(["update"]);
  });

  it("update ล้มแบบ system → failure system", async () => {
    const { calls, deps } = makeDeps();
    deps.updatePassword = vi.fn<PasswordResetConfirmDeps["updatePassword"]>(async () => {
      calls.push("update");
      return "system" as const;
    });
    const result = await confirmPasswordReset(input, deps);
    expect(result).toEqual({ ok: false, failure: "system" });
    expect(calls).toEqual(["update"]);
  });

  it("logout ล้ม → ไม่ clear cookies ไม่ audit → failure system (กด retry ได้)", async () => {
    const { calls, deps } = makeDeps();
    deps.logoutGlobal = vi.fn<PasswordResetConfirmDeps["logoutGlobal"]>(async () => {
      calls.push("logout");
      return "system" as const;
    });
    const result = await confirmPasswordReset(input, deps);
    expect(result).toEqual({ ok: false, failure: "system" });
    expect(calls).toEqual(["update", "logout"]);
  });

  it("audit ล้ม 2 ครั้ง → failure audit_failed (cookie ถูกล้างไปแล้วเพราะ revoke สำเร็จ — gate r1 M3)", async () => {
    const { calls, deps } = makeDeps();
    deps.audit = vi.fn<PasswordResetConfirmDeps["audit"]>(async () => {
      calls.push("audit");
      return { ok: false } as const;
    });
    const result = await confirmPasswordReset(input, deps);
    expect(result).toEqual({ ok: false, failure: "audit_failed" });
    expect(calls).toEqual(["update", "logout", "clear", "audit", "audit"]);
  });
});

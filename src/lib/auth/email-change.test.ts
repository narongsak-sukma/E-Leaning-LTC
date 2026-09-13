/**
 * email-change.test — unit test ของ src/lib/auth/email-change.ts (Wave F · D-f-2)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { getConfig } from "../config";
import { checkRateLimit, resetRateLimitStore } from "../rate-limit";

process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

import {
  EMAIL_CHANGE_CALLBACK_PATH,
  EMAIL_CHANGE_ERROR_CODES,
  EMAIL_CHANGE_MESSAGES,
  buildEmailChangeCallbackUrl,
  classifyAuditRpcError,
  classifyUpdateUserError,
  createEmailChangeSchema,
  emailChangeMfaRejected,
  hashEmailForAudit,
  requestEmailChange,
  type EmailChangeDeps,
  type EmailChangeFailure,
} from "./email-change";

// ─── hashEmailForAudit ───────────────────────────────────────────────────────

describe("hashEmailForAudit", () => {
  it("fixture new-probe@example.net = sha256 utf8 ที่คำนวณเองด้วย node:crypto", () => {
    const expected = createHash("sha256").update("new-probe@example.net", "utf8").digest("hex");
    expect(hashEmailForAudit("new-probe@example.net")).toBe(expected);
  });

  it("normalize แบบ trigger 0044 — trim + lowercase ก่อน hash เสมอ", () => {
    const expected = createHash("sha256").update("new-probe@example.net", "utf8").digest("hex");
    expect(hashEmailForAudit("  New-Probe@Example.NET ")).toBe(expected);
  });

  it("คืน hex 64 ตัวอักษรพิมพ์เล็ก (รูปแบบที่ RPC 0044 ยอมรับ)", () => {
    expect(hashEmailForAudit("a@b.test")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── buildEmailChangeCallbackUrl ─────────────────────────────────────────────

describe("buildEmailChangeCallbackUrl", () => {
  it("ต่อ path callback บน origin ที่ให้มา และตัด slash ท้าย", () => {
    expect(buildEmailChangeCallbackUrl("http://localhost:3000/")).toBe(
      `http://localhost:3000${EMAIL_CHANGE_CALLBACK_PATH}`,
    );
  });
});

// ─── emailChangeMfaRejected — ตารางความจริง guard MFA ────────────────────────

describe("emailChangeMfaRejected (guard truth table)", () => {
  it("citizen aal1 → ผ่าน (ไม่ถูกบังคับ MFA)", () => {
    expect(emailChangeMfaRejected(["citizen"], "aal1")).toBe(false);
  });

  it("instructor aal1 → ปฏิเสธ", () => {
    expect(emailChangeMfaRejected(["instructor"], "aal1")).toBe(true);
  });

  it("instructor aal2 → ผ่าน", () => {
    expect(emailChangeMfaRejected(["instructor"], "aal2")).toBe(false);
  });

  it("staff:viewer aal1 → ปฏิเสธ · super_admin aal2 → ผ่าน · ไม่มีบทบาท aal1 → ผ่าน", () => {
    expect(emailChangeMfaRejected(["staff:viewer"], "aal1")).toBe(true);
    expect(emailChangeMfaRejected(["super_admin"], "aal2")).toBe(false);
    expect(emailChangeMfaRejected([], "aal1")).toBe(false);
  });
});

// ─── createEmailChangeSchema (zod) ───────────────────────────────────────────

describe("createEmailChangeSchema", () => {
  const CURRENT = "old@example.com";

  it("อีเมลใหม่ถูกต้อง — trim + lowercase แล้วผ่าน", () => {
    const parsed = createEmailChangeSchema(CURRENT).safeParse({
      email: "  New@Example.COM ",
      password: "Integration#2026",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe("new@example.com");
    }
  });

  it("เท่ากับอีเมลปัจจุบัน (ต่างแค่ case) → ปฏิเสธ", () => {
    const parsed = createEmailChangeSchema(CURRENT).safeParse({
      email: "OLD@EXAMPLE.COM",
      password: "x",
    });
    expect(parsed.success).toBe(false);
  });

  it("รูปแบบอีเมลเพี้ยน → ปฏิเสธ", () => {
    const parsed = createEmailChangeSchema(CURRENT).safeParse({ email: "not-an-email", password: "x" });
    expect(parsed.success).toBe(false);
  });

  it("ยาวเกิน 254 → ปฏิเสธ", () => {
    const longEmail = `${"a".repeat(250)}@example.com`;
    expect(longEmail.length).toBeGreaterThan(254);
    const parsed = createEmailChangeSchema(CURRENT).safeParse({ email: longEmail, password: "x" });
    expect(parsed.success).toBe(false);
  });

  it("รหัสผ่านว่าง → ปฏิเสธ", () => {
    const parsed = createEmailChangeSchema(CURRENT).safeParse({ email: "new@example.com", password: "" });
    expect(parsed.success).toBe(false);
  });

  it("currentEmail ไม่รู้จัก (null) → ไม่บังคับต่างจากอีเมลปัจจุบัน", () => {
    const parsed = createEmailChangeSchema(null).safeParse({
      email: "new@example.com",
      password: "x",
    });
    expect(parsed.success).toBe(true);
  });
});

// ─── classifyUpdateUserError / classifyAuditRpcError ─────────────────────────

describe("classifyUpdateUserError", () => {
  it("email_exists → email_taken_masked (กัน enumeration — ตอบเหมือนสำเร็จ)", () => {
    expect(classifyUpdateUserError({ code: "email_exists" })).toBe("email_taken_masked");
  });

  it("over_*_rate_limit → rate_limited · ที่เหลือ opaque เป็น system", () => {
    expect(classifyUpdateUserError({ code: "over_email_send_rate_limit" })).toBe("rate_limited");
    expect(classifyUpdateUserError({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(classifyUpdateUserError({ code: null })).toBe("system");
    expect(classifyUpdateUserError({})).toBe("system");
  });
});

describe("EMAIL_CHANGE_MESSAGES / EMAIL_CHANGE_ERROR_CODES", () => {
  it("ทุก failure มี code ทะเบียน + ข้อความไทยครบ (รวม sent) — Thai-first copy ครบชุด", () => {
    const failures: EmailChangeFailure[] = [
      "validation",
      "password_mismatch",
      "mfa_required",
      "rate_limited",
      "system",
    ];
    for (const failure of failures) {
      expect(EMAIL_CHANGE_ERROR_CODES[failure]).toMatch(/^ERR-/);
      expect(EMAIL_CHANGE_MESSAGES[failure].length).toBeGreaterThan(0);
    }
    expect(EMAIL_CHANGE_MESSAGES.sent.length).toBeGreaterThan(0);
  });
});

describe("classifyAuditRpcError", () => {
  it("mfa_required ในข้อความ → mfa_required · ที่เหลือ system", () => {
    expect(classifyAuditRpcError("ERR-AUTH-004|mfa_required")).toBe("mfa_required");
    expect(classifyAuditRpcError("ERR-VAL-001|hash_format")).toBe("system");
    expect(classifyAuditRpcError(null)).toBe("system");
  });
});

// ─── requestEmailChange — orchestration ──────────────────────────────────────

describe("requestEmailChange (orchestration)", () => {
  const CURRENT = "old@example.com";
  const NEW = "new@example.com";
  const PWD = "Integration#2026";
  const CALL = "http://localhost:3000/email-change/callback";

  interface MakeDepsOptions {
    verify?: "ok" | "invalid" | "rate_limited" | "system";
    update?: "ok" | "email_exists" | "rate" | "boom";
    audit?: "ok" | "mfa_required" | "boom";
  }

  /** mock deps ที่บันทึกลำดับการเรียก: verify -> audit -> update (gate r1 F3: audit ก่อน mutation) */
  function makeDeps(options: MakeDepsOptions): EmailChangeDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      verifyPassword: async () => {
        calls.push("verify");
        return options.verify ?? "ok";
      },
      updateUserEmail: async (email, redirectTo) => {
        calls.push("update");
        expect(email).toBe(NEW);
        expect(redirectTo).toBe(CALL);
        if (options.update === "email_exists") {
          return { ok: false, code: "email_exists", message: "dup" };
        }
        if (options.update === "rate") {
          return { ok: false, code: "over_email_send_rate_limit", message: "slow" };
        }
        if (options.update === "boom") {
          return { ok: false, code: null, message: "boom" };
        }
        return { ok: true };
      },
      auditRequest: async (sha256) => {
        calls.push("audit");
        expect(sha256).toBe(hashEmailForAudit(NEW));
        if (options.audit === "mfa_required") {
          return { ok: false, message: "ERR-AUTH-004|mfa_required" };
        }
        if (options.audit === "boom") {
          return { ok: false, message: "boom" };
        }
        return { ok: true };
      },
    };
  }

  function input(overrides: Partial<Parameters<typeof requestEmailChange>[0]> = {}) {
    return {
      newEmail: NEW,
      password: PWD,
      currentEmail: CURRENT,
      roles: ["citizen"] as readonly string[],
      aal: "aal1" as const,
      rateLimitIp: "10.0.0.1",
      callbackUrl: CALL,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetRateLimitStore();
  });

  it("normal path: order verify -> audit -> update, result ok with correct sha256", async () => {
    const deps = makeDeps({});
    const result = await requestEmailChange(input(), deps);
    expect(result).toEqual({
      ok: true,
      newEmail: NEW,
      newEmailSha256: hashEmailForAudit(NEW),
    });
    expect(deps.calls).toEqual(["verify", "audit", "update"]);
  });

  it("wrong password -> password_mismatch, updateUser+audit never called", async () => {
    const deps = makeDeps({ verify: "invalid" });
    const result = await requestEmailChange(input(), deps);
    expect(result).toEqual({ ok: false, failure: "password_mismatch", errorCode: "ERR-AUTH-002" });
    expect(deps.calls).toEqual(["verify"]);
  });

  it("re-auth rate limited -> rate_limited, updateUser+audit never called", async () => {
    const deps = makeDeps({ verify: "rate_limited" });
    const result = await requestEmailChange(input(), deps);
    expect(result).toEqual({ ok: false, failure: "rate_limited", errorCode: "ERR-RATE-001" });
    expect(deps.calls).toEqual(["verify"]);
  });

  it("instructor aal1 (correct password) -> mfa_required, updateUser+audit never called", async () => {
    const deps = makeDeps({});
    const result = await requestEmailChange(input({ roles: ["instructor"], aal: "aal1" }), deps);
    expect(result).toEqual({ ok: false, failure: "mfa_required", errorCode: "ERR-AUTH-004" });
    expect(deps.calls).toEqual(["verify"]);
  });

  it("instructor aal2 -> passes all steps (audit called)", async () => {
    const deps = makeDeps({});
    const result = await requestEmailChange(input({ roles: ["instructor"], aal: "aal2" }), deps);
    expect(result.ok).toBe(true);
    expect(deps.calls).toEqual(["verify", "audit", "update"]);
  });

  it("email_exists -> masked as success · คำขอยังถูก audit ก่อน (หลักฐานภายใน sha256 ล้วน)", async () => {
    const deps = makeDeps({ update: "email_exists" });
    const result = await requestEmailChange(input(), deps);
    expect(result).toEqual({ ok: true, newEmail: NEW, newEmailSha256: hashEmailForAudit(NEW) });
    expect(deps.calls).toEqual(["verify", "audit", "update"]);
  });

  it("updateUser unknown failure -> system (คำขอถูก audit ไปแล้ว — ตรงความหมาย REQUEST)", async () => {
    const deps = makeDeps({ update: "boom" });
    const result = await requestEmailChange(input(), deps);
    expect(result).toEqual({ ok: false, failure: "system", errorCode: "ERR-SYS-001" });
    expect(deps.calls).toEqual(["verify", "audit", "update"]);
  });

  it("audit mfa_required (role changed mid-flight) -> ERR-AUTH-004 · updateUser ไม่ถูกเรียกเด็ดขาด", async () => {
    const deps = makeDeps({ audit: "mfa_required" });
    const result = await requestEmailChange(input(), deps);
    expect(result).toEqual({ ok: false, failure: "mfa_required", errorCode: "ERR-AUTH-004" });
    // gate r1 F3: หัวใจของการสลับลำดับ — RPC ปฏิเสธ = ไม่มี mutation (เดิม
    // updateUser ทำไปแล้วก่อน RPC ตรวจ จึงเปลี่ยนจริงแต่บอกผู้ใช้ว่าล้มเหลว)
    expect(deps.calls).toEqual(["verify", "audit"]);
  });

  it("audit unknown failure -> system", async () => {
    const deps = makeDeps({ audit: "boom" });
    const result = await requestEmailChange(input(), deps);
    expect(result).toEqual({ ok: false, failure: "system", errorCode: "ERR-SYS-001" });
  });

  it("invalid email form -> validation, no dep call", async () => {
    const deps = makeDeps({});
    const result = await requestEmailChange(input({ newEmail: "not-an-email" }), deps);
    expect(result).toEqual({ ok: false, failure: "validation", errorCode: "ERR-VAL-001" });
    expect(deps.calls).toEqual([]);
  });

  it("empty password -> validation, no dep call", async () => {
    const deps = makeDeps({});
    const result = await requestEmailChange(input({ password: "" }), deps);
    expect(result).toEqual({ ok: false, failure: "validation", errorCode: "ERR-VAL-001" });
    expect(deps.calls).toEqual([]);
  });

  it("AUTH rate limit per ip -> rate_limited before any dep call", async () => {
    const ip = "10.9.9.9";
    const deps = makeDeps({});
    const max = getConfig().rateLimit.authPerMin;
    // เติม counter ของ ip นี้ให้เต็มโควตาของหน้าต่างปัจจุบัน
    for (let i = 0; i < max; i += 1) {
      checkRateLimit("AUTH", { ip, secondary: CURRENT });
    }
    const result = await requestEmailChange(input({ rateLimitIp: ip }), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("rate_limited");
    }
    expect(deps.calls).toEqual([]);
  });
});


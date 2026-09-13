/**
 * password-change.test — unit test ของ src/lib/auth/password-change.ts (AUTH-005 · Wave G P1 · D72)
 */

import { describe, expect, it } from "vitest";

process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

import {
  changePassword,
  classifyUpdateUserPasswordError,
  PASSWORD_CHANGE_ERROR_CODES,
  PASSWORD_CHANGE_MESSAGES,
  PASSWORD_MIN_LENGTH,
  validatePasswordChange,
  type PasswordChangeDeps,
} from "./password-change";

// ─── fixture ร่วม ────────────────────────────────────────────────────────────

const BASE_INPUT = {
  userId: "00000000-0000-0000-0000-000000000001",
  email: "pc-user@example.test",
  currentPassword: "CurrentPass#2026",
  newPassword: "NewSecret#2026x",
  sessionId: "11111111-2222-4333-8444-555555555555",
};

interface RecordedCalls {
  readonly verify: readonly { email: string; password: string }[];
  readonly update: readonly string[];
  readonly audit: readonly { userId: string; sessionId: string }[];
}

/** deps จำลอง + บันทึกการเรียกทุกครั้ง (พิสูจน์ลำดับ verify → update → audit) */
function fakeDeps(
  overrides: Partial<PasswordChangeDeps> = {},
): { deps: PasswordChangeDeps; calls: RecordedCalls } {
  const verify: { email: string; password: string }[] = [];
  const update: string[] = [];
  const audit: { userId: string; sessionId: string }[] = [];
  return {
    deps: {
      verifyCurrentPassword: async (email, password) => {
        verify.push({ email, password });
        return "ok";
      },
      updateUserPassword: async (password) => {
        update.push(password);
        return { ok: true };
      },
      auditPasswordChange: async (userId, sessionId) => {
        audit.push({ userId, sessionId });
        return { ok: true };
      },
      ...overrides,
    },
    calls: { verify, update, audit },
  };
}

// ─── validatePasswordChange — ตารางความจริงของ validation ────────────────────

describe("validatePasswordChange", () => {
  it("ผ่านทุกข้อ (ครบ 3 ฟิลด์) → null", () => {
    expect(
      validatePasswordChange({
        currentPassword: "OldPass#2026",
        newPassword: "NewSecret#2026x",
        confirmPassword: "NewSecret#2026x",
      }),
    ).toBeNull();
  });

  it("currentPassword ว่าง → validation · รหัสใหม่ < 12 → password_policy", () => {
    expect(
      validatePasswordChange({ currentPassword: "", newPassword: "NewSecret#2026x" }),
    ).toBe("validation");
    expect(
      validatePasswordChange({ currentPassword: "OldPass#2026", newPassword: "short12less" }),
    ).toBe("password_policy");
  });

  it("รหัสใหม่ = ปัจจุบัน → same_password · ยืนยันไม่ตรง → confirm_mismatch", () => {
    expect(
      validatePasswordChange({
        currentPassword: "OldPass#2026",
        newPassword: "OldPass#2026",
        confirmPassword: "OldPass#2026",
      }),
    ).toBe("same_password");
    expect(
      validatePasswordChange({
        currentPassword: "OldPass#2026",
        newPassword: "NewSecret#2026x",
        confirmPassword: "Different#2026",
      }),
    ).toBe("confirm_mismatch");
  });

  it("ไม่ส่ง confirmPassword (เส้นทาง REST) → ไม่ตรวจ confirm — ผ่าน", () => {
    expect(
      validatePasswordChange({ currentPassword: "OldPass#2026", newPassword: "NewSecret#2026x" }),
    ).toBeNull();
  });

  it("ค่าความยาวขั้นต่ำตรง GOTRUE_PASSWORD_MIN_LENGTH = 12", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(validatePasswordChange({ currentPassword: "x", newPassword: "a".repeat(12) })).toBeNull();
    expect(validatePasswordChange({ currentPassword: "x", newPassword: "a".repeat(11) })).toBe(
      "password_policy",
    );
  });
});

// ─── ข้อความไทยตามสัญญา D72 (คำต่อคำ) ────────────────────────────────────────

describe("PASSWORD_CHANGE_MESSAGES — สัญญา D72", () => {
  it("wrong_current ตรงสัญญาคำต่อคำ", () => {
    expect(PASSWORD_CHANGE_MESSAGES.wrong_current).toBe("รหัสผ่านปัจจุบันไม่ถูกต้อง");
  });

  it("password_policy ตรงข้อความนโยบายของหน้า register คำต่อคำ", () => {
    expect(PASSWORD_CHANGE_MESSAGES.password_policy).toBe(
      "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่",
    );
  });

  it("same_password / confirm_mismatch เป็นข้อความไทยเจาะจง", () => {
    expect(PASSWORD_CHANGE_MESSAGES.same_password).toBe(
      "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน",
    );
    expect(PASSWORD_CHANGE_MESSAGES.confirm_mismatch).toBe(
      "รหัสผ่านใหม่กับการยืนยันรหัสผ่านใหม่ไม่ตรงกัน",
    );
  });
});

// ─── PASSWORD_CHANGE_ERROR_CODES — ตาราง code ทะเบียน ────────────────────────

describe("PASSWORD_CHANGE_ERROR_CODES", () => {
  it("แมป failure ทุกตัวเป็น code ทะเบียนถูกต้อง", () => {
    expect(PASSWORD_CHANGE_ERROR_CODES.validation).toBe("ERR-VAL-001");
    expect(PASSWORD_CHANGE_ERROR_CODES.password_policy).toBe("ERR-VAL-001");
    expect(PASSWORD_CHANGE_ERROR_CODES.same_password).toBe("ERR-VAL-001");
    expect(PASSWORD_CHANGE_ERROR_CODES.confirm_mismatch).toBe("ERR-VAL-001");
    expect(PASSWORD_CHANGE_ERROR_CODES.wrong_current).toBe("ERR-AUTH-002");
    expect(PASSWORD_CHANGE_ERROR_CODES.rate_limited).toBe("ERR-RATE-001");
    expect(PASSWORD_CHANGE_ERROR_CODES.audit_failed).toBe("ERR-SYS-002");
    expect(PASSWORD_CHANGE_ERROR_CODES.system).toBe("ERR-SYS-001");
  });
});

// ─── changePassword — ลำดับ verify → update → audit + แผนที่ failure ─────────

describe("changePassword — orchestration", () => {
  it("สำเร็จครบขั้น: verify(email,current) → update(ใหม่) → audit(userId, sessionId) ตามลำดับ", async () => {
    const { deps, calls } = fakeDeps();
    const result = await changePassword(BASE_INPUT, deps);
    expect(result).toEqual({
      ok: true,
      userId: BASE_INPUT.userId,
      sessionId: BASE_INPUT.sessionId,
    });
    expect(calls.verify).toEqual([{ email: BASE_INPUT.email, password: BASE_INPUT.currentPassword }]);
    expect(calls.update).toEqual([BASE_INPUT.newPassword]);
    expect(calls.audit).toEqual([
      { userId: BASE_INPUT.userId, sessionId: BASE_INPUT.sessionId },
    ]);
  });

  it("รหัสปัจจุบันผิด → wrong_current (401) · **update+audit ต้องไม่ถูกเรียก** (พิสูจน์ลำดับ)", async () => {
    const { deps, calls } = fakeDeps({
      verifyCurrentPassword: async () => "invalid",
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result).toEqual({
      ok: false,
      failure: "wrong_current",
      errorCode: "ERR-AUTH-002",
      errorMessage: "รหัสผ่านปัจจุบันไม่ถูกต้อง",
    });
    expect(calls.verify.length).toBeLessThanOrEqual(1);
    expect(calls.update.length).toBe(0);
    expect(calls.audit.length).toBe(0);
  });

  it("validation ล้ม (สั้น) → password_policy · verify ต้องไม่ถูกเรียก", async () => {
    const { deps, calls } = fakeDeps();
    const result = await changePassword(
      { ...BASE_INPUT, newPassword: "สั้น" },
      deps,
    );
    expect(result).toMatchObject({ failure: "password_policy" });
    expect(calls.verify.length).toBe(0);
    expect(calls.update.length).toBe(0);
  });

  it("GoTrue updateUser ล้ม weak_password → password_policy · audit ไม่ถูกเรียก", async () => {
    const { deps, calls } = fakeDeps({
      updateUserPassword: async () => ({ ok: false, code: "weak_password", message: "..." }),
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result).toMatchObject({ failure: "password_policy" });
    expect(calls.audit.length).toBe(0);
  });

  it("GoTrue updateUser ล้ม over_request_rate_limit → rate_limited", async () => {
    const { deps } = fakeDeps({
      updateUserPassword: async () => ({ ok: false, code: "over_request_rate_limit", message: "..." }),
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result).toMatchObject({ failure: "rate_limited", errorCode: "ERR-RATE-001" });
  });

  it("GoTrue updateUser ล้ม code แปลกปลอม → system (opaque)", async () => {
    const { deps } = fakeDeps({
      updateUserPassword: async () => ({ ok: false, code: null, message: "..." }),
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result).toMatchObject({ failure: "system" });
  });

  it("audit RPC ล้ม → audit_failed (ERR-SYS-002) — fail-closed แม้ GoTrue เปลี่ยนแล้ว", async () => {
    const { deps } = fakeDeps({
      auditPasswordChange: async () => ({ ok: false, message: "permission denied" }),
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result).toMatchObject({ failure: "audit_failed", errorCode: "ERR-SYS-002" });
  });
});

// ─── classifyUpdateUserPasswordError ─────────────────────────────────────────

describe("classifyUpdateUserPasswordError", () => {
  it("weak_password → password_policy · over_*_rate_limit → rate_limited · ที่เหลือ → system", () => {
    expect(classifyUpdateUserPasswordError({ code: "weak_password" })).toBe("password_policy");
    expect(classifyUpdateUserPasswordError({ code: "over_email_send_rate_limit" })).toBe("rate_limited");
    expect(classifyUpdateUserPasswordError({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(classifyUpdateUserPasswordError({ code: "same_as" })).toBe("system");
    expect(classifyUpdateUserPasswordError({})).toBe("system");
  });
});

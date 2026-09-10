/**
 * unit tests — src/lib/auth/session.ts (mock @supabase/ssr ตามแบบ errors.test.ts ของ B-01)
 * ครอบเกณฑ์ของ lane C-0: ไม่มี session → 401 · aal1 + บทบาทบังคับ → 403 · aal2 ผ่าน ·
 * citizen/lawyer ผ่านตลอด · กัน open redirect
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../supabase/ssr", () => ({
  createSupabaseSsrClient: vi.fn(),
}));

import { createSupabaseSsrClient } from "../supabase/ssr";
import {
  MFA_REQUIRED_ROLES,
  requiresMfa,
  getUser,
  requireUser,
  getMyRoles,
  requireMfaForRoles,
  resolveSafeNextPath,
  DEFAULT_POST_LOGIN_PATH,
} from "./session";
import { AppError, errorDefinition } from "../errors";

const createClientMock = vi.mocked(createSupabaseSsrClient);

/** mock client ที่มีเฉพาะ method ที่ session.ts ใช้จริง */
function makeClient(spec: {
  user: { id: string } | null;
  currentLevel: "aal1" | "aal2" | null;
  roles: string[];
  rolesError?: boolean;
}) {
  const rpc = vi.fn(async () =>
    spec.rolesError
      ? { data: null, error: { message: "rpc failed" } }
      : { data: spec.roles, error: null },
  );
  return {
    auth: {
      getUser: vi.fn(async () =>
        spec.user === null
          ? { data: { user: spec.user }, error: { message: "invalid JWT" } }
          : { data: { user: spec.user }, error: null },
      ),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: spec.currentLevel, nextLevel: null, currentAuthenticationMethods: [] },
          error: null,
        })),
      },
    },
    rpc,
  };
}

describe("MFA_REQUIRED_ROLES / requiresMfa — ตรง RBAC-DESIGN §1.1/§4.2", () => {
  it("ครบ 6 บทบาท: instructor + staff:* ทุกตัว + super_admin", () => {
    expect([...MFA_REQUIRED_ROLES].sort()).toEqual(
      [
        "instructor",
        "staff:viewer",
        "staff:content",
        "staff:exam",
        "staff:registrar",
        "super_admin",
      ].sort(),
    );
  });

  it("citizen/lawyer ไม่อยู่ในชุดบังคับ (MFA optional — RBAC §1.1)", () => {
    expect(requiresMfa(["citizen"])).toBe(false);
    expect(requiresMfa(["lawyer"])).toBe(false);
  });

  it("union ของหลายบทบาท: citizen + instructor → บังคับ (มี 1 ตัวพอ)", () => {
    expect(requiresMfa(["citizen", "instructor"])).toBe(true);
  });

  it("บทบาทที่ไม่รู้จัก / ชุดว่าง → ไม่บังคับ", () => {
    expect(requiresMfa(["unknown-role"])).toBe(false);
    expect(requiresMfa([])).toBe(false);
  });
});

describe("getUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("คืน null เมื่อไม่มี session (getUser error)", async () => {
    createClientMock.mockResolvedValue(makeClient({ user: null, currentLevel: null, roles: [] }) as never);
    await expect(getUser()).resolves.toBeNull();
  });

  it("คืน { userId, aal: \"aal1\" } เมื่อ currentLevel เป็น aal1", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-1" }, currentLevel: "aal1", roles: ["citizen"] }) as never,
    );
    await expect(getUser()).resolves.toEqual({ userId: "u-1", aal: "aal1" });
  });

  it("คืน aal: \"aal2\" เมื่อ currentLevel เป็น aal2", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-2" }, currentLevel: "aal2", roles: ["staff:exam"] }) as never,
    );
    await expect(getUser()).resolves.toEqual({ userId: "u-2", aal: "aal2" });
  });

  it("currentLevel เป็น null → ถือเป็น aal1 (ต่ำสุด — ไม่ประเมินสูงเอง)", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-3" }, currentLevel: null, roles: ["citizen"] }) as never,
    );
    const user = await getUser();
    expect(user?.aal).toBe("aal1");
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ไม่มี session → โยน ERR-AUTH-001 (401)", async () => {
    createClientMock.mockResolvedValue(makeClient({ user: null, currentLevel: null, roles: [] }) as never);
    const err = await requireUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-AUTH-001");
    expect((err as AppError).httpStatus).toBe(401);
    expect((err as AppError).message).toBe(errorDefinition("ERR-AUTH-001").message);
  });

  it("มี session → คืน user", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-9" }, currentLevel: "aal1", roles: ["citizen"] }) as never,
    );
    const user = await requireUser();
    expect(user.userId).toBe("u-9");
  });
});

describe("getMyRoles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("เรียก RPC my_roles และคืนชุดบทบาท", async () => {
    const client = makeClient({ user: { id: "u-1" }, currentLevel: "aal1", roles: ["staff:exam"] });
    createClientMock.mockResolvedValue(client as never);
    await expect(getMyRoles()).resolves.toEqual(["staff:exam"]);
    expect(client.rpc).toHaveBeenCalledWith("my_roles");
  });

  it("RPC ล้มเหลว → ERR-SYS-001 (fail-closed — อ่านบทบาทไม่ได้ = ไม่อนุญาตต่อ)", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-1" }, currentLevel: "aal1", roles: [], rolesError: true }) as never,
    );
    const err = await getMyRoles().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-SYS-001");
  });
});

describe("requireMfaForRoles — MFA fail-closed (D25-O4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ไม่มี session → ERR-AUTH-001 (401) ก่อนพิจารณาบทบาท", async () => {
    createClientMock.mockResolvedValue(makeClient({ user: null, currentLevel: null, roles: [] }) as never);
    const err = await requireMfaForRoles().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-AUTH-001");
    expect((err as AppError).httpStatus).toBe(401);
  });

  it("aal1 + staff:exam (บังคับ MFA) → ERR-AUTH-004 (403)", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-4" }, currentLevel: "aal1", roles: ["staff:exam"] }) as never,
    );
    const err = await requireMfaForRoles().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-AUTH-004");
    expect((err as AppError).httpStatus).toBe(403);
    expect((err as AppError).message).toBe(errorDefinition("ERR-AUTH-004").message);
  });
});

describe("requireMfaForRoles — กรณีผ่าน", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aal2 + staff:exam → ผ่าน และคืน user + roles", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-5" }, currentLevel: "aal2", roles: ["staff:exam", "citizen"] }) as never,
    );
    const ctx = await requireMfaForRoles();
    expect(ctx.user.userId).toBe("u-5");
    expect(ctx.user.aal).toBe("aal2");
    expect(ctx.roles).toEqual(["staff:exam", "citizen"]);
  });

  it("aal1 + citizen → ผ่าน (ผู้เรียนไม่ถูกบังคับ MFA)", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-6" }, currentLevel: "aal1", roles: ["citizen"] }) as never,
    );
    const ctx = await requireMfaForRoles();
    expect(ctx.user.aal).toBe("aal1");
    expect(ctx.roles).toEqual(["citizen"]);
  });

  it("aal1 + lawyer → ผ่าน (MFA แนะนำแต่ไม่บังคับ — RBAC §1.1)", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-7" }, currentLevel: "aal1", roles: ["lawyer"] }) as never,
    );
    await expect(requireMfaForRoles()).resolves.toBeTruthy();
  });

  it("instructor บังคับทุก aal ยกเว้น aal2 (enrollment-only — RBAC §4.2)", async () => {
    createClientMock.mockResolvedValue(
      makeClient({ user: { id: "u-8" }, currentLevel: "aal1", roles: ["lawyer", "instructor"] }) as never,
    );
    const err = await requireMfaForRoles().catch((e: unknown) => e);
    expect((err as AppError).code).toBe("ERR-AUTH-004");
  });
});

describe("resolveSafeNextPath — กัน open redirect", () => {
  it("ยอมรับเฉพาะ path ภายในที่เริ่มด้วย /", () => {
    expect(resolveSafeNextPath("/courses/abc?x=1")).toBe("/courses/abc?x=1");
    expect(resolveSafeNextPath("/my/enrollments")).toBe("/my/enrollments");
  });

  it("path ภายนอก / protocol-relative / scheme → default", () => {
    expect(resolveSafeNextPath("https://evil.example")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath("//evil.example")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath("/\\evil.example")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath("javascript:alert(1)")).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it("ค่าว่าง / null / undefined / ยาวเกิน 512 → default", () => {
    expect(resolveSafeNextPath("")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath(null)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath(undefined)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath("a".repeat(513))).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it("อักขระควบคุม (CR/LF/NUL) → default (กัน header injection)", () => {
    expect(resolveSafeNextPath("/x\r\nSet-Cookie: a=1")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath("/x\n")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath("/x\0")).toBe(DEFAULT_POST_LOGIN_PATH);
  });
});

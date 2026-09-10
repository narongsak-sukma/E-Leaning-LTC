/**
 * rbac.test — unit test ของ src/lib/rbac.ts
 *
 * ส่วน "matrix" = เกณฑ์ exit O-5 (D25): เทียบ ROLE_PERMISSIONS กับ RBAC-DESIGN §2
 * ทีละ role — doc เป็น master ถ้า test ล้ม = มี drift ต้องแก้โค้ด (ไม่ใช่แก้ test)
 *
 * จำนวน permission ต่อ role ยืนยันเป็นตัวเลขกำกับชัดเจน
 * (scope-variant เช่น "attempt:view (ตัวเอง)/(ทุกคน)" รวมเป็น permission string เดียว)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// loadSessionFromSupabase ใช้ session.getUser (dynamic import) — session.ts import "server-only"
vi.mock("server-only", () => ({}));

import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  requirePermission,
  loadMyRolesFromDb,
  loadSessionFromSupabase,
} from "./rbac";
import { AppError, errorDefinition } from "./errors";
import { createSupabaseSsrClient } from "./supabase/ssr";

// mock supabase/ssr ทั้ง module (rbac.ts เรียกแบบ lazy dynamic import ตาม D26)
vi.mock("./supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  // gate r12: getUser ของ session.ts ใช้ buffered client — wrapper อ่าน stub จาก
  // createSupabaseSsrClient ณ เวลาถูกเรียก (mockResolvedValue ตั้งทีหลังได้)
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});

/**
 * matrix จาก RBAC-DESIGN §2.1–§2.4 (baseline 1.0.0) — doc เป็น master
 * แต่ละ token คือ 1 permission (แถว matrix; scope-variant ใช้ string เดียวกัน)
 */
const DOC: Record<string, readonly string[]> = {
  citizen: "course:view lesson:view enroll:create assessment:view attempt:start attempt:view certificate:verify certificate:view user:view audit_log:view notification:view".split(" "),
  lawyer: "course:view lesson:view enroll:create assessment:view attempt:start attempt:view certificate:verify certificate:view credit_ledger:view user:view audit_log:view notification:view".split(" "),
  instructor: "course:view course:create course:update lesson:view lesson:update enroll:create question_bank:view question_bank:create question_bank:update assessment:view assessment:create assessment:update attempt:start attempt:view certificate:verify certificate:view credit_ledger:view user:view audit_log:view notification:view".split(" "),
  "staff:viewer": "course:view lesson:view question_bank:view assessment:view attempt:view certificate:verify credit_rule:view credit_ledger:view user:view audit_log:view report:view report:export notification:view".split(" "),
  "staff:content": "course:view course:create course:update course:delete course:publish lesson:view lesson:update certificate:verify user:view audit_log:view notification:view".split(" "),
  "staff:exam": "course:view lesson:view question_bank:view question_bank:create question_bank:update question_bank:delete assessment:view assessment:create assessment:update assessment:approve attempt:view attempt:grade_override certificate:verify user:view audit_log:view report:view report:export notification:view".split(" "),
  "staff:registrar": "course:view lesson:view assessment:view attempt:view certificate:verify certificate:issue certificate:revoke credit_rule:view credit_rule:create credit_rule:update credit_ledger:view credit_adjustment:create user:view user:update license:verify role:grant role:revoke audit_log:view report:view report:export notification:view notification:send".split(" "),
  super_admin: [...PERMISSIONS],
};

const ROLE_EXPECTED_COUNTS: Record<string, number> = {
  citizen: 11,
  lawyer: 12,
  instructor: 20,
  "staff:viewer": 13,
  "staff:content": 11,
  "staff:exam": 18,
  "staff:registrar": 22,
  super_admin: 41,
};

describe("O-5 (D25): ROLE_PERMISSIONS ตรง RBAC-DESIGN §2 ทีละ role", () => {
  it("PERMISSIONS มี 41 permission (จำนวนแถว matrix §2.1–§2.4 หลังรวม scope-variant)", () => {
    expect(PERMISSIONS).toHaveLength(41);
  });

  it("ROLE_PERMISSIONS มีครบทุก role ใน ROLES พอดี (guest ไม่มีบทบาท — ไม่อยู่ใน matrix)", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  for (const role of ROLES) {
    it("role " + role + " = " + ROLE_EXPECTED_COUNTS[role] + " permission ตรง matrix §2.1–§2.4", () => {
      const actual = [...ROLE_PERMISSIONS[role]];
      expect(actual).toHaveLength(ROLE_EXPECTED_COUNTS[role] ?? -1);
      expect([...actual].sort()).toEqual([...(DOC[role] ?? ["missing-doc-row"])].sort());
    });
  }

  it("ไม่มี role ใดถือ permission นอก PERMISSIONS และไม่มี permission ซ้ำใน role เดียว", () => {
    for (const role of ROLES) {
      const list = [...ROLE_PERMISSIONS[role]];
      expect(new Set(list).size, role).toBe(list.length);
      for (const p of list) {
        expect(PERMISSIONS, role + " ถือ " + p).toContain(p);
      }
    }
  });
});

describe("hasPermission — สิทธิ์รวมกันแบบ union ของทุกบทบาท (RBAC §1.2-3)", () => {
  it("บัญชี citizen+instructor ได้ course:create จาก instructor (ไม่มี inheritance)", () => {
    expect(hasPermission(["citizen", "instructor"], "course:create")).toBe(true);
  });

  it("lawyer ไม่ได้ user:disable (explicit map เท่านั้น)", () => {
    expect(hasPermission(["lawyer"], "user:disable")).toBe(false);
  });

  it("บัญชีไม่มีบทบาท (guest) ไม่ได้สิทธิ์ใด ๆ", () => {
    expect(hasPermission([], "course:view")).toBe(false);
  });

  it("บทบาทที่ไม่รู้จัก → ปฏิเสธ (fail-closed)", () => {
    expect(hasPermission(["unknown_role" as never], "course:view")).toBe(false);
  });
});

describe("requirePermission", () => {
  it("ไม่มี session → ERR-AUTH-001 (401)", async () => {
    const err = await requirePermission("course:view", {
      loadSession: async () => null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-AUTH-001");
    expect((err as AppError).httpStatus).toBe(401);
  });

  it("มี session แต่ไม่มีสิทธิ์ → ERR-RBAC-001 (403) พร้อม permission ใน details", async () => {
    const err = await requirePermission("certificate:issue", {
      loadSession: async () => ({ userId: "u1", aal: "aal1" }),
      loadMyRoles: async () => ["citizen"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-RBAC-001");
    expect((err as AppError).httpStatus).toBe(403);
    expect((err as AppError).details).toEqual({ permission: "certificate:issue" });
  });

  it("มี session + มีสิทธิ์ → allowed พร้อม userId/roles", async () => {
    const result = await requirePermission("enroll:create", {
      loadSession: async () => ({ userId: "u1", aal: "aal1" }),
      loadMyRoles: async () => ["citizen"],
    });
    expect(result).toEqual({ allowed: true, userId: "u1", roles: ["citizen"] });
  });

  it("หลายบทบาทรวมสิทธิ์แบบ union (citizen+instructor ผ่าน course:create ได้)", async () => {
    const result = await requirePermission("course:create", {
      loadSession: async () => ({ userId: "u1", aal: "aal2" }),
      loadMyRoles: async () => ["citizen", "instructor"],
    });
    expect(result.allowed).toBe(true);
  });

  it("loadSession โยน error อื่น → เผยแพร่ต่อ (handler จับเป็น ERR-SYS-001 ต่อ)", async () => {
    const boom = new Error("db down");
    const err = await requirePermission("course:view", {
      loadSession: async () => {
        throw boom;
      },
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
  });

  it("loadSession แล้ว loadMyRoles ทำงานตามลำดับ (session ก่อน roles)", async () => {
    const calls: string[] = [];
    await requirePermission("course:view", {
      loadSession: async () => {
        calls.push("session");
        return { userId: "u1", aal: "aal1" };
      },
      loadMyRoles: async () => {
        calls.push("roles");
        return ["citizen"];
      },
    });
    expect(calls).toEqual(["session", "roles"]);
  });
});

describe("requirePermission — MFA fail-closed ผูกเส้นทาง authorization หลัก (D25-O4/AUTH-007)", () => {
  it("instructor aal1 (บังคับ MFA ยังไม่ถึง aal2) → ERR-AUTH-004 (403) แม้มีสิทธิ์", async () => {
    const err = await requirePermission("course:create", {
      loadSession: async () => ({ userId: "u1", aal: "aal1" }),
      loadMyRoles: async () => ["instructor"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-AUTH-004");
    expect((err as AppError).httpStatus).toBe(403);
    expect((err as AppError).message).toBe(errorDefinition("ERR-AUTH-004").message);
  });

  it("instructor aal2 → ผ่าน (สิทธิ์พิจารณาตามปกติ)", async () => {
    const result = await requirePermission("course:create", {
      loadSession: async () => ({ userId: "u1", aal: "aal2" }),
      loadMyRoles: async () => ["instructor"],
    });
    expect(result.allowed).toBe(true);
  });

  it("citizen aal1 → ผ่าน (ผู้เรียนไม่ถูกบังคับ MFA)", async () => {
    const result = await requirePermission("enroll:create", {
      loadSession: async () => ({ userId: "u2", aal: "aal1" }),
      loadMyRoles: async () => ["citizen"],
    });
    expect(result.allowed).toBe(true);
  });

  it("staff:exam aal1 ต้องเจ็บทุก permission แม้ user:view (ไม่มีทางบายพาสผ่าน permission อื่น)", async () => {
    const err = await requirePermission("user:view", {
      loadSession: async () => ({ userId: "u3", aal: "aal1" }),
      loadMyRoles: async () => ["staff:exam"],
    }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe("ERR-AUTH-004");
  });
});

describe("loadMyRolesFromDb — RPC my_roles() ผ่าน user-JWT client", () => {
  beforeEach(() => {
    vi.mocked(createSupabaseSsrClient).mockReset();
  });

  function stubClient(opts: {
    roles?: unknown;
    rolesError?: { message: string } | null;
    user?: { id: string } | null;
    aal?: "aal1" | "aal2";
    /** แถว profiles — default = active (is_active true, ไม่ถูกลบ); null = แถวหาย */
    profile?: { is_active: boolean; deleted_at: string | null } | null;
    profileError?: boolean;
  }) {
    return {
      rpc: vi.fn(async () => ({ data: opts.roles, error: opts.rolesError ?? null })),
      auth: {
        getUser: vi.fn(async () => ({ data: { user: opts.user ?? null }, error: null })),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: opts.aal ?? "aal1", nextLevel: null, currentAuthenticationMethods: [] },
            error: null,
          })),
        },
      },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () =>
              opts.profileError
                ? { data: null, error: { message: "profiles read failed" } }
                : { data: opts.profile === undefined ? { is_active: true, deleted_at: null } : opts.profile, error: null },
            ),
          })),
        })),
      })),
    } as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>>;
  }

  it("RPC สำเร็จ → คืนบทบาทเป็น string[]", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ roles: ["citizen", "lawyer"] }));
    await expect(loadMyRolesFromDb()).resolves.toEqual(["citizen", "lawyer"]);
  });

  it("RPC error → ERR-SYS-002 (503) แบบ opaque — ไม่ leak ข้อความ DB", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ rolesError: { message: "SQLSTATE XXXXX" } }));
    const err = await loadMyRolesFromDb().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-SYS-002");
    expect((err as AppError).httpStatus).toBe(503);
    expect((err as AppError).message).toBe(errorDefinition("ERR-SYS-002").message);
  });

  it("data ไม่ใช่ array → ERR-SYS-002 (contract ผิด — fail-closed)", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ roles: "citizen" }));
    const err = await loadMyRolesFromDb().catch((e: unknown) => e);
    expect((err as AppError).code).toBe("ERR-SYS-002");
  });

  it("data มีสมาชิกไม่ใช่ string → ERR-SYS-002 (contract ผิด — fail-closed)", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ roles: ["citizen", 5] }));
    const err = await loadMyRolesFromDb().catch((e: unknown) => e);
    expect((err as AppError).code).toBe("ERR-SYS-002");
  });

  it("RPC สำเร็จแต่คืน array ว่าง → คืน []", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ roles: [] }));
    await expect(loadMyRolesFromDb()).resolves.toEqual([]);
  });

  it("loadSessionFromSupabase: มี user + บัญชี active → คืน { userId, aal } (aal default aal1)", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ user: { id: "uuid-1" } }));
    await expect(loadSessionFromSupabase()).resolves.toEqual({ userId: "uuid-1", aal: "aal1" });
  });

  it("loadSessionFromSupabase: aal2 → คืน aal aal2", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ user: { id: "uuid-2" }, aal: "aal2" }));
    await expect(loadSessionFromSupabase()).resolves.toEqual({ userId: "uuid-2", aal: "aal2" });
  });

  it("loadSessionFromSupabase: ไม่มี user (session หมด/ไม่มี) → คืน null", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ user: null }));
    await expect(loadSessionFromSupabase()).resolves.toBeNull();
  });

  it("loadSessionFromSupabase: บัญชีถูกปิด (is_active=false) → คืน null แม้ JWT ยังไม่หมดอายุ (SDS §5.5)", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(
      stubClient({ user: { id: "uuid-3" }, profile: { is_active: false, deleted_at: null } }),
    );
    await expect(loadSessionFromSupabase()).resolves.toBeNull();
  });

  it("loadSessionFromSupabase: บัญชีถูกลบ (deleted_at) → คืน null", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(
      stubClient({ user: { id: "uuid-4" }, profile: { is_active: true, deleted_at: "2026-09-10T00:00:00Z" } }),
    );
    await expect(loadSessionFromSupabase()).resolves.toBeNull();
  });

  it("loadSessionFromSupabase: แถว profiles หาย → คืน null (fail-closed — ไม่ปล่อยผ่าน)", async () => {
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stubClient({ user: { id: "uuid-5" }, profile: null }));
    await expect(loadSessionFromSupabase()).resolves.toBeNull();
  });
});

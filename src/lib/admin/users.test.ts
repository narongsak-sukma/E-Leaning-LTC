/**
 * users.test — unit ของ src/lib/admin/users.ts (Wave E Phase 5 · [#90] + Wave F · [#91])
 *
 * - mapAdminRpcError — ป้าย (ERR-XXX-NNN|tag) → AppError ตรงรหัส + reason ·
 *   ไม่มีป้าย → ERR-SYS-002 reason ตาม fallback (ไม่ leak SQL)
 * - unwrapScalarJsonb — obj ตรงผ่าน · [obj เดียว] unwrap · รูปอื่นคงเดิม (schema ตัดทีหลัง)
 * - ค่าคงที่ GoTrue ban — DISABLE "876000h" / ENABLE "none"
 * - Wave F (D-f-5): AdminUserResource ขาออก additive isBanned/bannedUntil — map ตรง
 *   ทุกรูป (null / วันในอดีตผ่านตรง ๆ = "เคยถูกแบนแล้วหมดอายุ") · แถว drift ขาด
 *   is_banned = schema ตัด (fail-closed)
 * - auditUsersPiiAccessFailClosed — fail-closed: ผ่านครั้งเดียวจบ · ล้ม retry อีกครั้ง ·
 *   ล้มครบ 2 ครั้ง = ERR-SYS-002 (503) — ไม่ปล่อย disclosure ผ่านโดยไม่มี audit
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

/** service client mock — ใช้กับ auditUsersPiiAccessFailClosed (retry 2 ครั้ง) */
const serviceRpcMock = vi.hoisted(() => {
  const rpc = vi.fn<() => Promise<{ error: unknown }>>();
  return rpc;
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: (): { rpc: typeof serviceRpcMock } => ({
    rpc: serviceRpcMock,
  }),
}));

import {
  AdminUserDbRow,
  AdminUserResource,
  BAN_DURATION_DISABLE,
  BAN_DURATION_ENABLE,
  auditUsersPiiAccessFailClosed,
  mapAdminRpcError,
  toAdminUserResource,
  unwrapScalarJsonb,
} from "./users";

/** แถว RPC ครบตาม 0035 §7 + 0041 — ใช้เป็นฐานของเคส mapping */
function baseDbRow(overrides: Partial<AdminUserDbRow> = {}): AdminUserDbRow {
  const base: AdminUserDbRow = {
    id: "11111111-1111-4111-8111-111111111111",
    display_name: "dcr13-users-unit-สมชาย",
    email: "dcr13-users-unit@ltc.test",
    deleted_at: null,
    created_at: "2026-09-01T00:00:00+00:00",
    roles: ["citizen"],
    has_verified_license: false,
    is_banned: false,
    banned_until: null,
  };
  return { ...base, ...overrides };
}

describe("mapAdminRpcError — ป้าย RPC เป็น AppError", () => {
  it("ป้าย ERR-VAL-001|no_verified_license → AppError 400 + reason", () => {
    const err = mapAdminRpcError(
      { message: "...(ERR-VAL-001|no_verified_license)" },
      "fallback_reason",
    );
    expect(err.code).toBe("ERR-VAL-001");
    expect(err.details?.["reason"]).toBe("no_verified_license");
  });

  it("ป้าย ERR-NF-001|user_not_found → 404", () => {
    const err = mapAdminRpcError(
      { message: "context (ERR-NF-001|user_not_found)" },
      "fallback_reason",
    );
    expect(err.code).toBe("ERR-NF-001");
  });

  it("ไม่มีป้าย → ERR-SYS-002 + reason ตาม fallback (ไม่ leak SQL)", () => {
    const err = mapAdminRpcError(
      { message: "SQLSTATE 42501 permission denied" },
      "admin_list_users_failed",
    );
    expect(err.code).toBe("ERR-SYS-002");
  });
});

describe("unwrapScalarJsonb — PostgREST scalar wrap", () => {
  it("object ตรง → ผ่านตรงไม่แตะ", () => {
    const obj = { courseId: "x" };
    expect(unwrapScalarJsonb(obj)).toBe(obj);
  });

  it("[obj เดียว] → unwrap obj ใน array", () => {
    const obj = { courseId: "x" };
    expect(unwrapScalarJsonb([obj])).toBe(obj);
  });

  it("array หลายชั้น/ค่าว่าง → คงเดิม (schema ตัดทีหลัง)", () => {
    const arr = [1, 2];
    expect(unwrapScalarJsonb(arr)).toBe(arr);
    expect(unwrapScalarJsonb([])).toEqual([]);
    expect(unwrapScalarJsonb(null)).toBeNull();
  });
});

describe("ค่าคงที่ GoTrue ban_duration", () => {
  it('DISABLE = "876000h" / ENABLE = "none"', () => {
    expect(BAN_DURATION_DISABLE).toBe("876000h");
    expect(BAN_DURATION_ENABLE).toBe("none");
  });
});

describe("AdminUserResource + toAdminUserResource — ban fields (0041 · D-f-5)", () => {
  it("is_banned=true + banned_until อนาคต → map ตรงทุกฟิลด์ และ parse ผ่าน schema", () => {
    const row = baseDbRow({
      is_banned: true,
      banned_until: "2076-09-01T00:00:00+00:00",
    });
    const mapped = toAdminUserResource(row);
    expect(mapped.isBanned).toBe(true);
    expect(mapped.bannedUntil).toBe("2076-09-01T00:00:00+00:00");
    expect(AdminUserResource.safeParse(mapped).success).toBe(true);
  });

  it("banned_until = null → bannedUntil null (ผ่าน schema)", () => {
    const mapped = toAdminUserResource(baseDbRow({ banned_until: null }));
    expect(mapped.isBanned).toBe(false);
    expect(mapped.bannedUntil).toBeNull();
    expect(AdminUserResource.safeParse(mapped).success).toBe(true);
  });

  it("แบนหมดอายุ: is_banned=false + banned_until อดีต → ผ่านตรง ๆ ไม่ลบค่า (ผ่าน schema)", () => {
    const past = "2020-01-01T00:00:00+00:00";
    const mapped = toAdminUserResource(baseDbRow({ is_banned: false, banned_until: past }));
    expect(mapped.isBanned).toBe(false);
    expect(mapped.bannedUntil).toBe(past);
    expect(new Date(mapped.bannedUntil ?? "").getTime()).toBeLessThan(Date.now());
    expect(AdminUserResource.safeParse(mapped).success).toBe(true);
  });

  it("แถว drift ขาด is_banned → schema ปฏิเสธ (fail-closed — parseOutgoingView จะโยน 503)", () => {
    const drifted = baseDbRow() as unknown as Record<string, unknown>;
    delete drifted["is_banned"];
    const mapped = toAdminUserResource(drifted as unknown as AdminUserDbRow);
    expect(mapped.isBanned).toBeUndefined();
    expect(AdminUserResource.safeParse(mapped).success).toBe(false);
  });
});

describe("auditUsersPiiAccessFailClosed — fail-closed retry (แบบแผน 1.1.2 B7)", () => {
  beforeEach(() => {
    serviceRpcMock.mockReset();
  });

  it("rpc ผ่านครั้งเดียว → resolve · เรียก rpc ครั้งเดียว · payload ตรง allowlist PII_ACCESS (0008/0025)", async () => {
    serviceRpcMock.mockResolvedValue({ error: null });
    await expect(
      auditUsersPiiAccessFailClosed({
        endpoint: "/api/v1/admin/users",
        targetUserId: null,
        purpose: "admin_users_search",
        actorId: "11111111-1111-4111-8111-111111111111",
        requestId: "req-unit-1",
      }),
    ).resolves.toBeUndefined();
    expect(serviceRpcMock).toHaveBeenCalledTimes(1);
    expect(serviceRpcMock).toHaveBeenCalledWith(
      "append_audit_event",
      expect.objectContaining({
        p_action: "PII_ACCESS",
        p_entity_type: "user",
        p_entity_id: null,
        p_context: {
          endpoint: "/api/v1/admin/users",
          purpose: "admin_users_search",
          user_id: "11111111-1111-4111-8111-111111111111",
        },
        p_request_id: "req-unit-1",
      }),
    );
  });

  it("ล้มครั้งเดียวแล้วผ่าน → resolve หลัง retry (เรียก rpc 2 ครั้ง)", async () => {
    serviceRpcMock
      .mockResolvedValueOnce({ error: { message: "deadlock detected" } })
      .mockResolvedValueOnce({ error: null });
    await expect(
      auditUsersPiiAccessFailClosed({
        endpoint: "/api/v1/admin/users",
        targetUserId: null,
        purpose: "unit_purpose",
        actorId: "11111111-1111-4111-8111-111111111111",
        requestId: "req-unit-2",
      }),
    ).resolves.toBeUndefined();
    expect(serviceRpcMock).toHaveBeenCalledTimes(2);
  });

  it("ล้มครบ 2 ครั้ง → ERR-SYS-002 (503) · เรียก rpc พอดี 2 ครั้ง (retry ครั้งเดียว)", async () =>  {
    serviceRpcMock.mockResolvedValue({ error: { message: "connection refused" } });
    await expect(
      auditUsersPiiAccessFailClosed({
        endpoint: "/api/v1/admin/users",
        targetUserId: null,
        purpose: "admin_users_search",
        actorId: "11111111-1111-3111-8111-111111111111",
        requestId: "req-unit-3",
      }),
    ).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "admin_users_pii_audit_unavailable" },
      httpStatus: 503,
    });
    expect(serviceRpcMock).toHaveBeenCalledTimes(2);
  });
});

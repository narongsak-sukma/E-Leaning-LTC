/**
 * users.test — unit ของ src/lib/admin/users.ts (Wave E Phase 5 · [#90])
 *
 * - mapAdminRpcError — ป้าย (ERR-XXX-NNN|tag) → AppError ตรงรหัส + reason ·
 *   ไม่มีป้าย → ERR-SYS-002 reason ตาม fallback (ไม่ leak SQL)
 * - unwrapScalarJsonb — obj ตรงผ่าน · [obj เดียว] unwrap · รูปอื่นคงเดิม (schema ตัดทีหลัง)
 * - ค่าคงที่ GoTrue ban — DISABLE "876000h" / ENABLE "none"
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

import {
  BAN_DURATION_DISABLE,
  BAN_DURATION_ENABLE,
  mapAdminRpcError,
  unwrapScalarJsonb,
} from "./users";

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
    expect(err.details?.["reason"]).toBe("admin_list_users_failed");
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

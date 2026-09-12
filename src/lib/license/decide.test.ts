/**
 * unit tests — lib/license/decide (Wave E Phase 5 · D-p5-3)
 *
 * ตรวจ: args RPC ครบ · unwrap array wrap · map ป้าย "(ERR-XXX-NNN|tag)" ตามทะเบียน ·
 * ไม่มีป้าย = 503 opaque · ขาออก strict — drift = 503 license_decision_result_drift
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { decideLicenseApplication } from "./decide";

const APP_ID = "b0000000-0000-4000-8000-000000000001";
const LIC_ID = "d0000000-0000-4000-8000-000000000001";

/** user-JWT client — rpc คืน data/error ตามที่เทสกำหนด + ติดตาม args ทุก call */
function mockUserClient(rpcResult: { readonly data?: unknown; readonly error?: unknown } | null = null): {
  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      return { data: rpcResult?.data ?? null, error: rpcResult?.error ?? null };
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { rpcCalls };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
});

describe("decideLicenseApplication — สำเร็จ", () => {
  it("approve — args RPC ครบ + unwrap array wrap + ผลตรงสัญญา", async () => {
    const { rpcCalls } = mockUserClient({
      data: [{
        applicationId: APP_ID,
        result: "approved",
        resultingLicenseId: LIC_ID,
        roleGranted: true,
      }],
    });
    const result = await decideLicenseApplication({ appId: APP_ID, action: "approve", reason: null, requestId: "req-d-1" });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("admin_decide_license_application");
    expect(rpcCalls[0]?.args).toEqual({ p_app_id: APP_ID, p_action: "approve", p_reason: null, p_request_id: "req-d-1" });
    expect(result).toEqual({ applicationId: APP_ID, result: "approved", resultingLicenseId: LIC_ID, roleGranted: true });
  });

  it("reject — resultingLicenseId/roleGranted = null", async () => {
    mockUserClient({ data: { applicationId: APP_ID, result: "rejected", resultingLicenseId: null, roleGranted: null } });
    const result = await decideLicenseApplication({ appId: APP_ID, action: "reject", reason: "เอกสารไม่ชัดเจนพอ", requestId: null });
    expect(result).toEqual({ applicationId: APP_ID, result: "rejected", resultingLicenseId: null, roleGranted: null });
  });

  it("คีย์หาย → null (schema nullable) — parse ผ่าน", async () => {
    mockUserClient({ data: { applicationId: APP_ID, result: "rejected" } });
    const result = await decideLicenseApplication({ appId: APP_ID, action: "reject", reason: "เอกสารไม่ชัดเจนพอ", requestId: null });
    expect(result.resultingLicenseId).toBeNull();
    expect(result.roleGranted).toBeNull();
  });
});

describe("decideLicenseApplication — map ป้าย error", () => {
  it.each([
    ["login_required", "ERR-AUTH-001", null],
    ["mfa_required", "ERR-AUTH-004", null],
    ["license_forbidden", "ERR-RBAC-001", null],
    ["action_value", "ERR-VAL-001", null],
    ["reason_required", "ERR-VAL-001", null],
    ["reason_length", "ERR-VAL-001", null],
    ["application_not_found", "ERR-NF-001", null],
    ["license_no_conflict", "ERR-VAL-001", "license_no_conflict"],
  ])("%s → %s", async (tag, expectedCode, expectedReason) => {
    mockUserClient({ error: { message: `op failed (${expectedCode}|${tag})`, code: "P0001" } });
    await expect(
      decideLicenseApplication({ appId: APP_ID, action: "reject", reason: "เอกสารไม่ชัดเจนพอ", requestId: null }),
    ).rejects.toMatchObject({
      code: expectedCode,
      details: expectedReason === null ? {} : { reason: expectedReason },
    });
  });
});

describe("decideLicenseApplication — ไม่มีป้าย / drift", () => {
  it("ไม่มีป้าย → ERR-SYS-002 opaque license_decide_failed", async () => {
    mockUserClient({ error: { message: "connection reset", code: "08000" } });
    await expect(
      decideLicenseApplication({ appId: APP_ID, action: "approve", reason: null, requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "license_decide_failed" } });
  });

  it("data null → drift 503 license_decision_result_drift", async () => {
    mockUserClient({ data: null });
    await expect(
      decideLicenseApplication({ appId: APP_ID, action: "approve", reason: null, requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "license_decision_result_drift" } });
  });

  it("result นอก enum → drift 503", async () => {
    mockUserClient({ data: { applicationId: APP_ID, result: "maybe", resultingLicenseId: null, roleGranted: null } });
    await expect(
      decideLicenseApplication({ appId: APP_ID, action: "approve", reason: null, requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "license_decision_result_drift" } });
  });
});

/**
 * deletion.test — lib/pdpa/deletion (SEC-012 · D-p5-8 · #90)
 *
 * mock ssr + service client (unit ล้วน) — จุดหลัก:
 * - requestAccountDeletion: RPC `my_request_account_deletion` (user JWT) → ถือ token
 *   ครั้งเดียว → แทรกอีเมล `account.delete.confirm` (confirm_url มี token · locale th)
 *   · **คืน {requestId, expiresAt} เท่านั้น — ไม่มี token หลุดออก (D24)**
 * - confirmAccountDeletion: RPC `confirm_account_deletion` (service) → GoTrue ban
 *   + อีเมล `account.deleted` · token เสียทุกกรณี → token_invalid ไม่เฉลยสถานะ
 * - error แบบป้าย "(ERR-XXX-NNN|reason)" → map ตามทะเบียน · ไม่มีป้าย → ERR-SYS-002
 */
vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  ACCOUNT_DELETE_BAN_DURATION,
  confirmAccountDeletion,
  requestAccountDeletion,
} from "@/lib/pdpa/deletion";

vi.mock("@/lib/supabase/ssr", () => ({ createSupabaseSsrClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

const REQUEST_ID = "c0000000-0000-4000-8000-000000000009";
const USER_ID = "b0000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43); // base64url 43 อักขระ ตามสัญญา 0036 §5
const EXPIRES = "2026-09-13T00:00:00+00:00";
const BASE = "https://elearning.lawyerthai.test";

type Result = { data: unknown; error: { message: string } | null };

interface ServiceSpec {
  requestResult: Result;
  confirmResult: Result;
  profileResult: Result;
  outboxError: { message: string } | null;
  banError: { message: string } | null;
}

interface Capture {
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  inserts: Record<string, unknown>[];
  banCalls: { userId: string; options: Record<string, unknown> }[];
}

/** service client จำลอง — rpc + profiles read + email_outbox insert + auth.admin ban */
function mockService(spec: Partial<ServiceSpec> = {}): Capture {
  const full: ServiceSpec = {
    requestResult: { data: null, error: null },
    confirmResult: { data: null, error: null },
    profileResult: {
      data: { email: "user@example.test", display_name: "ทดสอบ ใจดี" },
      error: null,
    },
    outboxError: null,
    banError: null,
    ...spec,
  };
  const capture: Capture = { rpcCalls: [], inserts: [], banCalls: [] };

  const profilesBuilder = {
    select: () => profilesBuilder,
    eq: () => profilesBuilder,
    maybeSingle: async () => full.profileResult,
  };

  const client = {
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      capture.rpcCalls.push({ fn, args: args ?? {} });
      if (fn === "my_request_account_deletion") {
        return full.requestResult;
      }
      if (fn === "confirm_account_deletion") {
        return full.confirmResult;
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return profilesBuilder;
      }
      if (table === "email_outbox") {
        return {
          insert: vi.fn(async (values: Record<string, unknown>) => {
            capture.inserts.push(values);
            return { data: null, error: full.outboxError };
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
    auth: {
      admin: {
        updateUserById: vi.fn(async (userId: string, options: Record<string, unknown>) => {
          capture.banCalls.push({ userId, options });
          return { data: {}, error: full.banError };
        }),
      },
    },
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return capture;
}

/** ssr client จำลอง — rpc คืนผลตามที่กำหนด (+ บันทึก call ลง rpcCalls เมื่อส่งมา) */
function mockSsr(
  result: Result,
  rpcCalls?: { fn: string; args: Record<string, unknown> }[],
): void {
  const client = {
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (rpcCalls !== undefined) {
        rpcCalls.push({ fn, args: args ?? {} });
      }
      return result;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
}

function requestRow(): Record<string, unknown> {
  return { requestId: REQUEST_ID, token: TOKEN, expiresAt: EXPIRES };
}

function confirmRow(): Record<string, unknown> {
  return { userId: USER_ID, confirmed: true };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
});

describe("requestAccountDeletion — ทางหลัก", () => {
  it("RPC ผ่าน → แทรกอีเมล account.delete.confirm (confirm_url มี token) + คืนค่าไม่มี token (D24)", async () => {
    const capture = mockService();
    mockSsr({ data: requestRow(), error: null }, capture.rpcCalls);

    const outcome = await requestAccountDeletion(null);

    expect(outcome).toEqual({ requestId: REQUEST_ID, expiresAt: EXPIRES });
    expect("token" in outcome).toBe(false);
    const call = capture.rpcCalls.find((c) => c.fn === "my_request_account_deletion");
    expect(call?.args).toEqual({ p_request_id: null });
    expect(capture.rpcCalls.filter((c) => c.fn === "confirm_account_deletion").length).toBe(0);
    const insert = capture.inserts[0];
    expect(insert?.["template_key"]).toBe("account.delete.confirm");
    expect(insert?.["to_email"]).toBe("user@example.test");
    expect(insert?.["locale"]).toBe("th");
    expect(insert?.["recipient_user_id"]).toBe(REQUEST_ID);
    const payload = insert?.["payload"] as Record<string, unknown>;
    expect(payload["notification_id"]).toBe(REQUEST_ID);
    expect(payload["user_id"]).toBe(REQUEST_ID);
    const vars = payload["vars"] as Record<string, unknown>;
    expect(String(vars["confirm_url"])).toBe(
      `${BASE}/profile/delete/confirm?token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it("x-request-id ที่ส่งมา → RPC รับ p_request_id ตรงค่า", async () => {
    const capture = mockService();
    mockSsr({ data: requestRow(), error: null }, capture.rpcCalls);

    await requestAccountDeletion(REQUEST_ID);

    const call = capture.rpcCalls.find((c) => c.fn === "my_request_account_deletion");
    expect(call?.args).toEqual({ p_request_id: REQUEST_ID });
  });

  it("RPC โยน account_delete_sod → AppError ERR-RBAC-001 (403) + reason", async () => {
    mockService();
    mockSsr({ data: null, error: { message: "ห้ามลบ (ERR-RBAC-001|account_delete_sod)" } });

    await expect(requestAccountDeletion(null)).rejects.toMatchObject({
      code: "ERR-RBAC-001",
      details: { reason: "account_delete_sod" },
      httpStatus: 403,
    });
  });

  it("RPC โยน delete_pending → ERR-VAL-001 reason delete_pending", async () => {
    mockService();
    mockSsr({ data: null, error: { message: "ค้าง (ERR-VAL-001|delete_pending)" } });

    await expect(requestAccountDeletion(null)).rejects.toMatchObject({
      code: "ERR-VAL-001",
      details: { reason: "delete_pending" },
    });
  });

  it("RPC โยน already_deleted → ERR-VAL-001 reason already_deleted", async () => {
    mockService();
    mockSsr({ data: null, error: { message: "ลบแล้ว (ERR-VAL-001|already_deleted)" } });

    await expect(requestAccountDeletion(null)).rejects.toMatchObject({
      code: "ERR-VAL-001",
      details: { reason: "already_deleted" },
    });
  });

  it("RPC คืน drift (คีย์เกิน) → ERR-SYS-002 deletion_request_drift", async () => {
    mockService();
    mockSsr({ data: { ...requestRow(), extra: 1 }, error: null });

    await expect(requestAccountDeletion(null)).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "deletion_request_drift" },
    });
  });

  it("โปรไฟล์อ่านไม่ได้ → ERR-SYS-002 deletion_profile_read_failed (ไม่แทรกอีเมล)", async () => {
    const capture = mockService({ profileResult: { data: null, error: null } });
    mockSsr({ data: requestRow(), error: null });

    await expect(requestAccountDeletion(null)).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "deletion_profile_read_failed" },
    });
    expect(capture.inserts.length).toBe(0);
  });

  it("แทรก outbox ล้ม → ERR-SYS-002 deletion_email_enqueue_failed", async () => {
    mockService({ outboxError: { message: "insert failed" } });
    mockSsr({ data: requestRow(), error: null });

    await expect(requestAccountDeletion(null)).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "deletion_email_enqueue_failed" },
    });
  });
});

describe("confirmAccountDeletion — ทางหลัก", () => {
  it("RPC ผ่าน → ban GoTrue + อีเมล account.deleted + emailQueued true", async () => {
    const capture = mockService({ confirmResult: { data: confirmRow(), error: null } });

    const outcome = await confirmAccountDeletion(TOKEN, null);

    expect(outcome).toEqual({ outcome: "confirmed", userId: USER_ID, emailQueued: true });
    const call = capture.rpcCalls.find((c) => c.fn === "confirm_account_deletion");
    expect(call?.args).toEqual({ p_token: TOKEN, p_request_id: null });
    expect(capture.banCalls.length).toBe(1);
    expect(capture.banCalls[0]?.userId).toBe(USER_ID);
    expect(capture.banCalls[0]?.options).toEqual({ ban_duration: ACCOUNT_DELETE_BAN_DURATION });
    const insert = capture.inserts[0];
    expect(insert?.["template_key"]).toBe("account.deleted");
    expect(insert?.["recipient_user_id"]).toBe(USER_ID);
    const payload = insert?.["payload"] as Record<string, unknown>;
    expect(payload["notification_id"]).toBe(USER_ID);
  });

  it("ban GoTrue ล้ม → ยัง confirmed + ยังส่งอีเมล (best-effort)", async () => {
    const capture = mockService({
      confirmResult: { data: confirmRow(), error: null },
      banError: { message: "gotrue down" },
    });

    const outcome = await confirmAccountDeletion(TOKEN, null);

    expect(outcome).toEqual({ outcome: "confirmed", userId: USER_ID, emailQueued: true });
    expect(capture.banCalls.length).toBe(1);
  });

  it("โปรไฟล์หลังยืนยันอ่านไม่ได้ → confirmed แต่ emailQueued false", async () => {
    mockService({
      confirmResult: { data: confirmRow(), error: null },
      profileResult: { data: null, error: null },
    });

    const outcome = await confirmAccountDeletion(TOKEN, null);

    expect(outcome).toEqual({ outcome: "confirmed", userId: USER_ID, emailQueued: false });
  });

  it("แทรกอีเมลล้ม → confirmed แต่ emailQueued false", async () => {
    mockService({
      confirmResult: { data: confirmRow(), error: null },
      outboxError: { message: "insert failed" },
    });

    const outcome = await confirmAccountDeletion(TOKEN, null);

    expect(outcome).toEqual({ outcome: "confirmed", userId: USER_ID, emailQueued: false });
  });
});

describe("confirmAccountDeletion — token เสีย (token_invalid ไม่เฉลยสถานะ)", () => {
  it.each([
    "token_required",
    "token_not_found",
    "token_used",
    "token_expired",
  ])("%s → token_invalid + ไม่ ban + ไม่แทรกอีเมล", async (tag) => {
    const capture = mockService({
      confirmResult: { data: null, error: { message: `ผิด (ERR-VAL-001|${tag})` } },
    });

    const outcome = await confirmAccountDeletion(TOKEN, null);

    expect(outcome).toEqual({ outcome: "token_invalid" });
    expect(capture.banCalls.length).toBe(0);
    expect(capture.inserts.length).toBe(0);
  });

  it("RPC คืน drift (คีย์เกิน) → ERR-SYS-002 confirm_deletion_drift", async () => {
    mockService({
      confirmResult: { data: { ...confirmRow(), extra: 1 }, error: null },
    });

    await expect(confirmAccountDeletion(TOKEN, null)).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "confirm_deletion_drift" },
    });
  });

  it("RPC error ไม่มีป้าย → ERR-SYS-002 confirm_deletion_failed (opaque)", async () => {
    mockService({
      confirmResult: { data: null, error: { message: "SQLSTATE XX000" } },
    });

    await expect(confirmAccountDeletion(TOKEN, null)).rejects.toMatchObject({
      code: "ERR-SYS-002",
      details: { reason: "confirm_deletion_failed" },
    });
  });

  it("ป้ายไม่ใช่ token (system reason อื่น) → โยนต่อตามทะเบียน", async () => {
    mockService({
      confirmResult: { data: null, error: { message: "ผิด (ERR-RBAC-001|account_delete_sod)" } },
    });

    await expect(confirmAccountDeletion(TOKEN, null)).rejects.toMatchObject({
      code: "ERR-RBAC-001",
      details: { reason: "account_delete_sod" },
    });
  });
});

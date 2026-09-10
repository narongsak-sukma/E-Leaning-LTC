/**
 * Unit tests: src/lib/certificates/shared.ts (Wave D, lane D-4)
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  appendAuditEvent,
  CERT_NO_PATTERN,
  MAX_CODE_ATTEMPTS,
  VERIFY_CODE_LENGTH,
  generateCertNo,
  generateVerifyCode,
  holderNameOf,
  isUniqueViolation,
  rowNumberOrNull,
  rowString,
  rowStringOrNull,
} from "./shared";

beforeEach(() => {
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
});

/** fake Supabase client ที่มีแค่ rpc() — พอสำหรับ appendAuditEvent */
function clientWithRpc(rpcImpl: (fn: string, args: Record<string, unknown>) => unknown) {
  const rpc = vi.fn(rpcImpl);
  return { client: { rpc } as unknown as Parameters<typeof appendAuditEvent>[0], rpc };
}

describe("cert_no / verify_code — CSPRNG", () => {
  it("cert_no ตรงรูปแบบ LTC-<ปี ค.ศ.>-<สุ่ม 6 หลัก>", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateCertNo(new Date("2026-09-08T00:00:00Z"))).toMatch(CERT_NO_PATTERN);
    }
    expect(generateCertNo(new Date("2026-09-08T00:00:00Z")).startsWith("LTC-2026-")).toBe(true);
  });

  it("cert_no ปีตามเวลาไทย (Asia/Bangkok) — 31 ธ.ค. 23:00 UTC = 1 ม.ค. ปีถัดไป", () => {
    expect(generateCertNo(new Date("2026-12-31T17:00:00Z")).startsWith("LTC-2027-")).toBe(true);
  });

  it("verify_code ยาว 43 อักขระ และใช้เฉพาะ nanoid alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateVerifyCode();
      expect(code).toHaveLength(VERIFY_CODE_LENGTH);
      expect(/^[A-Za-z0-9_-]{43}$/.test(code)).toBe(true);
    }
  });

  it("ไม่เรียก Math.random ในโดเมนนี้ (grep-assert call-site ทั้ง src/lib/certificates)", () => {
    const dir = "src/lib/certificates";
    for (const file of ["shared.ts", "issue.ts", "revoke.ts", "reissue.ts", "pdf.ts"]) {
      const src = readFileSync(`${dir}/${file}`, "utf8");
      expect(src.includes("Math.random(")).toBe(false);
    }
  });
});

describe("row helpers + isUniqueViolation", () => {
  it("rowString คืนค่าเมื่อชนิดตรง", () => {
    expect(rowString({ id: "x" }, "id")).toBe("x");
  });

  it("rowString ชนิดไม่ตรง → ERR-SYS-002 (contract mismatch, fail-closed)", () => {
    try {
      rowString({ id: 7 }, "id");
      expect.unreachable("ต้อง throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ERR-SYS-002");
    }
  });

  it("rowNumberOrNull / rowStringOrNull รับ null ได้", () => {
    expect(rowNumberOrNull({ n: null }, "n")).toBeNull();
    expect(rowStringOrNull({ s: null }, "s")).toBeNull();
  });

  it("isUniqueViolation: จับ 23505 และข้อความ duplicate key", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ message: "duplicate key value violates unique constraint" })).toBe(true);
    expect(isUniqueViolation({ code: "42P01" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it("holderNameOf: ชื่อ+นามสกุลก่อน, ว่าง → display_name", () => {
    expect(holderNameOf({ first_name: "สมชาย", last_name: "ใจดี", display_name: "x" })).toBe("สมชาย ใจดี");
    expect(holderNameOf({ first_name: null, last_name: null, display_name: "นายสมชาย" })).toBe("นายสมชาย");
  });
});

describe("appendAuditEvent — RPC append_audit_event", () => {
  const baseInput = {
    action: "CERT_ISSUE" as const,
    entityType: "certificate" as const,
    entityId: "c0000000-0000-4000-8000-000000000009",
    context: { enrollment_id: "e0000000-0000-4000-8000-000000000001" },
    actorId: "a0000000-0000-4000-8000-000000000001",
    requestId: "req-1",
  };

  it("เรียก rpc ด้วยพารามิเตอร์ตามสัญญา 0008 (before/after = null)", async () => {
    const { client, rpc } = clientWithRpc(() => ({ data: null, error: null }));
    const result = await appendAuditEvent(client, baseInput);
    expect(result).toEqual({ written: true, reason: "audit_written" });
    expect(rpc).toHaveBeenCalledWith(
      "append_audit_event",
      expect.objectContaining({
        p_action: "CERT_ISSUE",
        p_entity_type: "certificate",
        p_entity_id: baseInput.entityId,
        p_before: null,
        p_after: null,
        p_context: baseInput.context,
        p_request_id: "req-1",
      }),
    );
  });

  it("DB ปฏิเสธ (42501) → ไม่ throw · คืน written:false + เหตุผล allowlist", async () => {
    const { client } = clientWithRpc(() => ({
      data: null,
      error: { code: "42501", message: "permission denied" },
    }));
    const result = await appendAuditEvent(client, baseInput);
    expect(result).toEqual({ written: false, reason: "db_allowlist_denies_service_role" });
  });

  it("DB ปฏิเสธ (P0001) → written:false + เหตุผล function rejected", async () => {
    const { client } = clientWithRpc(() => ({
      data: null,
      error: { code: "P0001", message: "event not allowed" },
    }));
    const result = await appendAuditEvent(client, baseInput);
    expect(result).toEqual({ written: false, reason: "db_function_rejected_event" });
  });

  it("MAX_CODE_ATTEMPTS = 5 ตามใบงาน (retry ≤ 5 ครั้ง)", () => {
    expect(MAX_CODE_ATTEMPTS).toBe(5);
  });
});

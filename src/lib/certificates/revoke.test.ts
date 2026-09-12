/**
 * Unit tests: src/lib/certificates/revoke.ts — เพิกถอน (Wave D, lane D-4 · 0019-r1)
 *
 * 0019-r1 (gate r1 B2): lookup + conditional UPDATE + CERT_REVOKE audit อยู่ใน RPC
 * `admin_revoke_certificate` TX เดียว — BFF ตรวจ reason แล้วเรียก RPC ครั้งเดียว
 * (ไม่มี append_audit_event แยกอีกต่อไป) · error แบบป้าย (ERR-XXX-NNN|reason) map
 * ตรง, ไม่มีป้าย = ERR-SYS-002 opaque
 */
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
import { AppError } from "@/lib/errors";
import { MIN_REASON_LENGTH, revokeCertificate } from "./revoke";

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: Record<string, unknown> | null };

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const CERT_NO = "LTC-2026-000777";
const REVOKED_AT = "2026-09-08T05:00:00+00:00";
const REASON = "ตรวจพบการทุจริตในการสอบ";

/** แถวที่ RPC คืน (5 คีย์ exact ของ 0031 v2 — gate p3-r1 B1: reversal counters
 *  มาใน TX เดียวกัน ห้ามหายจาก strict schema) */
function revokedRow(): Row {
  return {
    id: CERT_ID,
    cert_no: CERT_NO,
    revoked_at: REVOKED_AT,
    credit_reversed_rows: 2,
    credit_reversed_total: 12.5,
  };
}

function revokeClient(result: RpcResult) {
  const rpc = vi.fn(async () => result);
  const client = { rpc };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return rpc;
}

describe("revokeCertificate", () => {
  beforeEach(() => {
    vi.mocked(createSupabaseServiceRoleClient).mockReset();
  });

  it("MIN_REASON_LENGTH = 10 ตามใบงาน", () => {
    expect(MIN_REASON_LENGTH).toBe(10);
  });

  it("reason สั้นกว่า 10 → ERR-VAL-001 (length_10_500) โดยไม่แตะ RPC", async () => {
    const rpc = revokeClient({ data: null, error: null });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: "สั้น" }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-VAL-001");
    expect((error as AppError).details).toMatchObject({ field: "reason", reason: "length_10_500" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reason ยาวเกิน 500 → ERR-VAL-001 โดยไม่แตะ RPC", async () => {
    const rpc = revokeClient({ data: null, error: null });
    const error = await revokeCertificate({
      actorId: STAFF_ID,
      certificateId: CERT_ID,
      reason: "x".repeat(501),
    }).catch((e: unknown) => e);
    expect((error as AppError).details).toMatchObject({ reason: "length_10_500" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reason trim ก่อนตรวจ — ความยาวนับหลังตัดช่องว่าง + ส่งค่าที่ trim แล้วให้ RPC", async () => {
    const rpc = revokeClient({ data: revokedRow(), error: null });
    const result = await revokeCertificate({
      actorId: STAFF_ID,
      certificateId: CERT_ID,
      reason: `  ${REASON}  `,
    });
    expect(result.status).toBe("revoked");
    expect(rpc).toHaveBeenCalledWith("admin_revoke_certificate", {
      p_actor_user_id: STAFF_ID,
      p_certificate_id: CERT_ID,
      p_reason: REASON,
      p_request_id: null,
    });
  });

  it("happy path: คืน id/certNo/revokedAt จากแถว RPC · เรียก RPC ครั้งเดียว (audit ใน TX — B2)", async () => {
    const rpc = revokeClient({ data: revokedRow(), error: null });
    const result = await revokeCertificate({
      actorId: STAFF_ID,
      certificateId: CERT_ID,
      reason: REASON,
      requestId: "req-7",
    });
    expect(result).toEqual({
      id: CERT_ID,
      certNo: CERT_NO,
      status: "revoked",
      revokedAt: REVOKED_AT,
      revokedReason: REASON,
      creditReversedRows: 2,
      creditReversedTotal: 12.5,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("admin_revoke_certificate", {
      p_actor_user_id: STAFF_ID,
      p_certificate_id: CERT_ID,
      p_reason: REASON,
      p_request_id: "req-7",
    });
  });

  it("PostgREST wrap jsonb เป็น array หลักเดียว → แกะแถวได้", async () => {
    revokeClient({ data: [revokedRow()], error: null });
    const result = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON });
    expect(result.certNo).toBe(CERT_NO);
    expect(result.revokedAt).toBe(REVOKED_AT);
  });

  it.each([
    ["ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)", "ERR-NF-001", "certificate_not_found"],
    ["ข้อมูลไม่ถูกต้อง: ใบนี้ไม่ได้อยู่ในสถานะออกใบแล้ว (ERR-VAL-001|not_valid)", "ERR-VAL-001", "not_valid"],
    ["ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 ตัวอักษร (ERR-VAL-001|reason_length)", "ERR-VAL-001", "reason_length"],
    ["ต้องระบุผู้ดำเนินการ (ERR-AUTH-001|actor_required)", "ERR-AUTH-001", "actor_required"],
  ])("RPC error มีป้าย → map ตรง: %s", async (message, code, reason) => {
    revokeClient({ data: null, error: { message } });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect(error, message).toBeInstanceOf(AppError);
    expect((error as AppError).code, message).toBe(code);
    expect((error as AppError).details, message).toEqual({ reason });
  });

  it("RPC error ไม่มีป้าย → ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    revokeClient({ data: null, error: { code: "XX000", message: "boom" } });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_revoke_rpc_failed" });
  });

  it("RPC สำเร็จแต่ data null → ERR-SYS-002 revoked_row_drift (schema ไม่ผ่าน = drift — r7-M2)", async () => {
    revokeClient({ data: null, error: null });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "revoked_row_drift" });
  });

  it("r8-N2: RPC คืน array ยาว 2 (แถวที่สองต้องหายเงียบไม่ได้) → revoked_row_drift", async () => {
    revokeClient({ data: [revokedRow(), { junk: true }], error: null });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "revoked_row_drift" });
  });

  it("แถว RPC มีคีย์เกิน → revoked_row_drift (ไม่ strip เงียว ๆ — r7-M2)", async () => {
    revokeClient({ data: { ...revokedRow(), extra_key: "x" }, error: null });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "revoked_row_drift" });
  });

  it("แถว RPC cert_no ผิดรูปแบบ LTC-YYYY-<6 หลัก> → revoked_row_drift", async () => {
    revokeClient({ data: { ...revokedRow(), cert_no: "not-a-cert-no" }, error: null });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "revoked_row_drift" });
  });

  it("แถว RPC ขาด revoked_at → revoked_row_drift (ไม่ fabricate เวลา)", async () => {
    const row = revokedRow();
    delete row.revoked_at;
    revokeClient({ data: row, error: null });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "revoked_row_drift" });
  });

  it("gate p3-r1 B1: แถว RPC ขาด credit_reversed_rows → revoked_row_drift (คีย์ใหม่ของ 0031 v2 ห้ามหาย)", async () => {
    const row = revokedRow();
    delete row.credit_reversed_rows;
    revokeClient({ data: row, error: null });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "revoked_row_drift" });
  });
});

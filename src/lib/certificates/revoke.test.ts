/**
 * Unit tests: src/lib/certificates/revoke.ts — เพิกถอน (Wave D, lane D-4)
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
import { certLogger } from "./shared";

type Row = Record<string, unknown>;

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const CERT_NO = "LTC-2026-000777";

interface BuilderState {
  table: string;
  select?: string;
  eq: Array<[string, unknown]>;
  updated?: unknown;
}

type Resolve = { data: unknown; error: null } | { data: null; error: Record<string, unknown> };

interface Spec {
  lookup?: Resolve;
  update?: Resolve;
}

const OK: Resolve = { data: null, error: null };

function revokeClient(spec: Spec) {
  const builderLog: BuilderState[] = [];
  const client = {
    from: vi.fn((table: string) => {
      const st: BuilderState = { table, eq: [] };
      builderLog.push(st);
      const builder: Record<string, unknown> = {
        select: vi.fn((s: string) => {
          st.select = s;
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          st.eq.push([column, value]);
          return builder;
        }),
        update: vi.fn((payload: unknown) => {
          st.updated = payload;
          return builder;
        }),
        maybeSingle: vi.fn(async () => spec.lookup ?? OK),
        single: vi.fn(async () => spec.update ?? OK),
        then: (res: (v: Resolve) => unknown) => res(spec.update ?? OK),
      };
      return builder;
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    _builderLog: builderLog,
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return client as typeof client & { _builderLog: BuilderState[] };
}

/** ใบ valid จำลอง */
function validCert(): Row {
  return { id: CERT_ID, cert_no: CERT_NO, status: "valid", revoked_at: null };
}

/** ผล update จำลอง (conditional UPDATE ... .eq("status","valid") ได้แถวเดียว) */
function revokedRow(): Row {
  return { id: CERT_ID, cert_no: CERT_NO, status: "revoked", revoked_at: "2026-09-08T05:00:00+00:00" };
}

const REASON = "ตรวจพบการทุจริตในการสอบ";

describe("revokeCertificate", () => {
  let warnCalls: Array<{ message: string; fields: Record<string, unknown> }> = [];

  beforeEach(() => {
    vi.mocked(createSupabaseServiceRoleClient).mockReset();
    warnCalls = [];
    vi.spyOn(certLogger, "warn").mockImplementation((message, fields) => {
      warnCalls.push({ message, fields: fields ?? {} });
      return certLogger;
    });
  });

  it("MIN_REASON_LENGTH = 10 ตามใบงาน", () => {
    expect(MIN_REASON_LENGTH).toBe(10);
  });

  it("reason สั้นกว่า 10 → ERR-VAL-001 (length_10_500) โดยไม่แตะ DB", async () => {
    const client = revokeClient({ lookup: OK });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: "สั้น" }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-VAL-001");
    expect((error as AppError).details).toMatchObject({ field: "reason", reason: "length_10_500" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("reason ยาวเกิน 500 → ERR-VAL-001", async () => {
    revokeClient({});
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: "x".repeat(501) }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "length_10_500" });
  });

  it("happy path: conditional UPDATE มี guard status='valid' + คืนสถานะ revoked + audit CERT_REVOKE", async () => {
    const client = revokeClient({
      lookup: { data: validCert(), error: null },
      update: { data: revokedRow(), error: null },
    });
    const result = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON });
    expect(result).toMatchObject({
      id: CERT_ID,
      certNo: CERT_NO,
      status: "revoked",
      revokedReason: REASON,
    });
    const updates = client._builderLog.filter((st) => st.updated !== undefined);
    expect(updates).toHaveLength(1);
    const upd = updates[0];
    expect(upd?.updated).toMatchObject({
      status: "revoked",
      revoked_reason: REASON,
    });
    expect(upd?.eq).toEqual(
      expect.arrayContaining([
        ["id", CERT_ID],
        ["status", "valid"],
      ]),
    );
    expect(client.rpc).toHaveBeenCalledWith(
      "append_audit_event",
      expect.objectContaining({ p_action: "CERT_REVOKE" }),
    );
  });

  it("ไม่พบใบ → ERR-NF-001", async () => {
    revokeClient({ lookup: { data: null, error: null } });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-NF-001");
  });

  it("ใบถูกเพิกถอนไปแล้ว (status revoked) → ERR-VAL-001 not_valid โดยไม่ UPDATE", async () => {
    const client = revokeClient({
      lookup: { data: { ...validCert(), status: "revoked" }, error: null },
      update: { data: revokedRow(), error: null },
    });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "not_valid" });
    expect(client._builderLog.some((st) => st.updated !== undefined)).toBe(false);
  });

  it("แข่งกันเพิกถอน (guard ตัด 0 แถว) → ERR-VAL-001 not_valid", async () => {
    revokeClient({
      lookup: { data: validCert(), error: null },
      update: { data: null, error: null },
    });
    const error = await revokeCertificate({ actorId: STAFF_ID, certificateId: CERT_ID, reason: REASON }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "not_valid" });
  });
});

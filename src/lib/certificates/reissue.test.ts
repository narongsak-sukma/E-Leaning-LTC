/**
 * Unit tests: src/lib/certificates/reissue.ts — ออกใบใหม่แทนใบเดิม (Wave D, lane D-4)
 *
 * จุดหลัก: lineage สองทิศ (ใบใหม่ supersedes_cert_id · ใบเดิม superseded_by) — mock TX ตามใบงาน,
 * compensating revert เมื่อออกใบใหม่ล้ม, และใบเดิมต้อง valid เท่านั้น
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
vi.mock("./pdf", () => ({ renderCertificatePdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import { reissueCertificate } from "./reissue";
import { certLogger } from "./shared";

type Row = Record<string, unknown>;

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const NEW_CERT_ID = "c0000000-0000-4000-8000-000000000009";
const ENROLL_ID = "e0000000-0000-4000-8000-000000000001";
const USER_ID = "f0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";
const T1 = "2026-09-01T00:00:00+00:00";

interface BuilderState {
  table: string;
  select?: string;
  eq: Array<[string, unknown]>;
  updated?: unknown;
  inserted?: unknown;
}

type Resolve = { data: unknown; error: null } | { data: null; error: Record<string, unknown> };

interface Spec {
  /** resolve ของ from("certificates") — (state, log) · คืน undefined เพื่อใช้ default */
  cert?: (st: BuilderState, log: BuilderState[]) => Resolve | undefined;
  read?: (table: string, st: BuilderState) => Resolve;
}

const OK: Resolve = { data: null, error: null };

function reissueClient(spec: Spec) {
  const builderLog: BuilderState[] = [];
  const client = {
    from: vi.fn((table: string) => {
      void table;
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
        not: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        update: vi.fn((payload: unknown) => {
          st.updated = payload;
          return builder;
        }),
        insert: vi.fn((payload: unknown) => {
          st.inserted = payload;
          return builder;
        }),
        maybeSingle: vi.fn(async () => resolveCert(table, st, spec, builderLog)),
        single: vi.fn(async () => resolveCert(table, st, spec, builderLog)),
        then: (res: (v: Resolve) => unknown) => res(resolveCert(table, st, spec, builderLog)),
      };
      return builder;
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    _builderLog: builderLog,
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return client as typeof client & { _builderLog: BuilderState[] };
}

/** default ของ lookup — หลัง supersede ใบเดิมไม่ valid แล้ว จึงมองไม่เห็นเป็น "ใบ valid" */
function lookupResolve(log: BuilderState[]): Resolve {
  const superseded = log.some((entry) => (entry.updated as Row | undefined)?.["status"] === "superseded");
  return superseded ? { data: null, error: null } : { data: validOldCert(), error: null };
}

/** resolve สำหรับ from("certificates") — insert → ใบใหม่ · update → สำเร็จ (default) · lookup ตามสถานะ */
function resolveCert(table: string, st: BuilderState, spec: Spec, log: BuilderState[]): Resolve {
  if (table !== "certificates") {
    return spec.read?.(table, st) ?? OK;
  }
  const overridden = spec.cert?.(st, log);
  if (overridden !== undefined) {
    return overridden;
  }
  if (st.inserted !== undefined) {
    return {
      data: {
        id: NEW_CERT_ID,
        cert_no: "LTC-2026-000999",
        verify_code: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
        issued_at: T1,
      },
      error: null,
    };
  }
  if (st.updated !== undefined) {
    const payload = st.updated as Row;
    if (payload["status"] === "superseded") {
      return { data: { id: CERT_ID, status: "superseded" }, error: null };
    }
    return { data: { id: CERT_ID }, error: null };
  }
  return lookupResolve(log);
}

/** ใบเดิม valid จำลอง */
function validOldCert(): Row {
  return {
    id: CERT_ID,
    cert_no: "LTC-2025-000001",
    enrollment_id: ENROLL_ID,
    status: "valid",
  };
}

/** fixtures ฝั่ง issue (enrollment/attempt/profile/course) ที่ reissue อ่านผ่าน issueCertificate */
function issueFixtures(): Record<string, Row> {
  return {
    enrollments: {
      id: ENROLL_ID,
      user_id: USER_ID,
      course_id: COURSE_ID,
      status: "completed",
      completed_at: T1,
      deleted_at: null,
    },
    assessment_attempts: { id: "d0000000-0000-4000-8000-000000000001", score_pct: 80, attempt_no: 1 },
    profiles: { display_name: "นายสมชาย", first_name: "สมชาย", last_name: "ใจดี" },
    courses: { title_th: "หลักสูตรทดสอบ" },
    media_assets: { id: "90000000-0000-4000-8000-000000000001" },
  };
}

/** read handler มาตรฐานฝั่ง issue — คืนแถวตารางเดียว (assessment_attempts ต้องเป็น array) */
function issueRead(fix: Record<string, Row>, overrides: Record<string, Resolve> = {}) {
  return (table: string): Resolve => {
    const hit = overrides[table];
    if (hit !== undefined) {
      return hit;
    }
    if (table === "assessment_attempts") {
      return { data: [fix["assessment_attempts"]], error: null };
    }
    if (table in fix) {
      return { data: fix[table], error: null };
    }
    return OK;
  };
}

describe("reissueCertificate — lineage (mock TX ตามใบงาน)", () => {
  let warns: Array<{ message: string; fields: Record<string, unknown> }> = [];

  beforeEach(() => {
    vi.mocked(createSupabaseServiceRoleClient).mockReset();
    warns = [];
    vi.spyOn(certLogger, "warn").mockImplementation((message, fields) => {
      warns.push({ message, fields: fields ?? {} });
      return certLogger;
    });
  });

  it("happy path: ใบเดิม superseded + lineage สองทิศ + audit CERT_REISSUE", async () => {
    const client = reissueClient({ read: issueRead(issueFixtures()) });
    const result = await reissueCertificate({ actorId: STAFF_ID, certificateId: CERT_ID });

    expect(result.oldStatus).toBe("superseded");
    expect(result.oldCertificateId).toBe(CERT_ID);
    expect(result.oldSupersededBy).toBe(NEW_CERT_ID);
    expect(result.newCertificate.id).toBe(NEW_CERT_ID);

    const updates = client._builderLog.filter((st) => st.updated !== undefined);
    // ลำดับ: supersede → lineage ใบใหม่ → lineage ใบเดิม
    expect(updates[0]?.updated).toEqual({ status: "superseded" });
    expect(updates[1]?.updated).toEqual({ supersedes_cert_id: CERT_ID });
    expect(updates[2]?.updated).toEqual({ superseded_by: NEW_CERT_ID });
    expect(updates[0]?.eq).toEqual(
      expect.arrayContaining([
        ["id", CERT_ID],
        ["status", "valid"],
      ]),
    );
    expect(updates[1]?.eq).toEqual([["id", NEW_CERT_ID]]);
    expect(updates[2]?.eq).toEqual([["id", CERT_ID]]);

    expect(client.rpc).toHaveBeenCalledWith(
      "append_audit_event",
      expect.objectContaining({ p_action: "CERT_REISSUE" }),
    );
  });

  it("ไม่พบใบเดิม → ERR-NF-001", async () => {
    reissueClient({
      cert: () => ({ data: null, error: null }),
      read: issueRead(issueFixtures()),
    });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-NF-001");
  });

  it("ใบเดิมไม่ valid (revoked) → ERR-VAL-001 not_valid และไม่ supersede", async () => {
    const client = reissueClient({
      cert: () => ({ data: { ...validOldCert(), status: "revoked" }, error: null }),
      read: issueRead(issueFixtures()),
    });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "not_valid" });
    expect(client._builderLog.some((st) => st.updated !== undefined)).toBe(false);
  });

  it("ออกใบใหม่ล้ม → compensating revert ใบเดิมกลับเป็น valid + throw ตัวเดิม", async () => {
    const client = reissueClient({
      read: issueRead(issueFixtures(), {
        // ไม่มี attempt ที่ผ่าน → issueCertificate throw ERR-VAL-001
        assessment_attempts: { data: [], error: null },
      }),
    });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).details).toMatchObject({ reason: "no_passed_attempt" });
    const revert = client._builderLog.filter((st) => st.updated !== undefined).at(-1);
    expect(revert?.updated).toEqual({ status: "valid" });
    expect(revert?.eq).toEqual(
      expect.arrayContaining([
        ["id", CERT_ID],
        ["status", "superseded"],
      ]),
    );
    expect(warns.map((w) => w.message)).not.toContain("certificate_audit_rpc_denied");
  });

  it("lineage update ล้มเหลว → ERR-SYS-002 cert_reissue_lineage_failed", async () => {
    const client = reissueClient({
      cert: (st) =>
        st.updated !== undefined && (st.updated as Row)["supersedes_cert_id"] !== undefined
          ? { data: null, error: { code: "XX000", message: "boom" } }
          : undefined,
      read: issueRead(issueFixtures()),
    });
    const error = await reissueCertificate({ actorId: STAFF_ID, certificateId: CERT_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toMatchObject({ reason: "cert_reissue_lineage_failed" });
    expect(client.from).toHaveBeenCalled();
  });
});

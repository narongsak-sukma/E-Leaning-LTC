/**
 * unit tests — src/lib/certificates/list.ts (Wave E · PB-20)
 *
 * ครอบ: role-gate D55-2 · listCertificates = RPC admin_list_certificates เดียว ·
 * keyset cursor แบบเดียวกับ eligible · drift fail-closed · audit PII_ACCESS หลัง list สำเร็จ
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { encodeCursor, decodeCursor } from "@/lib/api/pagination";
import { AppError } from "@/lib/errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { listCertificates, requireCertificateRegistryRole } from "./list";

type Row = Record<string, unknown>;
type Resolve = { data: unknown; error: null } | { data: null; error: Record<string, unknown> };

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const USER_ID = "f0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";
const T1 = "2026-09-08T04:00:00+00:00";

/** แถวตรง returns table ของ admin_list_certificates (0023 — 9 คอลัมน์ exact) */
function rpcRow(overrides: Row = {}): Row {
  return {
    id: CERT_ID,
    cert_no: "LTC-2026-000123",
    verify_code: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
    status: "valid",
    issued_at: T1,
    user_id: USER_ID,
    holder_name: "สมชาย ใจดี",
    course_id: COURSE_ID,
    course_title: "หลักสูตรทดสอบ",
    ...overrides,
  };
}

/** fake service client — rpc dispatch ตามชื่อฟังก์ชัน (list + append_audit_event) */
function serviceClient(spec: { rpc?: (fn: string) => Resolve } = {}) {
  const rpc = vi.fn(async (fn: string) => spec.rpc?.(fn) ?? { data: [], error: null });
  const client = { rpc };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return { rpc };
}

/** gate stubs — default registrar + aal2 */
function gateStubs(overrides: { roles?: readonly string[]; aal?: "aal1" | "aal2" } = {}) {
  const loadSession = vi.fn(async () => ({ userId: STAFF_ID, aal: overrides.aal ?? "aal2" }));
  const loadMyRoles = vi.fn(async () => overrides.roles ?? (["staff:registrar"] as const));
  return { loadSession, loadMyRoles };
}

describe("requireCertificateRegistryRole — role-gate ตรง (D55-2)", () => {
  it("registrar/super_admin ผ่าน — คืน userId/roles", async () => {
    for (const roles of [["staff:registrar"], ["super_admin"], ["staff:registrar", "citizen"]]) {
      const { loadSession, loadMyRoles } = gateStubs({ roles });
      const result = await requireCertificateRegistryRole({ loadSession, loadMyRoles });
      expect(result.userId).toBe(STAFF_ID);
      expect(result.roles).toEqual(roles);
    }
  });

  it("บทบาทอื่นทั้งชุด → ERR-RBAC-001 (ไม่ยืม certificate:issue)", async () => {
    for (const roles of [
      ["citizen"],
      ["lawyer"],
      ["instructor"],
      ["staff:viewer"],
      ["staff:content"],
      ["staff:exam"],
    ]) {
      const { loadSession, loadMyRoles } = gateStubs({ roles });
      await expect(
        requireCertificateRegistryRole({ loadSession, loadMyRoles }),
      ).rejects.toBeInstanceOf(AppError);
      await expect(
        requireCertificateRegistryRole({ loadSession, loadMyRoles }),
      ).rejects.toMatchObject({ code: "ERR-RBAC-001" });
    }
  });

  it("ไม่มี session → ERR-AUTH-001", async () => {
    const loadSession = vi.fn(async () => null);
    const { loadMyRoles } = gateStubs();
    await expect(
      requireCertificateRegistryRole({ loadSession, loadMyRoles }),
    ).rejects.toMatchObject({ code: "ERR-AUTH-001" });
  });

  it("บทบาทบังคับ MFA แต่ aal1 → ERR-AUTH-004 (fail-closed เหมือน requirePermission)", async () => {
    const { loadSession, loadMyRoles } = gateStubs({ roles: ["staff:registrar"], aal: "aal1" });
    await expect(
      requireCertificateRegistryRole({ loadSession, loadMyRoles }),
    ).rejects.toMatchObject({ code: "ERR-AUTH-004" });
  });

  it("citizen aal1 → ERR-RBAC-001 (บทบาทไม่ผ่าน gate ไม่ใช่ปัญหา MFA)", async () => {
    const { loadSession, loadMyRoles } = gateStubs({ roles: ["citizen"], aal: "aal1" });
    await expect(
      requireCertificateRegistryRole({ loadSession, loadMyRoles }),
    ).rejects.toMatchObject({ code: "ERR-RBAC-001" });
  });
});

describe("listCertificates — RPC param mapping", () => {
  it("default — rpc รับ null ครบทุก p_* และ p_limit = limit+1", async () => {
    const { rpc } = serviceClient();
    const page = await listCertificates({ actorId: STAFF_ID, query: { limit: 20 } });
    // 2 calls = list + audit PII_ACCESS (ตามภารกิจ — audit ทุกครั้งที่ list สำเร็จ)
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "admin_list_certificates",
      expect.objectContaining({
        p_after_issued_at: null,
        p_after_id: null,
        p_cert_no: null,
        p_verify_code: null,
        p_status: null,
        p_holder_user_id: null,
        p_course_id: null,
        p_limit: 21,
      }),
    );
    expect(page.data).toEqual([]);
    expect(page.page.nextCursor).toBeNull();
    expect(page.page.hasMore).toBe(false);
  });

  it("filter ครบชุด — map ตรง p_cert_no/p_verify_code/p_status/p_holder_user_id/p_course_id", async () => {
    const { rpc } = serviceClient({ rpc: () => ({ data: [rpcRow()], error: null }) });
    await listCertificates({
      actorId: STAFF_ID,
      query: {
        limit: 20,
        certNo: "LTC-2026-",
        verifyCode: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
        status: "valid",
        holderUserId: USER_ID,
        courseId: COURSE_ID,
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      "admin_list_certificates",
      expect.objectContaining({
        p_cert_no: "LTC-2026-",
        p_verify_code: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
        p_status: "valid",
        p_holder_user_id: USER_ID,
        p_course_id: COURSE_ID,
        p_limit: 21,
      }),
    );
  });
});

describe("listCertificates — keyset cursor (แบบเดียวกับ eligible)", () => {
  it("cursor → decode เป็น p_after_issued_at/p_after_id (encode/decode roundtrip)", async () => {
    const { rpc } = serviceClient({ rpc: () => ({ data: [rpcRow()], error: null }) });
    const cursor = encodeCursor({ sortKey: T1, id: CERT_ID });
    await listCertificates({ actorId: STAFF_ID, query: { limit: 20, cursor } });
    expect(rpc).toHaveBeenCalledWith(
      "admin_list_certificates",
      expect.objectContaining({ p_after_issued_at: T1, p_after_id: CERT_ID }),
    );
  });

  it("cursor ทับ after_* ตรง (signed มาก่อน) — cursor ปลอม → ERR-VAL-001", async () => {
    serviceClient();
    await expect(
      listCertificates({
        actorId: STAFF_ID,
        query: { limit: 20, cursor: "ปลอม", afterIssuedAt: T1, afterId: CERT_ID },
      }),
    ).rejects.toMatchObject({ code: "ERR-VAL-001" });
  });
});

describe("listCertificates — drift fail-closed (r7-M2 แบบ eligible)", () => {
  it("ผลลัพธ์ไม่ใช่ array → ERR-SYS-002", async () => {
    serviceClient({ rpc: () => ({ data: null, error: null }) });
    await expect(
      listCertificates({ actorId: STAFF_ID, query: { limit: 20 } }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002" });
  });

  it("แถวคีย์เกิน/คีย์หาย/ชนิดผิด → ERR-SYS-002 (แถวแรกพอ — map หยุดทันที)", async () => {
    serviceClient({
      rpc: () => ({
        data: [rpcRow({ extra_key: 1 }), rpcRow({ verify_code: 5 }), { id: "x" }],
        error: null,
      }),
    });
    await expect(
      listCertificates({ actorId: STAFF_ID, query: { limit: 20 } }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002" });
  });

  it("RPC error → ERR-SYS-002 cert_list_query_failed", async () => {
    serviceClient({ rpc: () => ({ data: null, error: { message: "boom" } }) });
    await expect(
      listCertificates({ actorId: STAFF_ID, query: { limit: 20 } }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002" });
  });
});

describe("listCertificates — buildPage (limit+1 peek แบบ eligible)", () => {
  it("21 แถว limit 20 → 20 แถว + hasMore + nextCursor ใช้ต่อได้", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 21; i += 1) {
      rows.push(rpcRow({ id: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    }
    serviceClient({ rpc: () => ({ data: rows, error: null }) });
    const page = await listCertificates({ actorId: STAFF_ID, query: { limit: 20 } });
    expect(page.data).toHaveLength(20);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).not.toBeNull();
    expect(() => decodeCursor(page.page.nextCursor as string)).not.toThrow();
    expect(page.data[19]?.issuedAt).toBe(T1);
  });

  it("แถวน้อยกว่า limit → ไม่มี nextCursor + hasMore false", async () => {
    serviceClient({
      rpc: (fn) => (fn === "admin_list_certificates" ? { data: [rpcRow()], error: null } : { data: null, error: null }),
    });
    const page = await listCertificates({ actorId: STAFF_ID, query: { limit: 20 } });
    expect(page.data).toHaveLength(1);
    expect(page.page.nextCursor).toBeNull();
    expect(page.page.hasMore).toBe(false);
  });
});

describe("listCertificates — audit PII_ACCESS หลัง list สำเร็จ", () => {
  it("เรียก append_audit_event ด้วยคีย์ตรง allowlist DB (endpoint/purpose + user_id)", async () => {
    const { rpc } = serviceClient();
    await listCertificates({ actorId: STAFF_ID, query: { limit: 20 } });
    expect(rpc).toHaveBeenCalledWith(
      "append_audit_event",
      expect.objectContaining({
        p_action: "PII_ACCESS",
        p_entity_type: "certificate",
        p_context: {
          endpoint: "/api/v1/admin/certificates",
          purpose: "certificate_registry_view",
          user_id: STAFF_ID,
        },
      }),
    );
  });

  it("หน้าว่าง → entityId null (ไม่ใส่ค่าปลอม) และยัง audit ทุกครั้ง", async () => {
    const { rpc } = serviceClient();
    await listCertificates({ actorId: STAFF_ID, query: { limit: 20 } });
    const calls = rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    const auditCall = calls.find((call) => call[0] === "append_audit_event");
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]["p_entity_id"]).toBeNull();
  });

  it("audit RPC ล้มเหลว → ไม่ล้ม read (access event — WARN แล้วคืนผลตามแบบแผน eligible)", async () => {
    serviceClient({
      rpc: (fn) => (fn === "append_audit_event" ? { data: null, error: { code: "42501" } } : { data: [rpcRow()], error: null }),
    });
    const page = await listCertificates({ actorId: STAFF_ID, query: { limit: 20 } });
    expect(page.data).toHaveLength(1);
  });
});

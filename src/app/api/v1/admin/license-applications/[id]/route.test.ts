/**
 * route.test — PATCH /api/v1/admin/license-applications/[id] (Wave E Phase 5 · แถว 229)
 *
 * reject reason <10 → 400 ก่อน RPC · approve → 200 · conflict เลขซ้ำ → 409 ข้อความไทย
 * ชี้ชัด constraint · mfa_required 403 · not found 404 · :id ผิดรูป 400 · body strict ·
 * RBAC license:verify + STAFF_WRITE
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
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/license/decide", () => ({
  decideLicenseApplication: vi.fn(),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { decideLicenseApplication } from "@/lib/license/decide";
import { PATCH } from "./route";

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const APP_ID = "b0000000-0000-4000-8000-000000000001";
const LIC_ID = "d0000000-0000-4000-8000-000000000001";
const APPROVE_RESULT = {
  applicationId: APP_ID,
  result: "approved" as const,
  resultingLicenseId: LIC_ID,
  roleGranted: true,
};

/** staff client ครบชั้น requirePermission (my_roles + aal2 + profiles active) */
function mockStaffClient(options: { readonly roles?: readonly string[]; readonly aal?: "aal1" | "aal2" } = {}): void {
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: STAFF_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: options.aal ?? "aal2" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) => {
      if (fn === "my_roles") {
        return { data: options.roles ?? ["staff:registrar"], error: null };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : {})),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
}

/** PATCH request — body JSON + param :id */
function patchRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/v1/admin/license-applications/${id}`, {
    method: "PATCH",
    headers: { "x-forwarded-for": "10.9.1.1", "x-request-id": "req-decide-1" },
    body: JSON.stringify(body),
  });
}

async function patchApp(id: string, body: unknown): Promise<Response> {
  return PATCH(patchRequest(id, body), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(decideLicenseApplication).mockReset();
  resetRateLimitStore();
});

describe("PATCH /api/v1/admin/license-applications/[id]", () => {
  it("reject — reason trim ≥10 → 200 + args RPC ครบ (reason ตัดขอบ)", async () => {
    mockStaffClient();
    vi.mocked(decideLicenseApplication).mockResolvedValue({
      applicationId: APP_ID,
      result: "rejected",
      resultingLicenseId: null,
      roleGranted: null,
    });
    const res = await patchApp(APP_ID, { action: "reject", reason: "   เอกสารไม่ชัดเจนพอ   " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: string } };
    expect(body.data.result).toBe("rejected");
    expect(decideLicenseApplication).toHaveBeenCalledWith({
      appId: APP_ID,
      action: "reject",
      reason: "เอกสารไม่ชัดเจนพอ",
      requestId: "req-decide-1",
    });
  });

  it("approve — 200 + roleGranted/licenseId · reason เว้นว่าง → null", async () => {
    mockStaffClient();
    vi.mocked(decideLicenseApplication).mockResolvedValue(APPROVE_RESULT);
    const res = await patchApp(APP_ID, { action: "approve", reason: "   " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof APPROVE_RESULT };
    expect(body.data).toEqual(APPROVE_RESULT);
    expect(decideLicenseApplication).toHaveBeenCalledWith({
      appId: APP_ID,
      action: "approve",
      reason: null,
      requestId: "req-decide-1",
    });
  });

  it("reject reason สั้น (<10 หลัง trim) → 400 fields [reason] ก่อน RPC", async () => {
    mockStaffClient();
    for (const reason of ["สั้น", "   "]) {
      const res = await patchApp(APP_ID, { action: "reject", reason });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { details: { fields?: string[] } } };
      expect(body.error.details.fields).toEqual(["reason"]);
    }
    expect(decideLicenseApplication).not.toHaveBeenCalled();
  });

  it("เลขซ้ำคนอื่น → 409 ข้อความไทยเอ่ยชื่อ constraint", async () => {
    mockStaffClient();
    const { AppError } = await import("@/lib/errors");
    vi.mocked(decideLicenseApplication).mockRejectedValue(
      new AppError("ERR-VAL-001", { details: { reason: "license_no_conflict" } }),
    );
    const res = await patchApp(APP_ID, { action: "approve" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.message).toContain("uq_lawyer_licenses_license_no_active_license");
    expect(res.headers.get("x-request-id")).toBe("req-decide-1");
  });

  it("ป้าย RPC ผ่าน lib — mfa_required 403 · application_not_found 404", async () => {
    mockStaffClient();
    const { AppError } = await import("@/lib/errors");
    vi.mocked(decideLicenseApplication).mockRejectedValue(new AppError("ERR-AUTH-004"));
    expect((await patchApp(APP_ID, { action: "approve" })).status).toBe(403);
    vi.mocked(decideLicenseApplication).mockRejectedValue(new AppError("ERR-NF-001"));
    expect((await patchApp(APP_ID, { action: "approve" })).status).toBe(404);
  });

  it("RBAC — staff:content 403 · ไม่มี session 401", async () => {
    mockStaffClient({ roles: ["staff:content"] });
    const res = await patchApp(APP_ID, { action: "approve" });
    expect(res.status).toBe(403);
    mockStaffClient({ roles: ["citizen"] });
    const res2 = await patchApp(APP_ID, { action: "approve" });
    expect(res2.status).toBe(403);
  });

  it(":id ผิดรูป uuid → 400 fields [id] ก่อน RPC", async () => {
    mockStaffClient();
    const res = await patchApp("not-a-uuid", { action: "approve" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields?: string[] } } };
    expect(body.error.details.fields).toEqual(["id"]);
    expect(decideLicenseApplication).not.toHaveBeenCalled();
  });

  it("body strict — key แปลกปลอม/ไม่มี action/reason >500 → 400", async () => {
    mockStaffClient();
    for (const body of [{ action: "approve", extra: 1 }, { reason: "x" }, { action: "approve", reason: "x".repeat(501) }]) {
      const res = await patchApp(APP_ID, body);
      expect(res.status).toBe(400);
    }
    expect(decideLicenseApplication).not.toHaveBeenCalled();
  });

  it("STAFF_WRITE 60/min — คำขอที่ 61+ → 429", async () => {
    mockStaffClient();
    vi.mocked(decideLicenseApplication).mockResolvedValue(APPROVE_RESULT);
    let saw429 = false;
    for (let i = 0; i < 65; i += 1) {
      const res = await patchApp(APP_ID, { action: "approve" });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(saw429).toBe(true);
  });
});

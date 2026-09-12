/**
 * route.test — /api/v1/me/license (Wave E Phase 5 · D-p5-2/4)
 *
 * GET — คำขอล่าสุด + ใบปัจจุบัน + canResubmit · 401 · query ล้ม 503 · drift 503
 * PUT — multipart 202 · pending ซ้ำ 409 · body/field ผิด 400 · 503 ทะลุ · LEARN_WRITE 429
 *
 * mock ตามแบบ admin/credit-rules (vi.mock ssr + buffered · thenable builder แยกตาราง)
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
vi.mock("@/lib/license/submit", () => ({
  submitLicenseApplication: vi.fn(),
}));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { submitLicenseApplication } from "@/lib/license/submit";
import { GET, PUT } from "./route";

const USER_ID = "u0000000-0000-4000-8000-000000000001";
const T = "2026-09-01T00:00:00+00:00";
const SUBMITTED = { applicationId: "b0000000-0000-4000-8000-000000000001", status: "pending" as const, submittedAt: T };

/** ไฟล์จำลอง — ตั้ง type/size ตรง schema */
function makeFile(options: { readonly type?: string; readonly size?: number } = {}): File {
  const type = options.type ?? "image/png";
  const size = options.size ?? 1024;
  const file = new File(["x".repeat(size)], "evidence.png", { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

type TableResult = { readonly data?: unknown; readonly error?: unknown };

/** บันทึก chain ของแต่ละตาราง — eq/is/order/limit/maybeSingle คืนผลตาม tables[table] */
interface TableCalls {
  readonly select: unknown[];
  readonly eq: Array<{ column: string; value: unknown }>;
  readonly is: Array<{ column: string; value: unknown }>;
  readonly order: Array<[string, { ascending: boolean }]>;
  readonly limit: unknown[];
  maybeSingle: () => Promise<TableResult>;
}

/**
 * client ครบชั้น requireUser — auth.getUser + mfa + profiles active ·
 * from(table) คืน builder แยกตาราง (GET เรียก 2 ตารางขนาน)
 */
function mockClient(options: {
  readonly userId?: string;
  readonly authError?: unknown;
  readonly tables?: Record<string, TableResult>;
} = {}): Record<string, TableCalls> {
  const userId = options.userId ?? USER_ID;
  const allCalls: Record<string, TableCalls> = {};
  const profilesResult: TableResult = options.tables?.["profiles"] ?? {
    data: { is_active: true, deleted_at: null },
    error: null,
  };
  const client = {
    auth: {
      getUser: vi.fn(async () =>
        options.authError === undefined
          ? { data: { user: { id: userId } }, error: null }
          : { data: { user: null }, error: options.authError },
      ),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn((table: string) => {
      const calls: TableCalls = {
        select: [],
        eq: [],
        is: [],
        order: [],
        limit: [],
        maybeSingle: async () => {
          const result = table === "profiles" ? profilesResult : (options.tables?.[table] ?? { data: null, error: null });
          return { data: result.data ?? null, error: result.error ?? null };
        },
      };
      const builder = {
        select: vi.fn((s: unknown) => {
          calls.select.push(s);
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          calls.eq.push({ column, value });
          return builder;
        }),
        is: vi.fn((column: string, value: unknown) => {
          calls.is.push({ column, value });
          return builder;
        }),
        order: vi.fn((column: string, opts: { ascending: boolean }) => {
          calls.order.push([column, opts]);
          return builder;
        }),
        limit: vi.fn((n: unknown) => {
          calls.limit.push(n);
          return builder;
        }),
        maybeSingle: vi.fn(() => calls.maybeSingle()),
      };
      allCalls[table] = calls;
      return builder;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return allCalls;
}

function getUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/me/license" + query, {
    headers: { "x-forwarded-for": "10.7.0.1", "x-request-id": "req-me-lic-1" },
  });
}

/** multipart PUT — license_no + ไฟล์ */
function putForm(fields: { readonly licenseNo?: string; readonly file?: File | string }): Request {
  const form = new FormData();
  if (fields.licenseNo !== undefined) {
    form.set("license_no", fields.licenseNo);
  }
  if (fields.file !== undefined) {
    form.set("file", fields.file);
  }
  return new Request("http://localhost:3000/api/v1/me/license", {
    method: "PUT",
    headers: { "x-forwarded-for": "10.7.0.2", "x-request-id": "req-me-lic-2" },
    body: form,
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(submitLicenseApplication).mockReset();
  resetRateLimitStore();
});

describe("GET /api/v1/me/license", () => {
  it("คำขอ pending ล่าสุด + ไม่มีใบ → canResubmit false · คิวรีครบทั้งสองตาราง", async () => {
    const calls = mockClient({
      tables: {
        license_applications: {
          data: { status: "pending", rejected_reason: null, decided_at: null, submitted_at: T },
          error: null,
        },
        lawyer_licenses: { data: null, error: null },
      },
    });
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { latestApplication: unknown; currentLicense: unknown; canResubmit: boolean } };
    expect(body.data).toEqual({
      latestApplication: { status: "pending", rejectedReason: null, decidedAt: null, submittedAt: T },
      currentLicense: null,
      canResubmit: false,
    });
    expect(calls["license_applications"]?.eq).toContainEqual({ column: "user_id", value: USER_ID });
    expect(calls["lawyer_licenses"]?.eq).toContainEqual({ column: "user_id", value: USER_ID });
    expect(calls["lawyer_licenses"]?.is).toContainEqual({ column: "revoked_at", value: null });
    expect(calls["lawyer_licenses"]?.is).toContainEqual({ column: "deleted_at", value: null });
  });

  it("โดน reject + มีใบเก่า → canResubmit true + เหตุผล/ใบครบ", async () => {
    mockClient({
      tables: {
        license_applications: {
          data: { status: "rejected", rejected_reason: "ภาพไม่ชัด", decided_at: T, submitted_at: T },
          error: null,
        },
        lawyer_licenses: { data: { license_no: "1234567", verified_at: T }, error: null },
      },
    });
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { latestApplication: { rejectedReason: string | null }; currentLicense: { licenseNo: string } | null; canResubmit: boolean } };
    expect(body.data.latestApplication?.rejectedReason).toBe("ภาพไม่ชัด");
    expect(body.data.currentLicense).toEqual({ licenseNo: "1234567", verifiedAt: T });
    expect(body.data.canResubmit).toBe(true);
  });

  it("approved + ใบ verified → canResubmit false (ผูกเลขแล้วห้ามเสนอฟอร์มยื่นซ้ำ)", async () => {
    mockClient({
      tables: {
        license_applications: {
          data: { status: "approved", rejected_reason: null, decided_at: T, submitted_at: T },
          error: null,
        },
        lawyer_licenses: { data: { license_no: "7301589", verified_at: T }, error: null },
      },
    });
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { latestApplication: unknown; currentLicense: unknown; canResubmit: boolean } };
    expect(body.data.latestApplication).toEqual({
      status: "approved",
      rejectedReason: null,
      decidedAt: T,
      submittedAt: T,
    });
    expect(body.data.currentLicense).toEqual({ licenseNo: "7301589", verifiedAt: T });
    expect(body.data.canResubmit).toBe(false);
  });

  it("ไม่มีคำขอ/ไม่มีใบ → null ทั้งคู่ + canResubmit true", async () => {
    mockClient({ tables: {} });
    const res = await GET(getUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { latestApplication: unknown; currentLicense: unknown; canResubmit: boolean } };
    expect(body.data.latestApplication).toBeNull();
    expect(body.data.currentLicense).toBeNull();
    expect(body.data.canResubmit).toBe(true);
  });

  it("401 เมื่อไม่มี session", async () => {
    mockClient({ authError: { message: "no session" } });
    const res = await GET(getUrl());
    expect(res.status).toBe(401);
  });

  it("คิวรีคำขอล้ม → 503 license_applications_query_failed", async () => {
    mockClient({ tables: { license_applications: { data: null, error: { message: "db down" } } } });
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason?: string } } };
    expect(body.error.details.reason).toBe("license_applications_query_failed");
  });

  it("คิวรีใบล้ม → 503 lawyer_licenses_query_failed", async () => {
    mockClient({ tables: { lawyer_licenses: { data: null, error: { message: "db down" } } } });
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason?: string } } };
    expect(body.error.details.reason).toBe("lawyer_licenses_query_failed");
  });

  it("สถานะนอก enum → 503 my_license_status_drift (strict ขาออก)", async () => {
    mockClient({
      tables: {
        license_applications: {
          data: { status: "processing", rejected_reason: null, decided_at: null, submitted_at: T },
          error: null,
        },
      },
    });
    const res = await GET(getUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason?: string } } };
    expect(body.error.details.reason).toBe("my_license_status_drift");
  });
});

describe("PUT /api/v1/me/license", () => {
  it("สำเร็จ → 202 + แถวคำขอ + ส่ง userId/licenseNo/file/requestId ให้ lib ครบ", async () => {
    mockClient();
    vi.mocked(submitLicenseApplication).mockResolvedValue(SUBMITTED);
    const res = await PUT(putForm({ licenseNo: "1234567", file: makeFile() }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: typeof SUBMITTED };
    expect(body.data).toEqual(SUBMITTED);
    expect(submitLicenseApplication).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(submitLicenseApplication).mock.calls[0]?.[0];
    expect(arg?.userId).toBe(USER_ID);
    expect(arg?.licenseNo).toBe("1234567");
    expect(arg?.file).toBeInstanceOf(File);
    expect(arg?.requestId).toBe("req-me-lic-2");
  });

  it("pending ซ้ำ → 409 + ข้อความไทย + x-request-id คงเดิม", async () => {
    vi.mocked(submitLicenseApplication).mockRejectedValue(
      new (await import("@/lib/errors")).AppError("ERR-VAL-001", { details: { reason: "pending_exists" } }),
    );
    mockClient();
    const res = await PUT(putForm({ licenseNo: "1234567", file: makeFile() }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.message).toContain("คำขอที่รอตัดสินอยู่แล้ว");
    expect(res.headers.get("x-request-id")).toBe("req-me-lic-2");
  });

  it("ไม่มี license_no → 400 fields [license_no] (ยังไม่เรียก lib)", async () => {
    mockClient();
    const res = await PUT(putForm({ file: makeFile() }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields?: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.fields).toEqual(["license_no"]);
    expect(submitLicenseApplication).not.toHaveBeenCalled();
  });

  it("ไม่มีไฟล์ → 400 fields [file]", async () => {
    mockClient();
    const res = await PUT(putForm({ licenseNo: "1234567" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields?: string[] } } };
    expect(body.error.details.fields).toEqual(["file"]);
  });

  it("body ไม่ใช่ multipart → 400 fields [body]", async () => {
    mockClient();
    const res = await PUT(new Request("http://localhost:3000/api/v1/me/license", {
      method: "PUT",
      headers: { "x-forwarded-for": "10.7.0.3" },
      body: "not-a-form",
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields?: string[] } } };
    expect(body.error.details.fields).toEqual(["body"]);
  });

  it("lib โยน error อื่น → ทะลุ jsonErrorResponse (503)", async () => {
    mockClient();
    vi.mocked(submitLicenseApplication).mockRejectedValue(
      new (await import("@/lib/errors")).AppError("ERR-SYS-002", { details: { reason: "evidence_upload_failed" } }),
    );
    const res = await PUT(putForm({ licenseNo: "1234567", file: makeFile() }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { details: { reason?: string } } };
    expect(body.error.details.reason).toBe("evidence_upload_failed");
  });

  it("LEARN_WRITE 120/min — คำขอที่ 121+ → 429", async () => {
    mockClient();
    vi.mocked(submitLicenseApplication).mockResolvedValue(SUBMITTED);
    let saw429 = false;
    for (let i = 0; i < 125; i += 1) {
      const res = await PUT(putForm({ licenseNo: "1234567", file: makeFile() }));
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(202);
    }
    expect(saw429).toBe(true);
  });
});

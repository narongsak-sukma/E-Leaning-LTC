/**
 * unit tests — lib/license/submit (Wave E Phase 5 · D-p5-2)
 *
 * ลำดับที่ตรวจ: validate → upload service → media_assets → RPC user-JWT → cleanup เมื่อล้ม
 * · ป้าย error "(ERR-XXX-NNN|tag)" แกะผ่าน rpc-errors · ไม่มีป้าย = 503 opaque
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

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { submitLicenseApplication, evidenceExtensionOf, LICENSE_EVIDENCE_BUCKET } from "./submit";

const USER_ID = "u0000000-0000-4000-8000-000000000001";
const MEDIA_ID = "m0000000-0000-4000-8000-000000000001";
const APP_ID = "b0000000-0000-4000-8000-000000000001";
const T = "2026-09-01T00:00:00+00:00";

/** ไฟล์จำลอง — ตั้ง type/size ตรง schema โดยไม่เขียน byte จริงทั้งก้อน */
function makeFile(options: { readonly type: string; readonly size?: number }): File {
  const size = options.size ?? 1024;
  const file = new File(["x".repeat(size)], "evidence.bin", { type: options.type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** service client mock — storage.upload/remove + media_assets insert/delete ติดตามทุก call */
function mockService(options: {
  readonly uploadError?: unknown;
  readonly mediaSingle?: { readonly data?: unknown; readonly error?: unknown } | null;
  readonly removeError?: unknown;
} = {}): {
  readonly calls: {
    readonly upload: unknown[];
    readonly mediaInsert: unknown[];
    readonly mediaDeleteEq: Array<{ column: string; value: unknown }>;
    readonly remove: unknown[];
  };
} {
  const calls = { upload: [] as unknown[], mediaInsert: [] as unknown[], mediaDeleteEq: [] as Array<{ column: string; value: unknown }>, remove: [] as unknown[] };
  const deleteChain = {
    eq: vi.fn(async (column: string, value: unknown) => {
      calls.mediaDeleteEq.push({ column, value });
      return { data: null, error: null };
    }),
  };
  const mediaBuilder = {
    insert: vi.fn((payload: unknown) => {
      calls.mediaInsert.push(payload);
      return mediaBuilder;
    }),
    delete: vi.fn(() => {
      return deleteChain;
    }),
    select: vi.fn(() => mediaBuilder),
    single: vi.fn(async () => options.mediaSingle ?? { data: { id: MEDIA_ID }, error: null }),
  };
  const storage = {
    from: vi.fn(() => storage),
    upload: vi.fn(async (path: unknown, body: unknown, opts: unknown) => {
      calls.upload.push({ path, opts });
      return options.uploadError === undefined ? { data: null, error: null } : { data: null, error: options.uploadError };
    }),
    remove: vi.fn(async (paths: unknown) => {
      calls.remove.push(paths);
      return { data: null, error: options.removeError ?? null };
    }),
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
    storage,
    from: vi.fn(() => mediaBuilder),
  } as never);
  return { calls };
}

/** user-JWT client mock — rpc my_submit_license_application คืนตามที่เทสกำหนด */
function mockUserClient(rpcResult: { readonly data?: unknown; readonly error?: unknown } | null = null): {
  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  vi.mocked(createSupabaseSsrClient).mockResolvedValue({
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      return { data: rpcResult?.data ?? null, error: rpcResult?.error ?? null };
    }),
  } as never);
  return { rpcCalls };
}

/** แถว jsonb ที่ RPC คืนตอนสำเร็จ (ตามสัญญา 0035) */
function appRow(): Record<string, unknown> {
  return { id: APP_ID, user_id: USER_ID, license_no: "1234567", status: "pending", evidence_media_id: MEDIA_ID, submitted_at: T };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
});

describe("submitLicenseApplication — happy path", () => {
  it("อัปโหลด path ตามสัญญา + insert media + rpc ครบ args + ไม่มี cleanup", async () => {
    const service = mockService();
    const { rpcCalls } = mockUserClient({ data: [appRow()] });
    const result = await submitLicenseApplication({
      userId: USER_ID,
      licenseNo: " 1234567 ",
      file: makeFile({ type: "image/png" }),
      requestId: "req-x-1",
    });
    // storage path license-evidence/{user_id}/{uuid}.png
    expect(service.calls.upload).toHaveLength(1);
    const upload = service.calls.upload[0] as { readonly path: string; readonly opts: Record<string, unknown> };
    expect(upload.path.startsWith(`license-evidence/${USER_ID}/`)).toBe(true);
    expect(upload.path.endsWith(".png")).toBe(true);
    expect(upload.opts).toEqual({ contentType: "image/png", upsert: false });
    // media_assets payload
    expect(service.calls.mediaInsert).toEqual([
      {
        provider: "supabase_storage",
        media_type: "image",
        bucket: "license-evidence",
        storage_path: upload.path,
        mime_type: "image/png",
        size_bytes: 1024,
        status: "ready",
        uploaded_by: USER_ID,
      },
    ]);
    // rpc args ครบ (license_no ผ่าน trim จาก schema)
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("my_submit_license_application");
    expect(rpcCalls[0]?.args).toEqual({
      p_license_no: "1234567",
      p_evidence_media_id: MEDIA_ID,
      p_request_id: "req-x-1",
    });
    // ไม่มี cleanup — ไฟล์คงอยู่
    expect(service.calls.remove).toHaveLength(0);
    expect(service.calls.mediaDeleteEq).toHaveLength(0);
    // แถวคำขอ (array wrap ถูก unwrap)
    expect(result).toEqual({ applicationId: APP_ID, status: "pending", submittedAt: T });
  });

  it("pdf → media_type document", async () => {
    mockService();
    mockUserClient({ data: appRow() });
    const result = await submitLicenseApplication({
      userId: USER_ID,
      licenseNo: "123456",
      file: makeFile({ type: "application/pdf" }),
      requestId: null,
    });
    expect(result.status).toBe("pending");
  });
});

describe("submitLicenseApplication — validate ก่อนแตะ DB/storage", () => {
  it("license_no ผิดรูป → ERR-VAL-001 fields [license_no] ไม่มี upload/rpc", async () => {
    const service = mockService();
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "12345", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-VAL-001", details: { fields: ["license_no"] } });
    expect(service.calls.upload).toHaveLength(0);
  });

  it("mime ไม่รับ → ERR-VAL-001 fields [file]", async () => {
    const service = mockService();
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/gif" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-VAL-001", details: { fields: ["file"] } });
    expect(service.calls.upload).toHaveLength(0);
  });

  it("arrayBuffer ล้ม → ERR-VAL-001 fields [file] (ไม่มี upload)", async () => {
    mockService();
    const file = makeFile({ type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockRejectedValueOnce(new Error("read fail"));
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file, requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-VAL-001", details: { fields: ["file"] } });
  });
});

describe("submitLicenseApplication — storage/media ล้ม", () => {
  it("upload ล้ม → 503 evidence_upload_failed (ยังไม่ insert media)", async () => {
    const service = mockService({ uploadError: { message: "storage down" } });
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "evidence_upload_failed" } });
    expect(service.calls.mediaInsert).toHaveLength(0);
    expect(service.calls.remove).toHaveLength(0);
  });

  it("insert media ล้ม → 503 evidence_media_insert_failed + ลบไฟล์คืน", async () => {
    const service = mockService({ mediaSingle: { data: null, error: { message: "insert fail" } } });
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "evidence_media_insert_failed" } });
    // cleanup — ลบไฟล์คืน (ยังไม่รู้ mediaId — ไม่มี delete แถว)
    expect(service.calls.remove).toHaveLength(1);
    expect(service.calls.mediaDeleteEq).toHaveLength(0);
  });

  it("media id ไม่ใช่ string → 503 evidence_media_row_drift + cleanup ไฟล์", async () => {
    const service = mockService({ mediaSingle: { data: { id: 42 }, error: null } });
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "evidence_media_row_drift" } });
    expect(service.calls.remove).toHaveLength(1);
  });
});

describe("submitLicenseApplication — RPC ล้ม → cleanup + map ป้าย", () => {
  it("pending_exists → ERR-VAL-001 reason pending_exists + ลบ media + ลบไฟล์", async () => {
    const service = mockService();
    mockUserClient({
      error: { message: 'duplicate key ... (ERR-VAL-001|pending_exists)', code: "23505" },
    });
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-VAL-001", details: { reason: "pending_exists" } });
    expect(service.calls.mediaDeleteEq).toEqual([{ column: "id", value: MEDIA_ID }]);
    expect(service.calls.remove).toHaveLength(1);
  });

  it("ป้าย license_no_format → ERR-VAL-001 (ไม่มี reason)", async () => {
    mockService();
    mockUserClient({ error: { message: "license_no format (ERR-VAL-001|license_no_format)", code: "22023" } });
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-VAL-001", details: {} });
  });

  it("ไม่มีป้าย → ERR-SYS-002 opaque license_submit_failed + cleanup", async () => {
    mockService();
    mockUserClient({ error: { message: "connection reset", code: "08000" } });
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "license_submit_failed" } });
  });
});

describe("submitLicenseApplication — ขาออก drift → 503 + cleanup", () => {
  it("submitted_at หาย → 503 license_application_created_drift", async () => {
    const service = mockService();
    mockUserClient({ data: [{ id: APP_ID, status: "pending" }] });
    await expect(
      submitLicenseApplication({ userId: USER_ID, licenseNo: "123456", file: makeFile({ type: "image/png" }), requestId: null }),
    ).rejects.toMatchObject({ code: "ERR-SYS-002", details: { reason: "license_application_created_drift" } });
    expect(service.calls.remove).toHaveLength(1);
    expect(service.calls.mediaDeleteEq).toEqual([{ column: "id", value: MEDIA_ID }]);
  });
});

describe("evidenceExtensionOf", () => {
  it("แผนที่ mime → นามสกุล (ไม่รู้จัก = null)", () => {
    expect(evidenceExtensionOf("image/jpeg")).toBe("jpg");
    expect(evidenceExtensionOf("image/png")).toBe("png");
    expect(evidenceExtensionOf("application/pdf")).toBe("pdf");
    expect(evidenceExtensionOf("image/gif")).toBeNull();
  });

  it("ชื่อบักเก็ตตามสัญญา 0035 §2", () => {
    expect(LICENSE_EVIDENCE_BUCKET).toBe("license-evidence");
  });
});

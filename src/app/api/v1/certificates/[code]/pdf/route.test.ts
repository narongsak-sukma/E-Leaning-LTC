/**
 * route.test — GET /api/v1/certificates/{code}/pdf (Wave D-2 · API-SPECIFICATION §3.6)
 *
 * mock ssr client (requirePermission จริง — session + my_roles RPC) + rate-limit —
 * จุดหลัก: uuid รูปแปลก → VAL-001 · RLS/permission 403 · pdf_media_id null → 404 NF-001 ·
 * media + download ครบ → 200 application/pdf — เจ้าของใบโหลดได้จริงทั้ง issued/revoked
 * (RLS media_read 0019 PB-14a + storage.objects ครอบเจ้าของแล้ว — e2e-10 พิสูจน์
 * 200 + %PDF- ผ่าน session เจ้าของใบบน stack จริง)
 */
process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { GET } from "./route";

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

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

interface RowResult {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

/** builder จำลอง select → eq → maybeSingle */
function makeSingleBuilder(result: RowResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({
      data: result.data === undefined ? null : result.data,
      error: result.error === undefined ? null : result.error,
    })),
  };
  return builder;
}

const USER_ID = "11111111-2222-4333-8444-555555555501";
const CERT_ID = "99999999-8888-4777-8666-555555555501";
const MEDIA_ID = "aaaaaaaa-bbbb-4ccc-8ddd-555555555501";

/** client จำลองที่มี session + บทบาท + ตาราง certificates/media_assets + storage */
function makeClient(options: {
  roles?: readonly string[];
  aal?: "aal1" | "aal2";
  session?: boolean;
  certs?: RowResult;
  media?: RowResult;
  download?: { data?: Blob; error?: { message: string } | null };
}) {
  const aal = options.aal ?? "aal1";
  const roles = options.roles ?? ["citizen"];
  const session = options.session ?? true;
  const certBuilder = makeSingleBuilder(options.certs ?? {});
  const mediaBuilder = makeSingleBuilder(options.media ?? {});
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const download = vi.fn(async () => ({
    data: options.download?.data ?? new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]),
    error: options.download?.error ?? null,
  }));
  const storage = { from: vi.fn(() => ({ download })) };
  const client = {
    auth: {
      getUser: vi.fn(async () =>
        session
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "no session" } },
      ),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: aal },
          error: null,
        })),
      },
    },
    rpc: vi.fn((fn: string) => {
      if (fn === "my_roles") {
        return Promise.resolve({ data: roles, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn((table: string) =>
      table === "certificates" ? certBuilder : table === "media_assets" ? mediaBuilder : profilesBuilder,
    ),
    storage,
    _cert: certBuilder,
    _media: mediaBuilder,
    _download: download,
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

function pdfUrl(): Request {
  return new Request("http://localhost:3000/api/v1/certificates/" + CERT_ID + "/pdf", {
    headers: { "x-request-id": "req-d2-2" },
  });
}

function ctx(code: string): { params: Promise<{ code: string }> } {
  return { params: Promise.resolve({ code }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /certificates/{code}/pdf — validation + auth", () => {
  it("{code} ไม่ใช่ uuid → 400 ERR-VAL-001 (field code) + ไม่ query ที่ DB", async () => {
    const client = makeClient({});
    const response = await GET(pdfUrl(), ctx("not-a-uuid"));
    const body = (await response.json()) as { error: { code: string; details: { fields: string[] } } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.fields).toEqual(["code"]);
    // ไม่ query ใบประกาศ (requirePermission ยังอ่าน profiles ตามขั้น session — ตามแบบ SDS §5.5)
    expect(client.from).not.toHaveBeenCalledWith("certificates");
  });

  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    makeClient({ session: false });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
  });

  it("บทบาทไม่มี certificate:view (staff:viewer) → 403 ERR-RBAC-001", async () => {
    makeClient({ roles: ["staff:viewer"], aal: "aal2" });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("บทบาทบังคับ MFA ที่ยัง aal1 → 403 ERR-AUTH-004", async () => {
    makeClient({ roles: ["super_admin"], aal: "aal1" });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ERR-AUTH-004");
  });
});

describe("GET /certificates/{code}/pdf — resolve media + ตอบไฟล์", () => {
  it("happy path — 200 application/pdf + content-disposition inline + x-request-id", async () => {
    const client = makeClient({
      certs: { data: { pdf_media_id: MEDIA_ID } },
      media: { data: { bucket: "certificates", storage_path: "pdf/" + CERT_ID + ".pdf", mime_type: "application/pdf" } },
    });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.arrayBuffer()) as ArrayBuffer;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="certificate-' + CERT_ID + '.pdf"',
    );
    expect(response.headers.get("x-request-id")).toBe("req-d2-2");
    expect(new Uint8Array(body)[0]).toBe(0x25); // '%PDF'
    expect(client._cert.eq).toHaveBeenCalledWith("id", CERT_ID);
    expect(client._media.eq).toHaveBeenCalledWith("id", MEDIA_ID);
    expect(client._download).toHaveBeenCalledWith("pdf/" + CERT_ID + ".pdf");
    expect(vi.mocked(enforceRateLimit)).toHaveBeenCalledWith(expect.anything(), {
      group: "READ",
      secondaryKey: USER_ID,
    });
  });

  it("pdf_media_id null → 404 ERR-NF-001 (ใบจากเส้นทาง SQL ล้วน/attach ล้ม fail-open ยังไม่มีไฟล์)", async () => {
    const client = makeClient({ certs: { data: { pdf_media_id: null } } });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("ERR-NF-001");
    expect(client.from).not.toHaveBeenCalledWith("media_assets");
    expect(client.from).not.toHaveBeenCalledWith("storage");
  });

  it("แถว certificates ไม่เจอ (RLS ซ่อน — ไม่ใช่เจ้าของ) → 404 ERR-NF-001 ไม่เปิดเผยการมีอยู่", async () => {
    const client = makeClient({ certs: { data: null } });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("ERR-NF-001");
    expect(client.from).not.toHaveBeenCalledWith("media_assets");
  });

  it("query error ของ certificates (RLS ปฏิเสธ 42501) → 403 ERR-RBAC-001", async () => {
    makeClient({ certs: { error: { code: "42501", message: "permission denied" } } });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("query error อื่น ๆ → 503 ERR-SYS-002 opaque", async () => {
    makeClient({ certs: { error: { message: "SQLSTATE XX000" } } });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("media_assets ไม่เจอ → 404 ERR-NF-001 (แถวถูก RLS ซ่อน = ไม่ใช่เจ้าของใบ/ไม่ใช่ผู้ที่ได้รับสิทธิ์)", async () => {
    const client = makeClient({ certs: { data: { pdf_media_id: MEDIA_ID } }, media: { data: null } });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("ERR-NF-001");
    expect(client._download).not.toHaveBeenCalled();
  });

  it("storage download ล้มเหลว → 503 ERR-SYS-002", async () => {
    makeClient({
      certs: { data: { pdf_media_id: MEDIA_ID } },
      media: { data: { bucket: "certificates", storage_path: "pdf/x.pdf", mime_type: "application/pdf" } },
      download: { error: { message: "Object not found" } },
    });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

describe("GET /certificates/{code}/pdf — r10-P1 inbound row drift (แทน cast ผ่าน)", () => {
  it("แถว certificates มีคีย์เกิน (status) → 503 cert_pdf_row_drift ไม่ strip เงียบแล้วตอบ 200", async () => {
    const client = makeClient({ certs: { data: { pdf_media_id: MEDIA_ID, status: "valid" } } });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { details?: { reason?: string } } };

    expect(response.status).toBe(503);
    expect(body.error.details?.reason).toBe("cert_pdf_row_drift");
    expect(client.from).not.toHaveBeenCalledWith("media_assets");
  });

  it("แถว certificates ขาดคีย์ pdf_media_id → 503 drift ไม่ fabricate เป็น null แล้วตอบ 404", async () => {
    makeClient({ certs: { data: { holder_name: "ไม่เกี่ยว" } } });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("cert_pdf_row_drift");
  });

  it("แถว media_assets มีคีย์เกิน (size_bytes) → 503 cert_pdf_media_row_drift ก่อนแตะ storage", async () => {
    const client = makeClient({
      certs: { data: { pdf_media_id: MEDIA_ID } },
      media: { data: { bucket: "certificates", storage_path: "pdf/x.pdf", mime_type: "application/pdf", size_bytes: 1024 } },
    });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { details?: { reason?: string } } };

    expect(response.status).toBe(503);
    expect(body.error.details?.reason).toBe("cert_pdf_media_row_drift");
    expect(client._download).not.toHaveBeenCalled();
  });

  it("แถว media_assets ขาด mime_type → 503 cert_pdf_media_row_drift (กัน Content-Type: undefined)", async () => {
    const client = makeClient({
      certs: { data: { pdf_media_id: MEDIA_ID } },
      media: { data: { bucket: "certificates", storage_path: "pdf/x.pdf" } },
    });
    const response = await GET(pdfUrl(), ctx(CERT_ID));
    const body = (await response.json()) as { error: { details?: { reason?: string } } };

    expect(response.status).toBe(503);
    expect(body.error.details?.reason).toBe("cert_pdf_media_row_drift");
    expect(client._download).not.toHaveBeenCalled();
  });

  it("mime_type เป็น \"\" → 200 application/pdf (fallback คงเดิม — positive control ไม่ over-block)", async () => {
    makeClient({
      certs: { data: { pdf_media_id: MEDIA_ID } },
      media: { data: { bucket: "certificates", storage_path: "pdf/x.pdf", mime_type: "" } },
    });
    const response = await GET(pdfUrl(), ctx(CERT_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });
});

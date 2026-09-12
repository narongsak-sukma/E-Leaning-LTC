/**
 * route.test — GET /api/v1/me/transcript (Wave E Phase 3 · API-SPECIFICATION 1.1.0 §3)
 *
 * mock ssr client (requireUser จริง) + rate-limit จริง (resetRateLimitStore) ตามแบบ
 * me/certificates/route.test.ts — จุดหลัก: ?format=json|csv|pdf (default json · อื่น/
 * unknown key = 400 ERR-VAL-001) · pdf = application/pdf + %PDF · csv = text/csv BOM +
 * header ไทย + กันสูตร · drift → 503 · rate READ
 */
process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { TranscriptView } from "@/lib/api/credits";
import { CSV_BOM } from "@/lib/reports/csv";
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

const USER_ID = "b0000000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "c0000000-0000-4000-8000-000000000003";
const COURSE_ID = "d0000000-0000-4000-8000-000000000004";
const ISO = "2026-09-10T03:00:00+07:00";

function entryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enrollment_id: ENROLLMENT_ID,
    course_id: COURSE_ID,
    course_title: "หลักสูตร A",
    enrollment_status: "completed",
    completed_at: ISO,
    passed: true,
    best_score_pct: 90,
    passed_at: ISO,
    credits: { general: 3.5 },
    certificates: [{ cert_no: "LTC-2026-000001", status: "valid", issued_at: ISO }],
    ...overrides,
  };
}

function transcriptFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: USER_ID,
    generated_at: ISO,
    entries: [entryFixture()],
    ...overrides,
  };
}

function meUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/me/transcript" + query, {
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-e10-2" },
  });
}

/** client จำลอง: session + rpc (my_credit_transcript) + profiles ของ requireUser */
function mockClient(
  rpcData: unknown,
  options: {
    rpcError?: { message: string };
    aal?: "aal1" | "aal2";
    session?: boolean;
  } = {},
) {
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () =>
        options.session === false
          ? { data: { user: null }, error: { message: "no session" } }
          : { data: { user: { id: USER_ID } }, error: null },
      ),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: options.aal ?? "aal1" },
          error: null,
        })),
      },
    },
    rpc: vi.fn((fn: string) => {
      if (fn === "my_credit_transcript") {
        return Promise.resolve({ data: rpcData, error: options.rpcError ?? null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn(() => profilesBuilder),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /me/transcript — format json (default/explicit)", () => {
  it("format ไม่ระบุ → 200 { data } ผ่าน strict schema + สะท้อน x-request-id", async () => {
    const payload = transcriptFixture();
    mockClient(payload);
    const res = await GET(meUrl());
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e10-2");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(() => TranscriptView.parse(body.data)).not.toThrow();
    expect(body.data).toEqual(payload);
  });

  it("format=json → 200 เหมือน default", async () => {
    mockClient(transcriptFixture());
    const res = await GET(meUrl("?format=json"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(() => TranscriptView.parse(body.data)).not.toThrow();
  });
});

describe("GET /me/transcript — format csv", () => {
  it("format=csv → 200 text/csv; charset=utf-8 + content-disposition + BOM + header ไทย 9 คอลัมน์", async () => {
    mockClient(transcriptFixture());
    const res = await GET(meUrl("?format=csv"));
    // อ่าน byte ดิบ — res.text() ของ fetch API ตัด BOM ตอน decode จึง decode เองแบบคง BOM
    const raw = await res.arrayBuffer();
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="credit-transcript.csv"',
    );
    // BOM UTF-8 จริงใน byte stream (EF BB BF)
    expect(Array.from(new Uint8Array(raw).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text).toContain(
      "ลำดับ,หลักสูตร,สถานะการลงทะเบียน,วันที่เรียนจบ,ผ่าน,คะแนนสูงสุด (%),วันที่ผ่าน,หน่วยกิต,ใบประกาศณียบัตร",
    );
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("แถว CSV ตาม entries — สถานะไทย + กันสูตร (ชื่อขึ้นต้น = ถูกนำหน้า ')", async () => {
    mockClient(
      transcriptFixture({
        entries: [entryFixture({ course_title: "=DROP, อันตราย" })],
      }),
    );
    const res = await GET(meUrl("?format=csv"));
    const text = await res.text();

    expect(text).toContain(`"'=DROP, อันตราย"`);
    expect(text).toContain("เรียนจบแล้ว");
    expect(text).toContain("LTC-2026-000001 (ใช้งานได้)");
  });
});

describe("GET /me/transcript — format pdf (B6 — เรนเดอร์ฝั่ง BFF)", () => {
  it("format=pdf → 200 application/pdf + content-disposition attachment + %PDF + x-request-id", async () => {
    mockClient(transcriptFixture());
    const res = await GET(meUrl("?format=pdf"));
    const raw = await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="credit-transcript.pdf"',
    );
    expect(res.headers.get("x-request-id")).toBe("req-e10-2");
    expect(Buffer.from(raw).toString("latin1").startsWith("%PDF-")).toBe(true);
  });

  it("format=pdf → body parse ด้วย PDFDocument.load ได้ (1 หน้า)", async () => {
    mockClient(transcriptFixture());
    const res = await GET(meUrl("?format=pdf"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const loaded = await PDFDocument.load(bytes);

    expect(loaded.getPageCount()).toBe(1);
  });
});

describe("GET /me/transcript — query ไม่ถูกต้อง", () => {
  it("format=xml → 400 ERR-VAL-001", async () => {
    mockClient(transcriptFixture());
    const res = await GET(meUrl("?format=xml"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("query key แปลกปลอม (?format=csv&foo=1) → 400 ERR-VAL-001 (strict — ไม่เรียก RPC)", async () => {
    const client = mockClient(transcriptFixture());
    const res = await GET(meUrl("?format=csv&foo=1"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("format=JSON (case-sensitive) → 400 ERR-VAL-001", async () => {
    mockClient(transcriptFixture());
    const res = await GET(meUrl("?format=JSON"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
  });
});

describe("GET /me/transcript — auth + fail-closed + rate", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (ไม่เรียก RPC)", async () => {
    const client = mockClient(transcriptFixture(), { session: false });
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("RPC error → 503 ERR-SYS-002 opaque (ก่อนแตกรูป json/csv)", async () => {
    mockClient(null, { rpcError: { message: "SQLSTATE XX000" } });
    const res = await GET(meUrl("?format=csv"));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("ขาออก drift (แถว entries คีย์เกิน — strict) → 503 transcript_contract_drift", async () => {
    const drifted = transcriptFixture();
    ((drifted.entries as unknown[])[0] as Record<string, unknown>)["extra"] = 1;
    mockClient(drifted);
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error.details?.reason).toBe("transcript_contract_drift");
  });

  it("RPC คืน array = drift → 503 ERR-SYS-002", async () => {
    mockClient([1, 2]);
    const res = await GET(meUrl());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("เกิน 120/min → 429 ERR-RATE-001 details.group=READ", async () => {
    mockClient(transcriptFixture());
    let last: Response | null = null;
    for (let i = 0; i < 121; i += 1) {
      last = await GET(meUrl());
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

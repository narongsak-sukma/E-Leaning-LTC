/**
 * route.test — GET /api/v1/certificates/{code} (Wave D-2 · API-SPECIFICATION §3.6)
 *
 * mock service_role client + rate-limit ตามแบบ courses/route.test.ts —
 * จุดหลัก: ตอบ 200 เสมอ (เจอ/ไม่เจอ — shape เหมือนกันเป๊ะ กัน enumeration) · ไม่มี PII ·
 * INSERT certificate_verifications ทุกครั้ง (best-effort) · rate PUBLIC_READ คีย์ ip เท่านั้น
 */
process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CertificatePublicView } from "@/lib/schemas/v1/certificate";
import { errorDefinition } from "@/lib/errors";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
  clientIpFrom: vi.fn(() => "203.0.113.7"),
}));

interface RowResult {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

/** builder จำลองสาย select → eq → maybeSingle (PostgrestBuilder จริง thenable) */
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

/** client จำลอง dispatch ตามตาราง/view — จับ payload ของ INSERT certificate_verifications */
function makeServiceClient(results: {
  view?: RowResult;
  certs?: RowResult;
  insert?: { error?: { message: string } | null; reject?: unknown };
}) {
  const viewBuilder = makeSingleBuilder(results.view ?? {});
  const certBuilder = makeSingleBuilder(results.certs ?? {});
  const insertPayloads: unknown[] = [];
  const insert = vi.fn(async (payload: unknown) => {
    insertPayloads.push(payload);
    if (results.insert?.reject !== undefined) {
      throw results.insert.reject;
    }
    return { data: null, error: results.insert?.error ?? null };
  });
  const insertTable = { insert };
  const from = vi.fn((table: string) =>
    table === "certificate_public_view" ? viewBuilder : table === "certificates" ? certBuilder : insertTable,
  );
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);
  return { from, view: viewBuilder, certs: certBuilder, insertPayloads, insertSpy: insert };
}

const IP = "203.0.113.7";

function verifyUrl(code: string): Request {
  return new Request("http://localhost:3000/api/v1/certificates/" + encodeURIComponent(code), {
    headers: { "x-request-id": "req-d2-1", "user-agent": "Vitest/1.0" },
  });
}

function ctx(code: string): { params: Promise<{ code: string }> } {
  return { params: Promise.resolve({ code }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/certificates/{code} — 200 เสมอ (D8/D11-14)", () => {
  it("เจอด้วย cert_no (view) → 200 + 4 ฟิลด์ snake_case — ฟิลด์เกิน/PII ในแถวถูกตัดทิ้ง", async () => {
    const client = makeServiceClient({
      view: {
        data: {
          code: "LTC-2026-000001",
          course_title: "หลักสูตรทดสอบ",
          issued_at: "2026-09-01T00:00:00+00:00",
          status: "valid",
          holder_name_snapshot: "นายทดสอบ ใจดี",
          revoked_at: "2026-09-02T00:00:00+00:00",
        },
      },
    });

    const response = await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(Object.keys(body).sort()).toEqual(["code", "course_title", "issued_at", "status"]);
    expect(body).toEqual({
      code: "LTC-2026-000001",
      course_title: "หลักสูตรทดสอบ",
      issued_at: "2026-09-01T00:00:00+00:00",
      status: "valid",
    });
    expect(() => CertificatePublicView.parse(body)).not.toThrow();
    // เจอใน view แล้ว → ไม่ค้น verify_code ซ้ำ
    expect(client.from).not.toHaveBeenCalledWith("certificates");
  });

  it("เจอด้วย verify_code (QR) — view ไม่เจอ → ค้น certificates แล้ว map 4 ฟิลด์ + source=qr", async () => {
    const client = makeServiceClient({
      view: { data: null },
      certs: {
        data: {
          cert_no: "LTC-2026-000002",
          course_title_snapshot: "หลักสูตร QR",
          issued_at: "2026-08-15T09:30:00+00:00",
          status: "valid",
          holder_name_snapshot: "นาย QR ทดสอบ",
        },
      },
    });

    const response = await GET(verifyUrl("abc-verify-code"), ctx("abc-verify-code"));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      code: "LTC-2026-000002",
      course_title: "หลักสูตร QR",
      issued_at: "2026-08-15T09:30:00+00:00",
      status: "valid",
    });
    expect(client.certs.eq).toHaveBeenCalledWith("verify_code", "abc-verify-code");
  });

  it("ไม่เจอทั้งสองชั้น → 200 + status not_found (course_title/issued_at null)", async () => {
    const client = makeServiceClient({ view: { data: null }, certs: { data: null } });

    const response = await GET(verifyUrl("nothing-here"), ctx("nothing-here"));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      code: "nothing-here",
      course_title: null,
      issued_at: null,
      status: "not_found",
    });
    expect(client.view.eq).toHaveBeenCalledWith("code", "nothing-here");
    expect(client.certs.eq).toHaveBeenCalledWith("verify_code", "nothing-here");
  });

  it("สถานะ revoked/superseded → 200 รูปเดิม — shape เหมือนกันเป๊ะกับทุกกรณี", async () => {
    const shapes: string[] = [];
    for (const status of ["valid", "revoked", "superseded", "not_found"] as const) {
      if (status === "not_found") {
        makeServiceClient({ view: { data: null }, certs: { data: null } });
      } else {
        makeServiceClient({
          view: {
            data: {
              code: "LTC-2026-000003",
              course_title: "หลักสูตรสถานะ",
              issued_at: "2026-07-01T00:00:00+00:00",
              status,
            },
          },
        });
      }
      const response = await GET(verifyUrl("LTC-2026-000003"), ctx("LTC-2026-000003"));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      shapes.push(Object.keys(body).sort().join(","));
      expect(body["status"]).toBe(status);
    }
    expect(new Set(shapes).size).toBe(1);
    expect(shapes[0]).toBe("code,course_title,issued_at,status");
  });
});

describe("GET /api/v1/certificates/{code} — verify log + rate + headers", () => {
  it("INSERT certificate_verifications เมื่อเจอ — ip_hash ไม่ใช่ IP ตรง + UA ตัดทอน + source=manual", async () => {
    const client = makeServiceClient({
      view: {
        data: {
          code: "LTC-2026-000001",
          course_title: "หลักสูตรทดสอบ",
          issued_at: "2026-09-01T00:00:00+00:00",
          status: "valid",
        },
      },
    });

    const longAgent = "Mozilla/5.0 " + "a".repeat(300);
    const request = new Request("http://localhost:3000/api/v1/certificates/LTC-2026-000001", {
      headers: { "user-agent": longAgent },
    });
    const response = await GET(request, ctx("LTC-2026-000001"));

    expect(response.status).toBe(200);
    expect(client.insertPayloads).toHaveLength(1);
    const payload = client.insertPayloads[0] as Record<string, unknown>;
    expect(payload["verify_code"]).toBe("LTC-2026-000001");
    expect(payload["result"]).toBe("valid");
    expect(payload["source"]).toBe("manual");
    expect(vi.mocked(clientIpFrom)).toHaveBeenCalledWith(request);
    expect(payload["ip_hash"]).not.toBe(IP);
    expect(payload["ip_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(payload["user_agent"]).toBe(("Mozilla/5.0 " + "a".repeat(300)).slice(0, 256));
    expect(JSON.stringify(payload)).not.toContain("203.0.113.7");
  });

  it("INSERT เมื่อไม่เจอ (result=not_found, source=qr)", async () => {
    const client = makeServiceClient({ view: { data: null }, certs: { data: null } });

    const response = await GET(verifyUrl("qr-only-code"), ctx("qr-only-code"));

    expect(response.status).toBe(200);
    expect(client.insertPayloads).toHaveLength(1);
    const payload = client.insertPayloads[0] as Record<string, unknown>;
    expect(payload["result"]).toBe("not_found");
    expect(payload["source"]).toBe("qr");
  });

  it("INSERT พัง (error หรือ throw) → ยัง 200 ตามปกติ (best-effort)", async () => {
    makeServiceClient({
      view: { data: null },
      certs: { data: null },
      insert: { error: { message: "duplicate key" } },
    });
    const response1 = await GET(verifyUrl("x1"), ctx("x1"));
    expect(response1.status).toBe(200);

    makeServiceClient({
      view: { data: null },
      certs: { data: null },
      insert: { reject: new Error("network down") },
    });
    const response2 = await GET(verifyUrl("x2"), ctx("x2"));
    expect(response2.status).toBe(200);
    const body2 = (await response2.json()) as Record<string, unknown>;
    expect(body2["status"]).toBe("not_found");
  });

  it("DB error ทั้งสองชั้น → 503 ERR-SYS-002 แบบ opaque + ไม่ INSERT log (ไม่บันทึก verdict เพี้ยน)", async () => {
    const client = makeServiceClient({
      view: { error: { message: "SQLSTATE XX000" } },
      certs: { data: null },
    });

    const response = await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
    expect(client.insertPayloads).toHaveLength(0);
  });

  it("error ชั้นค้น verify_code → 503 ERR-SYS-002 + ไม่ INSERT log", async () => {
    const client = makeServiceClient({
      view: { data: null },
      certs: { error: { message: "SQLSTATE XX000" } },
    });

    const response = await GET(verifyUrl("abc"), ctx("abc"));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(client.insertPayloads).toHaveLength(0);
  });

  it("rate PUBLIC_READ เรียกด้วย ip เท่านั้น — ไม่มี secondaryKey (§5)", async () => {
    makeServiceClient({ view: { data: null }, certs: { data: null } });

    await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));

    expect(vi.mocked(enforceRateLimit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enforceRateLimit)).toHaveBeenCalledWith(expect.anything(), { group: "PUBLIC_READ" });
  });

  it("สะท้อน x-request-id กลับทุก response", async () => {
    makeServiceClient({ view: { data: null }, certs: { data: null } });

    const response = await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));

    expect(response.headers.get("x-request-id")).toBe("req-d2-1");
  });

  it("ไม่มี PII ใน response — ไม่มี holder_name/revoked_at แม้กรณี revoked", async () => {
    makeServiceClient({
      view: {
        data: {
          code: "LTC-2026-000009",
          course_title: "หลักสูตรถูกเพิกถอน",
          issued_at: "2026-01-01T00:00:00+00:00",
          status: "revoked",
          holder_name_snapshot: "นายถูกเพิกถอน",
          revoked_at: "2026-02-01T00:00:00+00:00",
        },
      },
    });

    const response = await GET(verifyUrl("LTC-2026-000009"), ctx("LTC-2026-000009"));
    const raw = JSON.stringify(await response.json());

    expect(raw).not.toContain("holder_name");
    expect(raw).not.toContain("revoked_at");
    expect(raw).not.toContain("นายถูกเพิกถอน");
  });
});

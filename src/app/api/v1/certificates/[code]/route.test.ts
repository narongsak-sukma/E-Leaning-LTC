/**
 * route.test — GET /api/v1/certificates/{code} (Wave D-2 · API-SPECIFICATION §3.6 · 0019-r1)
 *
 * 0019-r1 (gate r1 B3/B5): route เรียก RPC `record_certificate_verification` ผ่าน SSR
 * user client เดียว — ค้น + INSERT certificate_verifications + audit ทั้งหมดใน TX ของ
 * RPC (mock จึงเหลือ rpc() จุดเดียว) · ไม่มี service_role ที่ route อีกต่อไป
 *
 * จุดหลัก: ตอบ 200 เสมอ (เจอ/ไม่เจอ — shape เหมือนกันเป๊ะ กัน enumeration) · ไม่มี PII ·
 * source manual/qr ตามรูป cert_no · rate PUBLIC_READ คีย์ ip เท่านั้น
 */
process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CertificatePublicView } from "@/lib/schemas/v1/certificate";
import { errorDefinition } from "@/lib/errors";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { GET } from "./route";

vi.mock("@/lib/supabase/ssr", () => ({
  createSupabaseSsrClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
  clientIpFrom: vi.fn(() => "203.0.113.7"),
}));

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

/** SSR client จำลอง — มีแค่ rpc() (0019-r1: ไม่มี from()/insert() ที่ route อีกแล้ว) */
function makeSsrClient(result: RpcResult) {
  // พารามิเตอร์มีไว้ให้ mock.calls บันทึก signature จริง (fn + args) — ค่า return คงที่
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
    void _fn;
    void _args;
    return result;
  });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue({ rpc } as never);
  return rpc;
}

const IP = "203.0.113.7";

function verifyUrl(code: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/v1/certificates/" + encodeURIComponent(code), {
    headers: { "x-request-id": "req-d2-1", "user-agent": "Vitest/1.0", ...headers },
  });
}

function ctx(code: string): { params: Promise<{ code: string }> } {
  return { params: Promise.resolve({ code }) };
}

/** แถว 4 ฟิลด์ที่ RPC คืน (จำลองเผื่อฟิลด์เกินหลุดมา — route ต้องตัดทิ้ง) */
function foundRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "LTC-2026-000001",
    course_title: "หลักสูตรทดสอบ",
    issued_at: "2026-09-01T00:00:00+00:00",
    status: "valid",
    holder_name: "นายทดสอบ ใจดี",
    revoked_at: "2026-09-02T00:00:00+00:00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/certificates/{code} — 200 เสมอ (D8/D11-14)", () => {
  it("เจอด้วย cert_no → 200 + 4 ฟิลด์ snake_case — ฟิลด์เกิน/PII ในแถว RPC ถูกตัดทิ้ง", async () => {
    const rpc = makeSsrClient({ data: foundRow(), error: null });

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
    // RPC เดียวจบ (ค้น + log + audit) — source=manual เพราะรูป cert_no
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "record_certificate_verification",
      expect.objectContaining({ p_code: "LTC-2026-000001", p_source: "manual" }),
    );
  });

  it("PostgREST wrap jsonb เป็น array หลักเดียว → แกะแถวได้", async () => {
    makeSsrClient({ data: [foundRow()], error: null });
    const response = await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body["code"]).toBe("LTC-2026-000001");
  });

  it("เจอด้วย verify_code (QR) → source=qr", async () => {
    const rpc = makeSsrClient({ data: foundRow({ code: "LTC-2026-000002" }), error: null });
    const response = await GET(verifyUrl("abc-verify-code"), ctx("abc-verify-code"));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "record_certificate_verification",
      expect.objectContaining({ p_code: "abc-verify-code", p_source: "qr" }),
    );
  });

  it("ไม่เจอ → 200 + status not_found (course_title/issued_at null) — ยังผ่าน RPC เพื่อ log", async () => {
    const rpc = makeSsrClient({
      data: { code: "nothing-here", course_title: null, issued_at: null, status: "not_found" },
      error: null,
    });
    const response = await GET(verifyUrl("nothing-here"), ctx("nothing-here"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toEqual({ code: "nothing-here", course_title: null, issued_at: null, status: "not_found" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("path ช่องว่างล้วน → 200 not_found โดยไม่เรียก RPC (ไม่ใช่รหัสที่มีความหมาย)", async () => {
    const rpc = makeSsrClient({ data: null, error: null });
    const response = await GET(verifyUrl("%20%20"), ctx("  "));
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toEqual({ code: "", course_title: null, issued_at: null, status: "not_found" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("สถานะ revoked/superseded/not_found → 200 รูปเดียวกันเป๊ะกับ valid (กัน enumeration)", async () => {
    const shapes: string[] = [];
    for (const status of ["valid", "revoked", "superseded", "not_found"] as const) {
      if (status === "not_found") {
        makeSsrClient({ data: { code: "LTC-2026-000003", course_title: null, issued_at: null, status }, error: null });
      } else {
        makeSsrClient({ data: foundRow({ status }), error: null });
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

describe("GET /api/v1/certificates/{code} — RPC contract + rate + headers", () => {
  it("พารามิเตอร์ RPC ครบ: ip_hash เป็น sha256 (ไม่ใช่ IP ตรง) + UA ตัดทอน 256 + request_id", async () => {
    const rpc = makeSsrClient({ data: foundRow(), error: null });
    const longAgent = "Mozilla/5.0 " + "a".repeat(300);
    const request = new Request("http://localhost:3000/api/v1/certificates/LTC-2026-000001", {
      headers: { "user-agent": longAgent, "x-request-id": "req-d2-9" },
    });

    const response = await GET(request, ctx("LTC-2026-000001"));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("record_certificate_verification", {
      p_code: "LTC-2026-000001",
      p_source: "manual",
      p_ip_hash: expect.any(String),
      p_user_agent: longAgent.slice(0, 256),
      p_request_id: "req-d2-9",
    });
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args["p_ip_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(args["p_ip_hash"]).not.toBe(IP);
    expect(JSON.stringify(args)).not.toContain("203.0.113.7");
    expect(vi.mocked(clientIpFrom)).toHaveBeenCalledWith(request);
  });

  it("ไม่มี user-agent → p_user_agent เป็น null", async () => {
    const rpc = makeSsrClient({ data: foundRow(), error: null });
    const request = new Request("http://localhost:3000/api/v1/certificates/LTC-2026-000001");
    await GET(request, ctx("LTC-2026-000001"));
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args["p_user_agent"]).toBeNull();
  });

  it("RPC ล้ม → 503 ERR-SYS-002 แบบ opaque (log/audit ไม่เกิด — TX เดียวกับ RPC)", async () => {
    makeSsrClient({ data: null, error: { code: "XX000", message: "boom" } });
    const response = await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
  });

  it("RPC สำเร็จแต่ data null → 503 ERR-SYS-002 (contract mismatch)", async () => {
    makeSsrClient({ data: null, error: null });
    const response = await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("rate PUBLIC_READ เรียกด้วย ip เท่านั้น — ไม่มี secondaryKey (§5)", async () => {
    makeSsrClient({ data: { code: "x", course_title: null, issued_at: null, status: "not_found" }, error: null });
    await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));
    expect(vi.mocked(enforceRateLimit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enforceRateLimit)).toHaveBeenCalledWith(expect.anything(), { group: "PUBLIC_READ" });
  });

  it("สะท้อน x-request-id กลับทุก response", async () => {
    makeSsrClient({ data: foundRow(), error: null });
    const response = await GET(verifyUrl("LTC-2026-000001"), ctx("LTC-2026-000001"));
    expect(response.headers.get("x-request-id")).toBe("req-d2-1");
  });

  it("ไม่มี PII ใน response — ไม่มี holder_name/revoked_at แม้กรณี revoked", async () => {
    makeSsrClient({ data: foundRow({ status: "revoked" }), error: null });
    const response = await GET(verifyUrl("LTC-2026-000009"), ctx("LTC-2026-000009"));
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain("holder_name");
    expect(raw).not.toContain("revoked_at");
    expect(raw).not.toContain("นายทดสอบ");
  });

  it("B3 (grep-assert): route ไม่ import service client และไม่ค้น view สาธารณะเองอีก", () => {
    const src = readFileSync("src/app/api/v1/certificates/[code]/route.ts", "utf8");
    expect(src.includes("createSupabaseServiceRoleClient")).toBe(false);
    expect(src.includes('.from("certificate_public_view")')).toBe(false);
    expect(src.includes("createSupabaseSsrClient")).toBe(true);
  });
});

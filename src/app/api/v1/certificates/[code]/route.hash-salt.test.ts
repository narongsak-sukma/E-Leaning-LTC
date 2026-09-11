/**
 * route.hash-salt.test — PB-13: ip_hash/user_agent_hash ต้องใช้ IP_HASH_SALT
 *
 * แยกเป็นไฟล์ต่างหากจาก route.test.ts เพราะ getConfig เป็น singleton ต่อ runtime
 * (lib/config.ts) — ไฟล์นั้น freeze config ตั้งแต่ GET แรกโดยไม่มี IP_HASH_SALT
 * ตั้ง salt กลางไฟล์จะไม่มีผล · vitest รันแต่ละไฟล์ใน worker แยกกัน (module registry
 * ใหม่) จึงตั้ง IP_HASH_SALT ก่อน import ได้ในไฟล์นี้โดยไม่กระทบไฟล์อื่น
 */
process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
process.env.IP_HASH_SALT = "pb13-dedicated-salt";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { clientIpFrom } from "@/lib/rate-limit";
import { GET } from "./route";

vi.mock("@/lib/supabase/ssr", () => ({
  createSupabaseSsrClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
  clientIpFrom: vi.fn(() => "203.0.113.7"),
}));

const IP = "203.0.113.7";
const UA = "Vitest/1.0 pb13";
const SALT = process.env.IP_HASH_SALT as string;
const ANON_KEY = process.env.SUPABASE_ANON_KEY as string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** SSR client จำลอง — มีแค่ rpc() (โครงเดียวกับ route.test.ts) */
function makeSsrClient() {
  // พารามิเตอร์มีไว้ให้ mock.calls บันทึก signature จริง (fn + args) — ค่า return คงที่
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
    void _fn;
    void _args;
    return {
      data: {
        code: "LTC-2026-000001",
        course_title: "หลักสูตรทดสอบ",
        issued_at: "2026-09-01T00:00:00+00:00",
        status: "valid",
      },
      error: null,
    };
  });
  vi.mocked(createSupabaseSsrClient).mockResolvedValue({ rpc } as never);
  return rpc;
}

function verifyRequest(): Request {
  return new Request("http://localhost:3000/api/v1/certificates/LTC-2026-000001", {
    headers: { "x-request-id": "req-pb13", "user-agent": UA },
  });
}

function ctx(): { params: Promise<{ code: string }> } {
  return { params: Promise.resolve({ code: "LTC-2026-000001" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PB-13: ตั้ง IP_HASH_SALT → hash ทั้งสองค่าใช้ salt เฉพาะ ไม่ใช่ anon key", () => {
  it("p_ip_hash = sha256(ip + IP_HASH_SALT) ตรงค่าคำนวณเอง และไม่ใช่ digest แบบ anon-key", async () => {
    const rpc = makeSsrClient();
    const response = await GET(verifyRequest(), ctx());
    expect(response.status).toBe(200);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args["p_ip_hash"]).toBe(sha256(IP + SALT));
    expect(args["p_ip_hash"]).not.toBe(sha256(IP + ANON_KEY));
  });

  it("p_user_agent_hash = sha256(ua + IP_HASH_SALT) ตรงค่าคำนวณเอง และไม่ใช่ digest แบบ anon-key", async () => {
    const rpc = makeSsrClient();
    const response = await GET(verifyRequest(), ctx());
    expect(response.status).toBe(200);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args["p_user_agent_hash"]).toBe(sha256(UA + SALT));
    expect(args["p_user_agent_hash"]).not.toBe(sha256(UA + ANON_KEY));
  });

  it("เรียกซ้ำ digest เสถียร (salt คงที่ตลอด runtime)", async () => {
    const rpc = makeSsrClient();
    await GET(verifyRequest(), ctx());
    await GET(verifyRequest(), ctx());
    const first = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = rpc.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(second["p_ip_hash"]).toBe(first["p_ip_hash"]);
    expect(second["p_user_agent_hash"]).toBe(first["p_user_agent_hash"]);
  });

  it("IP ต่างกัน → ip_hash ต่างกัน (salt ไม่กลืน input)", async () => {
    const rpc = makeSsrClient();
    await GET(verifyRequest(), ctx());
    vi.mocked(clientIpFrom).mockReturnValueOnce("198.51.100.9");
    await GET(verifyRequest(), ctx());
    const first = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = rpc.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(second["p_ip_hash"]).not.toBe(first["p_ip_hash"]);
  });
});

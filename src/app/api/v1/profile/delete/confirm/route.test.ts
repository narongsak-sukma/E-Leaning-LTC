/**
 * route.test — GET /api/v1/profile/delete/confirm (D-p5-8 · #90)
 *
 * mock lib/pdpa/deletion (unit ล้วน) — จุดหลัก: **สาธารณะ ไม่ต้อง session** ·
 * query strict รับเฉพาะ token (key เกิน/ชุดอักขระเพี้ยน/ขาด → 400) · หน้าผลทั้งสอง
 * กรณี = 200 (confirmed / link_invalid — generic ไม่เฉลยสถานะคำขอ) · error ระบบ →
 * envelope opaque · rate READ ต่อ IP (สาธารณะ)
 */
vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  process.env.RATE_LIMIT_READ_PER_MIN = "2";
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { AppError } from "@/lib/errors";
import { confirmAccountDeletion } from "@/lib/pdpa/deletion";
import { GET } from "./route";

vi.mock("@/lib/pdpa/deletion", () => ({ confirmAccountDeletion: vi.fn() }));

const TOKEN = "A".repeat(43);
const USER_ID = "b0000000-0000-4000-8000-000000000001";

function getUrl(query = ""): Request {
  return new Request("http://localhost:3000/api/v1/profile/delete/confirm" + query, {
    headers: { "x-forwarded-for": "10.0.0.6", "x-request-id": "req-e15-9" },
  });
}

beforeEach(() => {
  vi.mocked(confirmAccountDeletion).mockReset();
  vi.mocked(confirmAccountDeletion).mockResolvedValue({
    outcome: "confirmed",
    userId: USER_ID,
    emailQueued: true,
  });
  resetRateLimitStore();
});

describe("GET /profile/delete/confirm — 200 ทางหลัก (สาธารณะ)", () => {
  it("token ใช้ได้ → 200 {status: confirmed, message ไทย} + ส่ง token/requestId เข้า lib ตรง", async () => {
    const res = await GET(getUrl(`?token=${TOKEN}`));
    const body = (await res.json()) as { data: { status: string; message: string } };

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-e15-9");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body.data.status).toBe("confirmed");
    expect(body.data.message.length).toBeGreaterThan(0);
    expect(vi.mocked(confirmAccountDeletion)).toHaveBeenCalledWith(TOKEN, "req-e15-9");
  });

  it("token เสีย (used/expired) → **ยัง 200** link_invalid — สถานะเดียวกับสำเร็จ (ไม่เฉลย)", async () => {
    vi.mocked(confirmAccountDeletion).mockResolvedValue({ outcome: "token_invalid" });
    const res = await GET(getUrl(`?token=${TOKEN}`));
    const body = (await res.json()) as { data: { status: string; message: string } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("link_invalid");
    expect(body.data.message.length).toBeGreaterThan(0);
  });

  it("lib โยน ERR-SYS-002 → 503 opaque", async () => {
    vi.mocked(confirmAccountDeletion).mockRejectedValue(
      new AppError("ERR-SYS-002", { details: { reason: "confirm_deletion_failed" } }),
    );
    const res = await GET(getUrl(`?token=${TOKEN}`));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

describe("GET /profile/delete/confirm — query strict 400 ก่อน lib", () => {
  it("ขาด token → 400 ERR-VAL-001 fields=[token] (ไม่เรียก lib)", async () => {
    const res = await GET(getUrl(""));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toEqual(["token"]);
    expect(vi.mocked(confirmAccountDeletion)).not.toHaveBeenCalled();
  });

  it("key เกิน (?token=..&utm_source=x) → 400 fields มี utm_source (ไม่เรียก lib)", async () => {
    const res = await GET(getUrl(`?token=${TOKEN}&utm_source=email`));
    const body = (await res.json()) as { error: { code: string; details?: { fields?: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toContain("utm_source");
    expect(vi.mocked(confirmAccountDeletion)).not.toHaveBeenCalled();
  });

  it("token ชุดอักขระเพี้ยน (เว้นวรรค) → 400 (ไม่เรียก lib)", async () => {
    const res = await GET(getUrl(`?token=${"a".repeat(25)}%20bad`));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(vi.mocked(confirmAccountDeletion)).not.toHaveBeenCalled();
  });
});

describe("GET /profile/delete/confirm — rate READ (§5, ต่อ IP)", () => {
  it("เกิน 2/min (env ทดสอบ) → 429 ERR-RATE-001 details.group=READ", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 3; i += 1) {
      last = await GET(getUrl(`?token=${TOKEN}`));
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
  });
});

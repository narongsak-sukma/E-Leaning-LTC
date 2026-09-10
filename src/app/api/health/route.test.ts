import { afterEach, describe, expect, it } from "vitest";

/** stub env บังคับของ loadConfig (ตรง BASE_ENV ของ config.test.ts) */
const REQUIRED_STUBS: Record<string, string> = {
  PUBLIC_BASE_URL: "https://elearning.lawyerthai.test",
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
};

const TOUCHED_KEYS = [...Object.keys(REQUIRED_STUBS), "APP_ENV", "CURSOR_HMAC_SECRET"];

function withStubs(extra: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_STUBS, ...extra })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** คืนค่า env เดิมทุก key ที่ suite นี้แตะ (กันรั่วไป suite อื่นใน worker เดียวกัน) */
const SAVED: Record<string, string | undefined> = {};
for (const key of TOUCHED_KEYS) {
  SAVED[key] = process.env[key];
}

afterEach(() => {
  for (const key of TOUCHED_KEYS) {
    if (SAVED[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = SAVED[key];
    }
  }
});

describe("GET /api/health — readiness รวม config (PB-9)", () => {
  it("config invalid (APP_ENV=prod ขาด CURSOR_HMAC_SECRET) → 503 + status=error", async () => {
    // รันก่อนเคสผ่าน เพราะ getConfig เป็น singleton (throw ไม่ถูก cache)
    withStubs({ APP_ENV: "prod", CURSOR_HMAC_SECRET: undefined });
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe("error");
    expect(body.db).toBe("unknown");
  });

  it("config ผ่าน → 200 + status=ok + db ตาม env Supabase", async () => {
    withStubs({ APP_ENV: "local" });
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe("ok");
    expect(["configured", "not_configured"]).toContain(body.db);
  });

  it("รูปข้อมูลตาม API-SPEC §3.10 — มีแค่ {status, db, time}", async () => {
    withStubs({ APP_ENV: "local" });
    const { GET } = await import("./route");
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["db", "status", "time"]);
  });

  it("no-store + x-request-id ทุกกรณี", async () => {
    withStubs({ APP_ENV: "prod", CURSOR_HMAC_SECRET: "cursor-hmac-secret-prod" });
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
  });
});


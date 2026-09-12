/**
 * route.test — /api/internal/jobs/email-dispatch (Wave E Phase 4 · D-p4-8)
 *
 * mock config + dispatch (unit ล้วน) — จุดหลัก: ไม่มี CRON_SECRET = 404 fail-closed
 * เงียบ · secret ไม่ตรง/ไม่มี header = 404 เงียบ (timing-safe) · ผ่าน = 200
 * {processed:{claimed,sent,failed}} · POST = x-cron-secret (dev mailer) ·
 * GET = Authorization: Bearer (รูปทรง Vercel Cron — gate r1 B1)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigMock, runEmailDispatchMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  runEmailDispatchMock: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ getConfig: getConfigMock }));
vi.mock("@/lib/email/dispatch", () => ({ runEmailDispatch: runEmailDispatchMock }));

import type { AppConfig } from "@/lib/config";
import { GET, POST } from "./route";

/** ค่า secret ของชุดทดสอบ (ความยาว 30 อักขระ) */
const SECRET = "dev-cron-secret-0123456789";

/** config stub ครบทุกฟิลด์ของ AppConfig (route ใช้แค่ cronSecret — ที่เหลือเพื่อชนิด) */
function configStub(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    publicBaseUrl: "https://elearning.lawyerthai.test",
    appEnv: "local",
    logLevel: "info",
    certPublicBaseUrl: null,
    supabaseUrl: "https://stub.supabase.co",
    supabaseAnonKey: "stub-anon",
    supabaseServiceRoleKey: "stub-svc",
    supabaseDbPoolerUrl: null,
    supabasePublicUrl: null,
    cursorHmacSecret: null,
    ipHashSalt: null,
    mediaProvider: "supabase_storage",
    mediaSignedUrlTtlSec: 900,
    r2: null,
    stream: null,
    emailProvider: "console",
    smtp: null,
    emailFrom: null,
    resendApiKey: null,
    cronSecret: SECRET,
    rateLimit: {
      authPerMin: 10,
      otpPerHour: 3,
      pwdResetPerHour: 5,
      mfaPerMin: 10,
      verifyPerMin: 120,
      readPerMin: 120,
      learnWritePerMin: 120,
      examPerMin: 60,
      staffWritePerMin: 60,
      exportPerHour: 10,
    },
    session: { adminIdleMinutes: 15, adminAbsoluteHours: 8, loginLockoutAttempts: 5 },
    learning: { videoHeartbeatSec: 15, videoCompletePct: 80, docMinDwellSec: 30 },
    ...overrides,
  };
}

/** Request ของ cron — แนบ header x-cron-secret */
function cronRequest(secretHeader?: string): Request {
  return new Request("http://localhost:3000/api/internal/jobs/email-dispatch", {
    method: "POST",
    headers:
      secretHeader === undefined
        ? {}
        : { "x-cron-secret": secretHeader },
  });
}

beforeEach(() => {
  getConfigMock.mockReset();
  runEmailDispatchMock.mockReset();
  runEmailDispatchMock.mockResolvedValue({ claimed: 3, sent: 2, failed: 1 });
});

describe("POST — fail-closed เงียบ", () => {
  it("ไม่มี CRON_SECRET (config null) → 404 และไม่เรียก worker", async () => {
    getConfigMock.mockReturnValue(configStub({ cronSecret: null }));
    const res = await POST(cronRequest(SECRET));
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("config throw (env พัง) → 404 เงียบ (ไม่เฉลยสถานะ)", async () => {
    getConfigMock.mockImplementation(() => {
      throw new Error("env broken");
    });
    const res = await POST(cronRequest(SECRET));
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });
});

describe("POST — secret gate", () => {
  it("secret ถูกต้อง → 200 {processed:{claimed,sent,failed}} + เรียก worker ครั้งเดียว", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await POST(cronRequest(SECRET));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: { claimed: number; sent: number; failed: number } };
    expect(body).toEqual({ processed: { claimed: 3, sent: 2, failed: 1 } });
    expect(runEmailDispatchMock).toHaveBeenCalledTimes(1);
  });

  it("secret ไม่ตรง → 404 เงียบ + ไม่เรียก worker", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await POST(cronRequest("totally-wrong-secret"));
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("secret สั้น/ยาวไม่เท่า (กัน timing) → 404 เงียบ", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await POST(cronRequest("short"));
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
    const res2 = await POST(cronRequest(SECRET + "way-too-long-tail"));
    expect(res2.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("ไม่แนบ header → 404 เงียบ + ไม่เรียก worker", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await POST(cronRequest());
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });
});

describe("GET — รูปทรง Vercel Cron (Authorization: Bearer) — gate r1 B1", () => {
  /** Request แบบ Vercel Cron ส่งจริง: GET + Authorization: Bearer <secret> */
  function vercelCronRequest(authorization?: string): Request {
    return new Request("http://localhost:3000/api/internal/jobs/email-dispatch", {
      method: "GET",
      headers:
        authorization === undefined
          ? {}
          : { authorization },
    });
  }

  it("Bearer ถูกต้อง → 200 {processed} + เรียก worker ครั้งเดียว + no-store", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await GET(vercelCronRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: { claimed: number; sent: number; failed: number } };
    expect(body).toEqual({ processed: { claimed: 3, sent: 2, failed: 1 } });
    expect(runEmailDispatchMock).toHaveBeenCalledTimes(1);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("ไม่มี CRON_SECRET (config null) → GET 404 และไม่เรียก worker", async () => {
    getConfigMock.mockReturnValue(configStub({ cronSecret: null }));
    const res = await GET(vercelCronRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("Bearer ไม่ตรง → 404 เงียบ + ไม่เรียก worker", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await GET(vercelCronRequest("Bearer totally-wrong-secret"));
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("ไม่มี header Authorization เลย → 404 เงียบ", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await GET(vercelCronRequest());
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("scheme อื่น (ไม่ใช่ Bearer) → 404 เงียบ", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await GET(vercelCronRequest(`Basic ${SECRET}`));
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("POST ไม่ยอมรับ Bearer (ทางเดียวของ POST = x-cron-secret — แยกสองช่องชัดเจน)", async () => {
    getConfigMock.mockReturnValue(configStub());
    const res = await POST(
      new Request("http://localhost:3000/api/internal/jobs/email-dispatch", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(runEmailDispatchMock).not.toHaveBeenCalled();
  });
});

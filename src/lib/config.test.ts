import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  loadConfig,
  getConfig,
  ConfigError,
  PUBLIC_SERVICE_ROLE_BAN,
  PENDING_CONFIRMATIONS,
  FEATURE_FLAG_KEYS,
  getFeatureFlagEnabled,
  type FeatureFlagKey,
} from "./config";

const BASE_ENV: Record<string, string> = {
  PUBLIC_BASE_URL: "https://elearning.lawyerthai.test",
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
};

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...extra };
}

/** base64 ครบ 32 ไบต์ (AES-256) — ค่าท้องถิ่นของเทสเท่านั้น ไม่ใช่คีย์จริง */
const MFA_PENDING_KEY_FIXTURE = Buffer.alloc(32, 7).toString("base64");

describe("loadConfig — ค่าบังคับ (SDS §7.2)", () => {
  it("โหลดผ่านเมื่อ env บังคับครบ", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.publicBaseUrl).toBe(BASE_ENV.PUBLIC_BASE_URL);
    expect(cfg.supabaseUrl).toBe(BASE_ENV.SUPABASE_URL);
    expect(cfg.mediaProvider).toBe("supabase_storage");
  });

  it("SUPABASE_PUBLIC_URL ไม่ตั้ง = null · ตั้งแล้วส่งผ่านเป็น origin มุมมองผู้รับ (gate p5-r2 hostname)", () => {
    expect(loadConfig(baseEnv()).supabasePublicUrl).toBeNull();
    expect(loadConfig(baseEnv({ SUPABASE_PUBLIC_URL: "http://localhost:8000" })).supabasePublicUrl).toBe(
      "http://localhost:8000",
    );
  });

  it("throw ConfigError เมื่อขาด PUBLIC_BASE_URL", () => {
    const env = { ...BASE_ENV };
    delete env.PUBLIC_BASE_URL;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("รวมชื่อ key ที่ขาดในรายการ issue", () => {
    const env = baseEnv();
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      loadConfig(env);
      expect.unreachable("ต้อง throw ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join("\n");
      expect(issues).toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });

  it("throw ConfigError เมื่อขาด SUPABASE_URL หรือ SUPABASE_ANON_KEY", () => {
    const withoutUrl = { ...BASE_ENV };
    delete withoutUrl.SUPABASE_URL;
    expect(() => loadConfig(withoutUrl)).toThrow(ConfigError);

    const withoutAnon = { ...BASE_ENV };
    delete withoutAnon.SUPABASE_ANON_KEY;
    expect(() => loadConfig(withoutAnon)).toThrow(ConfigError);
  });
});

describe("loadConfig — ค่า default (SRS Appendix A / D8)", () => {
  it("ใส่ default ให้ APP_ENV / LOG_LEVEL / MEDIA_PROVIDER / EMAIL_PROVIDER", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.appEnv).toBe("local");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.mediaProvider).toBe("supabase_storage");
    expect(cfg.emailProvider).toBe("console");
    expect(cfg.certPublicBaseUrl).toBeNull();
    expect(cfg.mediaSignedUrlTtlSec).toBe(900);
  });

  it("ใส่ default ให้ rate limit / session / learning ตามตาราง SDS §7.2", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.rateLimit.authPerMin).toBe(10);
    expect(cfg.rateLimit.otpPerHour).toBe(3);
    expect(cfg.rateLimit.pwdResetPerHour).toBe(5);
    expect(cfg.rateLimit.mfaPerMin).toBe(10);
    expect(cfg.rateLimit.verifyPerMin).toBe(120);
    expect(cfg.rateLimit.readPerMin).toBe(120);
    expect(cfg.rateLimit.learnWritePerMin).toBe(120);
    expect(cfg.rateLimit.examPerMin).toBe(60);
    expect(cfg.rateLimit.staffWritePerMin).toBe(60);
    expect(cfg.rateLimit.exportPerHour).toBe(10);
    expect(cfg.session.adminIdleMinutes).toBe(15);
    expect(cfg.session.adminAbsoluteHours).toBe(8);
    expect(cfg.session.loginLockoutAttempts).toBe(5);
    expect(cfg.learning.videoHeartbeatSec).toBe(15);
    expect(cfg.learning.docMinDwellSec).toBe(30);
  });

  it("VIDEO_COMPLETE_PCT มี default 80 (ธง Q6 — รอยืนยัน)", () => {
    expect(loadConfig(baseEnv()).learning.videoCompletePct).toBe(80);
  });

  it("coerce ค่าตัวเลขจาก string ใน env", () => {
    const cfg = loadConfig(baseEnv({ VIDEO_COMPLETE_PCT: "90" }));
    expect(cfg.learning.videoCompletePct).toBe(90);
  });

  it("ปฏิเสธค่าตัวเลขที่ออกนอกช่วงที่กำหนด", () => {
    expect(() => loadConfig(baseEnv({ VIDEO_COMPLETE_PCT: "101" }))).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ VIDEO_COMPLETE_PCT: "abc" }))).toThrow(ConfigError);
  });

  it("ปฏิเสธค่า enum ที่ไม่รู้จัก", () => {
    expect(() =>
      loadConfig(baseEnv({ MEDIA_PROVIDER: "dropbox" })),
    ).toThrow(ConfigError);
  });
});

describe("loadConfig — เงื่อนไขข้ามฟิลด์ (SDS §7.1)", () => {
  it("MEDIA_PROVIDER=r2 ต้องมีค่า R2 ครบทั้ง 4 ตัว", () => {
    expect(() => loadConfig(baseEnv({ MEDIA_PROVIDER: "r2" }))).toThrow(ConfigError);
    const cfg = loadConfig(
      baseEnv({
        MEDIA_PROVIDER: "r2",
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key-id",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "bucket",
      }),
    );
    expect(cfg.r2?.bucket).toBe("bucket");
  });

  it("EMAIL_PROVIDER=smtp ต้องระบุ SMTP_HOST / SMTP_PORT / EMAIL_FROM", () => {
    expect(() => loadConfig(baseEnv({ EMAIL_PROVIDER: "smtp" }))).toThrow(ConfigError);
    const cfg = loadConfig(
      baseEnv({
        EMAIL_PROVIDER: "smtp",
        SMTP_HOST: "smtp.lawyerthai.test",
        SMTP_PORT: "587",
        EMAIL_FROM: "noreply@lawyerthai.test",
      }),
    );
    expect(cfg.smtp?.port).toBe(587);
  });
});

describe("CRON_SECRET — secret ของ cron email-dispatch (D-p4-8 · Wave E Phase 4)", () => {
  it("ไม่ตั้ง → cronSecret = null (route /api/internal/jobs/email-dispatch ตอบ 404 fail-closed เงียบ)", () => {
    expect(loadConfig(baseEnv()).cronSecret).toBeNull();
  });

  it("ตั้งค่า → เก็บค่าตาม env (trim แล้ว)", () => {
    const cfg = loadConfig(baseEnv({ CRON_SECRET: "  cron-secret-dev-0123456789abcdef  " }));
    expect(cfg.cronSecret).toBe("cron-secret-dev-0123456789abcdef");
  });

  it("ค่าว่าง → ConfigError (ห้าม secret ว่าง)", () => {
    expect(() => loadConfig(baseEnv({ CRON_SECRET: "   " }))).toThrow(ConfigError);
  });

  it("EMAIL_PROVIDER=resend ต้องระบุ RESEND_API_KEY / EMAIL_FROM (ทาง prod — SDS)", () => {
    expect(() => loadConfig(baseEnv({ EMAIL_PROVIDER: "resend" }))).toThrow(ConfigError);
    const cfg = loadConfig(
      baseEnv({
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_dev_placeholder_123",
        EMAIL_FROM: "noreply@lawyerthai.test",
      }),
    );
    expect(cfg.emailProvider).toBe("resend");
    expect(cfg.resendApiKey).toBe("re_dev_placeholder_123");
  });
});

describe("CURSOR_HMAC_SECRET — signed cursor (API-SPECIFICATION §1.2)", () => {
  it("ไม่ตั้ง → cursorHmacSecret = null (fallback ใช้ service key เป็น PRF ฝั่ง pagination)", () => {
    expect(loadConfig(baseEnv()).cursorHmacSecret).toBeNull();
  });

  it("ตั้งค่า → เก็บค่าตาม env (trim แล้ว)", () => {
    const cfg = loadConfig(baseEnv({ CURSOR_HMAC_SECRET: "  cursor-hmac-secret-dev  " }));
    expect(cfg.cursorHmacSecret).toBe("cursor-hmac-secret-dev");
  });

  it("ค่าว่าง → ConfigError (ห้าม secret ว่าง)", () => {
    expect(() => loadConfig(baseEnv({ CURSOR_HMAC_SECRET: "   " }))).toThrow(ConfigError);
  });

  it("PB-9: APP_ENV=prod ไม่ตั้ง → ConfigError พร้อมชื่อ key ใน issue (ห้าม fallback service key)", () => {
    try {
      loadConfig(baseEnv({ APP_ENV: "prod" }));
      expect.unreachable("ต้อง throw ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join("\n")).toContain("CURSOR_HMAC_SECRET");
    }
  });

  it("PB-9: APP_ENV=prod ตั้งค่าแล้ว → โหลดผ่าน (staging/prod ใช้กติกาเดียวกัน)", () => {
    const cfg = loadConfig(
      baseEnv({
        APP_ENV: "prod",
        CURSOR_HMAC_SECRET: "cursor-hmac-secret-prod",
        IP_HASH_SALT: "ip-hash-salt-prod",
        LTC_MFA_PENDING_KEY: MFA_PENDING_KEY_FIXTURE,
      }),
    );
    expect(cfg.appEnv).toBe("prod");
    expect(cfg.cursorHmacSecret).toBe("cursor-hmac-secret-prod");
  });

  it("PB-9: APP_ENV=local (default dev) ไม่ตั้ง → ยัง fallback null ได้ตามเดิม", () => {
    expect(loadConfig(baseEnv()).cursorHmacSecret).toBeNull();
  });
});

describe("IP_HASH_SALT — salt ของ ip_hash/user_agent_hash ตรวจประกาศนียบัตร (PB-13 · DD §3.4)", () => {
  it("ไม่ตั้ง → ipHashSalt = null (route ตรวจประกาศนียบัตร fallback ใช้ anon key เฉพาะ dev)", () => {
    expect(loadConfig(baseEnv()).ipHashSalt).toBeNull();
  });

  it("ตั้งค่า → เก็บค่าตาม env (trim แล้ว)", () => {
    const cfg = loadConfig(baseEnv({ IP_HASH_SALT: "  ip-hash-salt-dev  " }));
    expect(cfg.ipHashSalt).toBe("ip-hash-salt-dev");
  });

  it("ค่าว่าง → ConfigError (ห้าม salt ว่าง)", () => {
    expect(() => loadConfig(baseEnv({ IP_HASH_SALT: "   " }))).toThrow(ConfigError);
  });

  it("PB-13: APP_ENV=prod ไม่ตั้ง → ConfigError พร้อมชื่อ key ใน issue (ห้าม fallback anon key สาธารณะ)", () => {
    try {
      loadConfig(baseEnv({ APP_ENV: "prod" }));
      expect.unreachable("ต้อง throw ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join("\n")).toContain("IP_HASH_SALT");
    }
  });

  it("PB-13: APP_ENV=prod ตั้งค่าแล้ว → โหลดผ่าน (staging/prod ใช้กติกาเดียวกัน)", () => {
    const cfg = loadConfig(
      baseEnv({
        APP_ENV: "prod",
        CURSOR_HMAC_SECRET: "cursor-hmac-secret-prod",
        IP_HASH_SALT: "ip-hash-salt-prod",
        LTC_MFA_PENDING_KEY: MFA_PENDING_KEY_FIXTURE,
      }),
    );
    expect(cfg.appEnv).toBe("prod");
    expect(cfg.ipHashSalt).toBe("ip-hash-salt-prod");
  });

  it("PB-13: APP_ENV=local (default dev) ไม่ตั้ง → ยัง fallback null ได้ตามเดิม", () => {
    expect(loadConfig(baseEnv()).ipHashSalt).toBeNull();
  });
});

describe("LTC_MFA_PENDING_KEY — คีย์ AES-256-GCM ของ stash login สองขั้น (gate r1 F2/F5)", () => {
  it("ไม่ตั้ง → mfaPendingKey = null (helper ปฏิเสธ fail-closed — ไม่มีทาง fallback)", () => {
    expect(loadConfig(baseEnv()).mfaPendingKey).toBeNull();
  });

  it("ตั้งค่า → เก็บค่าตาม env (trim แล้ว)", () => {
    const cfg = loadConfig(baseEnv({ LTC_MFA_PENDING_KEY: `  ${MFA_PENDING_KEY_FIXTURE}  ` }));
    expect(cfg.mfaPendingKey).toBe(MFA_PENDING_KEY_FIXTURE);
  });

  it("APP_ENV=prod ไม่ตั้ง → ConfigError พร้อมชื่อ key ใน issue (prod ห้ามขาด)", () => {
    try {
      loadConfig(baseEnv({ APP_ENV: "prod", CURSOR_HMAC_SECRET: "c", IP_HASH_SALT: "s" }));
      expect.unreachable("ต้อง throw ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join("\n")).toContain("LTC_MFA_PENDING_KEY");
    }
  });
});

describe("กติกาความปลอดภัย env (SDS §5.1)", () => {
  it("ห้าม env ที่ขึ้นต้น NEXT_PUBLIC_ และมี SERVICE_ROLE ในชื่อ", () => {
    const key = ["NEXT_PUBLIC_", "SUPABASE_SERVICE_ROLE_KEY"].join("");
    expect(PUBLIC_SERVICE_ROLE_BAN.test(key)).toBe(true);
    expect(() => loadConfig(baseEnv({ [key]: "leak" }))).toThrow(ConfigError);
  });

  it("อนุญาต env public ทั่วไปที่ไม่เกี่ยวกับ service role", () => {
    expect(PUBLIC_SERVICE_ROLE_BAN.test("NEXT_PUBLIC_APP_NAME")).toBe(false);
  });
});

describe("PENDING_CONFIRMATIONS — ธง รอยืนยัน Q# (SDS §7.3)", () => {
  it("มีทั้งหมด Q1–Q6 โดยไม่ซ้ำ", () => {
    const qs = PENDING_CONFIRMATIONS.map((p) => p.q);
    expect(qs).toHaveLength(6);
    expect(new Set(qs).size).toBe(6);
  });

  it("Q6 ผูกกับ VIDEO_COMPLETE_PCT", () => {
    const q6 = PENDING_CONFIRMATIONS.find((p) => p.q === "Q6");
    expect(q6?.field).toBe("VIDEO_COMPLETE_PCT");
    expect(loadConfig(baseEnv()).learning.videoCompletePct).toBe(80);
  });
});

describe("getConfig — singleton ต่อ runtime", () => {
  it("เรียกซ้ำได้และได้ instance เดียวกัน เมื่อ env ครบ", () => {
    const env = baseEnv();
    for (const key of Object.keys(env)) {
      process.env[key] = env[key];
    }
    try {
      const first = getConfig();
      const second = getConfig();
      expect(second).toBe(first);
      expect(first.mediaProvider).toBe("supabase_storage");
    } finally {
      for (const key of Object.keys(env)) {
        delete process.env[key];
      }
    }
  });
});

describe("getFeatureFlagEnabled — อ่าน feature flag จาก DB (0026 · D55-7 · CRT-008)", () => {
  /**
   * builder จำลอง service client ตาม chain ที่ getFeatureFlagEnabled ใช้:
   * from("feature_flags") → select("enabled") → eq("key", key) → maybeSingle()
   */
  function flagClient(spec: { data: unknown; error: Record<string, unknown> | null }) {
    const maybeSingle = vi.fn(async () => ({ data: spec.data, error: spec.error }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);
    return { from, select, eq, maybeSingle };
  }

  beforeEach(() => {
    vi.mocked(createSupabaseServiceRoleClient).mockReset();
  });

  it("FEATURE_FLAG_KEYS มีคีย์ seed ของ 0026 ครบ ('cert_auto_issue')", () => {
    expect(FEATURE_FLAG_KEYS).toContain("cert_auto_issue");
    // key นอก union กันที่ compile-time แล้ว — ยืนยันคีย์ใช้ได้จริงตามชนิด
    const key: FeatureFlagKey = "cert_auto_issue";
    expect(FEATURE_FLAG_KEYS).toContain(key);
  });

  it("enabled=true → true (query ถูกตาราง/คอลัมน์/key)", async () => {
    const { from, select, eq } = flagClient({ data: { enabled: true }, error: null });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(true);
    expect(from).toHaveBeenCalledWith("feature_flags");
    expect(select).toHaveBeenCalledWith("enabled");
    expect(eq).toHaveBeenCalledWith("key", "cert_auto_issue");
  });

  it("enabled=false → false", async () => {
    flagClient({ data: { enabled: false }, error: null });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(false);
  });

  it("ไม่มีแถว (data null ไม่มี error) → false", async () => {
    flagClient({ data: null, error: null });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(false);
  });

  it("client คืน error → false (fail-closed ไม่ throw)", async () => {
    flagClient({ data: null, error: { message: "rls denied", code: "42501" } });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(false);
  });

  it("enabled ไม่ใช่ boolean (drift สัญญา DB) → false", async () => {
    flagClient({ data: { enabled: "true" }, error: null });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(false);
  });

  it("client throw (เช่น network ล้ม) → false (ไม่ throw ออกนอกฟังก์ชัน)", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockImplementation(() => {
      throw new Error("network down");
    });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(false);
  });

  it("เรียกซ้ำไม่ cache — สร้าง client ใหม่ทุกครั้งและได้ค่าสดตาม DB", async () => {
    flagClient({ data: { enabled: true }, error: null });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(true);
    flagClient({ data: { enabled: false }, error: null });
    await expect(getFeatureFlagEnabled("cert_auto_issue")).resolves.toBe(false);
    expect(createSupabaseServiceRoleClient).toHaveBeenCalledTimes(2);
  });
});

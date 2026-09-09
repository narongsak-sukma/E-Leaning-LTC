import { describe, expect, it } from "vitest";
import {
  loadConfig,
  getConfig,
  ConfigError,
  PUBLIC_SERVICE_ROLE_BAN,
  PENDING_CONFIRMATIONS,
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

describe("loadConfig — ค่าบังคับ (SDS §7.2)", () => {
  it("โหลดผ่านเมื่อ env บังคับครบ", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.publicBaseUrl).toBe(BASE_ENV.PUBLIC_BASE_URL);
    expect(cfg.supabaseUrl).toBe(BASE_ENV.SUPABASE_URL);
    expect(cfg.mediaProvider).toBe("supabase_storage");
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

/**
 * config — Shared Kernel (SDS §2.1, §7)
 *
 * - config-driven — ค่ากฎทั้งหมดมาจาก config พร้อม default (ยึด SRS Appendix A เป็น defaults master — D8)
 * - ธง "รอยืนยัน Q#" กำกับค่าที่ยังรอสภาทนายความยืนยัน (D3) — ดู PENDING_CONFIRMATIONS
 * - ตรวจครบ/ตรวจรูปแบบตอน boot + fail fast ถ้าขาด secret ที่บังคับ (SDS §7.1)
 * - APP_ENV ใช้เฉพาะ infra/observability — ห้าม branch business logic ด้วย APP_ENV (SDS §1.3-1)
 *
 * ขอบเขต: env vars ตามตาราง SDS §7.2 เท่านั้น (กฎธุรกิจที่ปรับได้โดยไม่ deploy เป็นชั้น DB-config)
 */
// guard (PB-9): โมดูลนี้อ่าน process.env ทั้ง secret ของ server — ห้ามถูก bundle เข้า
// client โดยเด็ดขาด; import เข้า Client Component ต้องพังตอน build ทันที (แบบเดียวกับ
// lib/supabase/server.ts / lib/auth/session.ts)
import "server-only";
import { z } from "zod";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const requiredString = z.string().trim().min(1);
const optionalString = z.string().trim().min(1).optional();

const intFromEnv = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** pattern ห้าม env (SDS §5.1) — ใช้ทั้งใน loadConfig และ lint rule ใน eslint.config.mjs */
export const PUBLIC_SERVICE_ROLE_BAN = /^NEXT_PUBLIC_[A-Z0-9_]*SERVICE_ROLE/;

/**
 * env schema — ทุกตัวแปรในตาราง SDS §7.2
 * default ยึด SRS Appendix A (D8) — ค่า rate limit ตรงกับ API-SPECIFICATION §5
 */
const envSchema = z.object({
  // — แอป —
  PUBLIC_BASE_URL: requiredString,
  APP_ENV: z.enum(["local", "prod"]).default("local"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  CERT_PUBLIC_BASE_URL: optionalString,
  // — Supabase —
  SUPABASE_URL: requiredString,
  SUPABASE_ANON_KEY: requiredString,
  SUPABASE_SERVICE_ROLE_KEY: requiredString,
  SUPABASE_DB_POOLER_URL: optionalString,
  // origin ของ Supabase gateway "มุมมองผู้รับอีเมล" — dev = http://localhost:8000
  // ขณะที่ SUPABASE_URL ใน container เห็น http://kong:8000 (ผู้รับเปิดไม่ได้ ·
  // gate p5-r2 hostname ruling) · ไม่ตั้ง = ใช้ SUPABASE_URL ตรง ๆ (prod ที่ผู้
  // ใช้เห็นโดเมนเดียวกับ service ไม่ต้องตั้ง)
  SUPABASE_PUBLIC_URL: optionalString,
  // — สื่อ (storage abstraction — สลับ dev/prod ด้วย MEDIA_PROVIDER) —
  MEDIA_PROVIDER: z.enum(["supabase_storage", "r2", "stream"]).default("supabase_storage"),
  R2_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: optionalString,
  STREAM_ACCOUNT_ID: optionalString,
  STREAM_CLIENT_SECRET: optionalString,
  MEDIA_SIGNED_URL_TTL_SEC: intFromEnv(900, 1, 86400),
  // — อีเมล —
  EMAIL_PROVIDER: z.enum(["console", "smtp", "resend"]).default("console"),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  EMAIL_FROM: optionalString,
  RESEND_API_KEY: optionalString,
  // secret ของ cron ที่ยิง POST /api/internal/jobs/email-dispatch (header x-cron-secret) —
  // ไม่ตั้ง = endpoint ตอบ 404 fail-closed เงียบ ๆ (D-p4-8 · Wave E Phase 4)
  CRON_SECRET: optionalString,
  // — Rate limit (ค่า canonical ชุดเดียวทุก environment — API-SPEC §5 / SRS Appendix A) —
  RATE_LIMIT_AUTH_PER_MIN: intFromEnv(10, 1, 10000),
  RATE_LIMIT_OTP_PER_HOUR: intFromEnv(3, 1, 1000),
  RATE_LIMIT_PWD_RESET_PER_HOUR: intFromEnv(5, 1, 1000),
  RATE_LIMIT_MFA_PER_MIN: intFromEnv(10, 1, 10000),
  RATE_LIMIT_VERIFY_PER_MIN: intFromEnv(120, 1, 10000),
  RATE_LIMIT_READ_PER_MIN: intFromEnv(120, 1, 10000),
  RATE_LIMIT_LEARN_WRITE_PER_MIN: intFromEnv(120, 1, 10000),
  RATE_LIMIT_EXAM_PER_MIN: intFromEnv(60, 1, 10000),
  RATE_LIMIT_STAFF_WRITE_PER_MIN: intFromEnv(60, 1, 10000),
  RATE_LIMIT_EXPORT_PER_HOUR: intFromEnv(10, 1, 1000),
  // — Session —
  SESSION_ADMIN_IDLE_MINUTES: intFromEnv(15, 1, 240),
  SESSION_ADMIN_ABSOLUTE_HOURS: intFromEnv(8, 1, 24),
  LOGIN_LOCKOUT_ATTEMPTS: intFromEnv(5, 1, 100),
  // — Cursor HMAC (API-SPEC §1.2 — cursor ต้อง signed) —
  CURSOR_HMAC_SECRET: optionalString,
  // — Salt ของ hash ตรวจสอบประกาศนียบัตร (PB-13 — ip_hash + user_agent_hash ใช้ค่าเดียวกัน) —
  IP_HASH_SALT: optionalString,
  // — การเรียน —
  VIDEO_HEARTBEAT_SEC: intFromEnv(15, 1, 600),
  VIDEO_COMPLETE_PCT: intFromEnv(80, 1, 100), // ธง Q6 — รอยืนยันกับสภาทนายความ
  DOC_MIN_DWELL_SEC: intFromEnv(30, 0, 3600),
});

/**
 * เงื่อนไขข้ามฟิลด์: provider ที่เลือกต้องมีค่าประกอบครบ (SDS §7.1 "ตรวจครบตอน boot")
 */
const envSchemaWithRules = envSchema.superRefine((env, ctx) => {
  if (env.MEDIA_PROVIDER === "r2") {
    for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "MEDIA_PROVIDER=r2 ต้องระบุค่านี้" });
      }
    }
  }
  if (env.MEDIA_PROVIDER === "stream") {
    for (const key of ["STREAM_ACCOUNT_ID", "STREAM_CLIENT_SECRET"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "MEDIA_PROVIDER=stream ต้องระบุค่านี้" });
      }
    }
  }
  if (env.EMAIL_PROVIDER === "smtp") {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "EMAIL_FROM"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "EMAIL_PROVIDER=smtp ต้องระบุค่านี้" });
      }
    }
  }
  if (env.EMAIL_PROVIDER === "resend") {
    for (const key of ["RESEND_API_KEY", "EMAIL_FROM"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "EMAIL_PROVIDER=resend ต้องระบุค่านี้" });
      }
    }
  }
  // PB-9: prod (รวม staging ที่รัน APP_ENV=prod) ห้ามตกไปใช้ service key เป็น PRF ของ cursor —
  // fail fast ตอน boot แรงกว่า documentation ล้วน (ASVS V14)
  if (env.APP_ENV === "prod" && env.CURSOR_HMAC_SECRET === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["CURSOR_HMAC_SECRET"],
      message: "APP_ENV=prod ต้องตั้ง CURSOR_HMAC_SECRET เฉพาะทาง (docs/09-dev/SECRETS-PROVISIONING.md)",
    });
  }
  // PB-13: prod ห้ามใช้ anon key (ค่าสาธารณะ) เป็น salt ของ ip_hash/user_agent_hash —
  // hash ถอยง่ายสำหรับ IP ที่รู้ค่า salt (DD §3.4 · SDS §3.4c) — กติกาเดียวกับ PB-9
  if (env.APP_ENV === "prod" && env.IP_HASH_SALT === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["IP_HASH_SALT"],
      message: "APP_ENV=prod ต้องตั้ง IP_HASH_SALT เฉพาะทาง (docs/09-dev/SECRETS-PROVISIONING.md)",
    });
  }
});

type EnvRaw = z.infer<typeof envSchemaWithRules>;

/** Error ตอน boot ถ้า env ขาด/ไม่ถูกต้อง (fail fast — SDS §7.1) */
export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`ตั้งค่าระบบไม่ครบหรือไม่ถูกต้อง:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** config หลังตรวจแล้ว (immutable) — โครงสร้างเดียวที่โค้ดทั้งระบบอ่านค่าจาก */
export interface AppConfig {
  publicBaseUrl: string;
  appEnv: "local" | "prod";
  logLevel: "debug" | "info" | "warn" | "error";
  certPublicBaseUrl: string | null;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  supabaseDbPoolerUrl: string | null;
  /**
   * origin ของ Supabase gateway มุมมองผู้รับลิงก์ (env `SUPABASE_PUBLIC_URL`):
   * email worker เขียนทับ protocol+host ของ signed URL ด้วยค่านี้ก่อนใส่เมล์ —
   * dev ผู้รับบน host เปิด http://kong:8000 ไม่ได้ · ไม่ตั้ง = null → ใช้ URL
   * จาก createSignedUrl (SUPABASE_URL) ตรง ๆ — prod โดเมนเดียวไม่ต้องตั้ง
   */
  supabasePublicUrl: string | null;
  /**
   * คีย์ HMAC สำหรับ signed cursor (API-SPECIFICATION §1.2) — optional env
   * `CURSOR_HMAC_SECRET`; ไม่ตั้ง = null → helper ฝั่ง cursor (lib/api/pagination)
   * fallback ใช้ `supabaseServiceRoleKey` เป็น PRF (dev-grade — ความเสี่ยงยอมรับได้เฉพาะ
   * dev; prod ต้องตั้ง CURSOR_HMAC_SECRET เพื่อไม่ผูกความปลอดภัยของ cursor กับอายุ/การหมุน
   * ของ service key) — HMAC เป็น one-way PRF จึงไม่เปิดเผยคีย์ต้นฉบับออกนอกกระบวนการ
   */
  cursorHmacSecret: string | null;
  /**
   * Salt ของ ip_hash/user_agent_hash ตอนตรวจสอบประกาศนียบัตรสาธารณะ
   * (DD §3.4) — optional env `IP_HASH_SALT`; ไม่ตั้ง = null → route ตรวจ
   * ประกาศนียบัตร fallback ใช้ `supabaseAnonKey` (ค่าสาธารณะ — dev-grade,
   * ยอมรับได้เฉพาะ dev; prod ต้องตั้ง IP_HASH_SALT — superRefine fail fast
   * ตอน boot) · sha256 เป็น one-way จึงไม่เปิดเผยค่า salt ออกนอกกระบวนการ
   */
  ipHashSalt: string | null;
  mediaProvider: "supabase_storage" | "r2" | "stream";
  mediaSignedUrlTtlSec: number;
  r2: {
    accountId: string | null;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    bucket: string | null;
  } | null;
  stream: { accountId: string | null; clientSecret: string | null } | null;
  emailProvider: "console" | "smtp" | "resend";
  smtp: { host: string; port: number; user: string | null; password: string | null } | null;
  emailFrom: string | null;
  resendApiKey: string | null;
  /**
   * secret ของ cron email-dispatch (env `CRON_SECRET` — D-p4-8 Wave E Phase 4):
   * route `/api/internal/jobs/email-dispatch` เทียบ header `x-cron-secret` แบบ
   * timing-safe · **ไม่ตั้ง = null → route ตอบ 404 ตลอด (fail-closed เงียบ)** —
   * dev ตั้งอะไรก็ได้ (สุ่ม `openssl rand -hex 16` · compose service `mailer`
   * อ่านค่านี้จาก .env) · prod = Vercel Cron secret ของ platform
   */
  cronSecret: string | null;
  rateLimit: {
    authPerMin: number;
    otpPerHour: number;
    pwdResetPerHour: number;
    mfaPerMin: number;
    verifyPerMin: number;
    readPerMin: number;
    learnWritePerMin: number;
    examPerMin: number;
    staffWritePerMin: number;
    exportPerHour: number;
  };
  session: { adminIdleMinutes: number; adminAbsoluteHours: number; loginLockoutAttempts: number };
  learning: { videoHeartbeatSec: number; videoCompletePct: number; docMinDwellSec: number };
}

/** แปลง env ที่ผ่าน validation แล้วเป็น AppConfig (แยกชั้น เพื่อให้ schema อ่านง่าย) */
function toConfig(env: EnvRaw): AppConfig {
  return {
    publicBaseUrl: env.PUBLIC_BASE_URL,
    appEnv: env.APP_ENV,
    logLevel: env.LOG_LEVEL,
    certPublicBaseUrl: env.CERT_PUBLIC_BASE_URL ?? null,
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseDbPoolerUrl: env.SUPABASE_DB_POOLER_URL ?? null,
    supabasePublicUrl: env.SUPABASE_PUBLIC_URL ?? null,
    cursorHmacSecret: env.CURSOR_HMAC_SECRET ?? null,
    ipHashSalt: env.IP_HASH_SALT ?? null,
    mediaProvider: env.MEDIA_PROVIDER,
    mediaSignedUrlTtlSec: env.MEDIA_SIGNED_URL_TTL_SEC,
    r2:
      env.MEDIA_PROVIDER === "r2"
        ? {
            accountId: env.R2_ACCOUNT_ID ?? null,
            accessKeyId: env.R2_ACCESS_KEY_ID ?? null,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? null,
            bucket: env.R2_BUCKET ?? null,
          }
        : null,
    stream:
      env.MEDIA_PROVIDER === "stream"
        ? { accountId: env.STREAM_ACCOUNT_ID ?? null, clientSecret: env.STREAM_CLIENT_SECRET ?? null }
        : null,
    emailProvider: env.EMAIL_PROVIDER,
    smtp:
      env.EMAIL_PROVIDER === "smtp"
        ? { host: env.SMTP_HOST ?? "", port: env.SMTP_PORT ?? 0, user: env.SMTP_USER ?? null, password: env.SMTP_PASSWORD ?? null }
        : null,
    emailFrom: env.EMAIL_FROM ?? null,
    resendApiKey: env.RESEND_API_KEY ?? null,
    cronSecret: env.CRON_SECRET ?? null,
    rateLimit: {
      authPerMin: env.RATE_LIMIT_AUTH_PER_MIN,
      otpPerHour: env.RATE_LIMIT_OTP_PER_HOUR,
      pwdResetPerHour: env.RATE_LIMIT_PWD_RESET_PER_HOUR,
      mfaPerMin: env.RATE_LIMIT_MFA_PER_MIN,
      verifyPerMin: env.RATE_LIMIT_VERIFY_PER_MIN,
      readPerMin: env.RATE_LIMIT_READ_PER_MIN,
      learnWritePerMin: env.RATE_LIMIT_LEARN_WRITE_PER_MIN,
      examPerMin: env.RATE_LIMIT_EXAM_PER_MIN,
      staffWritePerMin: env.RATE_LIMIT_STAFF_WRITE_PER_MIN,
      exportPerHour: env.RATE_LIMIT_EXPORT_PER_HOUR,
    },
    session: {
      adminIdleMinutes: env.SESSION_ADMIN_IDLE_MINUTES,
      adminAbsoluteHours: env.SESSION_ADMIN_ABSOLUTE_HOURS,
      loginLockoutAttempts: env.LOGIN_LOCKOUT_ATTEMPTS,
    },
    learning: {
      videoHeartbeatSec: env.VIDEO_HEARTBEAT_SEC,
      videoCompletePct: env.VIDEO_COMPLETE_PCT,
      docMinDwellSec: env.DOC_MIN_DWELL_SEC,
    },
  };
}

/**
 * ธง "รอยืนยัน Q#" (SDS §7.3) — ค่าที่ยังรอสภาทนายความยืนยันก่อนใช้งานจริง
 * field = null หมายถึงค่านั้นอยู่ชั้น DB-config (ไม่ใช่ env)
 */
export interface PendingConfirmation {
  readonly q: "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6";
  readonly field: string | null;
  readonly note: string;
}

export const PENDING_CONFIRMATIONS: readonly PendingConfirmation[] = [
  {
    q: "Q1",
    field: null,
    note: "รอบต่ออายุ + หน่วยกิตที่ต้องสะสม — credit_rules (ชั้น DB-config)",
  },
  {
    q: "Q2",
    field: null,
    note: "เกณฑ์ผ่าน/จำนวนครั้ง/เวลาสอบ — assessment_rules (ชั้น DB-config)",
  },
  {
    q: "Q3",
    field: null,
    note: "รูปแบบเลขที่ใบอนุญาตและวิธียืนยันทนาย — DB-config + zod schema (Wave C)",
  },
  {
    q: "Q4",
    field: null,
    note: "proctoring_mode — assessment_rules (ชั้น DB-config)",
  },
  {
    q: "Q5",
    field: null,
    note: "region ของ Supabase/Vercel — ตั้งที่ deploy-time ไม่ใช่ env ในโค้ด",
  },
  {
    q: "Q6",
    field: "VIDEO_COMPLETE_PCT",
    note: "ดูครบ 80% ถือว่าจบบทวิดีโอ — รอยืนยันกับสภาทนายความ",
  },
];

/**
 * โหลดและตรวจ env ทั้งหมด — throw ConfigError ถ้าขาดค่าบังคับหรือค่าไม่ถูกต้อง
 * (เรียกที่ boot / first request — SDS §7.1 fail fast)
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  for (const key of Object.keys(env)) {
    if (PUBLIC_SERVICE_ROLE_BAN.test(key)) {
      throw new ConfigError([
        `env "${key}" ห้ามใช้ — service-role key ห้ามขึ้นต้น NEXT_PUBLIC_ (SDS §5.1)`,
      ]);
    }
  }

  const parsed = envSchemaWithRules.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(issues);
  }
  return toConfig(parsed.data);
}

let cachedConfig: AppConfig | null = null;

/** config singleton ต่อ runtime — เรียกซ้ำได้โดยไม่ parse ซ้ำ (SDS §8: singleton ต่อ runtime) */
export function getConfig(): AppConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}

// — Feature flags (migration 0026 · D55-7 · CRT-008) ————————————————————————

/**
 * คีย์ feature flag ที่ BFF รู้จัก — ตรงกับ seed ของ migration 0026
 * (`cert_auto_issue` — CRT-008: ธงเปิด/ปิดการออกใบอัตโนมัติแบบ async scan โดย
 * cron ทุก 2 นาที · D55-7 ตัดสินแล้วว่าไม่มี hook หลัง submit) — union นี้บังคับ
 * ที่ compile-time: ผู้เรียก getFeatureFlagEnabled ใช้ได้เฉพาะคีย์ที่ประกาศไว้
 */
export const FEATURE_FLAG_KEYS = ["cert_auto_issue"] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/**
 * อ่านสถานะ feature flag จากตาราง `feature_flags` (migration 0026 — source of
 * truth ฝั่ง DB · BFF อ่านอย่างเดียว ไม่มี mutation ตามขอบเขต E-6)
 *
 * - อ่านผ่าน service-role client เท่านั้น — RLS ของตารางนี้ fail-closed ต่อ
 *   anon/authenticated (0026 revoke all + ไม่มี policy ของกลุ่มนั้น) เหลือให้
 *   service_role ผ่าน BFF และ cron (policy app_owner) เท่านั้น
 * - **fail-closed คืน false ทุกกรณีผิดปกติ** — ไม่มีแถว (maybeSingle ได้ data
 *   null โดยไม่มี error), error ใด ๆ, หรือ enabled ไม่ใช่ boolean (สัญญา DB
 *   เพี้ยน): flag default ปิด และผู้เรียกเป็น surface เสริม (หน้า admin) ต้องไม่
 *   พัง จึงห้าม throw ออกนอกฟังก์ชัน — false = ไม่ปลุก job ออกใบอัตโนมัติ ปลอดภัยกว่าเสมอ
 * - ไม่ cache — สร้าง client ใหม่ทุกครั้ง เพื่อให้เห็นค่าสดหลัง admin สลับ flag
 * - ไม่มี log — lib layer นี้ไม่แนบ logger (ไม่มี PII ใน query นี้อยู่แล้ว)
 */
export async function getFeatureFlagEnabled(key: FeatureFlagKey): Promise<boolean> {
  try {
    const client = createSupabaseServiceRoleClient();
    const res = await client.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
    if (res.error !== null || res.data === null) {
      return false;
    }
    // ชนิดเพี้ยน = drift ของสัญญา DB — ถือว่า flag ปิด ไม่ coerce เงียบ ๆ
    // (fail-closed แบบเดียวกับการตรวจแถว RPC ใน lib/certificates)
    if (typeof res.data.enabled !== "boolean") {
      return false;
    }
    return res.data.enabled;
  } catch {
    // client/เครือข่ายล้มระหว่างทาง — flag ปิด (fail-closed) ไม่ throw ต่อ
    return false;
  }
}

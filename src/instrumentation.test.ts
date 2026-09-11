import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * หมายเหตุสถาปัตยกรรมของ suite นี้: getConfig เป็น singleton ต่อ module instance —
 * ทุกเคสต้อง vi.resetModules() + dynamic import (register และ ConfigError จาก
 * module registry รุ่นเดียวกัน) ไม่เช่นนั้นเคสที่รันก่อน cache config ที่ผ่าน
 * แล้วไว้ ทำให้เคสถัดไปผ่าน/พังตามลำดับการรัน (จับโดย gate r2 เมื่อ shuffle)
 */

/** stub env บังคับของ loadConfig (ตรง BASE_ENV ของ config.test.ts) */
const REQUIRED_STUBS: Record<string, string> = {
  PUBLIC_BASE_URL: "https://elearning.lawyerthai.test",
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
};

const TOUCHED_KEYS = [
  ...Object.keys(REQUIRED_STUBS),
  "APP_ENV",
  "CURSOR_HMAC_SECRET",
  "IP_HASH_SALT",
  "NEXT_RUNTIME",
];

/** snapshot ค่า env เดิมทุก key ที่ suite นี้จะแตะ — คืนค่าจริง (ไม่ใช่ลบทิ้ง) */
const SAVED: Record<string, string | undefined> = {};
for (const key of TOUCHED_KEYS) {
  SAVED[key] = process.env[key];
}

function withStubs(extra: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_STUBS, ...extra })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("instrumentation.register — ตรวจ config ตอน boot (PB-9/PB-13 / SDS §7.1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of TOUCHED_KEYS) {
      if (SAVED[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = SAVED[key];
      }
    }
  });

  it("nodejs runtime + APP_ENV=prod ขาด CURSOR_HMAC_SECRET → reject ด้วย ConfigError", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    withStubs({ APP_ENV: "prod", CURSOR_HMAC_SECRET: undefined });
    const { register } = await import("./instrumentation");
    const { ConfigError } = await import("./lib/config");
    await expect(register()).rejects.toBeInstanceOf(ConfigError);
  });

  it("nodejs runtime + APP_ENV=prod ขาด IP_HASH_SALT → reject ด้วย ConfigError (PB-13)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    withStubs({
      APP_ENV: "prod",
      CURSOR_HMAC_SECRET: "cursor-hmac-secret-prod",
      IP_HASH_SALT: undefined,
    });
    const { register } = await import("./instrumentation");
    const { ConfigError } = await import("./lib/config");
    await expect(register()).rejects.toBeInstanceOf(ConfigError);
  });

  it("nodejs runtime + env ครบ → resolve (bootstrap ผ่าน)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    withStubs({
      APP_ENV: "prod",
      CURSOR_HMAC_SECRET: "cursor-hmac-secret-prod",
      IP_HASH_SALT: "ip-hash-salt-prod",
    });
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("nodejs runtime + APP_ENV=local ขาด secret → resolve ได้ (dev fallback ตามเดิม)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    withStubs({ APP_ENV: "local", CURSOR_HMAC_SECRET: undefined });
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("runtime อื่น (edge/undefined) → resolve โดยไม่ตรวจ (แต่ละ runtime ตรวจเองที่ getConfig)", async () => {
    delete process.env.NEXT_RUNTIME;
    // env พังก็ต้อง resolve — guard ต้องเป็นสิ่งเดียวที่ตัดสิน (config module รุ่นใหม่
    // จาก resetModules ยังไม่ถูกเรียกใช้ จึงไม่มี cache มาบัง)
    withStubs({ APP_ENV: "prod", CURSOR_HMAC_SECRET: undefined });
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });
});

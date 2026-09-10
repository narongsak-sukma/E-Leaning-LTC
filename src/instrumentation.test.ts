import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "./lib/config";

/** stub env บังคับของ loadConfig (ตรง BASE_ENV ของ config.test.ts) */
const REQUIRED_STUBS: Record<string, string> = {
  PUBLIC_BASE_URL: "https://elearning.lawyerthai.test",
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
};

const SAVED_NEXT_RUNTIME = process.env.NEXT_RUNTIME;

function withStubs(extra: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_STUBS, ...extra })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function cleanup(): void {
  const keys = new Set([
    ...Object.keys(REQUIRED_STUBS),
    "APP_ENV",
    "CURSOR_HMAC_SECRET",
  ]);
  for (const key of keys) {
    delete process.env[key];
  }
  if (SAVED_NEXT_RUNTIME === undefined) {
    delete process.env.NEXT_RUNTIME;
  } else {
    process.env.NEXT_RUNTIME = SAVED_NEXT_RUNTIME;
  }
}

describe("instrumentation.register — ตรวจ config ตอน boot (PB-9 / SDS §7.1)", () => {
  afterEach(cleanup);

  it("nodejs runtime + APP_ENV=prod ขาด CURSOR_HMAC_SECRET → reject ด้วย ConfigError", async () => {
    const { register } = await import("./instrumentation");
    process.env.NEXT_RUNTIME = "nodejs";
    withStubs({ APP_ENV: "prod", CURSOR_HMAC_SECRET: undefined });
    await expect(register()).rejects.toBeInstanceOf(ConfigError);
  });

  it("nodejs runtime + env ครบ → resolve (bootstrap ผ่าน)", async () => {
    const { register } = await import("./instrumentation");
    process.env.NEXT_RUNTIME = "nodejs";
    withStubs({
      APP_ENV: "prod",
      CURSOR_HMAC_SECRET: "cursor-hmac-secret-prod",
    });
    await expect(register()).resolves.toBeUndefined();
  });

  it("runtime อื่น (edge/undefined) → resolve โดยไม่ตรวจ (แต่ละ runtime ตรวจเองที่ getConfig)", async () => {
    const { register } = await import("./instrumentation");
    delete process.env.NEXT_RUNTIME;
    withStubs({ APP_ENV: "prod", CURSOR_HMAC_SECRET: undefined });
    await expect(register()).resolves.toBeUndefined();
  });
});

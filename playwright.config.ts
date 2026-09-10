/**
 * playwright.config.ts — ชุด smoke E2E ของ Phase 1 (C-10 / PB-10: E2E-04/05/06 + logout)
 *
 * - รันบนแอปจริง http://localhost:3000 (Next.js dev-stack container ltc-dev-app) + Supabase local
 * - ผู้ใช้ทดสอบ = GoTrue จริง (signup + confirm ฝั่ง DB + บทบาท citizen) แล้วเข้าสู่ระบบ
 *   ผ่านฟอร์ม /login จริง — ไม่แตะ session cookie ฝั่ง harness เด็ดขาด
 * - 1 worker · ไม่ parallel (ทุก spec เป็น user flow ของผู้ใช้หนึ่งคน ต่อกันภายในไฟล์)
 * - reuseExistingServer: dev ใช้เซิร์ฟเวอร์ที่รันอยู่แล้ว (ltc-dev-app) · CI เริ่มเอง
 * - env: อ่านไฟล์ .env ที่ root เอง (ไม่เพิ่ม dependency — dotenv ไม่ได้อยู่ใน package.json)
 */
import { readFileSync } from "node:fs";
import { defineConfig, devices, type ReporterDescription } from "@playwright/test";

/**
 * root ของ repo — ต้องรัน `npx playwright test` จาก root เท่านั้น
 * (ห้ามใช้ import.meta.url: Playwright โหลด config เป็น CJS เมื่อ package.json ไม่มี type:module)
 */
const REPO_ROOT = process.cwd();

/**
 * โหลด .env แบบ minimal (KEY=VALUE ต่อบรรทัด · ไม่ทับค่าที่ตั้งมาใน shell แล้ว)
 * — dotenv ไม่ได้เป็น dependency ของ repo จึงอ่านไฟล์เองที่นี่
 */
function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // ไม่มี .env — ใช้ค่าจาก shell/env ของ CI โดยตรง
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && key !== "POSTGRES_PASSWORD") {
      process.env[key] = value;
    }
  }
}

void loadDotEnv(`${REPO_ROOT}/.env`);

/** ค่ากลางของ config (แยกออกเพื่อไม่ต้อง assign undefined ให้ field ที่เป็น exactOptionalPropertyTypes) */
const common = {
  testDir: "./e2e",
  outputDir: "./e2e/.artifacts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]] as ReporterDescription[],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure" as const,
    video: "retain-on-failure" as const,
    screenshot: "only-on-failure" as const,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
};

/**
 * webServer: dev = ใช้ ltc-dev-app ที่รันอยู่แล้ว (reuseExistingServer) · ตั้ง E2E_NO_SERVER=1
 * เมื่อจัดการเซิร์ฟเวอร์เองภายนอก (ป้องกัน config พยายามสตาร์ท `npm run dev` ซ้ำ)
 */
const server =
  process.env.E2E_NO_SERVER !== undefined
    ? {}
    : {
        webServer: {
          command: "npm run dev",
          url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
          reuseExistingServer: !process.env.CI,
          ignoreHTTPSErrors: true,
          timeout: 120_000,
        },
      };

export default defineConfig({ ...common, ...server });

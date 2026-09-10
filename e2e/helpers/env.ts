/**
 * e2e/helpers/env.ts — อ่านค่า env สำหรับ harness (ไม่พิมพ์ค่า secret ทุกชนิด)
 *
 * - worker ของ Playwright เป็น process แยกจากตัว runner จึงต้องโหลด .env เองที่นี่
 *   (playwright.config.ts โหลดเพื่อ runner — ไฟล์นี้โหลดเพื่อ worker)
 * - fallback: TEST_SUPABASE_URL ?? SUPABASE_URL ?? http://localhost:8000 (Supabase local)
 *   (.env ของ dev ตอนนี้ยังไม่มี TEST_* — .env.example ประกาศชื่อไว้แล้ว ตาม C-9)
 * - ห้าม log ค่า key/รหัสผ่าน — helper ทั้งหมดอ้างชื่อ env var อย่างเดียว
 */
import { readFileSync } from "node:fs";

/** root ของ repo — Playwright worker รันด้วย cwd = repo root (ดู playwright.config.ts) */
const REPO_ROOT = process.cwd();

/** โหลด .env แบบ minimal — ไม่ทับค่าที่ shell ตั้งมาแล้ว (แบบเดียวกับ playwright.config.ts) */
function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
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
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(`${REPO_ROOT}/.env`);

/** ค่าที่อ่านแล้ว (ตัวเลือก fallback ตามลำดับ) */
export const REST_BASE =
  process.env["TEST_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? "http://localhost:8000";

/** anon key (GoTrue signup + REST สาธารณะ) — ค่า dev local ตาม .env */
export const ANON_KEY =
  process.env["TEST_SUPABASE_ANON_KEY"] ?? process.env["SUPABASE_ANON_KEY"] ?? "";

/** รหัสผ่านของผู้ใช้ทดสอบ (GoTrue GOTRUE_PASSWORD_MIN_LENGTH=12) */
export const TEST_PASSWORD = process.env["TEST_USER_PASSWORD"] ?? "Integration#2026";

/** origin ของแอปภายใต้ทดสอบ — ต้องตรง baseURL ใน playwright.config.ts */
export const APP_ORIGIN = process.env["E2E_BASE_URL"] ?? "http://localhost:3000";

/** container ของ DB ที่ใช้รัน psql (docker compose service `db`) */
export const DB_SERVICE = process.env["E2E_DB_SERVICE"] ?? "db";

/** ไฟล์ log ที่ harness เขียนได้ (evidence ตอน debug — ไม่ใช่ report ของ spec) */
export const HARNESS_LOG = `${REPO_ROOT}/e2e/.artifacts/harness.log`;

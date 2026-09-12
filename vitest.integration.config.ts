import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// alias เดียวกับ vitest.config.ts (unit) — gate p5-r2: integration suite ต้อง import
// "worker จริง" ได้ (เช่น processDataExportJob ของ dcr12) พร้อม stub server-only

/**
 * vitest — integration tests (C-9) บน dev stack จริง (docker-compose: db + kong/rest + auth)
 *
 * แยกจาก `npm test` (vitest.config.ts — include เฉพาะ src/**) ทุกด้าน:
 * - include เฉพาะ tests/integration/**.test.ts → unit tests ไม่ถูกนับเข้า/ไม่ถูกรันซ้ำ
 * - ต้องมี TEST_DATABASE_URL — อ่านจาก shell env ก่อน → .env → .env.example (fallback)
 *   ไม่มีเลย = skip ทั้งชุด (describe.skipIf ในไฟล์ทดสอบ) → ไม่มี DB = ไม่ fail
 * - รัน: npx vitest run --config vitest.integration.config.ts  (npm run test:integration)
 */

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

/** เติมตัวแปรที่ยังไม่มีใน process.env (shell ชนะ → .env → .env.example) */
function put(key: string, value: string | undefined): void {
  if (value === undefined || value === "") return;
  if (process.env[key] === undefined) process.env[key] = value;
}

// 1) .env — ทั้ง TEST_* และ SUPABASE_* (จับคู่เป็น TEST_* ให้ชุดทดสอบใช้คีย์ของ stack จริง)
for (const [key, value] of Object.entries(loadEnv("", repoRoot, ""))) {
  put(key, value);
  if (key.startsWith("SUPABASE_")) put(`TEST_${key}`, value);
}
// 2) .env.example — fallback เฉพาะคีย์ TEST_* ที่ยังขาด
try {
  for (const line of readFileSync(`${repoRoot}/.env.example`, "utf8").split("\n")) {
    const match = /^\s*(TEST_[A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match !== null) put(match[1] ?? "", (match[2] ?? "").replace(/^["']|["']$/g, ""));
  }
} catch {
  // ไม่มี .env.example — shell env เป็นผู้ตัดสิน (ไม่มี TEST_DATABASE_URL → skip ทั้งชุด)
}

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // เขียนลง DB จริง (signup/enroll) — ห้ามไฟล์ขนานกัน
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// alias เดียวกับ vitest.integration.config.ts — barrier suite import coordinator/harness จริงได้

/**
 * vitest — barrier-proof suite (Wave H D89-3 · gate แผน r15:1201 + r30 §2-D89-3)
 *
 * แยกจาก integration ทุกด้าน:
 * - include เฉพาะ tests/barrier-proof/** — scenario พิสูจน์ "runner abandonment +
 *   poison หยุดการลามของความล้มเหลว" ไม่ใช่ functional test ของแอป
 * - hookTimeout: 5_000 "ตั้งใจ" — scenario 8c/8e/8f ต้องการ vitest runner ทิ้ง hook
 *   จริงที่ 5s (promise เดิมยังวิ่งต่อตาม F56) · hook ที่ต้องการนานกว่าต้องส่ง timeout
 *   ระบุเป็นอาร์กิวเมนต์ที่สองของ beforeAll/afterAll เสมอ (เช่น beforeAll(fn, 60_000))
 * - fileParallelism: false + sequencer เรียงชื่อไฟล์ aa→bb — สัญญาลำดับของ 8b/8c/8d
 *   (ไฟล์ bb ต้องเห็น poison ของ aa จึงปฏิเสธก่อน setup — order คือส่วนหนึ่งของ proof)
 * - bail ไม่ตั้งที่ config — มีเฉพาะ child run ของ 8d ผ่าน CLI --bail=1 (พิสูจน์ขอบเขต
 *   bail: หยุด test-failure ไม่ใช่ hook-failure — คนละกลไกกับ poison ของ 8b)
 *
 * รัน: npx vitest run --config vitest.barrier-proof.config.ts
 *      (battery stage barrier-proof · RUN_ID=pre-it · child run ใช้ config นี้ + BARRIER_CHILD=1)
 */

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

/** เติมตัวแปรที่ยังไม่มีใน process.env (shell ชนะ → .env → .env.example) */
function put(key: string, value: string | undefined): void {
  if (value === undefined || value === "") return;
  if (process.env[key] === undefined) process.env[key] = value;
}

// 1) .env — ทั้ง TEST_* และ SUPABASE_* (จับคู่เป็น TEST_* ให้ใช้คีย์ของ stack จริง)
for (const [key, value] of Object.entries(loadEnv("", repoRoot, ""))) {
  put(key, value);
  if (key.startsWith("SUPABASE_")) put(`TEST_${key}`, value);
}
// 2) .env.example — fallback ทำนองเดียวกับ integration config
try {
  for (const line of readFileSync(`${repoRoot}.env.example`, "utf8").split("\n")) {
    const match = /^\s*(TEST_[A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match !== null) put(match[1] ?? "", (match[2] ?? "").replace(/^["']|["']$/g, ""));
  }
} catch {
  // ไม่มี .env.example — shell env เป็นผู้ตัดสิน
}

/** sequencer เรียงตามชื่อไฟล์ (basename ของ moduleId) — child ไฟล์ aa-* ต้องรันก่อน bb-* เสมอ */
class AaToBbSequencer extends BaseSequencer {
  public override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = [...files].sort((a, b) =>
      path.basename(a.moduleId).localeCompare(path.basename(b.moduleId), "en"),
    );
    return Promise.resolve(sorted);
  }
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
    include: ["tests/barrier-proof/**/*.test.ts"],
    // ลำดับไฟล์คือส่วนหนึ่งของ proof (8b/8c/8d) — ห้ามขนาน ห้ามสลับ
    fileParallelism: false,
    sequence: { sequencer: AaToBbSequencer },
    testTimeout: 30_000,
    // ตั้งใจ 5s — scenario abandonment ต้องการ runner ทิ้ง hook จริง (ดู header)
    hookTimeout: 5_000,
  },
});

#!/usr/bin/env node
/**
 * scripts/window-owner-proof.mjs — Wave H O1-O18 owner-proof executor [#94] (plan §2-D89-4)
 *
 * ตัวพิสูจน์จริงอยู่ใน tests/integration/wave-h-owner-proof.test.ts (TS · import
 * coordinator ตรง — single source ไม่ duplicate SQL ใน .mjs) · สคริปต์นี้เป็น
 * executor บางๆ ของ battery stage "owner-proof": รัน vitest ไฟล์นั้นแล้วส่งต่อ
 * exit code เป๊ะ (ห้ามกลืนความล้มเหลว — ล้ม = ล้ม)
 *
 * ใช้: node scripts/window-owner-proof.mjs            (battery เรียกเอง · มนุษย์รันได้)
 * ออก: exit ตาม vitest (0 = ผ่านครบ O1-O18 · 1 = มี O ล้ม) · 2 = สภาพแวดล้อมไม่พร้อม
 *      (vitest spawn ไม่ได้ / ไฟล์เทสหาย) — แยกจาก "เทสล้ม" ตามสัญญา exit ของ repo
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_FILE = "tests/integration/wave-h-owner-proof.test.ts";

if (!existsSync(path.join(REPO_ROOT, TEST_FILE))) {
  process.stderr.write(`window-owner-proof: ไม่พบ ${TEST_FILE} — สภาพแวดล้อมไม่พร้อม\n`);
  process.exit(2);
}

const child = spawn(
  "npx",
  ["vitest", "run", "--config", "vitest.integration.config.ts", TEST_FILE],
  { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
);
child.on("error", (err) => {
  process.stderr.write(`window-owner-proof: spawn vitest ล้มเหลว: ${err.message}\n`);
  process.exit(2);
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});

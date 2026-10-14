/**
 * tests/e2e/uat09/fixtures.ts — fixtures กลางของ UAT-09A–09D (Lane P-UAT09SPEC · Sprint 3 WO-2)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ห้ามรันตอนนี้ — post-close เท่านั้น (แบบแผน e2e-18/e2e-19 หัวไฟล์)
 * ═══════════════════════════════════════════════════════════════════════════
 * - specs ชุดนี้เขียนไว้เพื่อให้ tester agent รันหลัง CTO ประกาศ close drained เท่านั้น
 *   (UAT-09-SPECS §1 ข้อ 1) — ต้องมี stack prod-build :3001 + Mailpit :8025 + seed uat.*
 * - ไฟล์ชุดนี้อยู่ใต้ `tests/e2e/` ซึ่ง **ไม่ถูก playwright.config.ts ปัจจุบันเลือก**
 *   (testDir = "./e2e") — โดยเจตนาตาม A-4 (ศูนย์ overlap กับ close-ladder) · การต่อสาย
 *   testDir / config แยกเป็นหนี้ทางเทคนิคจุดเดียวของสปรินต์ — ของ execute lane post-close
 *   (SPRINT3-workorders C-4 + deferred DoD ของ WO-2)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * กฎลำดับการรัน — อ่านก่อนรันทุกครั้ง (UAT-09-SPECS §0 คัดมาครบ)
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. เงื่อนไขเริ่ม 09 ทั้งรอบ: รอบหลัก UAT-01..08 จบทั้งรอบแล้ว (P8) — หรือถ้าถูกสั่งให้
 *    รันก่อนรอบหลักจบ ต้องไม่กลับเข้าสคริปต์รอบหลักที่ยังไม่ได้รันโดยไม่ re-seed ก่อน
 * 2. ลำดับที่กำหนด: `P8 เสร็จ → 09A → re-seed → 09C → 09D → 09B → re-seed (คืนฐานส่งมอบ)`
 *    - 09A เปลี่ยนรหัส citizen → afterAll ของ 09A re-seed คืนค่าก่อนแตะบัญชีอื่น
 *    - 09C/09D อ่านอย่างเดียว (ยกเลิกเสมอ) จึงวางก่อน 09B ได้ปลอดภัย
 *    - 09B จบด้วย logout-all + รหัสใหม่ → afterAll ของ 09B re-seed ปิดท้าย
 * 3. คำสั่ง re-seed: `bash scripts/uat-seed.sh` (idempotent — ห้ามแก้สคริปต์ · A-6b) —
 *    หลัง re-seed MFA factor ของบัญชีเจ้าหน้าที่ยังอยู่เดิม (seed ไม่แตะ auth.mfa_factors)
 *    การล็อกอิน staff:exam หลัง re-seed จึงยังเป็นสองขั้นด้วย secret เดิม
 * 4. ห้ามเริ่ม 09A/09B เมื่อมีสคริปต์อื่นค้างอยู่กลางทาง · ห้ามข้ามขั้น re-seed ที่กำหนด
 * 5. ถ้ารหัสเพี้ยนระหว่างรัน (เช่น 09A ตั้งรหัสใหม่แล้ว crash ก่อนจด): ทางกู้เดียว =
 *    re-seed แล้วเริ่มสคริปต์นั้นใหม่ — จดเหตุลง run-log.md
 * - specs ทั้งสี่ไฟล์ออกแบบให้รันอนุกรมภายในกลุ่ม (serial · 1 worker semantics) —
 *   การบังคับ serial/ลำดับข้ามไฟล์เป็นของ config ตอน execute (A-4) · รันไฟล์ละเคส
 *   ตามลำดับข้อ 2 เสมอ อย่ารันสี่ไฟล์ยาว ๆ ในคำสั่งเดียวโดยไม่มี re-seed คั่น
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * วิธีเตรียมค่า (fail-loud ทุกตัว — A-5 · ศูนย์ค่าจริงใน repo)
 * ═══════════════════════════════════════════════════════════════════════════
 * - `UAT_DEMO_PASSWORD` (env ของเครื่องสาธิต หรือ .env ที่ repo root) — รหัสผ่านเดียว
 *   ของบัญชี seed ทุกตัว (≥12 ตาม GOTRUE_PASSWORD_MIN_LENGTH)
 * - `RUN_ID` (env) — รหนึ่งค่าต่อรอบ UAT (แบบแผน UAT-EXECUTION-PLAN §5) เช่น
 *   `uat-2026-10-14-1` — หลักฐาน/รันล็อก/MFA secret ทั้งหมดอยู่ใต้
 *   `.omc/artifacts/uat/${RUN_ID}/` (gitignored อยู่แล้ว)
 * - `E2E_BASE_URL` (optional · default `http://localhost:3001` — prod-build ตาม
 *   UAT-EXECUTION-PLAN · ต่างจาก default :3000 ของ e2e/helpers/env.ts — ธง stale S-3)
 * - `E2E_MAILPIT_URL` (optional · default `http://localhost:8025`)
 * - MFA secret ของ `uat.staff.exam@ltc.local` ที่
 *   `.omc/artifacts/uat/${RUN_ID}/mfa/uat.staff.exam@ltc.local.md` **หรือ** ชื่อย่อ
 *   `mfa/uat.staff.exam.md` (สเปกใช้สองรูป — §1.4 "mfa/<บัญชี>.md" กับ §0.3/§3.2
 *   "mfa/uat.staff.exam.md" · helper ลองทั้งสองชื่อ) — ถ้ายังไม่มี: ลงทะเบียนผ่าน
 *   `/my/security/enroll` ก่อน (ขั้นเตรียม ไม่ใช่ขั้นตรวจ ตาม Background ของ 09B)
 *   แล้วบันทึก secret ลงไฟล์ดังกล่าว — ห้าม commit
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ความต่างจาก helper ของบ้าน (mirror ตาม A-6 — precedent: d9-helpers.ts เคยมิเรอร์
 * id/SQL จาก helpers-d8 เพราะข้อจำกัด loader · จดไว้ให้ reviewer เห็นทุกจุด)
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. `totpNow` มิเรอร์ verbatim จาก `e2e/d9-helpers.ts:370` — ไม่ import จากต้นทาง
 *    เพราะ d9-helpers ลาก `@supabase/ssr` + `e2e/helpers/db` (docker exec) +
 *    `helpers/rest`/`helpers/users` (TEST_PASSWORD) ติดมาด้วย ทั้งที่ UAT-09 ไม่ใช้เลย
 *    (เหตุผลเดียวกับที่ d9-helpers มิเรอร์ helpers-d8 ไว้ของตัวเอง)
 * 2. `loginViaFormUat` มิเรอร์ `e2e/helpers/session.ts loginViaForm` แต่ **parameterize
 *    รหัสผ่าน** — ตัวบ้านผูก `TEST_PASSWORD` (ของ e2e/helpers/env.ts) แบบ hard-bind
 *    ขณะที่ UAT-09 ต้องใช้ `UAT_DEMO_PASSWORD` และรหัสที่เปลี่ยนระหว่างสคริปต์
 *    (รูปตาม `loginWithPassword` ภายใน e2e-17:47-57)
 * 3. default origin เป็น `:3001` (prod-build) ไม่ใช่ `:3000` ของ e2e/helpers/env.ts
 * 4. env loader มิเรอร์แบบ minimal จาก e2e/helpers/env.ts (โหลด .env เองฝั่ง worker
 *    ไม่ทับค่าที่ shell ตั้งแล้ว) — เพิ่ม UAT_DEMO_PASSWORD/RUN_ID ตาม A-5
 * 5. Mailpit poll มิเรอร์ `e2e/e2e-19-password-reset.spec.ts:51-70` (recoveryMailId +
 *    verifyLinkOf) ยกมาเป็น helper กลางเพราะ 09A ใช้เอง + ต้องนับเมลถึงอีเมล
 *    ที่ไม่มีในระบบ (A-3) — token ห้ามหลุดลง log/error ทุกชนิด (MAJOR-1)
 * 6. หลักฐานขั้น terminal (re-seed ขั้น 12) เป็นไฟล์ .txt ที่ **redact รหัสผ่านแล้ว**
 *    แทน "ภาพ terminal" — automation ไร้หน้าจอ terminal ให้ถ่าย และ seed พิมพ์รหัส
 *    ท้ายสคริปต์ (scripts/uat-seed.sh หัวไฟล์) จึงต้อง redact ก่อนเขียนลงแฟ้มหลักฐาน
 * 7. "จดรหัสใหม่ 09A/09B ลง run-log.md" ของสเปก ปรับเป็น "จดสูตรอนุพันธ์" แทนค่าจริง
 *    (รหัสใหม่ = UAT_DEMO_PASSWORD + คำต่อท้าย — ดึงค่าได้จาก env เสมอ) — ปฏิบัติตาม
 *    MAJOR-1 ของบ้าน (ห้าม log รหัสผ่านลง output ทุกชนิด) โดยยังกู้คืนได้ตามเจตนา §0.5
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, type Page } from "@playwright/test";

// ─── env loader ฝั่ง worker (มิเรอร์ e2e/helpers/env.ts — ดูความต่างข้อ 4) ───

/** root ของ repo — execute lane รันจาก repo root (แบบเดียวกับ playwright.config.ts) */
const REPO_ROOT = process.cwd();

/** โหลด .env แบบ minimal — ไม่ทับค่าที่ shell ตั้งมาแล้ว (แบบ e2e/helpers/env.ts) */
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

loadDotEnv(join(REPO_ROOT, ".env"));

// ─── ค่า env ของ UAT-09 (fail-loud ทุกตัว — ห้ามพิมพ์ค่า secret ใน error) ───

/** บัญชี seed ชุดเดิมเท่านั้น (A-6b — ห้ามเพิ่มบัญชีใหม่) */
export const UAT_ACCOUNTS = {
  citizen: "uat.citizen@ltc.local",
  staffExam: "uat.staff.exam@ltc.local",
} as const;

/** id สคริปต์ 09 ที่มีหลักฐานของตัวเอง (${RUN_ID}/uat-09<x>/) */
export type Uat09ScriptId = "09a" | "09b" | "09c" | "09d";

export interface Uat09Env {
  readonly runId: string;
  readonly demoPassword: string;
  readonly appOrigin: string;
  readonly mailpitOrigin: string;
}

let envCache: Uat09Env | undefined;

/**
 * อ่าน env ของรอบ UAT-09 — ครั้งแรกอ่านจริง + fail-loud พร้อมวิธีเตรียม ครั้งถัดไปใช้ค่าค้าง
 * (เรียกจาก beforeAll/ต้น test ของทุก spec — error ชี้ขั้นเตรียมชัดเจน ไม่ชี้ค่า secret)
 */
export function uat09Env(): Uat09Env {
  if (envCache !== undefined) {
    return envCache;
  }
  const runId = process.env["RUN_ID"] ?? "";
  if (runId === "") {
    throw new Error(
      "UAT-09: ไม่พบ env RUN_ID — ตั้งค่ารหนึ่งค่าต่อรอบ UAT ก่อนรัน (แบบแผน " +
        "UAT-EXECUTION-PLAN §5) เช่น RUN_ID=uat-2026-10-14-1 · หลักฐาน/รันล็อก/MFA " +
        "secret ทั้งหมดเก็บใต้ .omc/artifacts/uat/${RUN_ID}/ (gitignored)",
    );
  }
  if (/^[A-Za-z0-9._-]+$/.test(runId) === false) {
    throw new Error("UAT-09: RUN_ID ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - เท่านั้น (กัน path traversal)");
  }
  const demoPassword = process.env["UAT_DEMO_PASSWORD"] ?? "";
  if (demoPassword === "") {
    throw new Error(
      "UAT-09: ไม่พบ env UAT_DEMO_PASSWORD — ตั้งค่ารหัสผ่านชุด seed ของเครื่องสาธิต " +
        "(จาก .env หรือ export UAT_DEMO_PASSWORD=... ก่อนรัน · ตั้งค่าพร้อม seed ด้วย " +
        "UAT_DEMO_PASSWORD='...' bash scripts/uat-seed.sh) — ห้าม hardcode ลง repo",
    );
  }
  if (demoPassword.length < 12) {
    throw new Error(
      "UAT-09: UAT_DEMO_PASSWORD สั้นกว่า 12 (GOTRUE_PASSWORD_MIN_LENGTH=12) — ตรวจค่า env",
    );
  }
  envCache = {
    runId,
    demoPassword,
    appOrigin: process.env["E2E_BASE_URL"] ?? "http://localhost:3001",
    mailpitOrigin: process.env["E2E_MAILPIT_URL"] ?? "http://localhost:8025",
  };
  return envCache;
}

/**
 * รหัสผ่านใหม่ของสคริปต์ 09A/09B — อนุพันธ์ของ UAT_DEMO_PASSWORD (base + คำต่อท้าย):
 * ยาวเกิน 12 เสมอ · ต่างจากรหัสปัจจุบัน (มีคำต่อท้าย) · ต่างกันระหว่าง 09A/09B ·
 * กู้คืนได้จาก env เสมอแม้ crash กลางทาง — ค่าจริงไม่ถูกพิมพ์ลง output/log ใด ๆ (MAJOR-1)
 */
export function uatNewPassword(script: "09a" | "09b"): string {
  const env = uat09Env();
  return `${env.demoPassword}-UAT-${script.toUpperCase()}`;
}

// ─── หลักฐาน + รันล็อก (.omc/artifacts/uat/${RUN_ID}/... — gitignored) ───

/** ไดเรกทอรีรากของรอบ */
export function uatRunDir(): string {
  const env = uat09Env();
  return join(REPO_ROOT, ".omc", "artifacts", "uat", env.runId);
}

/** ไดเรกทอรีหลักฐานของสคริปต์ (${RUN_ID}/uat-09<x>/) — สร้างถ้ายังไม่มี */
export function scriptEvidenceDir(script: Uat09ScriptId): string {
  const dir = join(uatRunDir(), `uat-${script}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * จับภาพหลักฐานขั้น NN → `${RUN_ID}/uat-09<x>/step-NN.png` (fullPage — เห็นครบทั้งฟอร์มยาว)
 * เรียก **ก่อน** ไปขั้นถัดไปเสมอ (กติกา verdict ของ UAT-09-SPECS §0)
 */
export async function stepShot(page: Page, script: Uat09ScriptId, step: string): Promise<string> {
  const file = join(scriptEvidenceDir(script), `step-${step}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** บันทึกหลักฐานขั้นที่เป็นข้อความ (ผล JSON/terminal ที่ redact แล้ว) → step-NN.txt */
export function stepNote(script: Uat09ScriptId, step: string, safeText: string): string {
  const file = join(scriptEvidenceDir(script), `step-${step}.txt`);
  writeFileSync(file, safeText, "utf8");
  return file;
}

/**
 * ต่อแถวรันล็อกรวมของรอบ (${RUN_ID}/run-log.md — ตามกติกา UAT-EXECUTION-PLAN §5)
 * ผู้เรียกห้ามส่งค่ารหัสผ่าน/token/TOTP secret เข้ามา (MAJOR-1)
 */
export function runLog(script: Uat09ScriptId, message: string): void {
  const file = join(uatRunDir(), "run-log.md");
  const stamp = new Date().toISOString();
  appendFileSync(file, `- ${stamp} [uat-${script}] ${message}\n`, "utf8");
}

// ─── MFA secret + TOTP (RFC 6238 · HMAC-SHA1 · 6 หลัก · ช่วง 30 วิ) ───

/**
 * TOTP 6 หลักจาก secret base32 ของ GoTrue — มิเรอร์ verbatim จาก
 * e2e/d9-helpers.ts:370 (totpNow) · เหตุผลที่มิเรอร์ดูหัวไฟล์ "ความต่าง" ข้อ 1
 */
export function totpNow(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretBase32.replace(/=+$/u, "").toUpperCase()) {
    const index = alphabet.indexOf(ch);
    if (index >= 0) {
      bits += index.toString(2).padStart(5, "0");
    }
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i += 1) {
    key.writeUInt8(Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2), i);
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(
    Number.isSafeInteger(counter) && counter <= 0xffffffff ? counter : counter % 2 ** 32,
    4,
  );
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 2 ** 24 +
    (digest[offset + 1] ?? 0) * 2 ** 16 +
    (digest[offset + 2] ?? 0) * 2 ** 8 +
    (digest[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** กรอบเวลา 30 วิที่ใช้ไปแล้วต่อ secret (กัน GoTrue ปฏิเสธรหัสซ้ำในกรอบเดียวกัน) */
const totpUsedWindow = new Map<string, number>();

/**
 * TOTP รหัสล่าสุดที่ "ยังไม่เคยใช้" ในกรอบเวลาปัจจุบัน — ถ้ารหัสของกรอบนี้ถูกใช้ไปแล้ว
 * (เช่น ล็อกอิน staff:exam สอง context ใกล้กันใน 09B) จะรอเข้ากรอบถัดไปแล้วคำนวณใหม่
 * (GoTrue ปฏิเสธการใช้รหัส TOTP เดิมซ้ำในกรอบเดียวกัน — ป้องกันไว้ล่วงหน้า)
 */
export async function totpNowFresh(secretBase32: string): Promise<string> {
  let counter = Math.floor(Date.now() / 1000 / 30);
  if (totpUsedWindow.get(secretBase32) === counter) {
    const waitMs = (counter + 1) * 30_000 - Date.now() + 500;
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 200)));
    counter = Math.floor(Date.now() / 1000 / 30);
  }
  totpUsedWindow.set(secretBase32, counter);
  return totpNow(secretBase32);
}

/**
 * อ่าน MFA TOTP secret ของบัญชีเจ้าหน้าที่จากไฟล์ secret ใต้ ${RUN_ID}/mfa/ —
 * ลองสองชื่อตามที่สเปกใช้ทั้งคู่: `${อีเมลเต็ม}.md` และ `${ส่วนหน้าอีเมล}.md`
 * (§1.4 "mfa/<บัญชี>.md" กับ §0.3/§3.2 "mfa/uat.staff.exam.md") · แล้วดึงโทเค็น
 * base32 (≥16 อักษร A-Z2-7) ตัวแรกจากไฟล์ · fail-loud พร้อมขั้นเตรียม (A-5):
 * ถ้ายังไม่มีไฟล์ = ยังไม่ได้ลงทะเบียร MFA ของรอบนี้ — ลงทะเบียรผ่าน
 * `/my/security/enroll` แล้วบันทึก secret ลงไฟล์ (ขั้นเตรียม ไม่ใช่ขั้นตรวจ)
 */
export function mfaSecretOf(email: string): string {
  const runDir = uatRunDir();
  const localPart = email.split("@")[0] ?? email;
  const candidates = [join(runDir, "mfa", `${email}.md`), join(runDir, "mfa", `${localPart}.md`)];
  const found = candidates.find((path) => {
    try {
      readFileSync(path, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (found === undefined) {
    throw new Error(
      `UAT-09: ไม่พบไฟล์ MFA secret ของ ${email} — ต้องมีหนึ่งใน:\n` +
        candidates.map((path) => `  - ${path}`).join("\n") +
        "\nขั้นเตรียม: ล็อกอินบัญชีนี้ → /my/security/enroll → ลงทะเบียร TOTP → " +
        "บันทึก secret (ข้อความ base32) ลงไฟล์ข้างต้น (ห้าม commit — .omc/ gitignored อยู่แล้ว)",
    );
  }
  const text = readFileSync(found, "utf8");
  const match = /[A-Z2-7]{16,64}/i.exec(text.replace(/`/gu, ""));
  if (match === null) {
    throw new Error(
      `UAT-09: ไฟล์ MFA secret (${found}) ไม่มีโทเค็น base32 (A-Z2-7 ยาว 16-64) — ` +
        "ใส่ secret จาก /my/security/enroll ลงไฟล์แล้วลองใหม่",
    );
  }
  return match[0];
}

// ─── login ผ่านฟอร์มจริง (parameterize รหัส — มิเรอร์ session.ts loginViaForm) ───

/**
 * เข้าสู่ระบบผ่านฟอร์ม /login จริงด้วยรหัสผ่านที่ส่งเข้ามา (ความต่างข้อ 2 หัวไฟล์) —
 * บัญชีบังคับ MFA (staff:*) เดินสองขั้น: ส่ง { totpSecret } ให้ helper กรอก #code
 * แล้วกด "ยืนยันตัวตน" · ถูกขอ MFA แต่ไม่ส่ง secret = throw ทันที (fail-loud)
 */
export async function loginViaFormUat(
  page: Page,
  email: string,
  password: string,
  options?: { readonly totpSecret?: string | undefined },
): Promise<void> {
  const env = uat09Env();
  await page.goto(`${env.appOrigin}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  // ออกจาก /login เลย (ขั้นเดียว) หรือจอดหน้ายืนยันขั้นสอง — ทั้งสองถือว่าขั้นหนึ่งผ่าน
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/login") || url.pathname === "/login/verify",
    { timeout: 20_000 },
  );
  if (new URL(page.url()).pathname !== "/login/verify") {
    return;
  }
  const secret = options?.totpSecret;
  if (secret === undefined) {
    throw new Error(
      `loginViaFormUat: ${email} ถูกขอรหัส MFA ขั้นที่สอง — ส่ง { totpSecret } ของบัญชีนี้ให้ helper`,
    );
  }
  await page.fill("#code", await totpNowFresh(secret));
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.getByRole("button", { name: "ยืนยันตัวตน" }).click(),
  ]);
}

/**
 * พิสูจน์ว่ารหัสผ่านถูกปฏิเสธจริงผ่านฟอร์ม /login — เห็นการ์ด #login-alert
 * "อีเมลหรือรหัสผ่านไม่ถูกต้อง" ของหน้าเข้าสู่ระบบ และยังค้าง /login (09A ขั้น 10 · 09B ขั้น 06)
 */
export async function loginExpectRejected(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const env = uat09Env();
  await page.goto(`${env.appOrigin}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  await expect(page.locator("#login-alert")).toContainText("อีเมลหรือรหัสผ่านไม่ถูกต้อง", {
    timeout: 20_000,
  });
  await expect(page).toHaveURL(/\/login/);
}

/**
 * คามร์ด X-1 ของสเปก (§6): เส้นทางเปลี่ยนรหัสผ่าน **ไม่คาดหวัง** need-mfa —
 * re-auth ของ changePasswordAction คือช่อง "รหัสผ่านปัจจุบัน" เท่านั้น · เห็นการ์ด
 * นี้ตอนกด "เปลี่ยนรหัสผ่าน" = fail ขั้นนั้น (จด "สิ่งที่เห็นจริง")
 */
export async function expectNoNeedMfaCard(page: Page): Promise<void> {
  await expect(
    page.getByText("การกระทำนี้ต้องยืนยันตัวตนสองชั้นภายใน 15 นาทีล่าสุด"),
  ).toHaveCount(0);
}

// ─── Mailpit (มิเรอร์ e2e-19:51-70 — poll 1 วิ · token ห้ามหลุดลง log) ───

interface MailpitSummary {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
}

interface MailpitFull {
  readonly Text?: string;
}

async function mailpitList(): Promise<MailpitSummary[]> {
  const env = uat09Env();
  const res = await fetch(`${env.mailpitOrigin}/api/v1/messages?limit=50`);
  if (res.ok === false) {
    throw new Error(
      `UAT-09: Mailpit list ล้ม (HTTP ${res.status}) — ตรวจ stack Mailpit ที่ ${env.mailpitOrigin} (E2E_MAILPIT_URL)`,
    );
  }
  const body = (await res.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

async function mailpitMessage(id: string): Promise<MailpitFull> {
  const env = uat09Env();
  const res = await fetch(`${env.mailpitOrigin}/api/v1/message/${id}`);
  if (res.ok === false) {
    throw new Error(`UAT-09: Mailpit อ่านข้อความ ${id} ล้ม (HTTP ${res.status})`);
  }
  return (await res.json()) as MailpitFull;
}

/** จำนวนเมลในกล่อง (ล่าสุด 50 ฉบับ) ที่ถึง address — ใช้พิสูจน์ "ไม่มีเมลฉบับใหม่" (A-3) */
export async function countMailsTo(address: string): Promise<number> {
  const messages = await mailpitList();
  return messages.filter((m) => m.To.some((t) => t.Address === address)).length;
}

/** ลิงก์ verify (type=recovery) จากเนื้อเมล — token อยู่ใน URL ห้าม print/log (MAJOR-1) */
function verifyLinkOf(mailText: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/u.exec(mailText);
  return match === null ? null : match[0] ?? null;
}

export interface RecoveryMail {
  readonly id: string;
  /** ลิงก์ verify พร้อม token — ห้ามพิมพ์ลง log/error ทุกชนิด */
  readonly link: string;
}

/**
 * เมลตั้งรหัสผ่านใหม่ล่าสุดถึง address (poll 1 วิ — มิเรอร์ recoveryMailId ของ e2e-19)
 * คืน null เมื่อหมดเวลา · ผู้เรียก assert ต่อเองพร้อม fail-loud ที่อ่านง่าย
 */
export async function latestRecoveryMail(
  address: string,
  timeoutSec: number,
): Promise<RecoveryMail | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const messages = await mailpitList();
    for (const candidate of messages) {
      if (candidate.To.some((t) => t.Address === address) === false) {
        continue;
      }
      const full = await mailpitMessage(candidate.ID);
      if ((full.Text ?? "").includes("type=recovery")) {
        const link = verifyLinkOf(full.Text ?? "");
        if (link !== null) {
          return { id: candidate.ID, link };
        }
      }
    }
    if (Date.now() > deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ─── re-seed (ขั้น 12 ของ 09A/09B — คืนฐานตามกฎ §0 ข้อ 2/3) ───

/**
 * รัน `bash scripts/uat-seed.sh` (idempotent · ห้ามแก้สคริปต์) — spawn array-form
 * ไม่ผ่าน shell (แบบแผน portability ของบ้าน) · เขียนหลักฐาน step-12.txt ที่
 * **redact รหัสผ่าน** แล้ว (seed พิมพ์รหัสท้ายสคริปต์ — ความต่างข้อ 6 หัวไฟล์) ·
 * rc≠0 = throw fail-loud (ผลลัพธ์ redact แล้วเท่านั้น)
 */
export async function reSeed(script: Uat09ScriptId, step = "12"): Promise<void> {
  const env = uat09Env();
  const child = spawn("bash", ["scripts/uat-seed.sh"], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const rc = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("UAT-09: re-seed ล้ม — เกิน 180 วิ (ฆ่าโปรเซสแล้ว · ดู run-log)"));
    }, 180_000);
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`UAT-09: spawn bash scripts/uat-seed.sh ไม่ได้ (${err.message})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  // redact รหัสทุกรูปแบบที่อาจหลุดจาก output ของ seed (ค่า env + อนุพันธ์ 09A/09B)
  const redacted = [env.demoPassword, uatNewPassword("09a"), uatNewPassword("09b")]
    .reduce((text, secret) => text.split(secret).join("***"), output)
    .slice(-4000);
  if (rc !== 0) {
    runLog(script, `re-seed ล้ม rc=${rc} — ผลลัพธ์ (redact แล้ว) tail:\n${redacted}`);
    throw new Error(`UAT-09: re-seed ล้ม rc=${rc} — จดลง run-log แล้ว (ค่าถูก redact)`);
  }
  stepNote(script, step, `${new Date().toISOString()} — bash scripts/uat-seed.sh rc=0\n${redacted}`);
  runLog(script, `re-seed สำเร็จ (rc=0 · idempotent) — หลักฐาน step-${step}.txt (redact แล้ว)`);
}

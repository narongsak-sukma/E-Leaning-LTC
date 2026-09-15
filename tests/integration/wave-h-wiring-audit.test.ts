/**
 * wave-h-wiring-audit.test.ts — ตรวจ wiring ของ transport กลาง [#94]
 * (gate waveh-r1 M1/M2 fix: "ให้ wiring audit ตรวจ callers จริง พร้อมหลักฐานถอด
 * wiring แล้วเทสล้ม" — รันถาวรใน battery integration stage ทุกรอบ)
 *
 * ชั้นตรวจ:
 *  W1 ห้าม import createClient จาก @supabase/supabase-js ตรงใน tests/** + e2e/**
 *     (ทางเดียวที่อนุญาต = tests/integration/test-io.ts — จุด choke-point)
 *  W2 helpers.restCall: การเขียน (ไม่ใช่ GET/HEAD) ต้องผ่าน httpWrite (dynamic
 *     import "./test-io") — GET/HEAD อ่านคง fetch ตรงได้
 *  W3 helpers-d8.storageCall: การเขียน (POST/DELETE) ต้องผ่าน httpWrite + rawBody
 *  W4 e2e/helpers/d9-cleanup: deleteD9User/cleanupD9World ต้องผ่าน runUserCleanupVia
 *     (builder กลาง) + lifecycle rows — ห้าม SQL มือตาม FK-chain ยาว ๆ อีก
 *     (gate waveh-r2 M2: ตรวจรายฟังก์ชัน — wiring ต้องอยู่ใน body ของตัวเอง)
 *  W5 (สด — มี DB เท่านั้น) caller จริงเขียน ledger: restCall POST จริง 1 dispatch
 *     แล้ว invocation ล่าสุดของ opKey นั้นต้อง settled (พิสูจน์ว่า path รันจริง
 *     ไม่ใช่แค่ source สวย)
 *
 * พิสูจน์สองทิศ ([[regression-test-two-way-proof]]): detector เป็น pure function
 *  — ทิศ 1 โค้ดจริงผ่าน · ทิศ 2 ใส่ต้นฉบับละเมิด (synthetic) แล้วต้องถูกจับ
 *  (ถอด wiring = กลับไป createClient/fetch ตรง/SQL มือ → เทสล้มทันที)
 *
 * หมายเหตุขอบเขต (ตอบ gate r1): e2e/helpers/rest.ts (GoTrue auth flows) เป็น
 * read/login-flow ของ harness ที่โหลด test-io ไม่ได้ใต้ Playwright CJS
 * (import.meta.url ของ tests/integration/helpers.ts — ธง d9-helpers) — lifecycle
 * ของ e2e พิสูจน์ผ่าน d9-cleanup + audit-e2e แทน ไม่ใช่ช่องทาง transport นี้
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DB_URL = process.env["TEST_DATABASE_URL"];

// ─── detector แบบ pure function (ฉีดแหล่งไฟล์ได้ — ใช้พิสูจน์สองทิศ) ───────────

/** ไฟล์ .ts ทั้งหมดใต้ root ที่กำหนด (recursive) */
export function listTsFiles(root: string, skipDirs: readonly string[] = []): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".") || skipDirs.includes(name)) continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listTsFiles(full, skipDirs));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** W1: ไฟล์ที่ import createClient จาก @supabase/supabase-js ตรง (นอก allowlist) */
export function findDirectCreateClientImports(
  files: ReadonlyArray<{ path: string; source: string }>,
  allowlist: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const f of files) {
    const normalized = f.path.replace(/\\/g, "/");
    const allowed = allowlist.some((a) => normalized.endsWith(a));
    if (allowed) continue;
    if (/from\s+["']@supabase\/supabase-js["']/.test(f.source)) {
      violations.push(f.path);
    }
  }
  return violations;
}

/** W2: restCall ต้องมี branch จับ method ไม่ใช่ GET/HEAD แล้วส่ง httpWrite */
export function restCallWiringOk(source: string): boolean {
  const hasWriteBranch = /m\s*!==\s*"GET"\s*&&\s*m\s*!==\s*"HEAD"/.test(source);
  const usesTransport = /await\s+import\(["']\.\/test-io["']\)/.test(source)
    && /httpWrite\(/.test(source);
  return hasWriteBranch && usesTransport;
}

/** W3: storageCall ต้องส่งผ่าน httpWrite พร้อม rawBody (binary mp4 ไม่ JSON) */
export function storageCallWiringOk(source: string): boolean {
  const hasTransport = /await\s+import\(["']\.\/test-io["']\)/.test(source)
    && /httpWrite\(/.test(source)
    && /rawBody:\s*true/.test(source);
  const writeRouted = /method\s*!==\s*"GET"/.test(source);
  return hasTransport && writeRouted;
}

/** W4: d9-cleanup ต้องใช้ builder + lifecycle — และห้าม SQL มือ delete ยาว ๆ */
export function d9CleanupWiringOk(source: string): boolean {
  const usesBuilder = /runUserCleanupVia/.test(source)
    && /cleanup-builder/.test(source);
  const hasLifecycle = /lifecycleBegin/.test(source) && /lifecycleSettle/.test(source);
  const noManualFkChain = !/delete from public\.certificates\s+where user_id\s*=/.test(source)
    && !/delete from public\.credit_ledger_entries\s+where user_id\s*=/.test(source);
  return usesBuilder && hasLifecycle && noManualFkChain;
}

/** แยก source เป็น chunk ระดับ top-level export (จาก ^export ถึงก่อน ^export ถัดไป)
 * — gate waveh-r2 M2: W4 เดิมค้นทั้งไฟล์ เลยจับไม่ได้ว่า "ฟังก์ชันหนึ่งถูกแกะ body
 * ว่างแต่อีกฟังก์ชันในไฟล์เดียวกันยัง wired" (ตรวจจริง: แทน deleteD9User เป็นฟังก์ชัน
 * ว่างแล้ว W4 เดิมยัง true) — การตรวจต้องรายฟังก์ชัน */
export function splitTopLevelExports(source: string): Array<{ name: string; source: string }> {
  const parts = source.split(/^export\s+/m);
  const out: Array<{ name: string; source: string }> = [];
  for (const part of parts.slice(1)) {
    const m = part.match(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (m !== null && m[1] !== undefined) {
      out.push({ name: m[1], source: `export ${part}` });
    }
  }
  return out;
}

/** W4 (per-function): chunk ของ helper user-cleanup แต่ละตัวต้องมี builder + lifecycle
 * "ของตัวเอง" (dynamic import cleanup-builder + runUserCleanupVia + lifecycleBegin/Settle
 * อยู่ใน body ของฟังก์ชันนั้น) และไม่มี SQL มือ FK-chain */
export function cleanupHelperChunkOk(chunkSource: string): boolean {
  const usesBuilder = /runUserCleanupVia/.test(chunkSource)
    && /cleanup-builder/.test(chunkSource);
  const hasLifecycle = /lifecycleBegin/.test(chunkSource) && /lifecycleSettle/.test(chunkSource);
  const noManualFkChain = !/delete from public\.certificates\s+where user_id\s*=/.test(chunkSource)
    && !/delete from public\.credit_ledger_entries\s+where user_id\s*=/.test(chunkSource);
  return usesBuilder && hasLifecycle && noManualFkChain;
}

/** อ่าน source จริงของไฟล์ใน repo (แปลง path สัมพัทธ์จาก __dirname ของไฟล์นี้) */
function readRepoFile(relative: string): string {
  // tests/integration/… → ขึ้น 2 ชั้น = repo root
  const root = new URL("../..", import.meta.url);
  return readFileSync(new URL(relative, root), "utf8");
}

function collectSources(): Array<{ path: string; source: string }> {
  const root = new URL("../..", import.meta.url);
  const dirs = ["tests", "e2e"];
  const files: Array<{ path: string; source: string }> = [];
  for (const d of dirs) {
    for (const f of listTsFiles(new URL(d, root).pathname, ["node_modules", "__pycache__"])) {
      files.push({ path: f, source: readFileSync(f, "utf8") });
    }
  }
  return files;
}

describe.skipIf(!DB_URL)("wave-h wiring-audit — transport กลางถูกเชื่อมครบทุก caller [#94]", () => {
  it("W1 ไม่มี createClient จาก @supabase/supabase-js ตรงนอก test-io.ts (choke-point เดียว)", () => {
    const violations = findDirectCreateClientImports(collectSources(), [
      // choke-point เดียว + ตัวไฟล์ audit นี้เอง (synthetic fixture ของทิศ-2 มี
      // ข้อความ import อยู่ใน template literal — ไม่ใช่ import จริง)
      "tests/integration/test-io.ts",
      "tests/integration/wave-h-wiring-audit.test.ts",
    ]);
    expect(violations, `พบ direct createClient: ${violations.join(", ")}`).toEqual([]);
  });

  it("W2 helpers.restCall ส่งการเขียนผ่าน httpWrite (GET/HEAD อ่านตรงได้)", () => {
    expect(restCallWiringOk(readRepoFile("tests/integration/helpers.ts"))).toBe(true);
  });

  it("W3 helpers-d8.storageCall ส่งการเขียนผ่าน httpWrite + rawBody", () => {
    expect(storageCallWiringOk(readRepoFile("tests/integration/helpers-d8.ts"))).toBe(true);
  });

  it("W4 e2e d9-cleanup ใช้ builder + lifecycle rows รายฟังก์ชัน (ห้าม SQL มือ FK-chain)", () => {
    const source = readRepoFile("e2e/helpers/d9-cleanup.ts");
    expect(d9CleanupWiringOk(source)).toBe(true); // ระดับไฟล์คงไว้ (สัญญาเดิม)
    // gate waveh-r2 M2: ตรวจรายฟังก์ชัน — ทุกตัวที่ทำ user-cleanup ต้อง wired "ของตัวเอง"
    // ไม่ใช่ยืม wiring ของเพื่อนในไฟล์เดียวกัน (cleanupFastExamARows ออกจากขอบเขต:
    // เป็น suite-owned fixed-id rows ไม่ใช่ FK-chain ของ user จึงไม่ต้องผ่าน builder)
    const chunks = splitTopLevelExports(source);
    for (const helper of ["deleteD9User", "cleanupD9World"]) {
      const chunk = chunks.find((c) => c.name === helper);
      expect(chunk, `ไม่พบ export function ${helper} ใน e2e/helpers/d9-cleanup.ts`).toBeDefined();
      expect(
        cleanupHelperChunkOk(chunk?.source ?? ""),
        `${helper} ขาด wiring ของตัวเอง (builder+lifecycle ต้องอยู่ใน body ฟังก์ชันนี้)`,
      ).toBe(true);
    }
  });

  it("W5 สด: restCall POST จริง 1 dispatch → ledger มี invocation settled ของ opKey นั้น", async () => {
    const { restCall, psqlScalar } = await import("./helpers");
    // เขียนจริงผ่าน caller จริง (GoTrue password grant ด้วยข้อมูลไม่มีจริง → 400
    // = terminal ปกติ ไม่พังโลก ไม่แตะข้อมูลใคร)
    const r = await restCall("POST", "/auth/v1/token?grant_type=password", {}, {
      email: "wiring-audit-no-user@ltc.test",
      password: "WiringAudit#2026",
    });
    expect(r.status).toBe(400);
    // ledger: invocation ล่าสุดของ opKey ต้อง settled (class confirmed-400)
    const status = await psqlScalar(`
      select payload ->> 'status' from test_infra.lifecycle_ledger
       where kind = 'invocation' and op_key = 'kong:POST:/auth/v1/token'
       order by ts desc, id desc limit 1;`);
    expect(status).toBe("settled");
    const cls = await psqlScalar(`
      select payload ->> 'class' from test_infra.lifecycle_ledger
       where kind = 'invocation' and op_key = 'kong:POST:/auth/v1/token'
       order by ts desc, id desc limit 1;`);
    expect(cls).toBe("confirmed-400");
  });

  // ─── พิสูจน์สองทิศ: ถอด wiring (synthetic) → detector ต้องจับได้ทุกตัว ──────

  it("ทิศ-2 W1: source ที่ import createClient ตรงต้องถูกจับ", () => {
    const bad = [
      { path: "/repo/tests/integration/some-suite.test.ts", source: `import { createClient } from "@supabase/supabase-js";` },
      // single-quote + type-import variant ต้องถูกจับเหมือนกัน
      { path: "/repo/e2e/helpers/x.ts", source: `import type SupabaseClient from '@supabase/supabase-js';` },
      // การ "ใช้" createClient โดยไม่ import (จากโมดูลอื่น) ไม่ใช่ direct import —
      // ไม่ต้องจับ (detector ตรวจ import statement เท่านั้น)
      { path: "/repo/e2e/helpers/uses-only.ts", source: `const c = createClient(u, k);` },
    ];
    expect(findDirectCreateClientImports(bad, ["tests/integration/test-io.ts"])).toEqual(
      bad.filter((b) => b.path !== "/repo/e2e/helpers/uses-only.ts").map((b) => b.path),
    );
    // ไฟล์ใน allowlist ผ่านได้
    expect(
      findDirectCreateClientImports(
        [{ path: "/repo/tests/integration/test-io.ts", source: `import { createClient } from "@supabase/supabase-js";` }],
        ["tests/integration/test-io.ts"],
      ),
    ).toEqual([]);
  });

  it("ทิศ-2 W2: restCall แบบเก่า (fetch ตรงทุก method) ต้องไม่ผ่าน detector", () => {
    const oldStyle = `const init: RequestInit = { method, headers };
    if (body !== undefined) { init.body = JSON.stringify(body); }
    const response = await fetch(\`\${REST_URL}\${path}\`, init);`;
    expect(restCallWiringOk(oldStyle)).toBe(false);
    expect(restCallWiringOk(readRepoFile("tests/integration/helpers.ts"))).toBe(true);
  });

  it("ทิศ-2 W3: storageCall แบบเก่า (fetch ตรง ไม่มี rawBody ผ่าน transport) ต้องไม่ผ่าน", () => {
    const oldStyle = `const init: RequestInit = { method, headers };
    if (body !== undefined) { init.body = new Uint8Array(body); }
    const response = await fetch(\`\${REST_URL}\${path}\`, init);`;
    expect(storageCallWiringOk(oldStyle)).toBe(false);
  });

  it("ทิศ-2 W4: deleteD9User แบบเก่า (SQL มือหลาย TX) ต้องไม่ผ่าน detector", () => {
    const oldStyle = `export async function deleteD9User(userId: string): Promise<void> {
      await psql(\`delete from public.certificates where user_id = '\${userId}';
        delete from public.credit_ledger_entries where user_id = '\${userId}';
        delete from public.profiles where id = '\${userId}';\`);
    }`;
    expect(d9CleanupWiringOk(oldStyle)).toBe(false);
    // แบบใหม่ (builder + lifecycle) ผ่าน — อ่านจากไฟล์จริงใน W4 แล้ว
    expect(d9CleanupWiringOk(readRepoFile("e2e/helpers/d9-cleanup.ts"))).toBe(true);
  });

  it("ทิศ-2 W4 per-function (gate waveh-r2 M2): แทน body ฟังก์ชันหนึ่งเป็นว่าง ต้องถูกจับ แม้อีกฟังก์ชันในไฟล์ยัง wired (ช่องโหว่ detector ระดับไฟล์ที่ gate เจอจริง)", () => {
    // จำลองการกลายพันธุ์ที่ gate ทำจริงตอนตรวจ: แทน body ของ deleteD9User เป็นฟังก์ชันว่าง
    // แต่ cleanupD9World ในไฟล์เดียวกันยัง wired ครบ — W4 ระดับไฟล์ยัง true (หลุดรอด)
    // ส่วน per-function ต้องจับได้ตรงตัวว่าตัวไหนถูกแกะ
    const wiredBody = `  const { runUserCleanupVia } = await import("../../tests/integration/cleanup-builder");
  const { lifecycleBegin, lifecycleSettle } = await import("./lifecycle");
  const op = await lifecycleBegin("e2e:helper-wired");
  try {
    await runUserCleanupVia(psql, ids);
  } catch (err) {
    await lifecycleSettle(op, "poisoned", { reason: "cleanup error" });
    throw err;
  }
  await lifecycleSettle(op, "settled", {});`;
    const gutted = `export async function deleteD9User(userId: string): Promise<void> {
  // body ถูกแกะ — ไม่ทำอะไร
}
export async function cleanupD9World(ids: string[]): Promise<void> {
${wiredBody}
}`;
    // detector เก่า (ระดับไฟล์) ยัง true — ช่องโหว่ที่ gate waveh-r2 M2 จับ แสดงไว้เป็นหลักฐาน
    expect(d9CleanupWiringOk(gutted)).toBe(true);
    // detector ใหม่ (รายฟังก์ชัน) ต้องจับ: deleteD9User ถูกแกะ → chunk ไม่ผ่าน
    const chunks = splitTopLevelExports(gutted);
    const del = chunks.find((c) => c.name === "deleteD9User");
    const world = chunks.find((c) => c.name === "cleanupD9World");
    expect(del).toBeDefined();
    expect(world).toBeDefined();
    expect(cleanupHelperChunkOk(del?.source ?? ""), "deleteD9User ที่ถูกแกะ body ต้องไม่ผ่าน").toBe(false);
    expect(cleanupHelperChunkOk(world?.source ?? ""), "cleanupD9World ที่ยัง wired ต้องผ่าน").toBe(true);
    // ทิศสะอาด: ไฟล์จริง — ทุก helper wired → ผ่านครบ (พิสูจน์แล้วใน W4 ข้างบน)
    for (const c of splitTopLevelExports(readRepoFile("e2e/helpers/d9-cleanup.ts"))) {
      if (c.name === "deleteD9User" || c.name === "cleanupD9World") {
        expect(cleanupHelperChunkOk(c.source)).toBe(true);
      }
    }
  });
});

#!/usr/bin/env node
/**
 * Wave H D89-3 [#94] — verify-settle-manifest: two-layer ตรวจ EVIDENCE_SETTLE_MANIFEST
 * (gate แผน r30 §3 — "entry ใหม่ได้ต่อเมื่อผ่าน AST+catalog+sdkTargets must-equal")
 *
 * เลเยอร์ 1 (AST · repo): ดึง manifest จริงจาก tests/integration/test-io.ts ด้วย TypeScript
 *   compiler (ไม่ duplicate ค่า) แล้ว:
 *   (a) ทุก sdkTargets มีไฟล์จริง
 *   (b) app-direct: path จาก opKey (…/:uuid → /[id]) ตรงกับ route.ts ใน sdkTargets +
 *       export async function <METHOD> อยู่จริง
 *   (c) kong-path: opKey รูป rpc:<fn>:<METHOD> · พบ call site ของ fn (…rpc("fn"… หรือ
 *       "/rpc/fn" ใน string) ใน transitive closure ของ import จาก sdkTargets
 *   (d) app-direct ที่ singleDispatch=false: ใน closure ต้องมี retry loop จริง
 *       (DB_RPC_ATTEMPTS / retryDelayMs) — พิสูจน์ว่า "หลาย dispatch ต่อ invocation"
 *       คือ loop ที่บันทึกไว้ ไม่ใช่การเดา
 *   (e) เก็บหลักฐานการเขียนตารางจาก closure: `.from("t").(update|insert|upsert|delete)(`
 *       + ชื่อ rpc ที่ถูกเรียก
 *
 * เลเยอร์ 2 (catalog · DB จริง read-only): ตาราง public ทั้งหมด + pg_get_functiondef
 *   ของ rpc ที่เจอ → ชุดตารางที่ rpc เขียนจริง (regex กับชื่อตารางที่มีอยู่จริง) ∪
 *   ตาราง direct-write จากเลเยอร์ 1 ต้อง ⊇ touchSet ของ entry · คอลัมน์ใน whereTemplate
 *   (token แรก) + orderBy ต้องมีจริงในตารางนั้น
 *
 * ใช้: node scripts/verify-settle-manifest.mjs [--report .omc/artifacts/verify-settle-manifest.json]
 * ออก: exit 0 = ทุก entry ผ่านทั้งสองเลเยอร์ · exit 1 = มี mismatch (รายการพิมพ์ออก terminal)
 * dev-only · ไม่เขียนอะไรใน DB · ไม่ log ค่าลับ
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = path.join(REPO_ROOT, "tests/integration/test-io.ts");

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let reportPath = ".omc/artifacts/verify-settle-manifest.json";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--report") reportPath = args[++i];
  else { console.error(`verify-settle-manifest: unknown arg ${args[i]}`); process.exit(2); }
}

// ─── ดึง manifest จาก source ผ่าน AST (ค่าเดียวกับ runtime เป๊ะ — ไม่มี duplicate) ─
function extractManifest() {
  const src = readFileSync(MANIFEST_FILE, "utf8");
  const sf = ts.createSourceFile(MANIFEST_FILE, src, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "EVIDENCE_SETTLE_MANIFEST" && d.initializer !== undefined) {
        const entries = [];
        for (const el of d.initializer.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue;
          const entry = {};
          for (const p of el.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const key = p.name.getText(sf);
            if (ts.isStringLiteral(p.initializer) || ts.isNumericLiteral(p.initializer)) {
              entry[key] = p.initializer.text;
            } else if (p.initializer.kind === ts.SyntaxKind.TrueKeyword || p.initializer.kind === ts.SyntaxKind.FalseKeyword) {
              entry[key] = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
            } else if (ts.isArrayLiteralExpression(p.initializer)) {
              entry[key] = p.initializer.elements.map((e) => {
                if (ts.isStringLiteral(e)) return e.text;
                if (ts.isObjectLiteralExpression(e)) {
                  const o = {};
                  for (const ip of e.properties) {
                    if (ts.isPropertyAssignment(ip)) o[ip.name.getText(sf)] = ip.initializer.getText(sf).replace(/^['"]|['"]$/g, "");
                  }
                  return o;
                }
                return undefined;
              }).filter((x) => x !== undefined);
            }
          }
          entries.push(entry);
        }
        return entries;
      }
    }
  }
  throw new Error(`ไม่พบ EVIDENCE_SETTLE_MANIFEST ใน ${MANIFEST_FILE}`);
}

// ─── เลเยอร์ 1: import-graph transitive closure + call evidence ───────────────
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
  const base = spec.startsWith("@/") ? path.join(REPO_ROOT, "src", spec.slice(2)) : path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try { if (statSync(cand).isFile()) return cand; } catch { /* ข้าม */ }
  }
  return null;
}

function importClosure(entryFiles) {
  const seen = new Set();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    if (!existsSync(f)) continue;
    seen.add(f);
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const r = resolveImport(f, st.moduleSpecifier.text);
        if (r !== null && !seen.has(r)) queue.push(r);
      }
    }
  }
  return [...seen];
}

const DIRECT_WRITE_RE = /\.from\(\s*["']([a-z_]+)["']\s*\)\s*\.\s*(update|insert|upsert|delete)\s*\(/g;
// call site ของ rpc — ครอบ .rpc("fn") · userRpc("fn") · adminRpc("fn") (wrapper ของเทส/lib)
const RPC_CALL_RE = /\b\w*[Rr]pc\w*\(\s*["']([a-z0-9_]+)["']/g;
const RPC_URL_RE = /\/rpc\/([a-z0-9_]+)/g;

function scanFileEvidence(file) {
  const text = readFileSync(file, "utf8");
  const rpcNames = new Set();
  for (const m of text.matchAll(RPC_CALL_RE)) rpcNames.add(m[1]);
  for (const m of text.matchAll(RPC_URL_RE)) rpcNames.add(m[1]);
  const directWrites = new Set();
  for (const m of text.matchAll(DIRECT_WRITE_RE)) directWrites.add(m[1]);
  const hasRetryLoop = /DB_RPC_ATTEMPTS|retryDelayMs/.test(text);
  const methodExports = new Set();
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined) {
      const mods = st.modifiers ?? [];
      const hasExport = mods.some((mo) => mo.kind === ts.SyntaxKind.ExportKeyword);
      const hasAsync = mods.some((mo) => mo.kind === ts.SyntaxKind.AsyncKeyword);
      if (hasExport && hasAsync) methodExports.add(st.name.text.toUpperCase());
    }
  }
  return { rpcNames, directWrites, hasRetryLoop, methodExports };
}

/** หา route.ts จริงจาก path ของ opKey — segment `:uuid` จับคู่ dir `[<ชื่ออะไรก็ได้>]`
 *  (question-banks/[id]/questions/[qid] = :uuid สองชั้น) · คืน absolute path หรือ null */
function findRouteFile(urlPath) {
  const segs = urlPath.split("/").filter((s) => s.length > 0);
  let dir = path.join(REPO_ROOT, "src/app");
  for (const seg of segs) {
    let next = null;
    if (seg.startsWith(":")) {
      const paramDirs = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\[.+\]$/.test(d.name))
        .map((d) => d.name);
      if (paramDirs.length === 0) return null;
      if (paramDirs.length > 1) return null; // กำกวม — ปฏิเสธ (ต้องระบุ path ให้ชัด)
      next = path.join(dir, paramDirs[0]);
    } else {
      next = path.join(dir, seg);
    }
    if (!existsSync(next)) return null;
    dir = next;
  }
  const routeFile = path.join(dir, "route.ts");
  return existsSync(routeFile) ? routeFile : null;
}

// ─── เลเยอร์ 2: catalog จาก DB จริง (read-only) ───────────────────────────────
function psql(sql) {
  const r = spawnSync("docker", ["compose", "exec", "-T", "db", "sh", "-c",
    `PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -At -c ${JSON.stringify(sql)}`],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`psql ล้มเหลว (exit ${r.status}): ${(r.stderr || "").slice(0, 300)}`);
  return r.stdout;
}

function fetchCatalog() {
  const tables = new Set(psql(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE';",
  ).trim().split("\n").filter((l) => l.length > 0));
  const columns = new Map(); // table → Set(column)
  for (const t of tables) {
    const cols = psql(
      `select column_name from information_schema.columns where table_schema='public' and table_name='${t}';`,
    ).trim().split("\n").filter((l) => l.length > 0);
    columns.set(t, new Set(cols));
  }
  return { tables, columns };
}

/** ตารางที่ rpc เขียนจริง — จาก pg_get_functiondef เทียบกับชื่อตารางที่มีอยู่จริง */
function rpcWrittenTables(rpcNames, allTables) {
  const out = new Map(); // rpc → Set(table)
  for (const fn of rpcNames) {
    const def = psql(
      `select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${fn}' limit 1;`,
    ).trim();
    const touched = new Set();
    if (def !== "") for (const t of allTables) if (new RegExp(`\\b(public\\.)?${t}\\b`).test(def)) touched.add(t);
    out.set(fn, touched);
  }
  return out;
}

// ─── main ─────────────────────────────────────────────────────────────────────
const failures = [];
const results = [];
try {
  const manifest = extractManifest();
  if (manifest.length === 0) failures.push("manifest ว่าง");
  const catalog = fetchCatalog();
  const allRpcEvidence = new Set();

  for (const entry of manifest) {
    const r = { opKey: entry.opKey, checks: [], ok: true };
    const fail = (msg) => { r.checks.push({ ok: false, msg }); r.ok = false; failures.push(`${entry.opKey}: ${msg}`); };
    const pass = (msg) => r.checks.push({ ok: true, msg });

    // (a) sdkTargets มีไฟล์จริง
    for (const t of entry.sdkTargets ?? []) {
      const abs = path.join(REPO_ROOT, t);
      if (!existsSync(abs)) fail(`sdkTarget ไม่มีไฟล์: ${t}`);
    }
    if (r.ok) pass(`sdkTargets ${entry.sdkTargets.length} ไฟล์มีจริง`);

    const closureFiles = importClosure((entry.sdkTargets ?? []).map((t) => path.join(REPO_ROOT, t)));
    const evidence = closureFiles.map(scanFileEvidence);
    const rpcNames = new Set(evidence.flatMap((e) => [...e.rpcNames]));
    const directWrites = new Set(evidence.flatMap((e) => [...e.directWrites]));
    const anyRetryLoop = evidence.some((e) => e.hasRetryLoop);
    for (const fn of rpcNames) allRpcEvidence.add(fn);

    if (entry.transportTarget === "app-direct") {
      // (b) route path + method export
      const m = /^app:([A-Z]+):(.+)$/.exec(entry.opKey);
      const routeFile = m === null ? null : findRouteFile(m[2]);
      if (m === null) {
        fail(`opKey ไม่ใช่รูป app:<METHOD>:<path>`);
      } else if (routeFile === null) {
        fail(`ไม่พบ route.ts จริงของ path ${m[2]} ใต้ src/app`);
      } else {
        const rel = path.relative(REPO_ROOT, routeFile);
        if (!(entry.sdkTargets ?? []).includes(rel)) fail(`opKey path ${rel} ไม่อยู่ใน sdkTargets`);
        else {
          const routeEvidence = scanFileEvidence(routeFile);
          if (!routeEvidence.methodExports.has(m[1])) {
            fail(`${rel} ไม่มี export async function ${m[1]}`);
          } else pass(`route ${rel} + ${m[1]} export จริง`);
        }
      }
      // (d) singleDispatch=false ⇒ ต้องมี retry loop ใน closure
      if (entry.singleDispatch === false && !anyRetryLoop) {
        fail(`singleDispatch=false แต่ closure ไม่มี retry loop (DB_RPC_ATTEMPTS/retryDelayMs)`);
      }
    } else {
      // (c) kong-path: opKey rpc name + call site ใน closure
      const m = /^rpc:([a-z0-9_]+):([A-Z]+)$/.exec(entry.opKey);
      if (m === null) fail(`opKey ไม่ใช่รูป rpc:<fn>:<METHOD>`);
      else if (!rpcNames.has(m[1])) fail(`ไม่พบ call site ของ rpc ${m[1]} ใน closure (${closureFiles.length} ไฟล์)`);
      else pass(`rpc ${m[1]} call site จริงใน closure`);
    }

    // เลเยอร์ 2: touchSet ⊆ (rpc-derived ∪ direct-write) + คอลัมน์มีจริง
    const rpcTables = rpcWrittenTables(rpcNames, catalog.tables);
    const writable = new Set([...directWrites]);
    for (const tset of rpcTables.values()) for (const t of tset) writable.add(t);
    for (const tsEntry of entry.touchSet ?? []) {
      const table = tsEntry.table.replace(/^public\./, "");
      if (!catalog.tables.has(table)) { fail(`touchSet ตารางไม่มีใน public: ${table}`); continue; }
      if (!writable.has(table)) {
        fail(`touchSet ${table} ไม่ปรากฏในการเขียนจริง (rpc-derived={${[...rpcNames].map((f) => `${f}:{${[...(rpcTables.get(f) ?? [])].join(",")}}`).join(" ")}} direct={${[...directWrites].join(",")}})`);
        continue;
      }
      const whereCol = (tsEntry.whereTemplate ?? "").trim().split(/\s+/)[0];
      const orderCol = (tsEntry.orderBy ?? "").trim();
      const cols = catalog.columns.get(table) ?? new Set();
      if (whereCol !== "" && !cols.has(whereCol)) fail(`${table}.${whereCol} (whereTemplate) ไม่มีคอลัมน์จริง`);
      if (orderCol !== "" && !cols.has(orderCol)) fail(`${table}.${orderCol} (orderBy) ไม่มีคอลัมน์จริง`);
    }
    if (r.checks.every((c) => c.ok) && (entry.touchSet ?? []).length > 0) {
      pass(`touchSet ${entry.touchSet.map((t) => t.table.replace(/^public\./, "")).join(",")} ⊆ การเขียนจริง (catalog)`);
    }
    results.push(r);
  }

  // สรุป rpc ที่ evidence เจอ (audit มนุษย์อ่านได้)
  const report = { generatedAt: new Date().toISOString(), manifestFile: path.relative(REPO_ROOT, MANIFEST_FILE), entries: results, rpcEvidence: [...allRpcEvidence].sort(), failures };
  const absReport = path.resolve(REPO_ROOT, reportPath);
  mkdirSync(path.dirname(absReport), { recursive: true });
  writeFileSync(absReport, JSON.stringify(report, null, 2) + "\n");
  console.log(`entries=${results.length} pass=${results.filter((r) => r.ok).length} fail=${results.filter((r) => !r.ok).length}`);
  console.log(`report: ${path.relative(REPO_ROOT, absReport)}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log("verify-settle-manifest: PASS ทุก entry ทั้งสองเลเยอร์");
  process.exit(0);
} catch (err) {
  console.error(`verify-settle-manifest: ${String(err)}`);
  process.exit(1);
}

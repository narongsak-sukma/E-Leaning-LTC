#!/usr/bin/env node
/**
 * Wave H D89-3/D89-4 [#94] — audit-test-io: script audit ×3 (gate แผน r30
 * §2-D89-3 "script audit ×3" + limitation 17 "census/entry ตายตัว … unknown=FAIL ·
 * เพิ่มใหม่ = อัปเดต manifest+แผนก่อน")
 *
 * audit1 — census + manifest transitive fixpoint:
 *   นับ hook (beforeAll/afterAll/beforeEach/afterEach/onTestFinished · ชั้นย่อย DB)
 *   + แผนที่ direct entry ของทุกไฟล์เทส (fetch/sql/spawn/sdk) + รายชื่อไฟล์ SDK
 *   เทียบกับ fixpoint ที่ commit ไว้ (scripts/audit-test-io-fixpoint.json) —
 *   ไฟล์/จุดใหม่ที่ไม่อยู่ fixpoint = FAIL (ต้องอัปเดต fixpoint+แผนก่อนอย่างตั้งใจ
 *   ด้วย --update) · ตัวเลข plan-time (27/29/9 จุด/3 ไฟล์) เป็นค่าก่อน implement —
 *   pass 6 วัดจริงตาม D-f-13 แล้วบันทึกเป็น baseline ใหม่
 *
 * audit2 — floating-promise + attemptBegin guard wiring + negative fixtures:
 *   (a) AST walk tests/barrier-proof/**: expression statement เรียก async API
 *       ของ transport/ledger/harness โดยไม่ await/assign/return = floating FAIL
 *       + `.exec(`/`.end(` ของ session จาก startPsqlSession ที่ลอย = FAIL
 *   (b) transport ไม่ปรึกษา guard: ใน body ของ sqlWrite/httpWrite/createTrackedClient
 *       ห้ามมี call attemptBegin (ขอบเขต r29-m1 — จุดบังคับเดียวคือ attemptBegin เอง)
 *   (c) scenario family (8o/8o-ข/8o-ง/8q(ข)) ต้องมี call attemptBegin จริงทุกไฟล์
 *   (d) settle-decision row เดียว: ledgerWrite("settle-decision", …) ได้ใน
 *       writeSettleDecision เท่านั้น
 *   (e) negative ทั้งชุดมีจริง: w8s (op-key-mismatch · run-id-override-refused ·
 *       guard-refused) · w8o-ng (lifecycle-guard-refused-live-predecessor)
 *
 * audit3 — wiring ครอบทุก entry + APP_URL base + access-log fence:
 *   (a) transport สามตัว export จริง (sqlWrite/httpWrite/createTrackedClient)
 *   (b) httpWrite body: cursor เฉพาะ kong-path (captureLogCursor) · ua_nonce ทุก
 *       dispatch (headers user-agent) · settle 500 อ่าน window จริง (accessLogFence +
 *       kong500Decision) · path-normalize (normalizePathForLog ที่ binding + fence)
 *   (c) run-id freeze (FROZEN_RUN_ID + run-id-override-refused)
 *   (d) APP_URL base: tests/barrier-proof/*.test.ts ห้ามฝัง host literal
 *       (http://localhost · 127.0.0.1) — ต้องใช้ APP_URL/REST_URL จาก fixture/helpers
 *   (e) fixture จริง (qb-patch/user-active) วิ่งผ่าน httpWrite
 *
 * ใช้: node scripts/audit-test-io.mjs [--update] [--report <path>]
 * ออก: รายงาน JSON บรรทัดเดียวทาง stdout + ไฟล์ report (default
 *      .omc/artifacts/audit-test-io.json) · exit 0 = ผ่านทั้งสาม audit · 1 = มี FAIL
 *      · 2 = ใช้งานผิด · --update = เขียน fixpoint ใหม่จากต้นไม้จริง (act ของ lead —
 *      ต้อง commit พร้อมเหตุผล + อัปเดตแผน ห้ามใช้เพื่อ "ทำให้ผ่าน" โดยไม่รีวิว)
 * static-only · ไม่แตะ DB/container · ไม่ log ค่าลับ
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXPOINT_FILE = path.join(REPO_ROOT, "scripts/audit-test-io-fixpoint.json");
const TEST_DIRS = ["tests/integration", "tests/barrier-proof"];
const SRC_DIR = "src";

/** ไฟล์ infra ของ transport เอง — จุด "นิยาม" I/O ไม่ใช่ "direct entry" ของเทส */
const INFRA_FILES = new Set([
  "tests/integration/helpers.ts",
  "tests/integration/test-io.ts",
  "tests/integration/window-coordinator.ts",
  "tests/barrier-proof/barrier-harness.ts",
  "tests/barrier-proof/qb-patch-fixture.ts",
  "tests/barrier-proof/user-active-fixture.ts",
]);

const HOOK_NAMES = ["beforeAll", "afterAll", "beforeEach", "afterEach", "onTestFinished"];

/** API ที่ถือว่า "แตะ DB" สำหรับจำแนกชั้นย่อยของ hook (informational — นับตามชื่อที่อ้างใน body) */
const DB_API_RE =
  /\b(psql|psqlRows|psqlScalar|sqlWrite|createTestUser|deleteTestUser|assignRole|reloadRestSchema|startPsqlSession|terminateBackend|beforeSnapshot|ledgerWrite|ensureTestInfra)\b/;

/** async API ที่การเรียกแล้วปล่อยลอย (ไม่ await/assign/return) = บั๊กหลักฐานหาย */
const FLOAT_API_NAMES = new Set([
  "attemptBegin", "httpWrite", "sqlWrite", "ledgerWrite", "ledgerRead", "invocationClose",
  "invocationState", "settleHttpWithEvidence", "manualClearPoison", "windowSet",
  "ensureTestInfra", "beforeSnapshot", "captureLogCursor", "readAccessLogWindow",
  "accessLogFence", "findBackendByNonce", "terminateBackend", "buildTouchSet", "pidsBusy",
  "writeSettleDecision", "startPsqlSession", "createTrackedClient", "psql", "psqlRows",
  "psqlScalar", "restCall", "createTestUser", "deleteTestUser", "assignRole",
  "reloadRestSchema", "awaitStuckWaiter", "compose", "waitRestHealthy", "waitAuthHealthy",
]);

const TRANSPORT_FNS = ["sqlWrite", "httpWrite", "createTrackedClient"];

/** scenario family ของขอบเขต r29-m1 — ทุกไฟล์ที่ "เริ่ม" scenario attempt ต้องเรียก
 * attemptBegin จริง (w8o-guard-attempt-loop เป็น orchestrator: spawn child ผ่าน
 * childRun แล้ว assert ว่า child ใช้ attemptBegin — ตัวที่เริ่ม attempt คือ
 * child/mm-attempt-loop) */
const SCENARIO_FILES = [
  "tests/barrier-proof/child/mm-attempt-loop.test.ts",
  "tests/barrier-proof/w8o-kh-settle-refused-despite-attribution.test.ts",
  "tests/barrier-proof/w8o-ng-live-predecessor.test.ts",
  "tests/barrier-proof/w8q-refresh-fixtures.test.ts",
];

/** snippet ที่ห้ามหายจาก transport (audit3-b/c) — ผูกกับรูป source ปัจจุบันของ test-io.ts */
const REQUIRED_SNIPPETS = [
  'transportTarget === "kong-path" ? await captureLogCursor()',
  '"user-agent": uaNonce',
  'headers.set("user-agent", uaNonce)',
  "await accessLogFence(cursor",
  "kong500Decision(fence, opKey)",
  "urlNormalized: normalizePathForLog",
  "pathNorm: normalizePathForLog",
  "FROZEN_RUN_ID",
  "run-id-override-refused",
];

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let update = false;
let reportPath = ".omc/artifacts/audit-test-io.json";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--update") update = true;
  else if (argv[i] === "--report") reportPath = argv[++i];
  else {
    process.stderr.write(`audit-test-io: unknown arg ${argv[i]}\n`);
    process.exit(2);
  }
}

// ─── พื้นฐาน: walk + parse ──────────────────────────────────────────────────

function walkTs(relDir) {
  const out = [];
  const abs = path.join(REPO_ROOT, relDir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${name.name}`;
    if (name.isDirectory()) out.push(...walkTs(rel));
    else if (name.name.endsWith(".ts")) out.push(rel);
  }
  return out.sort();
}

const TEST_FILES = TEST_DIRS.flatMap(walkTs);
const INFRA_ABS = new Set([...INFRA_FILES].map((f) => path.join(REPO_ROOT, f)));
const SOURCE_CACHE = new Map();
function srcOf(file) {
  if (!SOURCE_CACHE.has(file)) SOURCE_CACHE.set(file, readFileSync(file, "utf8"));
  return SOURCE_CACHE.get(file);
}
function sfOf(file) {
  return ts.createSourceFile(file, srcOf(file), ts.ScriptTarget.Latest, true);
}

/** นับ call-site ตามชื่อ (word boundary + วงเล็บเปิด) — deterministic */
function countCalls(source, names) {
  let n = 0;
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    for (const m of source.matchAll(re)) {
      // เฉพาะที่ไม่ถูกคอมเมนต์บรรทัดนั้น (ประหยัดพอ — comment ทั้งบรรทัดเท่านั้น)
      const line = source.slice(source.lastIndexOf("\n", m.index) + 1, m.index);
      if (!/^\s*(\/\/|\*|\/\*)/.test(line)) n += 1;
    }
  }
  return n;
}

/** นับ hook + จำแนกชั้นย่อย "DB" จาก body จริง (paren-match argument แรก) */
function countHooks(source) {
  const out = {};
  for (const name of HOOK_NAMES) {
    let total = 0;
    let db = 0;
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    for (const m of source.matchAll(re)) {
      const args = extractBalanced(source, m.index + m[0].length - 1, "(", ")");
      if (args === null) continue;
      const line = source.slice(source.lastIndexOf("\n", m.index) + 1, m.index);
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      total += 1;
      if (DB_API_RE.test(args)) db += 1;
    }
    out[name] = { total, db };
  }
  return out;
}

/** ดึงเนื้อหาในวงเล็บ/ปีกกาที่สมดุล เริ่มที่ openIdx (ตำแหน่งของตัวเปิด) */
function extractBalanced(source, openIdx, open, close) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    const prev = source[i - 1];
    if (inStr !== null) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** call name ท้ายสุดของ callee (a.b.c( → c · attemptBegin( → attemptBegin) */
function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** เดินทุก descendant ของ node */
function* descendants(node) {
  for (const child of node.getChildren()) {
    yield child;
    yield* descendants(child);
  }
}

// ─── audit1 — census + fixpoint ──────────────────────────────────────────────

function measureCensus() {
  const hooks = {};
  for (const name of HOOK_NAMES) hooks[name] = { total: 0, db: 0 };
  const directEntries = {};
  for (const rel of TEST_FILES) {
    const source = srcOf(path.join(REPO_ROOT, rel));
    if (rel.endsWith(".test.ts")) {
      const h = countHooks(source);
      for (const name of HOOK_NAMES) {
        hooks[name].total += h[name].total;
        hooks[name].db += h[name].db;
      }
    }
    if (INFRA_FILES.has(rel)) continue;
    const entry = {
      fetch: countCalls(source, ["fetch"]),
      sql: countCalls(source, ["psql", "psqlRows", "psqlScalar"]),
      spawn: countCalls(source, ["spawn", "spawnSync"]),
      sdk: countCalls(source, ["createClient", "createTrackedClient"]),
    };
    if (entry.fetch + entry.sql + entry.spawn + entry.sdk > 0) directEntries[rel] = entry;
  }
  const sdkFiles = [
    ...walkTs(SRC_DIR),
    ...TEST_FILES,
  ].filter((rel) => countCalls(srcOf(path.join(REPO_ROOT, rel)), ["createClient"]) > 0);
  return {
    scope: TEST_DIRS,
    hooks,
    sqlEntryApis: ["psql", "psqlRows", "psqlScalar", "sqlWrite", "PsqlSession.exec"],
    sdkFiles,
    directEntries,
  };
}

function audit1(measured, failures) {
  if (!existsSync(FIXPOINT_FILE)) {
    failures.push("audit1: ไม่มี scripts/audit-test-io-fixpoint.json — รัน --update ครั้งแรกเพื่อบันทึก baseline");
    return;
  }
  const fixpoint = JSON.parse(srcOf(FIXPOINT_FILE));
  const strip = (o) => JSON.stringify(o, null, 2);
  // hooks
  for (const name of HOOK_NAMES) {
    const want = fixpoint.hooks?.[name];
    const got = measured.hooks[name];
    if (want === undefined || want.total !== got.total || want.db !== got.db) {
      failures.push(
        `audit1: hook ${name} คลาด fixpoint (วัดได้ total=${got.total} db=${got.db} · fixpoint=${JSON.stringify(want ?? null)}) — เพิ่ม hook ใหม่ = อัปเดต fixpoint+แผนก่อน`,
      );
    }
  }
  // direct entries
  const wantFiles = new Set(Object.keys(fixpoint.directEntries ?? {}));
  const gotFiles = new Set(Object.keys(measured.directEntries));
  for (const f of gotFiles) {
    if (!wantFiles.has(f)) {
      failures.push(`audit1: direct entry ใหม่ที่ไม่อยู่ fixpoint: ${f} (${JSON.stringify(measured.directEntries[f])})`);
    } else if (strip(fixpoint.directEntries[f]) !== strip(measured.directEntries[f])) {
      failures.push(
        `audit1: direct entry เปลี่ยน: ${f} fixpoint=${JSON.stringify(fixpoint.directEntries[f])} → วัดได้=${JSON.stringify(measured.directEntries[f])}`,
      );
    }
  }
  for (const f of wantFiles) {
    if (!gotFiles.has(f)) {
      failures.push(`audit1: direct entry หายไปจากต้นไม้ (fixpoint เน่า): ${f}`);
    }
  }
  // sdk files
  const wantSdk = [...(fixpoint.sdkFiles ?? [])].sort();
  const gotSdk = [...measured.sdkFiles].sort();
  if (JSON.stringify(wantSdk) !== JSON.stringify(gotSdk)) {
    failures.push(`audit1: ไฟล์ SDK คลาด fixpoint — fixpoint=${JSON.stringify(wantSdk)} → วัดได้=${JSON.stringify(gotSdk)}`);
  }
}

// ─── audit2 — floating + guard wiring + negatives ────────────────────────────

function audit2(failures) {
  const barrierFiles = walkTs("tests/barrier-proof");
  const sessionVarsByFile = new Map();

  for (const rel of barrierFiles) {
    const abs = path.join(REPO_ROOT, rel);
    const sf = sfOf(abs);
    const sessionVars = new Set();
    sessionVarsByFile.set(rel, sessionVars);

    // ตัวแปรที่รับจาก startPsqlSession — .exec/.end ของตัวแปรพวกนี้ต้องไม่ลอย
    for (const n of descendants(sf)) {
      if (ts.isVariableDeclaration(n) && n.initializer !== undefined && ts.isCallExpression(n.initializer)
        && calleeName(n.initializer) === "startPsqlSession" && ts.isIdentifier(n.name)) {
        sessionVars.add(n.name.text);
      }
    }

    for (const n of descendants(sf)) {
      if (!ts.isExpressionStatement(n)) continue;
      const expr = n.expression;
      if (!ts.isCallExpression(expr)) continue;
      const name = calleeName(expr);
      if (name !== null && FLOAT_API_NAMES.has(name)) {
        failures.push(`audit2: floating promise — ${rel}: เรียก ${name}( แบบ expression statement (ไม่ await/assign/return)`);
        continue;
      }
      if (ts.isPropertyAccessExpression(expr.expression)) {
        const obj = expr.expression.expression;
        const method = expr.expression.name.text;
        if ((method === "exec" || method === "end") && ts.isIdentifier(obj) && sessionVars.has(obj.text)) {
          failures.push(`audit2: floating session call — ${rel}: ${obj.text}.${method}( ลอย (ไม่ await/assign/return)`);
        }
      }
    }
  }

  // transport ไม่ปรึกษา guard + settle-decision row เดียว (AST ของ test-io.ts)
  const ioAbs = path.join(REPO_ROOT, "tests/integration/test-io.ts");
  const ioSf = sfOf(ioAbs);
  const fnBodies = new Map();
  for (const st of ioSf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined && st.body !== undefined) {
      fnBodies.set(st.name.text, st.body);
    }
  }
  for (const fnName of TRANSPORT_FNS) {
    const body = fnBodies.get(fnName);
    if (body === undefined) {
      failures.push(`audit2: transport ${fnName} หายจาก test-io.ts (ต้อง export อยู่จริง)`);
      continue;
    }
    for (const n of descendants(body)) {
      if (ts.isCallExpression(n) && calleeName(n) === "attemptBegin") {
        failures.push(`audit2: transport ${fnName} ปรึกษา attemptBegin เอง — ขอบเขต r29-m1 จุดบังคับเดียวคือ attemptBegin เอง`);
      }
    }
  }
  const settleWriter = fnBodies.get("writeSettleDecision");
  if (settleWriter === undefined) {
    failures.push("audit2: writeSettleDecision หายจาก test-io.ts");
  } else {
    for (const [fnName, body] of fnBodies) {
      if (fnName === "writeSettleDecision") continue;
      for (const n of descendants(body)) {
        if (ts.isCallExpression(n) && calleeName(n) === "ledgerWrite") {
          const arg0 = n.arguments[0];
          if (arg0 !== undefined && ts.isStringLiteral(arg0) && arg0.text === "settle-decision") {
            failures.push(`audit2: ledgerWrite("settle-decision") ปรากฏใน ${fnName} — settle decision row เดียวต้องเขียนที่ writeSettleDecision เท่านั้น`);
          }
        }
      }
    }
  }

  // guard definition: attemptBegin ตรวจ invocationState + ALLOWED_PREDECESSOR_STATUS
  const guard = fnBodies.get("attemptBegin");
  if (guard === undefined) {
    failures.push("audit2: attemptBegin หายจาก test-io.ts");
  } else {
    const inner = [...descendants(guard)].map((n) => n.getText(ioSf)).join(" ");
    if (!inner.includes("invocationState")) failures.push("audit2: attemptBegin ไม่อ่าน invocationState — serial invariant ไม่ถูกบังคับ");
    if (!inner.includes("ALLOWED_PREDECESSOR_STATUS")) failures.push("audit2: attemptBegin ไม่ใช้ ALLOWED_PREDECESSOR_STATUS");
  }

  // scenario family: ทุกไฟล์เริ่ม scenario attempt ผ่าน attemptBegin จริง
  for (const rel of SCENARIO_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      failures.push(`audit2: scenario file หาย: ${rel}`);
      continue;
    }
    const sf = sfOf(abs);
    let hasCall = false;
    for (const n of descendants(sf)) {
      if (ts.isCallExpression(n) && calleeName(n) === "attemptBegin") hasCall = true;
    }
    if (!hasCall) failures.push(`audit2: ${rel} ไม่มี call attemptBegin — scenario attempt ต้องเริ่มผ่าน guard เท่านั้น`);
  }

  // negative markers มีจริงในชุด negative
  const markers = [
    ["tests/barrier-proof/w8s-negative-proofs.test.ts", ["op-key-mismatch", "run-id-override-refused", "no-attribution"]],
    ["tests/barrier-proof/w8o-ng-live-predecessor.test.ts", ["lifecycle-guard-refused-live-predecessor"]],
    ["tests/barrier-proof/w8q-refresh-fixtures.test.ts", ["GuardRefusedError"]],
  ];
  for (const [rel, needles] of markers) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      failures.push(`audit2: negative fixture หาย: ${rel}`);
      continue;
    }
    const source = srcOf(abs);
    for (const needle of needles) {
      if (!source.includes(needle)) failures.push(`audit2: ${rel} ไม่มี marker "${needle}" ของ negative ชุดเดิม`);
    }
  }
}

// ─── audit3 — wiring ครอบทุก entry + APP_URL base + fence ────────────────────

function audit3(failures) {
  const ioAbs = path.join(REPO_ROOT, "tests/integration/test-io.ts");
  const ioSrc = srcOf(ioAbs);
  for (const snippet of REQUIRED_SNIPPETS) {
    if (!ioSrc.includes(snippet)) {
      failures.push(`audit3: test-io.ts ขาด wiring snippet: ${snippet}`);
    }
  }

  // wiring ต้องอยู่ "ใน" httpWrite จริง ไม่ใช่แค่อยู่ในไฟล์
  const ioSf = sfOf(ioAbs);
  for (const st of ioSf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === "httpWrite" && st.body !== undefined) {
      const inner = [...descendants(st.body)].map((n) => n.getText(ioSf)).join(" ");
      for (const fn of ["captureLogCursor", "accessLogFence", "kong500Decision", "normalizePathForLog"]) {
        if (!inner.includes(fn)) {
          failures.push(`audit3: httpWrite body ขาด wiring จริงของ ${fn}`);
        }
      }
    }
  }

  // transport export จริงสามตัว
  for (const fn of TRANSPORT_FNS) {
    if (!new RegExp(`export (async )?function ${fn}\\b`).test(ioSrc)) {
      failures.push(`audit3: test-io.ts ไม่ export transport ${fn}`);
    }
  }

  // APP_URL base — barrier .test.ts ห้ามฝัง host literal
  const hostRe = /http:\/\/(localhost|127\.0\.0\.1)/;
  for (const rel of walkTs("tests/barrier-proof")) {
    if (!rel.endsWith(".test.ts")) continue;
    if (srcOf(path.join(REPO_ROOT, rel)).match(hostRe)) {
      failures.push(`audit3: ${rel} ฝัง host literal — ต้องใช้ APP_URL/REST_URL จาก fixture/helpers`);
    }
  }

  // fixture จริงวิ่งผ่าน httpWrite
  for (const rel of ["tests/barrier-proof/qb-patch-fixture.ts", "tests/barrier-proof/user-active-fixture.ts"]) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs) || !/\bhttpWrite\s*\(/.test(srcOf(abs))) {
      failures.push(`audit3: fixture ${rel} ไม่ได้วิ่งผ่าน httpWrite`);
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

const measured = measureCensus();
const failures = [];
try {
  audit1(measured, failures);
  audit2(failures);
  audit3(failures);
} catch (err) {
  process.stderr.write(`audit-test-io: ตรวจไม่สำเร็จ (environment/parse): ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

if (update) {
  writeFileSync(
    FIXPOINT_FILE,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), ...measured }, null, 2)}\n`,
  );
  process.stderr.write(`audit-test-io: --update เขียน fixpoint ใหม่จากต้นไม้จริงแล้ว (${FIXPOINT_FILE})\n`);
}

const ok = failures.length === 0;
const report = {
  ok,
  audits: { census: "audit1", floatGuard: "audit2", wiring: "audit3" },
  fixpoint: existsSync(FIXPOINT_FILE) ? path.relative(REPO_ROOT, FIXPOINT_FILE) : null,
  hooks: measured.hooks,
  directEntryFiles: Object.keys(measured.directEntries).length,
  sdkFiles: measured.sdkFiles.length,
  failures,
};
const reportAbs = path.resolve(REPO_ROOT, reportPath);
mkdirSync(path.dirname(reportAbs), { recursive: true });
writeFileSync(reportAbs, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok, ...report, failures: failures.length }));
process.exit(ok ? 0 : 1);

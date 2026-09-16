#!/usr/bin/env node
// Wave I เฟส 3 [#94] — scripts/prod-build-proof.mjs (DCR-PROD-BUILD-E2E.md ข้อ 4)
// พิสูจน์ว่า origin ที่ e2e วิ่งเข้าไปกำลังเสิร์ฟ production build จริง (เงื่อนไข verdict wavei-r3)
//
//   ชั้น 1 (มุมมอง browser — สัญญาณเฉพาะ production): GET /login → ดึง URL chunk
//          /_next/static/chunks/*.js แรกจาก HTML → GET chunk → Cache-Control ต้องมี
//          "immutable" (prod: public, max-age=31536000, immutable · dev ไม่ใส่ immutable)
//   ชั้น 2 (ตัว container): docker inspect Config.Cmd ต้องมี "npm start" และ State.Running
//          · docker exec cat /app/.next/BUILD_ID → พิมพ์ BUILD_ID ลง log ประจำรอบ
//   ชั้น 0 (โดยธรรมชาติ): next start ปฏิเสธการรันเมื่อไม่มี production build —
//          container ที่ตอบ health 200 ได้ = เสิร์ฟ production build อยู่แล้ว
//
// ใช้โดย stage health ของ scripts/battery-run.mjs เมื่อ E2E_REQUIRE_PROD=1 ·
// two-way proof: ชี้ไป dev (:3000) ต้อง exit 1 · ชี้ไป prod (:3001) ต้อง exit 0
//
// exit: 0 = ผ่านทุกชั้น · 1 = ไม่ผ่าน (ข้อความบอกจุดล้ม)

import { execFileSync } from "node:child_process";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv.length > i + 1) return process.argv[i + 1];
  return fallback;
}

const ORIGIN = arg("origin", process.env["E2E_BASE_URL"] ?? "http://localhost:3001").replace(/\/$/, "");
const CONTAINER = arg("container", "ltc-prod-app");

function fail(step, msg) {
  console.error(`prod-build-proof: FAIL [${step}] ${msg}`);
  console.error(`prod-build-proof: origin=${ORIGIN} container=${CONTAINER}`);
  process.exit(1);
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return null;
  }
}

// ---- ชั้น 1: probe ฝั่ง HTTP ผ่านมุมมอง browser ------------------------------
let html;
try {
  const res = await fetch(`${ORIGIN}/login`, { redirect: "follow" });
  if (!res.ok) fail("http:/login", `HTTP ${res.status} (ต้อง 200)`);
  html = await res.text();
} catch (e) {
  fail("http:/login", `fetch ไม่ได้: ${e?.message ?? e}`);
}
const m = html.match(/\/_next\/static\/chunks\/[^"'<>\s]+?\.js/);
if (!m) fail("http:chunk-url", `ไม่พบ URL /_next/static/chunks/*.js ใน HTML ของ /login (ได้ ${html.length} ไบต์)`);
const chunkUrl = m[0];
let chunkRes;
try {
  chunkRes = await fetch(`${ORIGIN}${chunkUrl}`);
} catch (e) {
  fail("http:chunk-get", `GET ${chunkUrl} ไม่ได้: ${e?.message ?? e}`);
}
if (!chunkRes.ok) fail("http:chunk-get", `GET ${chunkUrl} = HTTP ${chunkRes.status}`);
const cacheControl = chunkRes.headers.get("cache-control") ?? "";
if (!cacheControl.includes("immutable")) {
  fail(
    "http:immutable",
    `Cache-Control ของ chunk ไม่มี immutable (ได้: "${cacheControl}") — สัญญาณว่ากำลังคุยกับ next dev ไม่ใช่ production build`
  );
}
console.log(`prod-build-proof: ชั้น 1 ผ่าน — chunk ${chunkUrl}`);
console.log(`prod-build-proof:   Cache-Control: ${cacheControl}`);

// ---- ชั้น 2: probe ตัว container --------------------------------------------
const cmdJson = sh("docker", ["inspect", "-f", "{{json .Config.Cmd}}", CONTAINER]);
if (cmdJson === null) fail("docker:inspect", `docker inspect ${CONTAINER} ล้ม (container อยู่จริง?)`);
let cmd;
try {
  cmd = JSON.parse(cmdJson);
} catch {
  fail("docker:inspect", `Config.Cmd แยกไม่ได้: ${cmdJson}`);
}
if (!Array.isArray(cmd) || !cmd.some((c) => String(c).includes("npm start"))) {
  fail("docker:cmd", `Config.Cmd ไม่มี "npm start" (ได้: ${cmdJson})`);
}
const state = sh("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER]);
if (state !== "true") fail("docker:state", `State.Running=${state} (ต้อง true)`);
const buildId = sh("docker", ["exec", CONTAINER, "cat", "/app/.next/BUILD_ID"]);
if (!buildId) fail("docker:build-id", `อ่าน /app/.next/BUILD_ID จาก ${CONTAINER} ไม่ได้ (ไม่มี production build ใน container)`);
console.log(`prod-build-proof: ชั้น 2 ผ่าน — Cmd=${cmdJson} Running=${state} BUILD_ID=${buildId}`);
console.log(`prod-build-proof: PASS — ${ORIGIN} เสิร์ฟ production build จริง (BUILD_ID=${buildId})`);

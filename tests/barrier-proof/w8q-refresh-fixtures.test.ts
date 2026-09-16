/**
 * 8q — refresh fixtures ก/ข (r30 §2-D89-3 "refresh fixtures" + §2-D89-4 CC·fixtures)
 *
 * ก: mint access token exp-in-past (HS256 ด้วย SUPABASE_JWT_SECRET จาก .env —
 *    dev-only · ห้าม print/commit · limitation 20) แล้วพิสูจน์สองทิศ:
 *    (−) AT หมดอายุใช้ /auth/v1/user ไม่ได้ — 403 bad_jwt "token is expired" =
 *    confirmed-403 (วัดจริงจาก stack: 401 สงวนไว้ "no_authorization" ไม่มี bearer ·
 *    Kong auth-v1 มีแค่ key-auth ไม่ตรวจ JWT คือ GoTrue ปฏิเสธเอง — kong.yml:20-34)
 *    (+) POST /auth/v1/token?grant_type=refresh_token ผ่าน Kong → 200 =
 *    confirmed-200 + token หมุนจริง (access_token/refresh_token คู่ใหม่) ·
 *    RT เดิมถูกกินหลัง rotation — ห้าม reuse
 *
 * ข: หยุด ltc-dev-auth ก่อนวน refresh → Kong 502/503 (gateway = retryable ไม่
 *    มี terminal ต้นทาง — ห้าม settle ทุกครั้ง 'unresolved-gateway') ภายใต้
 *    invocation เดียว (attemptBegin) ตามงบ loop 30 วิ · budget 45 วิ หมด =
 *    poison → attemptBegin ปฏิเสธ (poisoned = เคลียร์มือก่อน — limitation 5) ·
 *    finally: restart auth + health-wait (/auth/v1/health 200) เสมอ + เคลียร์
 *    poisoned ด้วย intent · RT สดต่อ fixture (rotation — ไม่แตะของ ก)
 */
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { ANON_KEY, createTestUser, REPO_ROOT, REST_URL } from "../integration/helpers.js";
import {
  attemptBegin,
  GuardRefusedError,
  httpWrite,
  invocationClose,
  invocationState,
  ledgerWrite,
  manualClearPoison,
} from "../integration/test-io.js";

function compose(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", ...args], { cwd: REPO_ROOT });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** รอ GoTrue กลับมาสุขภาพดี — Kong → /auth/v1/health ตอบ 200 (key-auth ต้องมี
 * apikey — ไม่มี = Kong ปฏิเสธ 401 เองก่อนถึง auth สุขภาพไม่สุขภาพ · auth ตาย
 * Kong ตอบ 503 = จำแนก 200 กับ "ยังไม่กลับ" ได้จริง) */
async function waitAuthHealthy(deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${REST_URL}/auth/v1/health`, { headers: { apikey: ANON_KEY } });
      if (response.status === 200) return true;
    } catch {
      // ยังไม่กลับมา — วนต่อ
    }
    await sleep(500);
  }
  return false;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * mint AT exp-in-past จาก payload ของ AT จริง (sub/role/aud/session_id คงเดิม —
 * เอาแค่ exp/iat เป็นอดีต) sign HS256 ด้วย SUPABASE_JWT_SECRET — secret ห้าม
 * ออกจาก process (ไม่ print ไม่ log ไม่ error-message)
 */
function mintExpiredAccessToken(realAt: string, secret: string): string {
  const part = realAt.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now - 600, exp: now - 120 };
  const header = { typ: "JWT", alg: "HS256" };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(body)))}`;
  const sig = b64url(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

describe("8q refresh fixtures — ก mint exp-in-past + refresh confirmed · ข auth ตาย → budget poison", () => {
  let refreshTokenKa = "";
  let expiredAt = "";

  beforeAll(async () => {
    const secret = process.env["SUPABASE_JWT_SECRET"];
    if (secret === undefined || secret === "") {
      throw new Error("h8q: SUPABASE_JWT_SECRET ไม่มีใน env — mint exp-in-past ไม่ได้ (dev fixtures เท่านั้น)");
    }
    const user = await createTestUser("h8q-ka");
    refreshTokenKa = user.refreshToken;
    expiredAt = mintExpiredAccessToken(user.accessToken, secret);
  }, 120_000);

  it(
    "(ก) AT exp-in-past → /auth/v1/user = 403 bad_jwt confirmed · refresh grant = 200 confirmed + rotation",
    async () => {
      // (−) โทเคนหมดอายุต้องใช้ไม่ได้จริง — GoTrue ตอบ 403 bad_jwt "token is expired"
      // (วัดจริงจาก stack: 401 สงวนไว้สำหรับไม่มี bearer · Kong auth-v1 ไม่ตรวจ JWT
      // เอง — kong.yml:20-34 คือ GoTrue ปฏิเสธเอง)
      const neg = await httpWrite("GET", `${REST_URL}/auth/v1/user`, undefined, {
        transportTarget: "kong-path",
        token: expiredAt,
        label: "h8q-ka-expired-user",
      });
      expect(neg.status, `AT exp-in-past ต้องถูกปฏิเสธ (ได้ ${neg.status})`).toBe(403);
      const negBody = (neg.json ?? {}) as { error_code?: unknown; msg?: unknown };
      expect(negBody.error_code, "ต้องเป็นการปฏิเสธเพราะ token หมดอายุจริง").toBe("bad_jwt");
      expect(String(negBody.msg)).toContain("expired");
      expect(neg.settledAs).toBe("confirmed-403");
      expect((await invocationState(neg.opKey))?.status).toBe("settled");

      // (+) refresh_token grant ผ่าน Kong → 200 + คู่โทเคนใหม่ (rotation จริง)
      const pos = await httpWrite(
        "POST",
        `${REST_URL}/auth/v1/token?grant_type=refresh_token`,
        { refresh_token: refreshTokenKa },
        { transportTarget: "kong-path", label: "h8q-ka-refresh" },
      );
      expect(pos.status, `refresh ต้องสำเร็จ (ได้ ${pos.status}: ${pos.text.slice(0, 200)})`).toBe(200);
      expect(pos.settledAs).toBe("confirmed-200");
      const body = (pos.json ?? {}) as { access_token?: unknown; refresh_token?: unknown };
      expect(typeof body.access_token, "ต้องได้ access_token ใหม่").toBe("string");
      expect(typeof body.refresh_token, "ต้องได้ refresh_token หมุนใหม่").toBe("string");
      expect((await invocationState(pos.opKey))?.status).toBe("settled");

      // RT เดิมถูกกินแล้ว (rotation) — ไฟล์นี้ไม่ reuse (limitation 20)
      await ledgerWrite("note", { event: "h8q-ka-complete", opKey: pos.opKey });
    },
    30_000,
  );

  it(
    "(ข) หยุด auth → refresh วนตามงบ 60 วิ ทุกครั้ง unresolved-gateway → budget poison → guard ปฏิเสธ → restart+health ใน finally",
    async () => {
      // RT สดต่อ fixture — ของ ก ถูก rotation กินไปแล้ว
      const user2 = await createTestUser("h8q-kh");
      const opKey = "kong:POST:/auth/v1/token";
      const guard = await attemptBegin(opKey, "h8q-kh-refresh-budget");
      const statuses: number[] = [];
      const dispatchMs: number[] = [];

      const stop = await compose(["stop", "auth"]);
      expect(stop.code, `docker compose stop auth ล้ม: ${stop.stderr.slice(0, 200)}`).toBe(0);
      try {
        // warm-up นอก transport: dispatch แรกหลัง auth ตาย Kong ยังจำ upstream เป็น
        // healthy → ถือ connection ค้างจน connect-timeout ของตัวเอง (วัดจริง ~54 วิ
        // ก่อนตอบ 503 · หลังครั้งนั้นตอบ 503 เร็ว ~1-70ms เพราะ mark unreachable แล้ว)
        // — ให้ probe ธรรมดา (fake RT) รับความช้าครั้งเดียวนี้แทน loop ของ transport
        const warmupStart = Date.now();
        let warmupStatus = "aborted";
        try {
          const w = await fetch(`${REST_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            headers: { apikey: ANON_KEY, "content-type": "application/json" },
            body: JSON.stringify({ refresh_token: "warmup-not-a-real-token" }),
            signal: AbortSignal.timeout(70_000),
          });
          warmupStatus = String(w.status);
        } catch {
          // abort/timeout — Kong ก็ตัด target ไปแล้วเองที่ timeout ของมัน ณ จุดนี้
          // dispatch ต่อๆ มาเร็วอยู่ดี
        }
        await ledgerWrite("note", {
          event: "h8q-kh-kong-warmup",
          elapsedMs: Date.now() - warmupStart,
          outcome: warmupStatus,
        });
        // งบ 60 วิ (เดิม 30 วิ — battery r10 ล้มจริง: dispatch หลัง auth ตายแพงตาม
        // จริง 17.6s/18.7s วัดก่อนหน้า และรอบ r10 หนึ่ง dispatch กิน ≥28 วิ จน window
        // 30 วิใส่ได้ 1 อันเดียว — สิ่งที่พิสูจน์คือ "วนจริง ≥2 ครั้ง ทุกครั้ง gateway-5xx"
        // งบจึงต้องครอบ dispatch ที่แพงสุดที่เคยวัด 2 ครั้ง + sleep พร้อม margin)
        const loopDeadline = Date.now() + 60_000;
        while (Date.now() < loopDeadline) {
          const dispatchStart = Date.now();
          const res = await httpWrite(
            "POST",
            `${REST_URL}/auth/v1/token?grant_type=refresh_token`,
            { refresh_token: user2.refreshToken },
            {
              transportTarget: "kong-path",
              invocationId: guard.invocationId,
              label: "h8q-kh-dispatch",
            },
          );
          dispatchMs.push(Date.now() - dispatchStart);
          statuses.push(res.status);
          expect(res.status, "Kong ต่อ auth ที่ตายต้องตอบ gateway-5xx").toBeGreaterThanOrEqual(500);
          expect(res.settledAs, "gateway 5xx = retryable ไม่มี terminal — ห้าม settle").toBe("unresolved-gateway");
          await sleep(2_000);
        }
        // หมายเหตุขนาดจริง (วัดจาก stack): dispatch หนึ่งครั้งหลัง auth ตายแพง 17.6s/18.7s
        // (วัด 2026-09-15 00:28) จนถึง ≥28 วิ (วัด r10 08:35) — Kong balancer ลองต่อ
        // upstream หลายรอบ × connect-timeout ไม่มี healthcheck ให้ mark target ถาวร
        // ความแปรผันนี้เป็นของจริงของ stack สิ่งที่ต้องพิสูจน์คือ "วนจริงอย่างน้อยสองครั้ง
        // ทุกครั้งคือ gateway-5xx unresolved" ไม่ใช่จำนวนสูงสุด
        expect(statuses.length, "วนจริง ≥2 dispatches ภายในงบ loop 30 วิ").toBeGreaterThanOrEqual(2);
        expect((await invocationState(opKey))?.status, "หลัง dispatch สุดท้ายยังไม่ terminal-settled").toBe("unresolved");

        // งบ หมด โดยไม่มี terminal ต้นทาง → poison — ไม่มีทาง settle สิ่งที่ไม่มี terminal
        // (budget ของ loop = 30 วิ + warm-up/latency จบก่อน test-timeout 200 วิ)
        await invocationClose(guard.invocationId, opKey, "poisoned", {
          reason: "refresh-retryable-budget-exceeded",
          attempts: statuses.length,
          lastStatuses: statuses.slice(-3),
          dispatchMs,
        });
        expect((await invocationState(opKey))?.status).toBe("poisoned");

        // poisoned = เคลียร์มือก่อน — attempt ใหม่ของ opKey เดิมถูกปฏิเสธ
        let refused: unknown = null;
        try {
          await attemptBegin(opKey, "h8q-kh-after-poison");
        } catch (err) {
          refused = err;
        }
        expect(refused).toBeInstanceOf(GuardRefusedError);
        expect(String(refused)).toContain("poisoned");
      } finally {
        const start = await compose(["start", "auth"]);
        if (start.code !== 0) {
          await ledgerWrite("note", { event: "h8q-auth-restart-failed", stderr: start.stderr.slice(0, 300) });
        }
        expect(await waitAuthHealthy(30_000), "ltc-dev-auth ต้องกลับมาสุขภาพดีก่อนจบเทส").toBe(true);
        await manualClearPoison(opKey, "h8q(ข) เคลียร์ poisoned ใน teardown ด้วย intent (negative fixture)");
      }
      expect((await invocationState(opKey))?.status).toBe("cleared-manual");
      await ledgerWrite("note", { event: "h8q-kh-complete", invocationRef: randomUUID().slice(0, 8) });
    },
    200_000,
  );
});

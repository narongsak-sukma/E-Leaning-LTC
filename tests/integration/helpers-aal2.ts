/**
 * helpers-aal2.ts — mint session aal2 จริงจาก GoTrue ให้ผู้ใช้ fixture ของ integration
 * tests (gate r1 BLOCKER-3 — RPC ฝั่ง admin ของ 0031 B3 + 0032 บังคับ
 * auth.jwt()->>'aal' = 'aal2')
 *
 * ทางเดินจริงของ GoTrue v2.164.0 (probe บน dev stack 2026-09-12): MFA endpoints
 * mount ที่ /auth/v1/factors* — **ไม่มี route /mfa/*** (404 ที่เจอครั้งแรกไม่ใช่
 * เพราะ config ปิด MFA แต่เพราะเวอร์ชันนี้ไม่มี route เหล่านั้นจริง) · TOTP เปิด
 * ตาม default ของ GoTrue (EnrollEnabled/VerifyEnabled = true) ไม่ต้องตั้ง env ใด
 *
 *   (1) password grant ใหม่ → access_token aal1 (session ที่ mint เอง — ไม่แตะ
 *       user.accessToken ที่เทสฝั่ง "ปฏิเสธ" ใช้ เพราะ verify จะ invalidate
 *       aal1 session ที่ใช้ทำ flow เท่านั้น)
 *   (2) POST /auth/v1/factors {factor_type:"totp"} (Bearer aal1) → {id, totp.secret}
 *   (3) คำนวณรหัส RFC 6238 (HMAC-SHA1 · step 30s · 6 หลัก) จาก secret base32
 *   (4) POST /auth/v1/factors/{id}/challenge {} → {id} (challenge_id)
 *   (5) POST /auth/v1/factors/{id}/verify {challenge_id, code} → 200 = session ใหม่
 *       ที่ claim aal = 'aal2' (assert ในตัวก่อนคืนค่า)
 *
 * ห้ามใช้ไฟล์นี้นอก dev/test — เรียก GoTrue/Kong ของ dev stack เท่านั้น
 */
import { createHmac } from "node:crypto";

import { restCall, TEST_PASSWORD, type RestResult, type TestUser } from "./helpers.js";

/** ถอด payload ของ JWT (ไม่ตรวจลายเซ็น — ใช้กับ token ที่ GoTrue เพิ่งออกให้เท่านั้น) */
function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64").toString("utf8")) as Record<string, unknown>;
}

/** fail-loud — ทุก step ของ flow ต้อง 200 ไม่เช่นนั้น throw พร้อมบริบทของ step นั้น */
function expectOk(step: string, res: RestResult): void {
  if (res.status !== 200) {
    throw new Error(`helpers-aal2 ${step} ล้ม (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
  }
}

/** base32 decode (RFC 4648 — alphabet มาตรฐาน ไม่มี padding) สำหรับ secret ของ TOTP */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/=+$/g, "")) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** รหัส TOTP 6 หลัก (RFC 6238 — HMAC-SHA1 · step 30 วินาที) ณ หน้าต่างเวลาที่กำหนด */
function totpAt(secret: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * mint session aal2 จริง: enroll TOTP → challenge → verify ผ่าน GoTrue — คืน
 * access_token ที่ claim aal = 'aal2' · ไม่กระทบ user.accessToken (fresh password
 * grant ภายใน — session aal1 เดิมของเทสฝั่ง reject ยังใช้ได้ตามปกติ)
 */
export async function mintAal2Token(user: TestUser): Promise<string> {
  // (1) fresh password grant — session aal1 แยกสำหรับ flow
  const login = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email: user.email, password: TEST_PASSWORD },
  );
  expectOk("password grant", login);
  const aal1 = (login.json as { access_token?: string }).access_token ?? "";
  if (aal1 === "") {
    throw new Error("helpers-aal2: password grant ไม่คืน access_token");
  }
  // (2) enroll factor TOTP (factor cascade ลบตาม auth.users ตอน cleanup)
  const enroll = await restCall(
    "POST",
    "/auth/v1/factors",
    { token: aal1 },
    { factor_type: "totp", friendly_name: "e12-integration-harness" },
  );
  expectOk("factors enroll", enroll);
  const factorId = (enroll.json as { id?: string }).id ?? "";
  const secret = (enroll.json as { totp?: { secret?: string } }).totp?.secret ?? "";
  if (factorId === "" || secret === "") {
    throw new Error(`helpers-aal2: enroll ไม่คืน id/secret: ${enroll.text.slice(0, 200)}`);
  }
  // (3)+(4) challenge แล้วคำนวณรหัสของหน้าต่างปัจจุบัน
  const challenge = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/challenge`,
    { token: aal1 },
    {},
  );
  expectOk("factors challenge", challenge);
  const challengeId = (challenge.json as { id?: string }).id ?? "";
  // (5) verify — ถ้าข้ามขอบหน้าต่าง 30s พอดีระหว่าง challenge→verify (challenge_id
  //     ใช้ครั้งเดียว) ขอ challenge ใหม่แล้วลองรหัสของหน้าต่างถัดไปครั้งเดียว
  let verify = await restCall(
    "POST",
    `/auth/v1/factors/${factorId}/verify`,
    { token: aal1 },
    { challenge_id: challengeId, code: totpAt(secret, Date.now() / 1000) },
  );
  if (verify.status !== 200) {
    console.warn(
      "[helpers-aal2] TOTP window rollover — ขอ challenge ใหม่ แล้ว verify ด้วยรหัสหน้าต่างถัดไป",
    );
    const challenge2 = await restCall(
      "POST",
      `/auth/v1/factors/${factorId}/challenge`,
      { token: aal1 },
      {},
    );
    expectOk("factors challenge (retry)", challenge2);
    const challengeId2 = (challenge2.json as { id?: string }).id ?? "";
    verify = await restCall(
      "POST",
      `/auth/v1/factors/${factorId}/verify`,
      { token: aal1 },
      { challenge_id: challengeId2, code: totpAt(secret, Date.now() / 1000 + 30) },
    );
  }
  expectOk("factors verify", verify);
  const token = (verify.json as { access_token?: string }).access_token ?? "";
  if (token === "") {
    throw new Error(`helpers-aal2: verify ไม่คืน access_token: ${verify.text.slice(0, 200)}`);
  }
  // guard ท้าย flow — session ที่คืนต้อง aal2 จริง (ไม่งั้นให้เทสพังตรงจุดนี้เสมอ)
  const claims = jwtPayload(token);
  if (claims["aal"] !== "aal2") {
    throw new Error(`helpers-aal2: session ใหม่ไม่ใช่ aal2 (aal=${String(claims["aal"])})`);
  }
  return token;
}

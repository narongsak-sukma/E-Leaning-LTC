/**
 * mfa — ห้องเครื่อง MFA ของแอป (Wave F · D-f-1)
 *
 * ครอบคลุม 4 หมวด:
 * 1) TOTP (RFC 6238) — คำนวณรหัส 6 หลักจาก secret base32 ด้วย node:crypto ล้วน
 *    (ใช้เฉพาะเส้นทาง "โค้ดสำรอง" ของการเข้าสู่ระบบสองขั้น — ไม่มีทางใดใช้เพื่อหลีกเลี่ยง
 *     การยืนยันของ GoTrue: ทุกเส้นทางยังจบด้วย challenge+verify ของ GoTrue เสมอ)
 * 2) โค้ดสำรอง (backup codes) — สร้างจาก CSPRNG รูป `xxxx-xxxx` ชุดอักษรไม่มีตัวเลข/ตัวอักษร
 *    ที่สับสน · hash ด้วย sha256 ของ `code.trim().toLowerCase()` ตามสัญญาของ migration 0042
 *    (เทียบ fixture ได้ใน mfa.test.ts)
 * 3) recent-MFA (หน้าต่าง 15 นาที) — อ่าน claim `aal`/`amr` จาก access token ของ session
 *    ที่ GoTrue ออกให้ (claim ลงนามโดย GoTrue — อ่านค่าหลัง requireUser ตรวจกับ Auth server
 *    แล้วเท่านั้น)
 * 4) client interop — client เดี่ยว (ไม่ผูก cookie) สำหรับขั้น password ของ login สองขั้น
 *    + stash ฝั่ง server ของ token ขั้น password (cookie `ltc_mfa_pending` เก็บ uuid
 *    เท่านั้น — gate r1 F2/F5)
 *
 * ข้อจำกัดของ GoTrue v2.164.0 (probe จริง 2026-09-13):
 * - GET /admin/users/{id}/factors **ไม่คืน secret** และ POST /admin/users/{id}/factors
 *   (admin create factor) ตอบ 405 — ฝั่ง service จึงไม่มีทางอ่าน secret ของ factor ผู้ใช้
 * - เส้นทางโค้ดสำรองของ login สองขั้นจึง "ปั้น" aal2 ด้วย recovery factor ชั่วคราว:
 *   enroll factor ใหม่บน pending session (GoTrue คืน secret เฉพาะตอน enroll) → challenge +
 *   verify ด้วยรหัสที่คำนวณจาก secret นั้น → GoTrue ออก session aal2 → ลบ recovery factor
 *   ทันที ความปลอดภัยเทียบเท่า (รหัสผ่าน + โค้ดสำรองที่ DB ตรวจ single-use ก่อนขั้นนี้เสมอ)
 *   และ session ที่ได้เป็น session จริงของ GoTrue (หมุน refresh token ตามปกติ) —
 *   ดู mintAal2ForBackupLogin()
 */
import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getConfig } from "../config";
import { AppError } from "../errors";
import { requiresMfa } from "../rbac";

/** ชื่อ cookie ชั่วคราวของ login สองขั้น (token ของ session aal1 ที่ยังไม่ยืนยัน MFA) */
export const MFA_PENDING_COOKIE = "ltc_mfa_pending";

/** อายุ cookie ชั่วคราว (วินาที) — 5 นาทีพอสำหรับพิมพ์รหัส */
export const MFA_PENDING_COOKIE_MAX_AGE = 300;

/** หน้าต่าง recent-MFA (วินาที) — การกระทำอันตรายต้องยืนยัน MFA ภายใน 15 นาที */
export const MFA_RECENT_WINDOW_SEC = 900;

/** จำนวนโค้ดสำรองต่อชุด (สัญญา RPC รับ 8-12 — เราออกชุดละ 8 เสมอ) */
export const BACKUP_CODE_COUNT = 8;

/** ชุดอักษรของโค้ดสำรอง — ไม่มี 0/1/i/l/o (กันสับสนเมื่ออ่าน/พิมพ์) */
const BACKUP_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

const BACKUP_CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/;

// ─── 1) TOTP (RFC 6238) ───────────────────────────────────────────────────────

/**
 * base32 decode (RFC 4648 — alphabet มาตรฐาน A-Z2-7 ไม่มี padding) —
 * secret ที่ GoTrue ออกเป็น base32 ล้วน อักขระแปลกปลอมถูกข้าม (เหมือน helpers-aal2)
 */
export function base32Decode(input: string): Buffer {
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

/**
 * รหัส TOTP 6 หลัก ณ หน้าต่างเวลา (RFC 6238 — HMAC-SHA1 · step 30 วินาที · dynamic
 * truncation ตามมาตรฐาน) — เวกเตอร์ทดสอบ RFC อยู่ใน mfa.test.ts
 */
export function totpCode(secret: string, unixSeconds: number): string {
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

// ─── 2) โค้ดสำรอง ─────────────────────────────────────────────────────────────

/** hash ของโค้ดสำรอง — สัญญาเดียวกับ migration 0042: sha256 hex ของ trim+lowercase (utf8) */
export function backupCodeHash(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * สร้างชุดโค้ดสำรองด้วย CSPRNG (crypto.randomBytes) — รูป `xxxx-xxxx` ชุดอักษร
 * 23456789abcdefghjkmnpqrstuvwxyz · กันซ้ำในชุด (โอกาสซ้ำต่ำมากอยู่แล้ว แต่ RPC
 * ปฏิเสธชุดซ้ำ — วนสุ่มซ้ำจนได้ครบ)
 */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): {
  readonly codes: readonly string[];
  readonly hashes: readonly string[];
} {
  if (!Number.isInteger(count) || count < 8 || count > 12) {
    throw new Error("generateBackupCodes: count ต้องเป็น 8-12");
  }
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = randomBytes(8);
    let raw = "";
    for (let i = 0; i < 8; i += 1) {
      const byte = bytes[i] ?? 0;
      raw += BACKUP_ALPHABET[byte % BACKUP_ALPHABET.length];
    }
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  const list = [...codes];
  return { codes: list, hashes: list.map(backupCodeHash) };
}

/**
 * จัดรูป input ของผู้ใช้เป็น `xxxx-xxxx` — trim + lowercase + เติมขีดกลางเมื่อพิมพ์
 * ติดกัน 8 ตัว · รูปอื่น (สั้น/ยาวเกิน หรือมี 0/1/i/l/o ซึ่งไม่มีทางเป็นโค้ดจริง) = null
 * (ห้ามส่ง input ดิบเข้า RPC — consume จะ hash ค่าที่ส่งเข้าไป รูปเพี้ยน = ไม่มีทางตรง)
 */
export function normalizeBackupCodeInput(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const compact = value.startsWith("xxxx")
    ? value
    : /^[a-z0-9]{8}$/.test(value)
      ? `${value.slice(0, 4)}-${value.slice(4)}`
      : value;
  return BACKUP_CODE_RE.test(compact) ? compact : null;
}

// ─── 3) recent-MFA (claim aal/amr ของ access token) ──────────────────────────

/** payload ของ JWT (ไม่ตรวจลายเซ็น — ใช้กับ token ที่ GoTrue ตรวจแล้วผ่าน requireUser/getUser) */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * recent-MFA — session ต้อง aal2 **และ** มี amr แบบ mfa/* ล่าสุดภายในหน้าต่าง
 * (default 15 นาที) · aal1 หรือไม่มี amr = ไม่ผ่านเสมอ
 */
export function hasRecentMfa(
  payload: Record<string, unknown> | null,
  nowUnixSec: number,
  windowSec: number = MFA_RECENT_WINDOW_SEC,
): boolean {
  if (payload === null || payload["aal"] !== "aal2") {
    return false;
  }
  const amr = payload["amr"];
  if (!Array.isArray(amr)) {
    return false;
  }
  let latest = -1;
  for (const entry of amr) {
    const method = String((entry as { method?: unknown }).method ?? "");
    // GoTrue v2.164.0 ใส่ "totp" ล้วน (ไม่มี prefix "mfa/") ใน token ที่ verify ออกใหม่ —
    // รับทั้งสองรูป (เอกสาร Supabase ใช้ "mfa/totp") — ดู probe จริง DCR-14
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { method?: unknown }).method === "string" &&
      (method === "totp" || method.startsWith("mfa/")) &&
      typeof (entry as { timestamp?: unknown }).timestamp === "number"
    ) {
      latest = Math.max(latest, (entry as { timestamp: number }).timestamp);
    }
  }
  return latest >= 0 && nowUnixSec - latest <= windowSec;
}

/**
 * recent-MFA จาก session ปัจจุบันของ client (user-JWT SSR client) —
 * ผู้เรียกต้องผ่าน requireUser()/getUser() (GoTrue ตรวจ token แล้ว) ก่อนเรียกเสมอ
 */
export async function sessionHasRecentMfa(client: SupabaseClient): Promise<boolean> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (typeof token !== "string" || token === "") {
    return false;
  }
  return hasRecentMfa(decodeJwtPayload(token), Math.floor(Date.now() / 1000));
}

/**
 * guard บทบาทสำหรับการปิด MFA — บทบาทบังคับ MFA (instructor และ staff:viewer, staff:content, staff:exam, staff:registrar และ super_admin)
 * ห้ามปิดเด็ดขาด (คืนข้อความไทยที่มีคำ MFA ตามสัญญา) · citizen/lawyer ผ่าน
 */
export function assertMfaDisableAllowed(roles: readonly string[]): void {
  if (requiresMfa(roles)) {
    throw new AppError("ERR-RBAC-001", {
      message: "บทบาทของคุณต้องใช้การยืนยันตัวตนสองชั้น (MFA) จึงปิดใช้งาน MFA ไม่ได้",
    });
  }
}

// ─── 4) client interop ────────────────────────────────────────────────────────

/**
 * client เดี่ยว (ไม่ผูก cookie — persistSession:false) สำหรับ:
 * - ขั้น password ของ login สองขั้น (ห้ามเขียน session cookie ตั้งแต่ขั้นนี้ —
 *   ผู้ใช้ที่ต้องยืนยัน MFA ยังไม่ "เข้าระบบจริง" จนกว่า step-2 จะผ่าน)
 * - ต่อ session จาก token ของ stash ฝั่ง server (setSession อ่านเข้า memory เท่านั้น)
 */
export function createStandaloneAuthClient(): SupabaseClient {
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** token pair ของขั้น password ที่ยังไม่ยืนยัน MFA (refresh token จำเป็น — setSession ของ SDK ต้องใช้) */
export interface PendingMfaTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

// ─── 4a) stash ฝั่ง server (gate r1 F2/F5 · migration 0045) ───────────────────
//
// เดิม (รูปแบบที่ gate ปฏิเสธ): แพ็ก token จริงเป็น JSON ลง cookie — ใครก็ตาม
// อ่าน Set-Cookie ได้ (client ที่ไม่ใช่ browser/HTTPS proxy log) ถือ session aal1
// เต็มตัวโดยไม่ต้องผ่านขั้นสอง · ใหม่: token ถูกเข้ารหัส (AES-256-GCM) เก็บใน
// ตาราง mfa_pending_stash ผ่าน RPC — cookie เก็บ uuid ของแถวอย่างเดียว · อายุ/
// single-use บังคับที่ DB (expires_at/consumed_at) ไม่ใช่ browser maxAge

/** รูป uuid v4 — ค่าเดียวที่ cookie ชั่วคราวมีสิทธิ์บรรจุ */
const PENDING_STASH_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** ค่า cookie ชั่วคราว → uuid ของ stash — ค่าอื่นทุกชนิด = null (fail-closed) */
export function parsePendingStashCookie(raw: string): string | null {
  return PENDING_STASH_ID_RE.test(raw) ? raw : null;
}

/** ถอด base64 → คีย์ 32 ไบต์ของ AES-256 — รูปอื่น = null (ผู้เรียกตอบ fail-closed) */
export function decodePendingStashKey(b64: string): Buffer | null {
  try {
    const key = Buffer.from(b64, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/**
 * AAD ผูก ciphertext ของ stash เข้ากับ **เจ้าของแถว + deadline** (gate r2 G1) —
 * `${userId}:${deadlineUnixSec}` · create ใช้ค่าจาก session ที่กำลัง stash ·
 * take ใช้ค่าจากแถวที่ RPC คืน — สำเนา ciphertext ที่ถูก re-host ไปแถวของ
 * ผู้อื่น (user_id เจ้าของใหม่ + deadline ใหม่) GCM auth ไม่ผ่าน = ถอดไม่ได้
 */
export function pendingStashAad(userId: string, deadlineUnixSec: number): string {
  return `${userId}:${deadlineUnixSec}`;
}

/** เข้ารหัส token pair เป็น payload ของ stash: `v1.<iv>.<tag>.<ct>` (base64url) — AAD ผูก (userId, deadlineSec) */
export function encryptPendingStashPayload(
  tokens: PendingMfaTokens,
  key: Buffer,
  aad: string,
): string | null {
  const { accessToken, refreshToken } = tokens;
  if (typeof accessToken !== "string" || accessToken === "" || typeof refreshToken !== "string" || refreshToken === "") {
    return null;
  }
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const plaintext = Buffer.from(JSON.stringify({ a: accessToken, r: refreshToken }), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  } catch {
    return null;
  }
}

/** ถอด payload ของ stash กลับเป็น token pair — ค่าเพี้ยน/แก้ไข/คีย์ผิด/AAD ไม่ตรง = null (GCM ตรวจ) */
export function decryptPendingStashPayload(
  payload: string,
  key: Buffer,
  aad: string,
): PendingMfaTokens | null {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const accessToken = record["a"];
    const refreshToken = record["r"];
    if (typeof accessToken !== "string" || accessToken === "" || typeof refreshToken !== "string" || refreshToken === "") {
      return null;
    }
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}

/**
 * เก็บ token pair ลง stash ฝั่ง server — คืน uuid ให้ใส่ cookie หรือ null เมื่อ
 * ไม่มีคีย์ (LTC_MFA_PENDING_KEY)/เข้ารหัสไม่ได้/RPC ปฏิเสธ (ทุกกรณี = ERR-SYS-001
 * ที่ caller — fail-closed ห้าม fallback กลับไปแพ็ก token ใน cookie)
 *
 * gate r2 G1: ciphertext ผูกกับ (userId, deadlineSec) ผ่าน AAD — RPC ตรวจกรอบ
 * p_expires_at (> now, ≤ now+305s) แล้วเก็บค่าที่ส่งไป as-is เพื่อให้ AAD ฝั่ง
 * take (อ่านจากแถว) ตรงค่านี้เป๊ะ
 */
export async function stashPendingMfaTokens(
  client: SupabaseClient,
  tokens: PendingMfaTokens,
  userId: string,
): Promise<string | null> {
  const { mfaPendingKey } = getConfig();
  if (mfaPendingKey === null) {
    return null;
  }
  const key = decodePendingStashKey(mfaPendingKey);
  if (key === null) {
    return null;
  }
  const deadlineMs = Date.now() + MFA_PENDING_COOKIE_MAX_AGE * 1000;
  const deadlineSec = Math.floor(deadlineMs / 1000);
  const aad = pendingStashAad(userId, deadlineSec);
  const payload = encryptPendingStashPayload(tokens, key, aad);
  if (payload === null) {
    return null;
  }
  const { data, error } = await client.rpc("mfa_pending_stash_create", {
    p_payload: payload,
    p_expires_at: new Date(deadlineMs).toISOString(),
  });
  if (error !== null || typeof data !== "string" || !PENDING_STASH_ID_RE.test(data)) {
    return null;
  }
  return data;
}

/**
 * ขอคืน token pair จาก stash (ขั้นสอง — ยังไม่มี session: ยิง RPC ด้วย anon key
 * ของ standalone client · uuid คือ bearer secret 122 บิต + อายุ 300 วิที่ DB) ·
 * **peek ไม่ใช่ consume** — รหัสผิดพยายามใหม่ได้เท่าอายุที่เหลือ (single-use
 * ตัดสินที่ consumePendingMfaTokens หลัง verify สำเร็จเท่านั้น) · ไม่มี/ใช้แล้ว/
 * หมดอายุ/ถอดไม่ได้ = null → caller ตอบ state=expired
 */
export async function takePendingMfaTokens(stashId: string): Promise<PendingMfaTokens | null> {
  if (!PENDING_STASH_ID_RE.test(stashId)) {
    return null;
  }
  const { mfaPendingKey } = getConfig();
  if (mfaPendingKey === null) {
    return null;
  }
  const key = decodePendingStashKey(mfaPendingKey);
  if (key === null) {
    return null;
  }
  const client = createStandaloneAuthClient();
  const { data, error } = await client.rpc("mfa_pending_stash_take", { p_id: stashId });
  // gate r2 G1: RPC คืน jsonb {payload, user_id, expires_at} ของแถวจริง — AAD
  // ประกอบจากสองค่านี้ (ไม่ใช่ค่าที่ผู้เรียกเดาเอง) ก่อนถอดรหัส · รูปไม่ใช่/
  // ถอดไม่ได้ (สำเนา re-host ของคนอื่น) = null → caller ตอบ state=expired
  if (
    error !== null ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data)
  ) {
    return null;
  }
  const row = data as { payload?: unknown; user_id?: unknown; expires_at?: unknown };
  const payload = row.payload;
  const rowUserId = row.user_id;
  const expiresAt = row.expires_at;
  if (
    typeof payload !== "string" ||
    payload === "" ||
    typeof rowUserId !== "string" ||
    rowUserId === "" ||
    typeof expiresAt !== "string"
  ) {
    return null;
  }
  const deadlineMs = Date.parse(expiresAt);
  if (!Number.isFinite(deadlineMs)) {
    return null;
  }
  return decryptPendingStashPayload(payload, key, pendingStashAad(rowUserId, Math.floor(deadlineMs / 1000)));
}

/**
 * ปิด stash หลัง verify สำเร็จ (single-use จริง — uuid ตายทันทีที่ออก session:
 * replay คุกกี้เดิมไม่มีทางกลับมาได้ token)
 *
 * gate r2 G3 — fail-closed: คืน **true เฉพาะเมื่อ DB ยืนยันการ consume จริง**
 * (แถวยังไม่ถูกใช้ + ยังไม่หมดอายุ — 0046 เพิ่ม `expires_at > now()` ที่ UPDATE)
 * · false = แถวถูก consume ไปแล้ว/หมดอายุ/id รูปเพี้ยน — caller **ห้ามออก
 * session** (ตอบ state=expired) · RPC error = throw ERR-SYS-001 ให้ caller ตอบ
 * ข้อผิดพลาดระบบ — ทุกกรณีที่ไม่ใช่ "consume สำเร็จเต็มรูปแบบ" ไม่มี session
 */
export async function consumePendingMfaTokens(
  stashId: string,
  client: SupabaseClient = createStandaloneAuthClient(),
): Promise<boolean> {
  if (!PENDING_STASH_ID_RE.test(stashId)) {
    return false;
  }
  const { data, error } = await client.rpc("mfa_pending_stash_consume", { p_id: stashId });
  if (error !== null) {
    throw new AppError("ERR-SYS-001", { details: { reason: "mfa_pending_stash_consume_failed" } });
  }
  return data === true;
}

/** client ที่ถือ pending session (token จาก cookie ชั่วคราว) — เรียก auth.mfa และ rpc ผ่านตัวนี้ */
export async function createPendingMfaClient(tokens: PendingMfaTokens): Promise<SupabaseClient> {
  const client = createStandaloneAuthClient();
  const { error } = await client.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  if (error !== null) {
    // token หมดอายุ/ถูกเพิกถอน — pending ใช้ไม่ได้อีก (cookie ฝั่ง caller จะถูกล้าง)
    throw new AppError("ERR-AUTH-005");
  }
  return client;
}

/**
 * factor TOTP ที่ verified ตัวแรกของผู้ใช้ (ลำดับเดียวกับ listFactors — โมเดลของเรา
 * คือบัญชีละ 1 factor ที่ใช้งาน; กรณีหลาย factor ถือ "ตัวแรกที่ verified" เป็น canonical)
 */
export function firstVerifiedTotpFactor(
  factors: readonly { factor_type: string; status: string; id: string }[],
): { id: string } | null {
  const found = factors.find((f) => f.factor_type === "totp" && f.status === "verified");
  return found ? { id: found.id } : null;
}

// ─── เส้นทางโค้ดสำรองของ login สองขั้น ────────────────────────────────────────

/** ผลของการปั้น aal2 — token คู่ใหม่จาก GoTrue (session จริง หมุน refresh ได้) */
export interface MintedAal2Session {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * **ปั้น session aal2 สำหรับเส้นทางโค้ดสำรอง** — เรียกเฉพาะหลัง `mfa_backup_codes_consume`
 * คืน valid:true (รหัสผ่านถูกพิสูจน์ด้วย pending session + โค้ดสำรองถูกตรวจ single-use
 * โดย DB แล้ว) ดูข้อจำกัดของ GoTrue ที่หัวไฟล์ (admin API ไม่คืน secret ทำให้ทาง
 * "อ่าน secret ของ factor ผู้ใช้" เป็นไปไม่ได้)
 *
 * ลำดับ (ล้มขั้นใด = throw ERR-SYS-001 — โค้ดสำรองที่เพิ่งใช้ถือว่าถูกเผา ผู้ใช้ลอง
 * เส้นทาง TOTP ปกติแทน หรือ regenerate ชุดใหม่จากหน้าความปลอดภัย):
 * 1) enroll recovery factor บน pending session → GoTrue คืน secret (ครั้งเดียว)
 * 2) challenge + verify ด้วยรหัส TOTP ที่คำนวณจาก secret นั้น (ถ้าข้ามขอบหน้าต่าง
 *    30 วิพอดี → challenge ใหม่ + รหัสหน้าต่างถัดไป — เช่นเดียวกับ helpers-aal2)
 *    → GoTrue ออก session ใหม่ที่ claim aal=aal2
 * 3) ลบ recovery factor ทันที (session คง aal2 เพราะ factor TOTP จริงของผู้ใช้ยัง
 *    verified อยู่ — GoTrue คำนวณ aal จาก "มี factor verified" ตอน refresh)
 */
export async function mintAal2ForBackupLogin(pending: SupabaseClient): Promise<MintedAal2Session> {
  // 1) recovery factor ชั่วคราว — secret ปรากฏเฉพาะใน response นี้ (ในหน่วยความจำ)
  const enroll = await pending.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `ltc-recovery-${Date.now()}`,
  });
  const factorId = enroll.data?.id;
  const secret = enroll.data?.totp?.secret;
  if (enroll.error !== null || typeof factorId !== "string" || typeof secret !== "string" || secret === "") {
    throw new AppError("ERR-SYS-001", { details: { reason: "backup_login_enroll_failed" } });
  }
  try {
    // 2) challenge + verify ด้วยรหัสที่คำนวณเอง (GoTrue รับ skew ±1 หน้าต่าง)
    const minted = await challengeAndVerifyTotp(pending, factorId, () =>
      totpCode(secret, Math.floor(Date.now() / 1000)),
    );
    if (minted === null) {
      throw new AppError("ERR-SYS-001", { details: { reason: "backup_login_verify_failed" } });
    }
    return minted;
  } finally {
    // 3) ลบ factor ชั่วคราวเสมอ (แม้ verify พลาด — ห้ามทิ้ง factor ค้าง)
    await pending.auth.mfa.unenroll({ factorId });
  }
}

/**
 * challenge + verify TOTP หนึ่งรอบ พร้อม retry ข้ามขอบหน้าต่างครั้งเดียว
 * (challenge_id ใช้ครั้งเดียว) — คืน token คู่ใหม่จาก GoTrue หรือ null เมื่อรหัสไม่ผ่าน
 */
export async function challengeAndVerifyTotp(
  client: SupabaseClient,
  factorId: string,
  codeAt: (unixSeconds: number) => string,
): Promise<MintedAal2Session | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const challenge = await client.auth.mfa.challenge({ factorId });
    if (challenge.error !== null || typeof challenge.data?.id !== "string") {
      throw new AppError("ERR-SYS-001", { details: { reason: "mfa_challenge_failed" } });
    }
    // รอบแรก = รหัสของหน้าต่างปัจจุบัน · รอบสอง (ถ้ารอบแรกล้ม) = หน้าต่างถัดไป
    // (ข้ามขอบหน้าต่าง 30 วิพอดีระหว่าง challenge→verify — เช่นเดียวกับ helpers-aal2)
    const unixSec = Math.floor(Date.now() / 1000) + (attempt === 0 ? 0 : 30);
    const verify = await client.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code: codeAt(unixSec),
    });
    if (verify.error === null) {
      const accessToken = verify.data?.access_token;
      const refreshToken = verify.data?.refresh_token;
      if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
        throw new AppError("ERR-SYS-001", { details: { reason: "mfa_verify_bad_contract" } });
      }
      return { accessToken, refreshToken };
    }
  }
  return null;
}

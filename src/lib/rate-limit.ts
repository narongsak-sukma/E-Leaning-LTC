/**
 * rate-limit — in-memory rate limiter (SDS §5.3: dev/สำรอง prod ในกระบวนการ Next)
 *
 * - กลุ่ม+ค่า canonical ตาม API-SPECIFICATION §5 ทั้ง 10 กลุ่ม — ค่าทุกตัวอ่านจาก lib/config
 *   (SRS Appendix A = defaults master) ห้าม hardcode
 * - คีย์นับแบบ cumulative ต่อกลุ่ม (D12-11): IP counter เสมอ + คีย์รอง (user_id / อีเมล normalized /
 *   ปลายทาง OTP) — นับแยกทั้งคู่ "ใครถึงขีดก่อนถูกจำกัดก่อน"
 * - เกิน → AppError ERR-RATE-001 (429) พร้อม details.retry_after_sec
 *   (jsonError ตั้ง header Retry-After ให้ — §5)
 * - หมายเหตุ: ตัวนับอยู่ในหน่วยความจำของ process — ต่อ instance, หายตอน restart (ยอมรับตาม §5.3)
 */
import { AppError } from "./errors";
import { getConfig, type AppConfig } from "./config";

/** กลุ่ม rate limit ครบทุกกลุ่มของ API-SPECIFICATION §5 */
export const RATE_LIMIT_GROUPS = [
  "AUTH",
  "OTP_REQUEST",
  "PWD_RESET",
  "MFA",
  "PUBLIC_READ",
  "READ",
  "LEARN_WRITE",
  "EXAM",
  "STAFF_WRITE",
  "EXPORT",
] as const;

export type RateLimitGroup = (typeof RATE_LIMIT_GROUPS)[number];

/** คีย์รองประจำกลุ่ม (คู่กับ IP counter เสมอ — D12-11); PUBLIC_READ นับเฉพาะ IP ตาม §5 */
export type SecondaryKeyKind = "user" | "email" | "destination" | null;

interface GroupRule {
  /** หน้าต่างนับเป็นวินาที (1 นาที = 60, 1 ชั่วโมง = 3600 ตาม §5) */
  readonly windowSec: 60 | 3600;
  readonly secondary: SecondaryKeyKind;
  /** ขีดจำกัดจาก config (canonical ชุดเดียวทุก environment — §5) */
  readonly limit: (rateLimit: AppConfig["rateLimit"]) => number;
}

/** ตารางกลุ่ม — ค่าหน้าต่าง/คีย์รอง/คีย์ config ตรงตาราง §5 แถวต่อแถว */
const GROUP_RULES: Record<RateLimitGroup, GroupRule> = {
  AUTH: { windowSec: 60, secondary: "email", limit: (r) => r.authPerMin },
  OTP_REQUEST: { windowSec: 3600, secondary: "destination", limit: (r) => r.otpPerHour },
  PWD_RESET: { windowSec: 3600, secondary: "email", limit: (r) => r.pwdResetPerHour },
  MFA: { windowSec: 60, secondary: "user", limit: (r) => r.mfaPerMin },
  PUBLIC_READ: { windowSec: 60, secondary: null, limit: (r) => r.verifyPerMin },
  READ: { windowSec: 60, secondary: "user", limit: (r) => r.readPerMin },
  LEARN_WRITE: { windowSec: 60, secondary: "user", limit: (r) => r.learnWritePerMin },
  EXAM: { windowSec: 60, secondary: "user", limit: (r) => r.examPerMin },
  STAFF_WRITE: { windowSec: 60, secondary: "user", limit: (r) => r.staffWritePerMin },
  EXPORT: { windowSec: 3600, secondary: "user", limit: (r) => r.exportPerHour },
};

interface Bucket {
  count: number;
  windowStartMs: number;
}

/** ตัวนับ in-memory — key รูปแบบ "g:group:kind:id" (kind = ip / ชนิดคีย์รอง) */
const store = new Map<string, Bucket>();

/** ล้างตัวนับทั้งหมด (dev / unit test) */
export function resetRateLimitStore(): void {
  store.clear();
}

function bucketKey(group: RateLimitGroup, kind: string, id: string): string {
  return "g:" + group + ":" + kind + ":" + id;
}

export interface RateLimitKeys {
  readonly ip: string;
  /** คีย์รอง: user_id หรือ อีเมล/ปลายทาง normalized (lowercase + trim) — PUBLIC_READ ไม่ต้องส่ง */
  readonly secondary?: string | null;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly group: RateLimitGroup;
  readonly limit: number;
  /** เหลือโควตาของคีย์ที่ใกล้ถึงขีดที่สุด (min ของทุก counter ในกลุ่ม) */
  readonly remaining: number;
  /** จำนวนวินาทีที่ควรรอเมื่อโดนจำกัด (>= 1) — ไปเป็น header Retry-After */
  readonly retryAfterSec: number;
}

/**
 * นับ 1 ครั้งและตัดสินอนุญาต (fixed window ต่อคีย์ — reset ตามหน้าต่างของกลุ่ม)
 * IP counter กับคีย์รองนับแยก — ตัวใดถึงขีดก่อน = ถูกจำกัด (D12-11)
 */
export function checkRateLimit(
  group: RateLimitGroup,
  keys: RateLimitKeys,
  now: () => number = Date.now,
): RateLimitResult {
  const rule = GROUP_RULES[group];
  const limit = rule.limit(getConfig().rateLimit);
  const nowMs = now();
  const windowMs = rule.windowSec * 1000;
  const counters: Bucket[] = [];
  const kinds: Array<[string, string]> = [["ip", keys.ip]];
  if (rule.secondary !== null) {
    kinds.push([rule.secondary, keys.secondary ?? ""]);
  }
  let minRemaining = limit;
  let maxRetryMs = 0;
  let allowed = true;
  for (const [kind, id] of kinds) {
    const key = bucketKey(group, kind, id);
    let bucket = store.get(key);
    if (bucket === undefined || nowMs - bucket.windowStartMs >= windowMs) {
      bucket = { count: 0, windowStartMs: nowMs };
    }
    bucket.count += 1;
    store.set(key, bucket);
    counters.push(bucket);
    if (bucket.count > limit) {
      allowed = false;
      maxRetryMs = Math.max(maxRetryMs, bucket.windowStartMs + windowMs - nowMs);
    }
    minRemaining = Math.min(minRemaining, Math.max(0, limit - bucket.count));
  }
  return {
    allowed,
    group,
    limit,
    remaining: minRemaining,
    retryAfterSec: maxRetryMs > 0 ? Math.max(1, Math.ceil(maxRetryMs / 1000)) : 0,
  };
}

interface RouteRule {
  readonly method: "POST" | "GET" | null;
  readonly pattern: RegExp;
  readonly group: RateLimitGroup;
}

/**
 * เรียงจากเจาะจงมาก → น้อย (D11-13 กติกา 1: specific ชนะกลุ่มกว้าง)
 * ตรงตาราง §5: OTP/PWD_RESET ชนะ AUTH · EXPORT ชนะ STAFF_WRITE · admin → STAFF_WRITE · me/profile → READ
 */
const ROUTE_RULES: readonly RouteRule[] = [
  { method: "POST", pattern: /^\/api\/v1\/auth\/otp\/request\/?$/, group: "OTP_REQUEST" },
  { method: "POST", pattern: /^\/api\/v1\/auth\/password-reset\/.*$/, group: "PWD_RESET" },
  { method: null, pattern: /^\/api\/v1\/auth\/mfa\/.*$/, group: "MFA" },
  { method: "POST", pattern: /^\/api\/v1\/auth\/.*$/, group: "AUTH" },
  { method: null, pattern: /^\/api\/v1\/admin\/reports\/[^/]+\/export\/?$/, group: "EXPORT" },
  { method: null, pattern: /^\/api\/v1\/profile\/export\/?$/, group: "EXPORT" },
  { method: null, pattern: /^\/api\/v1\/admin\/.*$/, group: "STAFF_WRITE" },
  { method: null, pattern: /^\/api\/v1\/credit-.*$/, group: "STAFF_WRITE" },
  { method: "POST", pattern: /^\/api\/v1\/lessons\/[^/]+\/(progress|quiz\/submit)\/?$/, group: "LEARN_WRITE" },
  { method: "POST", pattern: /^\/api\/v1\/assessments\/[^/]+\/attempts\/?$/, group: "EXAM" },
  { method: "POST", pattern: /^\/api\/v1\/attempts\/[^/]+\/(answers|submit)\/?$/, group: "EXAM" },
  { method: null, pattern: /^\/api\/v1\/(me|profile)\/.*$/, group: "READ" },
  // PDF ของประกาศนียบัตร = ทรัพย์สินส่วนตัว (auth เจ้าของ/registrar) — จัดกลุ่ม READ
  // ก่อนถึง pattern PUBLIC_READ ของ /certificates/* (Wave D / D36-O8)
  { method: "GET", pattern: /^\/api\/v1\/certificates\/[^/]+\/pdf\/?$/, group: "READ" },
  { method: "GET", pattern: /^\/api\/v1\/(categories|courses|certificates)\/?.*$/, group: "PUBLIC_READ" },
];

/** หากลุ่มของ request — ใช้กฎเจาะจงที่สุดก่อน ไม่ตรงกฎใด → READ (default ปลอดภัย 120/min + ip) */
export function resolveRateLimitGroup(method: string, pathname: string): RateLimitGroup {
  for (const rule of ROUTE_RULES) {
    if (rule.method !== null && rule.method !== method) continue;
    if (rule.pattern.test(pathname)) return rule.group;
  }
  return "READ";
}

/** ดึง IP ของ client — x-forwarded-for (ตัวแรก) ก่อน แล้ว x-real-ip (proxy ตั้ง — SDS §5.3) */
export function clientIpFrom(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp !== null && realIp.trim().length > 0) return realIp.trim();
  return "unknown";
}

export interface EnforceRateLimitOptions {
  /** ระบุกลุ่มชัดเจน (แนะนำสำหรับ endpoint ที่รู้กลุ่มของตัวเอง) */
  readonly group?: RateLimitGroup;
  /** คีย์รอง (user_id หรือ อีเมล normalized) — ไม่ส่งและกลุ่มต้องการจะนับเป็น "" (โดน IP cap ก่อนเสมอ) */
  readonly secondaryKey?: string | null;
  /** inject นาฬิกา (unit test) */
  readonly now?: () => number;
}

/**
 * ตรวจ+นับ rate limit ของ request — เกิน → throw ERR-RATE-001 (429)
 * พร้อม details.retry_after_sec (jsonError จะตั้ง header Retry-After ให้ — §5)
 */
export function enforceRateLimit(
  request: Request,
  options: EnforceRateLimitOptions = {},
): RateLimitResult {
  const url = new URL(request.url);
  const group = options.group ?? resolveRateLimitGroup(request.method, url.pathname);
  const result = checkRateLimit(
    group,
    { ip: clientIpFrom(request), secondary: options.secondaryKey ?? null },
    options.now,
  );
  if (!result.allowed) {
    throw new AppError("ERR-RATE-001", { details: { retry_after_sec: result.retryAfterSec, group } });
  }
  return result;
}

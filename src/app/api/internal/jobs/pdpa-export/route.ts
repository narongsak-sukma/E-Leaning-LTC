/**
 * /api/internal/jobs/pdpa-export — ทริกเกอร์ worker ส่งออกข้อมูล PDPA
 * (IDENT-008 · D-p5-7 · #90) — auth shape เดียวกับ /api/internal/jobs/email-dispatch:
 *
 * - **prod** = Vercel Cron ยิง **GET** พร้อม `Authorization: Bearer <CRON_SECRET>`
 * - **dev** = compose service `mailer` (curlimages/curl) ยิง POST + header
 *   `x-cron-secret` loop ทุก 30 วินาที
 *
 * ความปลอดภัย (fail-closed เงียบ — เหมือนกันทั้งสอง method):
 * - **ไม่มี CRON_SECRET ใน env = 404 เสมอ** (endpoint ไม่มีอยู่จากมุมผู้ยิง —
 *   ไม่เปิดเผยสถานะระบบ ไม่สนใจ header)
 * - secret ไม่ตรง/ไม่มี header = 404 เงียบ ๆ เช่นกัน (ไม่เฉลยว่า endpoint มีจริง) —
 *   เทียบแบบ timing-safe · ความยาวไม่เท่า = เทียบ dummy เท่าตัวก่อนเพื่อไม่ให้เวลา
 *   เฉลยความยาว
 * - method อื่น (PUT/DELETE/…) = 405 โดย Next เอง (ไม่ export)
 * - ผ่าน secret = runPersonalDataExportLoop() แล้วตอบ 200
 *   {processed: {claimed, done, failed}} — ตัวเลขเมตาเท่านั้น (ไม่มี PII/URL — D24)
 */
import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import { runPersonalDataExportLoop } from "@/lib/pdpa/export";

export const dynamic = "force-dynamic";

/** header ที่ dev mailer แนบมา (POST) */
const CRON_SECRET_HEADER = "x-cron-secret";
/** scheme ที่ Vercel Cron ใช้ (GET): `Authorization: Bearer <CRON_SECRET>` */
const BEARER_PREFIX = "Bearer ";

/**
 * เทียบ secret แบบ timing-safe — ความยาวไม่เท่า = เทียบ dummy เท่าตัวก่อนแล้วคืน
 * false (กัน timing oracle ที่เฉลยความยาวของ secret จริง)
 */
function secretsMatch(provided: string, secret: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length === b.length) {
    return timingSafeEqual(a, b);
  }
  // เทียบ dummy เท่าตัว (pad กับ pad) — งานเทียบกินเวลาไล่ระดับความยาว input
  // (buffer ว่างห้ามผ่าน timingSafeEqual ตรง ๆ จึงใช้ pad 1 byte คู่กัน)
  const pad = a.length > 0 ? a : Buffer.alloc(1);
  timingSafeEqual(pad, pad);
  return false;
}

/** แก้ secret จาก env — null = config ไม่ครบ/ไม่ตั้ง → ประตูปิดเงียบ (404) */
function resolveSecret(): string | null {
  try {
    return getConfig().cronSecret;
  } catch {
    // config พัง (env ไม่ครบ) — fail-closed เงียบเช่นเดียวกับไม่มี secret
    return null;
  }
}

/** รัน worker แล้วตอบ 200 — ใช้ร่วมทั้ง GET (Vercel) และ POST (dev mailer) */
async function runDispatch(): Promise<Response> {
  try {
    const processed = await runPersonalDataExportLoop();
    return Response.json(
      { processed },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // worker ตั้งใจไม่ throw (dispatch log ภายใน) — ถึงจุดนี้ = เหตุผิดปกติจริง
    return new Response(null, { status: 500 });
  }
}

/** POST — dev mailer endpoint (auth ด้วย x-cron-secret เท่านั้น ไม่มี session/rate-limit) */
export async function POST(request: Request): Promise<Response> {
  const secret = resolveSecret();
  if (secret === null) {
    return new Response(null, { status: 404 });
  }
  const provided = request.headers.get(CRON_SECRET_HEADER) ?? "";
  if (!secretsMatch(provided, secret)) {
    return new Response(null, { status: 404 });
  }
  return runDispatch();
}

/** GET — Vercel Cron endpoint (auth ด้วย Authorization: Bearer เท่านั้น — gate r1 B1) */
export async function GET(request: Request): Promise<Response> {
  const secret = resolveSecret();
  if (secret === null) {
    return new Response(null, { status: 404 });
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith(BEARER_PREFIX)) {
    return new Response(null, { status: 404 });
  }
  if (!secretsMatch(authorization.slice(BEARER_PREFIX.length), secret)) {
    return new Response(null, { status: 404 });
  }
  return runDispatch();
}

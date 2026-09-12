/**
 * POST /api/internal/jobs/email-dispatch — ทริกเกอร์ email worker (Wave E Phase 4 · D-p4-8)
 *
 * ประตูเดียวที่ทำให้ worker ทำงานในทุก environment:
 * - **prod** = Vercel Cron ยิง POST พร้อม header `x-cron-secret` (เทียบ env CRON_SECRET
 *   ผ่าน config — timing-safe)
 * - **dev** = compose service `mailer` (curlimages/curl) ยิง loop ทุก 30 วินาที
 *
 * ความปลอดภัย (fail-closed เงียบ):
 * - **ไม่มี CRON_SECRET ใน env = 404 เสมอ** (endpoint ไม่มีอยู่จากมุมผู้ยิง —
 *   ไม่เปิดเผยสถานะระบบ ไม่สนใจ header)
 * - secret ไม่ตรง = 404 เงียบ ๆ เช่นกัน (ไม่เฉลยว่า endpoint มีจริง) — เทียบแบบ
 *   timing-safe · ความยาวไม่เท่า = เทียบ dummy เท่าตัวก่อนเพื่อไม่ให้เวลาเฉลยความยาว
 * - GET = 405 (cron ใช้ POST เท่านั้น)
 * - ผ่าน secret = runEmailDispatch() แล้วตอบ 200 {processed: {claimed, sent, failed}}
 *   (ตัวเลขเมตาเท่านั้น — ไม่มี to_email/payload ใน response/log ตามกติกาโปรเจกต์)
 */
import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import { runEmailDispatch } from "@/lib/email/dispatch";

export const dynamic = "force-dynamic";

/** header ที่ cron ต้องแนบมา (Vercel Cron ส่ง CRON_SECRET ใน header นี้ให้อัตโนมัติ) */
const CRON_SECRET_HEADER = "x-cron-secret";

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

/** POST — cron endpoint (auth ด้วย x-cron-secret เท่านั้น ไม่มี session/rate-limit) */
export async function POST(request: Request): Promise<Response> {
  let secret: string | null;
  try {
    secret = getConfig().cronSecret;
  } catch {
    // config พัง (env ไม่ครบ) — fail-closed เงียบเช่นเดียวกับไม่มี secret
    return new Response(null, { status: 404 });
  }
  if (secret === null) {
    return new Response(null, { status: 404 });
  }
  const provided = request.headers.get(CRON_SECRET_HEADER) ?? "";
  if (!secretsMatch(provided, secret)) {
    return new Response(null, { status: 404 });
  }
  try {
    const processed = await runEmailDispatch();
    return Response.json(
      { processed },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // worker ตั้งใจไม่ throw (dispatch log ภายใน) — ถึงจุดนี้ = เหตุผิดปกติจริง
    return new Response(null, { status: 500 });
  }
}

/** GET — ห้าม (cron เป็น POST เท่านั้น ตาม D-p4-8) */
export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}

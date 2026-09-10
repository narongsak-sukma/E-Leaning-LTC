/**
 * GET /api/health — liveness/readiness probe (API-SPECIFICATION §3.10)
 *
 * อยู่นอก prefix /api/v1 โดยเจตนา — ไม่ผูกกับ version
 * ตอบ { status, db, time } เท่านั้น ไม่มีข้อมูลอื่น (guest)
 *
 * readiness สองชั้น (PB-9):
 * - config: getConfig() ต้องผ่าน (env ครบ/ถูกนโยบาย — เช่น APP_ENV=prod ต้องมี
 *   CURSOR_HMAC_SECRET) ไม่ผ่าน → 503 + status="error" (ชั้นสำรองของ
 *   instrumentation.register — ถ้า runtime กลืน error ตอน boot ยังจับได้ที่นี่)
 * - db: "configured"/"not_configured" จากการมี env Supabase (deep ping DB
 *   ต่อยอดตอน Wave D+)
 */
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let configOk = true;
  try {
    getConfig();
  } catch {
    configOk = false;
  }

  const dbConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  );

  return Response.json(
    {
      status: configOk ? "ok" : "error",
      db: configOk ? (dbConfigured ? "configured" : "not_configured") : "unknown",
      time: new Date().toISOString(),
    },
    {
      status: configOk ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "x-request-id": crypto.randomUUID(),
      },
    },
  );
}

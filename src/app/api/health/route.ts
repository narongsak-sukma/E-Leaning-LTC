/**
 * GET /api/health — liveness/readiness probe (API-SPECIFICATION §3.10)
 *
 * อยู่นอก prefix /api/v1 โดยเจตนา — ไม่ผูกกับ version
 * ตอบ { status, db, time } เท่านั้น ไม่มีข้อมูลอื่น (guest, 200)
 *
 * db: "not_configured" = ยังไม่มี env Supabase (scaffold — Wave B)
 *     Wave C ต่อยอดเป็น deep health: ping Supabase จริง + 503 เมื่อ DB ไม่พร้อม
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const dbConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  );

  return Response.json(
    {
      status: "ok",
      db: dbConfigured ? "configured" : "not_configured",
      time: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "x-request-id": crypto.randomUUID(),
      },
    },
  );
}

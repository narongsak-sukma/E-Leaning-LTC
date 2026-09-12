/**
 * GET /api/v1/admin/dashboard (Wave E Phase 5 · [#90] D-p5-9 · API-SPEC §3.8 แถว 235)
 *
 * - requirePermission("report:view") — ชุดบทบาทที่ถือ (staff:viewer / staff:exam /
 *   staff:registrar / super_admin) ตรงกับ has_any_role ของ RPC admin_dashboard_stats
 *   (0036 §7) พอดี — staff:content ไม่ถือ report:view จึงถูกตัดที่ BFF ก่อนถึง RPC
 *   (ตาราง spec แถว 235 ระบุ staff:content ต่างจาก RPC — migration wins, ดูรายงาน drift)
 * - rate STAFF_WRITE (§5 — /api/v1/admin/* ทุก method) — หลัง RBAC
 * - query strict-zod: from / to (ISO date YYYY-MM-DD · optional — ไม่ระบุ = RPC ใช้
 *   30 วันล่าสุดเอง) · from > to = 400 ERR-VAL-001 ก่อนแตะ RPC (RPC ตรวจซ้ำชั้นที่สอง
 *   ERR-VAL-001|date_range)
 * - 200 { data } — aggregate สด lag ≤15 นาที (D-p5-9 — ไม่ใช่ materialized view) ·
 *   shape ตรง jsonb ของ RPC: range{from,to} · users{new,total} · enrollments{new} ·
 *   exams{attempts,passed,passRatePct} · certificates{issued} · credits{issued}
 *   (ตรวจ strict ฝั่ง lib แล้ว — drift = 503)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dashboardStatsViaRpc } from "@/lib/admin/users";
import { jsonErrorResponse, jsonOk, type JsonResponseOptions } from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";

/** query — strict (key แปลกปลอม → 400 ERR-VAL-001) · from/to ISO date optional */
const RangeQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict();

/** query → parsed (ค่าว่าง = ไม่ระบุ · ผิดรูป → ERR-VAL-001 รูปแบบ fields เดียวกับ credit-rules) */
function parseRangeQuery(searchParams: URLSearchParams): z.output<typeof RangeQuerySchema> {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  for (const key of Object.keys(raw)) {
    if (raw[key] === "") {
      delete raw[key];
    }
  }
  const parsed = RangeQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : "query";
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return parsed.data;
}

/** สะท้อน x-request-id (SDS §5.4) — exactOptionalPropertyTypes-safe */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** GET — สถิติรวม dashboard (200 · sv/se/sr/sa เท่านั้น) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — report:view (sv/se/sr/sa) — RPC admin_dashboard_stats gate ตรวจซ้ำชั้นที่สอง
    const { userId } = await requirePermission("report:view");
    // 2) rate STAFF_WRITE — หลัง RBAC
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) query strict + from ≤ to (เทียบแบบ lexical ได้ — ISO date YYYY-MM-DD เรียงตรงกัน)
    const query = parseRangeQuery(new URL(request.url).searchParams);
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      query.from > query.to
    ) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["from"] } });
    }
    // 4) RPC ผ่าน user-JWT — guard/aggregate ฝั่ง DB · drift ตรวจ strict ใน lib แล้ว
    const stats = await dashboardStatsViaRpc({
      from: query.from ?? null,
      to: query.to ?? null,
      requestId: options.requestId ?? null,
    });
    // 5) 200 { data }
    return jsonOk(stats, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}
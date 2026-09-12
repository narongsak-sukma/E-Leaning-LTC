/**
 * GET /api/v1/me/transcript — transcript ของตัวเอง (Wave E Phase 3 · CRB-006 ·
 * API-SPECIFICATION 1.1.0 §3 แถว /me/transcript — citizen, lawyer)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (ผู้เรียนเหมือน /me — AUTH-007)
 *   · ไม่มี permission gate — RPC my_credit_transcript ผ่าน grant `authenticated` และ
 *     ขอบเขต "ของตัวเอง" อยู่ใน RPC เอง (auth.uid() — security definer · handler ไม่รับ
 *     user_id จากภายนอกเด็ดขาด)
 * - ?format=json|csv (default json — API-SPEC 1.1.0): รูปอื่น → 400 ERR-VAL-001 ·
 *   v1 ไม่มี pdf (PDF เฉพาะใบประกาศฯ — แถว /certificates/{id}/pdf)
 * - csv = text/csv; charset=utf-8 มี BOM + กันสูตร CSV (buildCsv — จุดเดียวกับรายงาน
 *   เจ้าหน้าที่ src/lib/reports/csv) · json = 200 { data } ตาม §1.1
 * - ขาออก zod strict ทุกชั้น — RPC คืน drift → 503 ERR-SYS-002 (parseOutgoingView)
 */
import { NextResponse } from "next/server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { TranscriptView, transcriptCsvDocument } from "@/lib/api/credits";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** ชุดค่า format ที่ยอมรับ — query ขาเข้าตรวจ zod strict ก่อนใช้ (ERR-VAL-001 เมื่ออื่น) */
const TranscriptFormat = z.enum(["json", "csv"]);

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** แถวดิบจาก Supabase (untyped client — ตรวจชนิดเองก่อนใช้) */
type Row = Record<string, unknown>;

/** ตรวจชนิดแบบมือ — RPC คืน jsonb ผ่าน untyped client (ต้องเป็น object ไม่ใช่ array/null) */
function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ตอบไฟล์ CSV — สะท้อน x-request-id เหมือน envelope JSON (SDS §5.4) */
function csvResponse(csv: string, options: JsonResponseOptions): NextResponse {
  const headers: Record<string, string> = {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="credit-transcript.csv"',
  };
  if (options.requestId !== undefined) {
    headers["x-request-id"] = options.requestId;
  }
  return new NextResponse(csv, { status: 200, headers });
}

export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session (ไม่มี MFA gate — allowlist AUTH-007 เหมือน /me) → 401 ERR-AUTH-001
    const user = await requireUser();
    // 2) rate READ (user_id + ip — D12-11) — หลังตรวจ session
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) query ขาเข้า — ?format= ไม่ระบุ = json · รูปอื่น → 400 ERR-VAL-001
    const formatRaw = new URL(request.url).searchParams.get("format");
    let format: "json" | "csv";
    if (formatRaw === null) {
      format = "json";
    } else {
      const parsedFormat = TranscriptFormat.safeParse(formatRaw);
      if (!parsedFormat.success) {
        throw new AppError("ERR-VAL-001", { details: { field: "format" } });
      }
      format = parsedFormat.data;
    }
    // 4) RPC my_credit_transcript ด้วย user JWT (ขอบเขตของตัวเองอยู่ใน RPC — auth.uid())
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("my_credit_transcript");
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    if (!isRecord(data)) {
      throw new AppError("ERR-SYS-002", { details: { reason: "transcript_contract_drift" } });
    }
    // 5) ขาออก zod strict — drift → 503 fail-closed ทั้งสองรูป (json/csv)
    const view = parseOutgoingView(TranscriptView, data, "transcript_contract_drift");
    if (format === "csv") {
      return csvResponse(transcriptCsvDocument(view), options);
    }
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}


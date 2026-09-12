/**
 * GET /api/v1/me/transcript — transcript ของตัวเอง (Wave E Phase 3 · CRB-006 ·
 * API-SPECIFICATION 1.1.2 §3 แถว /me/transcript — citizen, lawyer)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (ผู้เรียนเหมือน /me — AUTH-007)
 *   · ไม่มี permission gate — RPC my_credit_transcript ผ่าน grant `authenticated` และ
 *     ขอบเขต "ของตัวเอง" อยู่ใน RPC เอง (auth.uid() — security definer · handler ไม่รับ
 *     user_id จากภายนอกเด็ดขาด)
 * - ?format=json|csv|pdf (default json — ตรงสัญญา 1.1.0/1.1.2 · รูปอื่น หรือ query key
 *   แปลกปลอม → 400 ERR-VAL-001 — zod strict ทั้ง object) · pdf = เรนเดอร์ฝั่ง BFF ด้วย
 *   pdf-lib + ฟอนต์ Sarabun (src/lib/credits/transcript-pdf — แบบเดียวกับ PDF ใบประกาศฯ ·
 *   เนื้อหา = ข้อมูลชุดเดียวกับแถว CSV) · response = application/pdf + content-disposition
 *   attachment (ASCII filename credit-transcript.pdf)
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
import { renderTranscriptPdf, transcriptPdfInputOf } from "@/lib/credits/transcript-pdf";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** ชุดค่า format ที่ยอมรับ — query ขาเข้าตรวจ zod strict ทั้ง object ก่อนใช้ (ERR-VAL-001 เมื่ออื่น) */
const TranscriptFormat = z.enum(["json", "csv", "pdf"]);

/** query ขาเข้า — strict: key แปลกปลอมใด ๆ → 400 ERR-VAL-001 (แบบ admin/credits/[userId]) */
const TranscriptQuerySchema = z.object({ format: TranscriptFormat.optional() }).strict();

/** รวม path ของ issue เป็นชื่อ field (path ว่าง = ระดับ object → "query") — แบบ parseListQuery */
function queryErrorFields(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0 ? path : "query";
      }),
    ),
  ];
}

/** searchParams → object แบน → zod strict (ผิดรูป/คีย์เกิน → ERR-VAL-001 fields) */
function parseTranscriptQuery(searchParams: URLSearchParams): { format: "json" | "csv" | "pdf" } {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = TranscriptQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: queryErrorFields(parsed.error) } });
  }
  return { format: parsed.data.format ?? "json" };
}

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

/** ตอบไฟล์ PDF — application/pdf + attachment (ASCII filename — ไม่มี PII) แบบเดียวกับ CSV */
function pdfResponse(pdf: Uint8Array, options: JsonResponseOptions): NextResponse {
  const headers: Record<string, string> = {
    "content-type": "application/pdf",
    "content-disposition": 'attachment; filename="credit-transcript.pdf"',
  };
  if (options.requestId !== undefined) {
    headers["x-request-id"] = options.requestId;
  }
  // new Uint8Array(...) — คัดลอกเข้า ArrayBuffer เดี่ยวให้ตรง BodyInit (BufferSource) ของ Next
  return new NextResponse(new Uint8Array(pdf), { status: 200, headers });
}

export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session (ไม่มี MFA gate — allowlist AUTH-007 เหมือน /me) → 401 ERR-AUTH-001
    const user = await requireUser();
    // 2) rate READ (user_id + ip — D12-11) — หลังตรวจ session
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) query ขาเข้า — ?format= ไม่ระบุ = json · รูปอื่น/key แปลกปลอม → 400 ERR-VAL-001
    const { format } = parseTranscriptQuery(new URL(request.url).searchParams);
    // 4) RPC my_credit_transcript ด้วย user JWT (ขอบเขตของตัวเองอยู่ใน RPC — auth.uid())
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("my_credit_transcript");
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    if (!isRecord(data)) {
      throw new AppError("ERR-SYS-002", { details: { reason: "transcript_contract_drift" } });
    }
    // 5) ขาออก zod strict — drift → 503 fail-closed ทุกรูป (json/csv/pdf)
    const view = parseOutgoingView(TranscriptView, data, "transcript_contract_drift");
    if (format === "csv") {
      return csvResponse(transcriptCsvDocument(view), options);
    }
    if (format === "pdf") {
      return pdfResponse(await renderTranscriptPdf(transcriptPdfInputOf(view)), options);
    }
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}


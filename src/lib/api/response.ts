/**
 * response — JSON envelope กลางของ BFF (API-SPECIFICATION §1.1–§1.3)
 *
 * - ทุก response เป็น application/json; charset=utf-8 (ยกเว้น 204 = ไม่มี body)
 * - สำเร็จ: { data } — list endpoint ใช้ { data, page } จาก lib/api/pagination (§1.2)
 * - ผิดพลาด: { error: { code, message ไทยจากทะเบียน, details? } } (§1.3) — code อ้าง lib/errors เท่านั้น
 * - สะท้อน x-request-id ที่ middleware สร้าง (SDS §5.4) กลับทุก response
 * - Retry-After อัตโนมัติเมื่อ error details มี retry_after_sec (ERR-RATE-001 — API-SPEC §5)
 */
import { NextResponse } from "next/server";
import { type z } from "zod";
import {
  AppError,
  fromUnknown,
  toErrorBody,
  type ErrorCode,
} from "../errors";
import type { PageEnvelope } from "./pagination";

/** ตัวเลือกกลางของทุก response — requestId มาจาก middleware, headers เสริมสำหรับ handler */
export interface JsonResponseOptions {
  readonly requestId?: string;
  readonly headers?: Record<string, string>;
}

function buildHeaders(options: JsonResponseOptions = {}, noContentType = false): Record<string, string> {
  const headers: Record<string, string> = noContentType
    ? {}
    : { "content-type": "application/json; charset=utf-8" };
  if (options.requestId !== undefined) {
    headers["x-request-id"] = options.requestId;
  }
  if (options.headers !== undefined) {
    Object.assign(headers, options.headers);
  }
  return headers;
}

/** 200 — { data } */
export function jsonOk(data: unknown, options: JsonResponseOptions = {}): NextResponse {
  return new NextResponse(JSON.stringify({ data }), { status: 200, headers: buildHeaders(options) });
}

/** 201 — { data } สร้างทรัพยากรใหม่ (API-SPEC §1.1) */
export function jsonCreated(data: unknown, options: JsonResponseOptions = {}): NextResponse {
  return new NextResponse(JSON.stringify({ data }), { status: 201, headers: buildHeaders(options) });
}

/**
 * 200 — { data, page: { nextCursor, hasMore } } ของ list endpoint (API-SPECIFICATION §1.2)
 * รับ envelope ที่ lib/api/pagination.buildPage สร้างไว้ตรง ๆ — เดิมแต่ละ route ประกอบ
 * { data, page } + header เอง (ธง Phase 1 ของ C-3) — helper นี้ทำให้เหลือจุดเดียว
 */
export function jsonPageOk<T>(
  envelope: PageEnvelope<T>,
  options: JsonResponseOptions = {},
): NextResponse {
  return new NextResponse(JSON.stringify({ data: envelope.data, page: envelope.page }), {
    status: 200,
    headers: buildHeaders(options),
  });
}

/**
 * zod-ตรวจ view ขาออกก่อนตอบ client (gate r1 B4) — mapper to*Resource รับแถว DB
 * ผ่าน cast จึงเชื่อ type ไม่ได้: แถวเพี้ยนหนึ่งแถว (คอลัมน์ drift/null ผิดสัญญา) ต้อง
 * fail-closed เป็น ERR-SYS-002 503 ห้ามรั่วออกไปเป็น 200 ที่ payload เพี้ยน
 */
export function parseOutgoingView<S extends z.ZodType>(
  schema: S,
  data: unknown,
  reason: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError("ERR-SYS-002", { details: { reason } });
  }
  return result.data;
}

/** 204 — สำเร็จแบบไม่มี body (API-SPEC §1.1 — ใช้เฉพาะ mark-read) */
export function jsonNoContent(options: JsonResponseOptions = {}): NextResponse {
  return new NextResponse(null, { status: 204, headers: buildHeaders(options, true) });
}

/**
 * error response ตามทะเบียน (API-SPECIFICATION §1.3 / §2)
 * - status + ข้อความไทยมาจาก lib/errors เท่านั้น
 * - รับ AppError โดยตรง หรือ ErrorCode (พร้อม details เสริม)
 * - details.retry_after_sec เป็น number → ตั้ง header Retry-After (§5)
 */
export function jsonError(
  error: AppError | ErrorCode,
  options: JsonResponseOptions & { details?: Record<string, unknown> } = {},
): NextResponse {
  const err =
    typeof error === "string"
      ? options.details !== undefined
        ? new AppError(error, { details: options.details })
        : new AppError(error)
      : error;
  const body = toErrorBody(err, options.requestId);
  const headers = buildHeaders(options);
  const retryAfterSec = err.details?.["retry_after_sec"];
  if (typeof retryAfterSec === "number") {
    headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterSec)));
  }
  return new NextResponse(JSON.stringify(body), { status: err.httpStatus ?? 500, headers });
}

/** จุดจบ catch-all ของทุก handler — unknown → ERR-SYS-001 แบบ opaque (ไม่ leak stack/SQL — SDS §6.1) */
export function jsonErrorResponse(error: unknown, options: JsonResponseOptions = {}): NextResponse {
  return jsonError(fromUnknown(error), options);
}

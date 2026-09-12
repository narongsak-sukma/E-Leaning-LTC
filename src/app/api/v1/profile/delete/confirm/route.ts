/**
 * GET /api/v1/profile/delete/confirm — ยืนยันการลบบัญชีด้วย token จากอีเมล
 * (D-p5-8 · #90) — **สาธารณะ ไม่ต้อง session** (ผู้คลิกจากลิงก์ในอีเมลยังไม่ได้
 * login ก็ต้องทำได้ — spec §3.2 แถว confirm)
 *
 * - rate = READ (§5 — /profile/* · RATE-001)
 * - query strict — รับเฉพาะ `token` (base64url · ว่าง/ชุดอักขระเพี้ยน/key เกิน →
 *   400 ERR-VAL-001 แบบ /profile/consents)
 * - ทางเข้า lib/pdpa/deletion.confirmAccountDeletion — service client เรียก RPC
 *   `confirm_account_deletion` single-use (TX เดียว: deleted_at + display_name →
 *   "บัญชีที่ขอลบแล้ว" + audit PROFILE_DELETE) แล้ว GoTrue ban + อีเมล account.deleted
 *   (best-effort — การลบ durable ใน TX แล้ว)
 * - **หน้าผลทั้งสองกรณี = 200** ตาม spec (token ผิด/หมดอายุ/ใช้แล้ว = generic
 *   "ลิงก์ไม่ถูกต้องหรือหมดอายุ" — ไม่เปิดเผยสถานะคำขอ) · error ระบบ = envelope
 *   opaque ตามทะเบียน (500/503)
 * - ห้าม log token ทุกทาง (D24) — token มีอยู่เฉพาะใน query ที่ RPC อ่าน
 */
import { NextResponse } from "next/server";

import {
  jsonErrorResponse,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { confirmAccountDeletion } from "@/lib/pdpa/deletion";
import { enforceRateLimit } from "@/lib/rate-limit";
import { ConfirmInvalidView, ConfirmSuccessView, ConfirmTokenQuery } from "../schema";

/** ข้อความหน้าผล (ไทย-first) — generic เดียวทั้งสองกรณีตามสัญญา spec */
const SUCCESS_MESSAGE =
  "ยืนยันการลบบัญชีสำเร็จ บัญชีของท่านถูกลบเรียบร้อยแล้ว ขอบคุณที่ใช้บริการ";
const INVALID_MESSAGE =
  "ลิงก์ยืนยันไม่ถูกต้องหรือหมดอายุแล้ว หากท่านยังต้องการลบบัญชี กรุณาเข้าสู่ระบบและยื่นคำขอใหม่";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** query ขาเข้า — รับเฉพาะ token (base64url 20..200) · key เกิน/ค่าเพี้ยน → 400 */
function parseTokenQuery(searchParams: URLSearchParams): string {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const extraKeys = Object.keys(raw).filter((key) => key !== "token");
  if (extraKeys.length > 0) {
    throw new AppError("ERR-VAL-001", { details: { fields: extraKeys } });
  }
  const parsed = ConfirmTokenQuery.safeParse(raw["token"]);
  if (!parsed.success) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["token"] } });
  }
  return parsed.data;
}

/** หน้าผล 200 — { data: view } พร้อม header มาตรฐาน */
function jsonResult(data: unknown, options: JsonResponseOptions): NextResponse {
  return new NextResponse(JSON.stringify({ data }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(options.requestId !== undefined ? { "x-request-id": options.requestId } : {}),
    },
  });
}

/** GET — ยืนยันลบด้วย token → 200 หน้าผลทั้งสองกรณี (spec §3.2) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) rate READ (สาธารณะ — นับ IP · RATE-001)
    enforceRateLimit(request);
    // 2) query strict — token เท่านั้น
    const token = parseTokenQuery(new URL(request.url).searchParams);
    // 3) ทางเข้า lib จุดเดียว — RPC single-use + ban + อีเมล (token ไม่ถูก log)
    const outcome = await confirmAccountDeletion(token, options.requestId ?? null);
    // 4) หน้าผลทั้งสองกรณี = 200 (ไม่เปิดเผยสถานะคำขอ)
    if (outcome.outcome === "token_invalid") {
      const invalid = parseOutgoingView(
        ConfirmInvalidView,
        { status: "link_invalid", message: INVALID_MESSAGE },
        "confirm_invalid_view_drift",
      );
      return jsonResult(invalid, options);
    }
    const success = parseOutgoingView(
      ConfirmSuccessView,
      { status: "confirmed", message: SUCCESS_MESSAGE },
      "confirm_success_view_drift",
    );
    return jsonResult(success, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/**
 * GET/PATCH /api/v1/profile/consents — ความยินยอมเสริม (PDPA · D12-17) ของตัวเอง
 * (Wave E Phase 4 · dependency ของ email channel · API-SPECIFICATION §3.2 L142-143)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (เส้นข้อมูลของตัวเอง aal1 ใช้ได้)
 * - ไม่มี permission gate — RPC my_consents_get / my_consents_update ทำ owner-check เองใน DB
 *   (auth.uid()) · เรียกด้วย user JWT ผ่าน PostgREST เท่านั้น (ห้าม service key)
 * - GET: RPC my_consents_get → ประกอบ 2 sections ตามรูป §3.2 (D12-17): notice_acknowledgments
 *   = [] เสมอ (อ่านอย่างเดียว — ยังไม่มี RPC ของส่วนนี้ · ธง Wave F) + consents จาก RPC
 *   (เฉพาะ optional: marketing|email_notify) — ผ่าน zod strict ทุกฟิลด์ก่อนตอบ
 * - PATCH: body { type: marketing|email_notify, action: grant|revoke } strict →
 *   RPC my_consents_update (append-only insert + audit CONSENT_UPDATE ใน SQL) → 200 {type,status}
 * - RPC โยน '(ERR-XXX-NNN|tag)' → map ตามทะเบียน (ERR-VAL-001 → 400) · ไม่มีป้าย → 503 opaque
 * - rate = READ (§5: /profile/* ทุก method — 120/min ต่อ user_id + ip)
 */
import { NextResponse } from "next/server";

import { parseRpcErrorCodeDetailed, type RpcErrorLike } from "@/lib/api/rpc-errors";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import {
  ConsentStatusView,
  ConsentsPatchBody,
  ConsentsView,
  type ConsentsPatchBodyParsed,
} from "./schema";

/**
 * error ของ RPC → AppError — มีป้าย "(ERR-XXX-NNN|tag)" ที่อยู่ในทะเบียน = map ตรง ·
 * ไม่มีป้าย = ERR-SYS-002 opaque (ไม่ leak SQL — SDS §6.1) — pattern เดียวกับ credit-rules
 */
function mapRpcError(error: RpcErrorLike, fallbackReason: string): AppError {
  const parsed = parseRpcErrorCodeDetailed(error);
  if (parsed !== undefined) {
    const details: Record<string, string> = {};
    if (parsed.reason !== null) {
      details.reason = parsed.reason;
    }
    return new AppError(parsed.code, { details });
  }
  return new AppError("ERR-SYS-002", { details: { reason: fallbackReason } });
}

/** reason กลางเมื่อ RPC ล้มแบบไม่มีป้าย */
const CONSENTS_FALLBACK = "consents_update_failed";

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** query ขาเข้า = ต้องว่าง (ไม่มีพารามิเตอร์ — strict: key ใด ๆ → 400 แบบ /me/credits MINOR-2) */
function parseEmptyQuery(searchParams: URLSearchParams): void {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  if (Object.keys(raw).length > 0) {
    throw new AppError("ERR-VAL-001", {
      details: { fields: Object.keys(raw) },
    });
  }
}

/** body → parsed (parse ไม่ได้ / ชนิดผิด → ERR-VAL-001 พร้อมรายชื่อ field) */
async function parsePatchBody(request: Request): Promise<ConsentsPatchBodyParsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
  }
  const parsed = ConsentsPatchBody.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
    throw new AppError("ERR-VAL-001", { details: { fields: fields.length > 0 ? fields : ["body"] } });
  }
  return parsed.data;
}

/** GET — ความยินยอมของตัวเอง (2 sections ตามรูป §3.2) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session → 401 · 2) rate READ
    const user = await requireUser();
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) query ต้องว่าง — key ใด ๆ → 400 (แบบ /me/credits)
    parseEmptyQuery(new URL(request.url).searchParams);
    // 4) RPC my_consents_get ด้วย user JWT — คืนเฉพาะ optional (marketing|email_notify)
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("my_consents_get");
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    // 5) RPC อาจคืน array ตรง ๆ หรือ {consents: [...]} — ประกอบทั้งสองรูปก่อนตรวจ strict
    const list = Array.isArray(data)
      ? data
      : typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>)["consents"])
        ? ((data as Record<string, unknown>)["consents"] as unknown[])
        : null;
    if (list === null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "consents_read_drift" } });
    }
    // 6) ประกอบ 2 sections ตามรูป §3.2 — notice_acknowledgments = [] (อ่านอย่างเดียว · ธง Wave F)
    const view = parseOutgoingView(
      ConsentsView,
      { notice_acknowledgments: [], consents: list },
      "consents_read_drift",
    );
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

/** PATCH — ให้/ถอน consent เฉพาะ optional → 200 { type, status } */
export async function PATCH(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session → 401 · 2) rate READ
    const user = await requireUser();
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) body strict — { type, action } (ทำทีละหนึ่ง type ต่อ request ตาม §3.2)
    const body = await parsePatchBody(request);
    // 4) RPC my_consents_update ด้วย user JWT — append-only insert + audit ใน SQL
    const supabase = await createSupabaseSsrClient();
    const rpc = await supabase.rpc("my_consents_update", {
      p_type: body.type,
      p_action: body.action,
    });
    if (rpc.error !== null) {
      throw mapRpcError(rpc.error as RpcErrorLike, CONSENTS_FALLBACK);
    }
    // 5) PostgREST อาจ wrap scalar/jsonb เป็น array หลักเดียว (r8-N2) — คลี่ก่อนตรวจ strict
    const rawRow: unknown = Array.isArray(rpc.data) && rpc.data.length === 1 ? rpc.data[0] : rpc.data;
    if (typeof rawRow !== "object" || rawRow === null || Array.isArray(rawRow)) {
      throw new AppError("ERR-SYS-002", { details: { reason: CONSENTS_FALLBACK } });
    }
    // 6) ขาออก strict — { type, status } (status จาก RPC ตาม action ล่าสุด)
    const view = parseOutgoingView(ConsentStatusView, rawRow, "consents_updated_drift");
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

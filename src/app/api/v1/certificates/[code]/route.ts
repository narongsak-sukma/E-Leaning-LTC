/**
 * GET /api/v1/certificates/{code} — ตรวจสอบสาธารณะ (Wave D-2 · API-SPECIFICATION 1.0.3 §3.6 · 0019-r1)
 *
 * 0019-r1 (gate r1 B3/B5):
 * - เลิกใช้ service_role ที่ route (B3): เดิม import service client ตรง แล้ว INSERT
 *   certificate_verifications แยกจากผลตรวจ (best-effort หายได้) โดยไม่มี audit —
 *   ตอนนี้ทั้งค้นและ log อยู่ใน RPC `record_certificate_verification` เดียว (SELECT
 *   4 ฟิลด์ + INSERT log + audit CERT_VERIFY_PUBLIC ใน TX เดียว) เรียกผ่าน **SSR
 *   user client** (guest = anon — EXECUTE ของ RPC ให้ anon+authenticated พอดี)
 * - ทางเดิมยังชน B5: ค้น certificate_public_view ใต้ service_role ทั้งที่ 0009 ถอน
 *   select ของ role นั้นไปแล้ว → ERR-SYS-002 ถาวร; RPC เป็น SECURITY DEFINER อ่าน
 *   certificates เองแล้วคืนเฉพาะ 4 ฟิลด์สาธารณะ (ไม่มี holder_name เด็ดขาด)
 * - guest ได้ (ไม่ auth) — rate กลุ่ม PUBLIC_READ (§5: 120/min ต่อ IP — คีย์ ip เท่านั้น,
 *   ไม่มีคีย์รอง) — endpoint เรียก enforceRateLimit เอง (middleware ไม่ wire ให้)
 * - {code} ยอมรับทั้ง cert_no (พิมพ์มือ — D10) และ verify_code (จาก QR — D10) — RPC
 *   ค้นทั้งสองคอลัมน์ (verify_code ไม่ถูก expose ใน view สาธารณะ — 0009 มี 4 คอลัมน์)
 * - **ตอบ 200 เสมอ (D8/D11-14)**: เจอ → 4 ฟิลด์ snake_case {code, course_title,
 *   issued_at, status} · ไม่เจอ → 200 + status "not_found" หน้าตาเหมือนกันทุกกรณี
 *   กัน enumeration · ไม่มี holder_name/revoked_at (PII) ใน response เด็ดขาด
 * - ip_hash = sha256(ip + salt) ห้ามเก็บ IP ตรง · ธง dev-grade: config ยังไม่มีคีย์
 *   salt เฉพาะของ ip_hash จึงใช้ SUPABASE_ANON_KEY แทนชั่วคราว (PB-13 ตามหลัง)
 * - RPC ล้ม/สัญญาเพี้ยน → 503 ERR-SYS-002 opaque — log/audit ไม่เกิดเพราะอยู่ใน TX
 *   เดียวกับ RPC ที่ล้ม (ไม่มี "ผลตรวจเพี้ยน" ถูกบันทึกแยก)
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { CertificatePublicView, type CertificatePublicViewParsed } from "@/lib/schemas/v1/certificate";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** ความยาว code สูงสุดที่ยอมรับ (cert_no = 12 ตัวอักษร, verify_code = nanoid 43) */
const CODE_MAX_LENGTH = 128;

/** user_agent ตัดทอนก่อนส่งให้ RPC (กัน header ยาวรื้อแถว — DD §3.4) */
const USER_AGENT_MAX = 256;

/** รูป cert_no ตามทะเบียน LTC-<ปี>-<6 หลัก> — ใช้จำแนก source qr/manual (D10) */
const CERT_NO_RE = /^LTC-\d{4}-\d{6}$/;

/** options ของ response — สะท้อน x-request-id (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/**
 * ip_hash = sha256(ip + salt) — ห้ามเก็บ IP ตรง (DD §3.4) ·
 * ธง dev-grade: config.ts ยังไม่มีคีย์ salt ของ ip_hash → ใช้ SUPABASE_ANON_KEY แทน
 * (anon key เป็นค่าสาธารณะ ใช้เป็น salt ไม่ปลอดภัยจริง — รอ DCR เพิ่ม IP_HASH_SALT)
 */
function ipHashOf(ip: string): string {
  const { supabaseAnonKey } = getConfig();
  return createHash("sha256").update(ip + supabaseAnonKey).digest("hex");
}

/** user_agent ตัดทอน + ตัดค่าว่าง → null (ไม่ log PII อื่น) */
function userAgentOf(request: Request): string | null {
  const raw = request.headers.get("user-agent");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, USER_AGENT_MAX);
}

/** {code} ดิบ → ค่าที่ใช้ค้น (trim + จำกัดความยาว — ตัดเศษเกินทิ้ง ไม่ error) */
function normalizeCode(raw: string): string {
  return raw.trim().slice(0, CODE_MAX_LENGTH);
}

/**
 * jsonb ของ RPC → 4 ฟิลด์ตามสัญญา — fail-closed ทั้งสองทิศ (r4-H2c):
 * - คีย์ต้องเป็น 4 ฟิลด์พอดี (เกิน/ขาด = drift ของ RPC → 503 ไม่ใช่ตัดเงียบแล้วตอบ 200 —
 *   ฟิลด์เกินอาจเป็น PII ที่ view/RPC รั่วมา)
 * - ค่าต้องผ่าน CertificatePublicView.safeParse (enum/refine ผิด → 503 ไม่ใช่ ZodError → 500)
 */
function verifyResultOf(data: unknown): CertificatePublicViewParsed {
  // r8-N2: แกะ array เฉพาะความยาว 1 พอดี (PostgREST wrap) — ความยาวอื่นคงเป็น array
  // ให้ guard/keys ตีตกเอง: แถวที่สอง ([validRow, junk]) หายเงียบไม่ได้
  const raw = Array.isArray(data) && data.length === 1 ? data[0] : data;
  const row = raw as Record<string, unknown> | null;
  if (row === null || Array.isArray(row) || typeof row !== "object") {
    throw new AppError("ERR-SYS-002", { details: { reason: "cert_verify_rpc_contract_mismatch" } });
  }
  const keys = Object.keys(row).sort().join(",");
  if (keys !== "code,course_title,issued_at,status") {
    throw new AppError("ERR-SYS-002", { details: { reason: "cert_verify_rpc_contract_mismatch" } });
  }
  const parsed = CertificatePublicView.safeParse({
    code: row["code"],
    course_title: row["course_title"],
    issued_at: row["issued_at"],
    status: row["status"],
  });
  if (!parsed.success) {
    throw new AppError("ERR-SYS-002", { details: { reason: "cert_verify_rpc_contract_mismatch" } });
  }
  return parsed.data;
}

/** GET — 200 เสมอ (ยกเว้น infra error → 503, rate เกิน → 429 ตาม §5) */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { group: "PUBLIC_READ" }); // คีย์ ip เท่านั้น (§5 — PUBLIC_READ ไม่มีคีย์รอง)
    const { code: rawCode } = await params;
    const code = normalizeCode(rawCode);

    const respond = (body: CertificatePublicViewParsed): NextResponse => {
      const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
      const requestId = request.headers.get("x-request-id");
      if (requestId !== null) {
        headers["x-request-id"] = requestId;
      }
      return new NextResponse(JSON.stringify(body), { status: 200, headers });
    };

    if (code.length === 0) {
      // path เป็นช่องว่างล้วน — ไม่ใช่รหัสที่มีความหมาย ตอบ not_found ตรง (200 เสมอ) ไม่เรียก RPC
      return respond({ code: "", course_title: null, issued_at: null, status: "not_found" });
    }

    const isManual = CERT_NO_RE.test(code); // cert_no = พิมพ์มือ · verify_code (QR) = อื่น ๆ
    const client = await createSupabaseSsrClient();
    const rpc = await client.rpc("record_certificate_verification", {
      p_code: code,
      p_source: isManual ? "manual" : "qr",
      p_ip_hash: ipHashOf(clientIpFrom(request)),
      p_user_agent: userAgentOf(request),
      p_request_id: request.headers.get("x-request-id"),
    });
    if (rpc.error !== null) {
      // opaque เสมอ: route normalize input หมดแล้วและ RPC ตรวจ input ซ้ำอีกชั้น — error
      // ที่เหลือคือ infra/สัญญา ไม่ใช่ผลตรวจ (log/audit อยู่ใน TX เดียวกัน = ไม่ถูกบันทึก)
      throw new AppError("ERR-SYS-002", { details: { reason: "cert_verify_rpc_failed" } });
    }
    return respond(verifyResultOf(rpc.data));
  } catch (error: unknown) {
    return jsonErrorResponse(error, optionsOf(request));
  }
}

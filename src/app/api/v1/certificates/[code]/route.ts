/**
 * GET /api/v1/certificates/{code} — ตรวจสอบสาธารณะ (Wave D-2 · API-SPECIFICATION 1.0.3 §3.6)
 *
 * - **guest ได้ (ไม่ auth)** — rate กลุ่ม PUBLIC_READ (§5: 120/min ต่อ IP — คีย์ ip เท่านั้น,
 *   ไม่มีคีย์รอง) — endpoint เรียก enforceRateLimit เอง (middleware ไม่ wire ให้)
 * - {code} ยอมรับทั้ง cert_no (พิมพ์มือ — D10) และ verify_code (จาก QR — D10):
 *   ค้น cert_no ใน view `certificate_public_view` (0009 L6-12 — 4 คอลัมน์เสมอ) ก่อน
 *   ไม่เจอ ค่อยค้น verify_code ในตาราง `certificates` (0006 L4-25) — ทั้งหมดผ่าน
 *   service_role เพราะ anon อ่าน view ได้แต่ INSERT certificate_verifications ไม่ได้
 *   (0010 L792-794) — จุดเดียวของ lane นี้ที่ใช้ service_role
 * - **ตอบ 200 เสมอ (D8/D11-14)**: เจอ → 4 ฟิลด์ snake_case {code, course_title, issued_at,
 *   status} · ไม่เจอ → 200 {code: ที่พิมพ์, course_title: null, issued_at: null,
 *   status: "not_found"} — shape เหมือนกันทุกกรณี กัน enumeration · **ไม่มี holder_name /
 *   revoked_at** (PII) ใน response เด็ดขาด
 * - INSERT certificate_verifications ทุก request (เจอ/ไม่เจอ — DD §3.4) — ip_hash =
 *   sha256(ip + salt) ห้ามเก็บ IP ตรง · INSERT พัง = best-effort ไม่ fail request ·
 *   ธง dev-grade: config ยังไม่มีคีย์ salt เฉพาะของ ip_hash จึงใช้ SUPABASE_ANON_KEY
 *   แทนชั่วคราว (รายงาน Wave D ให้ lead แล้ว)
 * - error ฝั่ง DB (infra) → 503 ERR-SYS-002 แบบ opaque — ไม่นับเป็นผลตรวจ จึงไม่ INSERT log
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { CertificatePublicView, type CertificatePublicViewParsed } from "@/lib/schemas/v1/certificate";
import { clientIpFrom, enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

/** client ของ service_role (untyped schema — from() ได้ทุกตาราง/view) */
type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** select ของ view — 4 คอลัมน์จริงของ certificate_public_view (0009 L6-12) */
const PUBLIC_VIEW_SELECT = "code,course_title,issued_at,status";

/** select ของตาราง certificates กรณีค้นด้วย verify_code — map ให้ตรงรูป view ใน JS */
const BASE_SELECT = "cert_no,course_title_snapshot,issued_at,status";

/** ความยาว code สูงสุดที่ยอมรับ (cert_no = 12 ตัวอักษร, verify_code = nanoid 43) */
const CODE_MAX_LENGTH = 128;

/** user_agent ตัดทอนก่อนลง certificate_verifications (กัน header ยาวรื้อแถว — DD §3.4) */
const USER_AGENT_MAX = 256;

/** รูป cert_no ตามทะเบียน LTC-<ปี>-<6 หลัก> — ใช้จำแนก source qr/manual (D10) */
const CERT_NO_RE = /^LTC-\d{4}-\d{6}$/;

/** แถวของ view certificate_public_view (snake_case ตามคอลัมน์ view จริง — 0009 L6-12) */
interface PublicViewRow {
  readonly code: string;
  readonly course_title: string;
  readonly issued_at: string;
  readonly status: string;
}

/** แถวของตาราง certificates ที่ route อ่าน (ค้นด้วย verify_code — 0006 L4-25) */
interface BaseRow {
  readonly cert_no: string;
  readonly course_title_snapshot: string;
  readonly issued_at: string;
  readonly status: string;
}

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

/** ค้น cert_no ใน view certificate_public_view (service_role — มองเห็นทุกแถว) */
async function findInPublicView(service: ServiceClient, code: string): Promise<PublicViewRow | null> {
  const { data, error } = await service
    .from("certificate_public_view")
    .select(PUBLIC_VIEW_SELECT)
    .eq("code", code)
    .maybeSingle();
  if (error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "cert_public_view_query_failed" } });
  }
  return data === null ? null : (data as unknown as PublicViewRow);
}

/**
 * ค้น verify_code ในตาราง certificates (verify_code ไม่ได้ถูก expose ใน view — 0009 มี
 * แค่ 4 คอลัมน์) แล้ว map ให้ตรงรูป view — เลือกเฉพาะ 4 คอลัมน์ที่ประกาศสาธารณะได้เสมอ
 */
async function findByVerifyCode(service: ServiceClient, code: string): Promise<PublicViewRow | null> {
  const { data, error } = await service
    .from("certificates")
    .select(BASE_SELECT)
    .eq("verify_code", code)
    .maybeSingle();
  if (error !== null) {
    throw new AppError("ERR-SYS-002", { details: { reason: "cert_by_verify_code_failed" } });
  }
  if (data === null) return null;
  const row = data as unknown as BaseRow;
  return {
    code: row.cert_no,
    course_title: row.course_title_snapshot,
    issued_at: row.issued_at,
    status: row.status,
  };
}

/**
 * INSERT certificate_verifications (0008 L43-51) — best-effort: พังทั้งแบบคืน error หรือ
 * throw ก็ไม่กระทบ response · ไม่มี PII ลง log (เก็บ verify_code ที่ค้น + ip_hash +
 * user_agent ตัดทอน + result + source)
 */
async function logVerification(
  service: ServiceClient,
  payload: {
    readonly verifyCode: string;
    readonly result: CertificatePublicViewParsed["status"];
    readonly ipHash: string;
    readonly userAgent: string | null;
    readonly source: "qr" | "manual";
  },
): Promise<void> {
  try {
    const { error } = await service.from("certificate_verifications").insert({
      verify_code: payload.verifyCode,
      result: payload.result,
      ip_hash: payload.ipHash,
      user_agent: payload.userAgent,
      source: payload.source,
    });
    if (error !== null) {
      return; // best-effort — ไม่ fail request, ไม่ log รายละเอียด DB
    }
  } catch {
    return; // best-effort
  }
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
    const isManual = CERT_NO_RE.test(code); // cert_no = พิมพ์มือ · verify_code (QR) = อื่น ๆ
    const service = createSupabaseServiceRoleClient();

    let found: PublicViewRow | null = await findInPublicView(service, code);
    if (found === null) {
      found = await findByVerifyCode(service, code);
    }

    const body: CertificatePublicViewParsed =
      found === null
        ? {
            code,
            course_title: null,
            issued_at: null,
            status: "not_found",
          }
        : {
            code: found.code,
            course_title: found.course_title,
            issued_at: found.issued_at,
            status: found.status as CertificatePublicViewParsed["status"],
          };

    // contract-first: ตรวจ 4 ฟิลด์ + refine ก่อนส่ง — ป้องกัน PII/ฟิลด์แปลกหลุดออกไป
    const validated = CertificatePublicView.parse(body);

    // INSERT ทุกครั้งที่ verify (เจอ/ไม่เจอ) — best-effort (DD §3.4)
    await logVerification(service, {
      verifyCode: code,
      result: validated.status,
      ipHash: ipHashOf(clientIpFrom(request)),
      userAgent: userAgentOf(request),
      source: isManual ? "manual" : "qr",
    });

    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    const requestId = request.headers.get("x-request-id");
    if (requestId !== null) {
      headers["x-request-id"] = requestId;
    }
    return new NextResponse(JSON.stringify(validated), { status: 200, headers });
  } catch (error: unknown) {
    return jsonErrorResponse(error, optionsOf(request));
  }
}

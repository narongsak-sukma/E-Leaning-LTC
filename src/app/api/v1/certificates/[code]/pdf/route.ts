/**
 * GET /api/v1/certificates/{code}/pdf — ดาวน์โหลด PDF ตัวจริง (Wave D-2 · API-SPECIFICATION 1.0.3 §3.6)
 *
 * - {code} ของ route นี้ = **uuid (id ของ certificate)** — ต่างจาก public verify ที่ใช้
 *   cert_no/verify_code (ใช้ slug [code] เดียวกันเพราะ Next ห้าม dynamic slug ต่างชื่อ
 *   ระดับเดียว) · ไม่ใช่ uuid → ERR-VAL-001 400
 * - requirePermission("certificate:view") — ไม่ login → 401 ERR-AUTH-001 · ไม่มี permission
 *   → 403 ERR-RBAC-001 · ขอบเขต "เจ้าของใบ" บังคับซ้ำที่ RLS certs_owner_read (0010 L781-783:
 *   owner OR staff:registrar/super_admin) — แถวที่ RLS ซ่อน = ไม่พบ → 404 ERR-NF-001
 *   (ไม่เปิดเผยการมีอยู่ของทรัพยากรผู้อื่น)
 * - rate กลุ่ม READ (user_id + ip — D12-11)
 * - โครง 2 ขั้น: certificates.pdf_media_id → media_assets (bucket/storage_path/mime_type) →
 *   storage download ด้วย user-JWT · **ธงค้าง Wave D**: สื่อประกาศนียบัตรยังไม่มีจริง —
 *   pdf_media_id เป็น null จนกว่า D-4 จะ render/อัปโหลด จึงตอบ 404 ERR-NF-001 ไปก่อน ·
 *   และ RLS media_read (0010 L372-375) เปิดเฉพาะ instructor/staff — เจ้าของใบ (learner) ยัง
 *   อ่าน media_assets/storage ไม่ได้ = e2e จริงรอ D-4/D-8 เติมนโยบาย storage
 * - ห้ามมี holder_name ใน header/body ใด ๆ (PII) — filename ใช้ id ของใบ
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { jsonErrorResponse, type JsonResponseOptions } from "@/lib/api/response";
import { parseCertificateIdParam } from "@/lib/schemas/v1/certificate";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select ของ certificates — คอลัมน์เดียวที่ route ต้องใช้ (0006 L19 pdf_media_id) */
const CERT_PDF_SELECT = "pdf_media_id";

/** select ของ media_assets — คอลัมน์จริงที่ใช้ download (0004_catalog.sql L145-152) */
const MEDIA_SELECT = "bucket,storage_path,mime_type";

/** แถว media_assets ที่ route อ่าน (snake_case ตามคอลัมน์จริง — 0004 L145-152) */
interface MediaRow {
  readonly bucket: string;
  readonly storage_path: string;
  readonly mime_type: string;
}

function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** error ของ query → RLS ปฏิเสธ (Postgres 42501) → 403 RBAC · อื่น ๆ → 503 ERR-SYS-002 opaque */
function throwQueryError(reason: string, code: string | undefined): never {
  if (code === "42501") {
    throw new AppError("ERR-RBAC-001", { details: { permission: "certificate:view" } });
  }
  throw new AppError("ERR-SYS-002", { details: { reason } });
}

/** GET — คืนไฟล์ PDF (200 application/pdf) เมื่อ media พร้อม · ยังไม่มีไฟล์ → 404 ERR-NF-001 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) session + permission (ไม่ login → 401 · ไม่มี certificate:view → 403)
    const auth = await requirePermission("certificate:view");
    // 2) rate READ (user_id + ip — D12-11)
    enforceRateLimit(request, { group: "READ", secondaryKey: auth.userId });
    // 3) {code} = uuid ของ certificate — รูปแปลก → 400
    const { code } = await params;
    const certificateId = parseCertificateIdParam(code);

    const supabase = await createSupabaseSsrClient();
    // 4) ใบของตัวเองเท่านั้น (RLS certs_owner_read — แถวที่ซ่อน = 404 ไม่เปิดเผยการมีอยู่)
    const cert = await supabase
      .from("certificates")
      .select(CERT_PDF_SELECT)
      .eq("id", certificateId)
      .maybeSingle();
    if (cert.error !== null) {
      throwQueryError("cert_pdf_query_failed", cert.error.code);
    }
    if (cert.data === null) {
      throw new AppError("ERR-NF-001");
    }
    const mediaId = (cert.data as unknown as { readonly pdf_media_id: string | null }).pdf_media_id;
    // ธง D-4: ยังไม่มีการ render/อัปโหลด PDF จริง — pdf_media_id ว่าง = ยังไม่มีไฟล์ (404)
    if (mediaId === null) {
      throw new AppError("ERR-NF-001");
    }
    // 5) หา path ของไฟล์จาก media_assets (RLS media_read ปัจจุบันไม่ครอบ learner เจ้าของใบ — ธง D-8)
    const media = await supabase.from("media_assets").select(MEDIA_SELECT).eq("id", mediaId).maybeSingle();
    if (media.error !== null) {
      throwQueryError("cert_pdf_media_query_failed", media.error.code);
    }
    if (media.data === null) {
      throw new AppError("ERR-NF-001");
    }
    const mediaRow = media.data as unknown as MediaRow;
    // 6) ดาวน์โหลดด้วย user-JWT (storage.objects RLS ยังไม่มีนโยบายสำหรับใบประกาศ — ธง D-8)
    const { data, error } = await supabase.storage.from(mediaRow.bucket).download(mediaRow.storage_path);
    if (error !== null || data === null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "cert_pdf_download_failed" } });
    }
    const headers: Record<string, string> = {
      "content-type": mediaRow.mime_type === "" ? "application/pdf" : mediaRow.mime_type,
      "content-disposition": `inline; filename="certificate-${certificateId}.pdf"`,
    };
    const requestId = request.headers.get("x-request-id");
    if (requestId !== null) {
      headers["x-request-id"] = requestId;
    }
    return new NextResponse(data, { status: 200, headers });
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/**
 * /api/v1/me/license — ยื่น/ดูคำขอผูกเลขที่ใบอนุญาตของตัวเอง (Wave E Phase 5 · D-p5-2/4)
 *
 * PUT — multipart: license_no (^\d{6,9}$) + ไฟล์ jpg/png/pdf ≤10MB
 * - requireUser() (citizen/lawyer) · rate LEARN_WRITE (กฎ WRITE มาตรฐานของ mutation ผู้เรียน)
 * - lib submit จุดเดียว (validate + upload service + media_assets + RPC user-JWT)
 * - pending ซ้ำ = 409 ERR-VAL-001 reason pending_exists (spec แถว 126 · status 409 ต่างจาก
 *   ทะเบียน (400) → envelope ประกอบเองด้วย toErrorBody คงรูป §1.3)
 * - สำเร็จ = 202 { data: { applicationId, status, submittedAt } }
 *
 * GET — คำขอล่าสุด + ใบปัจจุบัน + canResubmit (IDENT-005 · D-p5-4) อ่านผ่าน user-JWT RLS
 * (la_read/ll_read) + .eq(user_id) ซ้ำชั้นที่สอง · 200 strict ขาออก (drift → 503)
 */
import { NextResponse } from "next/server";
import { AppError, toErrorBody } from "@/lib/errors";
import { jsonErrorResponse, jsonOk, parseOutgoingView, type JsonResponseOptions } from "@/lib/api/response";
import { MyLicenseStatusView, type MyLicenseStatusViewParsed } from "@/lib/schemas/license";
import { requireUser } from "@/lib/auth/session";
import { submitLicenseApplication } from "@/lib/license/submit";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** header ของ response พิเศษ (202/409) — คงรูป envelope §1.1/§1.3 */
function envelopeHeaders(options: JsonResponseOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (options.requestId !== undefined) {
    headers["x-request-id"] = options.requestId;
  }
  return headers;
}

/** error envelope พร้อม status เฉพาะ (409 — status ตาม spec นอกทะเบียนของ code) */
function jsonErrorWithStatus(status: number, error: AppError, options: JsonResponseOptions): NextResponse {
  return new NextResponse(JSON.stringify(toErrorBody(error, options.requestId)), {
    status,
    headers: envelopeHeaders(options),
  });
}

/** แยกเคส conflict ที่ lib โยน ERR-VAL-001 + details.reason กำกับ */
function isReasonError(error: unknown, reason: string): error is AppError {
  return error instanceof AppError && error.details?.["reason"] === reason;
}

/** 409 ยื่นซ้อน — ข้อความผู้ใช้ ไม่เอ่ยชื่อ constraint */
const PENDING_CONFLICT_MESSAGE =
  "ท่านมีคำขอที่รอตัดสินอยู่แล้ว กรุณารอผลการตรวจก่อนยื่นคำขอใหม่";

interface ApplicationRow {
  readonly status: unknown;
  readonly rejected_reason: unknown;
  readonly decided_at: unknown;
  readonly submitted_at: unknown;
}

interface LicenseRow {
  readonly license_no: unknown;
  readonly verified_at: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** GET — สถานะคำขอล่าสุด + ใบปัจจุบัน + canResubmit (200) */
export async function GET(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    const user = await requireUser();
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    const supabase = await createSupabaseSsrClient();
    const [applicationResult, licenseResult] = await Promise.all([
      supabase
        .from("license_applications")
        .select("status,rejected_reason,decided_at,submitted_at")
        .eq("user_id", user.userId)
        .order("submitted_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("lawyer_licenses")
        .select("license_no,verified_at")
        .eq("user_id", user.userId)
        .is("revoked_at", null)
        .is("deleted_at", null)
        .order("verified_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (applicationResult.error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "license_applications_query_failed" } });
    }
    if (licenseResult.error !== null) {
      throw new AppError("ERR-SYS-002", { details: { reason: "lawyer_licenses_query_failed" } });
    }
    const application = applicationResult.data as unknown as ApplicationRow | null;
    const license = licenseResult.data as unknown as LicenseRow | null;
    const status = asString(application?.status);
    const submittedAt = asString(application?.submitted_at);
    let latestApplication: MyLicenseStatusViewParsed["latestApplication"] = null;
    if (application !== null && status !== null && submittedAt !== null) {
      latestApplication = {
        status: status as "pending" | "approved" | "rejected",
        rejectedReason: asString(application.rejected_reason),
        decidedAt: asString(application.decided_at),
        submittedAt,
      };
    }
    const licenseNo = asString(license?.license_no);
    const currentLicense =
      licenseNo === null
        ? null
        : { licenseNo, verifiedAt: asString(license?.verified_at) };
    const parsed = parseOutgoingView(
      MyLicenseStatusView,
      {
        latestApplication,
        currentLicense,
        // ยื่นใหม่ได้ = ยังไม่เคยยื่น หรือคำขอล่าสุดถูกปฏิเสธ (API-SPEC §3.2 แถว 131) —
        // pending = รอผล · approved = ผูกเลขแล้ว ทั้งคู่ห้ามเสนอฟอร์มยื่นซ้ำ (เดิมเทียบ
        // แค่ "ไม่ pending" ทำ approved คืน true จน UI โชว์ฟอร์มแก่ทนายที่ verify แล้ว)
        canResubmit: latestApplication === null || latestApplication.status === "rejected",
      },
      "my_license_status_drift",
    );
    return jsonOk(parsed, options);
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

/** PUT — ยื่นคำขอผูกเลขที่ใบอนุญาต (202 · multipart) */
export async function PUT(request: Request): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    const user = await requireUser();
    enforceRateLimit(request, { group: "LEARN_WRITE", secondaryKey: user.userId });
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("ERR-VAL-001", { details: { fields: ["body"] } });
    }
    const licenseNo = form.get("license_no");
    const file = form.get("file");
    if (typeof licenseNo !== "string") {
      throw new AppError("ERR-VAL-001", { details: { fields: ["license_no"] } });
    }
    if (!(file instanceof File)) {
      throw new AppError("ERR-VAL-001", { details: { fields: ["file"] } });
    }
    const submitted = await submitLicenseApplication({
      userId: user.userId,
      licenseNo,
      file,
      requestId: options.requestId ?? null,
    });
    return new NextResponse(JSON.stringify({ data: submitted }), {
      status: 202,
      headers: envelopeHeaders(options),
    });
  } catch (error: unknown) {
    if (isReasonError(error, "pending_exists")) {
      return jsonErrorWithStatus(
        409,
        new AppError("ERR-VAL-001", { message: PENDING_CONFLICT_MESSAGE, details: { reason: "pending_exists" } }),
        options,
      );
    }
    return jsonErrorResponse(error, options);
  }
}

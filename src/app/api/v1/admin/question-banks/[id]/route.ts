/**
 * GET /api/v1/admin/question-banks/{id} — รายละเอียดคลังข้อสอบ (Wave G P2 · D73/D78 ·
 * API-SPECIFICATION §3.8 แถว 218 · v1.3.0)
 *
 * - requirePermission("question_bank:view") — instructor (เจ้าของ)/staff:viewer/staff:exam/
 *   super_admin (rbac.ts) · rate STAFF_WRITE ตามขอบเขต /api/v1/admin/* (ทุก method)
 * - user-scoped SSR client (ไม่ใช่ service role) — RLS qb_read (0010 L539) กรองขอบเขตบทบาทให้เอง:
 *   instructor ต่างเจ้าของ = แถวถูกซ่อน → 404 ไม่เปิดเผยการมีอยู่
 * - UUID ผิดรูป = 400 ERR-VAL-001 fields:["id"] ก่อนแตะ DB · bank ไม่มี/เข้าไม่ถึง =
 *   404 ERR-NF-001 (ต่างจาก "คลังที่มีแต่ยังไม่มีข้อ" = 200)
 * - envelope {data} (§1.1) — resource เดียวกับแถว list (QuestionBankResource — หัวคลัง +
 *   is_active + questionCount นับฝั่ง DB ด้วย embed questions(count))
 */
import { NextResponse } from "next/server";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import {
  parseQuestionBankRow,
  QuestionBankResource,
  toQuestionBankResource,
} from "@/lib/schemas/v1/admin-exam";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** select เดียวกับ list — หัวคลัง + embed นับข้อ (PostgREST aggregation) ไม่มี options/is_correct */
const BANK_DETAIL_SELECT =
  "id,code,name,description,course_id,category_id,is_active,created_at,questions(count)";

/** UUID v4 รูปแบบเดียวกับ pagination.ts (ผิดรูป → 400 ก่อนแตะ DB) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** :id ผิดรูป uuid → 400 ERR-VAL-001 fields:["id"] ก่อนแตะ DB */
function parseBankId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["id"] } });
  }
  return raw;
}

/** GET — หัวคลังข้อสอบแถวเดียว (RLS กรองขอบเขตให้ — ไม่เจอ = 404) → 200 {data} */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC — ไม่มี question_bank:view → 403 ERR-RBAC-001
    const { userId } = await requirePermission("question_bank:view");
    // 2) rate STAFF_WRITE — หลัง RBAC เพื่อไม่นับคำขอที่ยังไม่ผ่านสิทธิ์
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 3) :id ผิดรูป uuid → 400 ก่อนแตะ DB
    const bankId = parseBankId((await context.params).id);
    // 4) user-scoped client — RLS qb_read ซ่อนคลังที่เข้าไม่ถึง (instructor ต่างเจ้าของ = 404)
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase
      .from("question_banks")
      .select(BANK_DETAIL_SELECT)
      .eq("id", bankId)
      .maybeSingle();
    if (error !== null) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "admin_question_bank_query_failed" },
      });
    }
    // bank ไม่มี/เข้าไม่ถึง → 404 (ไม่เปิดเผยการมีอยู่) — ต่างจากคลังว่าง (มีแถว ตอบ 200)
    if (data === null) {
      throw new AppError("ERR-NF-001", {
        details: { reason: "question_bank_not_found" },
      });
    }
    // 5) ขาเข้า/ขาออก strict (r4-H2a/r6-L1) — drift → 503 ไม่ตอบ payload เพี้ยน
    const bank = parseQuestionBankRow(data);
    return jsonOk(
      parseOutgoingView(
        QuestionBankResource,
        toQuestionBankResource(bank),
        "question_bank_resource_drift",
      ),
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

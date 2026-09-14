/**
 * GET /api/v1/admin/question-banks/{id}/questions — รายการข้อของคลัง (Wave G P2 · D73/D78 ·
 * API-SPECIFICATION §3.8 แถว 219 · v1.3.0)
 *
 * - requirePermission("question_bank:view") — instructor (เจ้าของ)/staff:viewer/staff:exam/
 *   super_admin · rate STAFF_WRITE (ทุก method ใต้ /api/v1/admin/*)
 * - user-scoped SSR client — RLS q_read (0010 L559) กรองข้อตามบทบาทให้เอง
 * - bank ไม่มี/เข้าไม่ถึง = 404 ERR-NF-001 ต่างจาก "คลังว่าง" = 200 data:[] — เช็คแถวคลัง
 *   ก่อน (RLS qb_read) แล้วจึง list ข้อ
 * - cursor (created_at,id) DESC แบบ row-wise เดียวกับ bank list + limit default 20/max 100
 *   (PageQuery — strict) + limit+1 probe หา hasMore → envelope {data,page} (§1.2)
 * - แถวไม่มีเฉลย: select ตัด is_correct ตั้งแต่ query (QUESTION_SELECT เดิมของ [qid] route) —
 *   QuestionResource options ไม่มี isCorrect (D74 — เฉลยเฉพาะ edit GET)
 */
import { NextResponse } from "next/server";
import { buildPage, decodeCursor } from "@/lib/api/pagination";
import {
  jsonErrorResponse,
  jsonPageOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import {
  parseQuestionRow,
  QuestionResource,
  toQuestionResource,
} from "@/lib/schemas/v1/admin-exam";
import { parsePageQuery } from "@/lib/schemas/v1/common";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** สะท้อน x-request-id ที่ middleware สร้าง กลับทุก response (SDS §5.4) */
function optionsOf(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

/** UUID v4 รูปแบบเดียวกับ pagination.ts (ผิดรูป → 400 ก่อนแตะ DB) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** :id ผิดรูป uuid → 400 ERR-VAL-001 fields:["id"] ก่อนแตะ DB */
function parseBankId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new AppError("ERR-VAL-001", { details: { fields: ["id"] } });
  }
  return raw;
}

/** or-filter เลื่อน cursor แบบ row-wise (created_at, id) < (sortKey, id) — เรียง DESC (§1.2) */
function cursorFilterOf(payload: { sortKey: string; id: string }): string {
  const sortKey = payload.sortKey.replace(/[,()]/g, " "); // ตัดอักขระ PostgREST or-syntax
  return `created_at.lt.${sortKey},and(created_at.eq.${sortKey},id.lt.${payload.id})`;
}

/** select ของ list — ตัด is_correct ตั้งแต่ query (ต้นแบบ QUESTION_SELECT ของ [qid] route:53) */
const QUESTION_SELECT =
  "id,bank_id,type,difficulty,question_text,explanation,points,status,tags,version,created_at," +
  "question_options(id,option_text,sort_order)";

/** GET — รายการข้อของคลัง (เรียงล่าสุดก่อน + cursor + ไม่มีเฉลย) → 200 {data,page} */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const options = optionsOf(request);
  try {
    // 1) RBAC + rate
    const { userId } = await requirePermission("question_bank:view");
    enforceRateLimit(request, { group: "STAFF_WRITE", secondaryKey: userId });
    // 2) :id ผิดรูป uuid → 400 ก่อนแตะ DB
    const bankId = parseBankId((await context.params).id);
    // 3) bank ต้องมีจริงและเข้าถึงได้ (RLS qb_read) — ไม่เจอ = 404 ไม่เปิดเผยการมีอยู่
    const supabase = await createSupabaseSsrClient();
    const { data: bankRow, error: bankError } = await supabase
      .from("question_banks")
      .select("id")
      .eq("id", bankId)
      .maybeSingle();
    if (bankError !== null) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "admin_question_bank_query_failed" },
      });
    }
    if (bankRow === null) {
      throw new AppError("ERR-NF-001", { details: { reason: "question_bank_not_found" } });
    }
    // 4) query (limit default 20 max 100 — PageQuery strict) + cursor row-wise DESC
    const url = new URL(request.url);
    const query = parsePageQuery(url.searchParams);
    const cursorPayload = query.cursor === undefined ? null : decodeCursor(query.cursor);
    let builder = supabase
      .from("questions")
      .select(QUESTION_SELECT)
      .eq("bank_id", bankId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit + 1); // limit+1 probe → buildPage ตัดสิน hasMore จากแถวเกิน
    if (cursorPayload !== null) {
      builder = builder.or(cursorFilterOf(cursorPayload));
    }
    const { data, error } = await builder;
    if (error !== null) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "admin_question_list_query_failed" },
      });
    }
    // r4-H2a/r8-N1: ตรวจขาเข้าเป็น array ก่อน map (null = drift ไม่กลืนเป็นหน้าว่าง)
    if (!Array.isArray(data)) {
      throw new AppError("ERR-SYS-002", { details: { reason: "questions_rows_not_array" } });
    }
    const rows = data.map(parseQuestionRow);
    const page = buildPage({
      rows,
      limit: query.limit,
      sortKeyOf: (row) => row.created_at,
      idOf: (row) => row.id,
    });
    // ขาออก strict ต่อแถว (r6-L1) — drift ของ mapper = 503 ทั้ง response ไม่ตอบ 200 เพี้ยน
    return jsonPageOk(
      {
        data: page.data.map((row) =>
          parseOutgoingView(QuestionResource, toQuestionResource(row), "question_resource_drift"),
        ),
        page: page.page,
      },
      options,
    );
  } catch (error: unknown) {
    return jsonErrorResponse(error, options);
  }
}

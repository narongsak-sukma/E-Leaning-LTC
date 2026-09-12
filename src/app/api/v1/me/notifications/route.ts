/**
 * GET /api/v1/me/notifications — แจ้งเตือน in-app ของตัวเอง (Wave E Phase 4 · NTF-001 ·
 * API-SPECIFICATION §3.9)
 *
 * - ต้อง login — ไม่ login → 401 ERR-AUTH-001 · ไม่มี MFA gate (เส้นข้อมูลของตัวเอง aal1 ใช้ได้
 *   — allowlist เดียวกับ /me และ /me/credits)
 * - ไม่มี permission gate — RPC my_notifications ทำ owner-check เองใน DB (auth.uid() ·
 *   security definer) — handler ไม่ส่ง user_id ใด ๆ เข้าไป (ห้ามยอมรับจาก query)
 * - เรียก RPC ด้วย user JWT ผ่าน PostgREST เท่านั้น (แบบแผน my_credit_summary — ห้าม service key)
 * - rate = READ (§5: /me* → 120/min ต่อ user_id + ip — เรียกเองใน handler)
 * - query ขาเข้า: ?limit= (default 20 · 1..50 — เพดานต่ำกว่า PageQuery กลางตามแผน §4.6) +
 *   ?cursor= (opaque signed — encodeCursor/decodeCursor ของ lib/api/pagination · (created_at,id)
 *   มาจาก next_cursor ของ RPC) — ผิดรูป/ถูกแก้/limit ผิด → 400 ERR-VAL-001
 * - ขาออก zod strict ทุกชั้น — คืน { items, unread_count, next_cursor|null } · next_cursor เป็น
 *   signed opaque จาก encodeCursor (RPC คืนแค่คู่ raw {created_at,id} ให้ BFF ลงนาม) ·
 *   RPC คืน drift → 503 ERR-SYS-002 (parseOutgoingView) · RPC error → 503 opaque ไม่ leak SQL
 */
import { NextResponse } from "next/server";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";
import {
  jsonErrorResponse,
  jsonOk,
  parseOutgoingView,
  type JsonResponseOptions,
} from "@/lib/api/response";
import { requireUser } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { NotificationsPageView, RpcNextCursor } from "./schema";

/** query ขาเข้า — limit default 20 เพดาน 50 (ต่างจาก PageQuery กลาง max 100 — §4.6) · strict */
const NotificationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** searchParams → object แบน → zod strict (key ใด ๆ → ERR-VAL-001 fields) — แบบ parsePageQuery */
function parseNotificationsQuery(searchParams: URLSearchParams): { limit: number; cursor: string | null } {
  const raw: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = NotificationsQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join(".");
          return path.length > 0 ? path : "query";
        }),
      ),
    ];
    throw new AppError("ERR-VAL-001", { details: { fields } });
  }
  return { limit: parsed.data.limit, cursor: parsed.data.cursor ?? null };
}

/** x-request-id (SDS §5.4) → envelope options (exactOptionalPropertyTypes-safe) */
function responseOptions(request: Request): JsonResponseOptions {
  const requestId = request.headers.get("x-request-id");
  return requestId === null ? {} : { requestId };
}

export async function GET(request: Request): Promise<NextResponse> {
  const options = responseOptions(request);
  try {
    // 1) session (ไม่มี MFA gate — เส้นข้อมูลตัวเอง · allowlist เดียวกับ /me) → 401 ERR-AUTH-001
    const user = await requireUser();
    // 2) rate READ (user_id + ip — D12-11) — หลังตรวจ session
    enforceRateLimit(request, { group: "READ", secondaryKey: user.userId });
    // 3) query ขาเข้า (limit + cursor) — ผิดรูป → 400 ERR-VAL-001 (ก่อนยิง RPC)
    const query = parseNotificationsQuery(new URL(request.url).searchParams);
    // 4) cursor → ทูเปิล (unread-rank, created_at, id) ของ RPC — ผิดรูป/ถูกแก้ (HMAC) →
    //    400 ERR-VAL-001 field=cursor · sortKey บรรจุ rank นำหน้าเวลาแบบ "1|<ISO>"
    //    (unread=1 เรียงก่อน — D-p4-13) — codec กลางให้ sortKey เป็น free-form string
    //    จึงเดินทูเปิลครบโดยไม่แตะ lib/api/pagination ของเส้นอื่น
    let afterUnread: boolean | null = null;
    let afterCreatedAt: string | null = null;
    let afterId: string | null = null;
    if (query.cursor !== null) {
      const after = decodeCursor(query.cursor);
      const parts = /^([01])\|(.+)$/.exec(after.sortKey);
      if (parts === null) {
        throw new AppError("ERR-VAL-001", { details: { field: "cursor", reason: "legacy_sort_key" } });
      }
      afterUnread = parts[1] === "1";
      // regex `.+` รับประกันกลุ่ม 2 ไม่ว่าง — ?? null เพียงคลายชนิดให้กระชับ (กลุ่มว่าง
      // ไม่มีทางเกิด: ไม่ match จะติด branch 400 ด้านบนไปแล้ว)
      afterCreatedAt = parts[2] ?? null;
      afterId = after.id;
    }
    // 5) RPC my_notifications ด้วย user JWT (ขอบเขตของตัวเองอยู่ใน RPC — auth.uid())
    const supabase = await createSupabaseSsrClient();
    const { data, error } = await supabase.rpc("my_notifications", {
      p_limit: query.limit,
      p_after_unread: afterUnread,
      p_after_created_at: afterCreatedAt,
      p_after_id: afterId,
    });
    if (error !== null) {
      throw new AppError("ERR-SYS-002"); // opaque — ไม่ leak SQL (SDS §6.1)
    }
    // 6) ขาออก zod strict — RPC คืน drift → 503 fail-closed ไม่ส่ง payload เพี้ยน
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "notifications_contract_drift" },
      });
    }
    const record = data as Record<string, unknown>;
    const parsedRpc = RpcNextCursor.safeParse(record["next_cursor"]);
    if (!parsedRpc.success) {
      throw new AppError("ERR-SYS-002", {
        details: { reason: "notifications_contract_drift" },
      });
    }
    const view = parseOutgoingView(
      NotificationsPageView,
      {
        items: record["items"],
        unread_count: record["unread_count"],
        // ลงนามทูเปิล raw {unread,created_at,id} ของ RPC เป็น opaque cursor ของ BFF
        // (§1.2 — ปลอมไม่ได้ · rank บรรจุใน sortKey: "1|<ISO>" / "0|<ISO>" — D-p4-13)
        next_cursor:
          parsedRpc.data === null
            ? null
            : encodeCursor({
                sortKey: `${parsedRpc.data.unread ? "1" : "0"}|${parsedRpc.data.created_at}`,
                id: parsedRpc.data.id,
              }),
      },
      "notifications_contract_drift",
    );
    return jsonOk(view, options);
  } catch (err: unknown) {
    return jsonErrorResponse(err, options);
  }
}

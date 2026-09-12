/**
 * schemas — GET /api/v1/me/notifications (Wave E Phase 4 · NTF-001 · API-SPECIFICATION §3.9)
 *
 * แยกไฟล์เพราะ Next.js route.ts export ได้เฉพาะ HTTP handlers — route.ts import จากที่นี่
 * (ไฟล์นี้ไม่ใช่ route — ปลอดภัยที่จะ export schema/const ให้ test ใช้ตรวจสอบ)
 */
import { z } from "zod";

/** เวลา ISO 8601 (ยอมทั้ง Z และ +00:00 — เดียวกับ schema กลางของ repo) */
const IsoTimestamp = z.iso.datetime({ offset: true });

/** แถวแจ้งเตือน in-app หนึ่งรายการ (notifications ⋈ notification_recipients — 0007) */
export const NotificationItem = z
  .object({
    id: z.string().uuid(),
    // D-p4-11: id แถว recipient ของตัวเอง (มุมมองผู้ใช้) — ใช้กับ per-user ops
    // (เช่น ซ่อน = deleted_at บนแถว recipient) · RPC ส่งมาแล้ว ห้ามตัดทิ้ง
    recipient_id: z.string().uuid(),
    topic: z.string().min(1).max(200),
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(2000),
    severity: z.enum(["info", "success", "warning", "error"]),
    ref_type: z.string().min(1).max(100).nullable(),
    ref_id: z.string().uuid().nullable(),
    read_at: IsoTimestamp.nullable(),
    created_at: IsoTimestamp,
  })
  .strict();

export type NotificationItemParsed = z.infer<typeof NotificationItem>;

/**
 * คู่ raw ที่ RPC คืนใน next_cursor (keyset ทูเปิลเต็ม (unread-rank, created_at, id) —
 * D-p4-13) — null = หน้าสุดท้าย · BFF เป็นคนลงนามเป็น opaque cursor เองด้วย
 * encodeCursor (route.ts — rank บรรจุใน sortKey แบบ "1|<ISO>")
 */
export const RpcNextCursor = z
  .object({ unread: z.boolean(), created_at: IsoTimestamp, id: z.string().uuid() })
  .strict()
  .nullable();

/** view ขาออก — next_cursor = signed opaque string ของ BFF (encodeCursor) หรือ null */
export const NotificationsPageView = z
  .object({
    items: z.array(NotificationItem),
    unread_count: z.number().int().min(0),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();

export type NotificationsPageViewParsed = z.infer<typeof NotificationsPageView>;

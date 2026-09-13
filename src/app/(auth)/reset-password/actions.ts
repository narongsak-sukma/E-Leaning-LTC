"use server";

/**
 * establishRecoverySession — server action ของหน้า /reset-password (AUTH-004 · Wave G P1 · D72)
 *
 * - ลิงก์ recovery ของ GoTrue วาง token ไว้ใน URL **fragment** (#access_token=...&refresh_token=...)
 *   ซึ่งไม่เดินทางถึง server — client component จึงอ่าน fragment เอง (และลบทิ้งจาก
 *   address bar ทันที) แล้วส่งเข้า action นี้เพื่อตั้ง session ฝั่ง server
 * - setSession ของ auth-js **ตรวจ token กับ Auth server ก่อนบันทึกลง cookie** (แบบ
 *   เดียวกับ loginAction) — token ปลอม/ใช้แล้ว/หมดอายุ = error → ERR-AUTH-005
 * - rate limit group AUTH (headers-based — checkRateLimit ตรง ๆ เพราะ server action
 *   ไม่มี Request object; ip จาก x-forwarded-for/x-real-ip แบบเดียวกับ clientIpFrom)
 * - ห้าม log token ทุกชนิด (PII)
 */
import { headers } from "next/headers";
import { z } from "zod";

import { type ErrorCode } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** fragment ที่ GoTrue วางให้หลัง redirect — คู่ token ต้องมีครบ */
const recoverySchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(1024),
});

/** คืนค่าที่ payload ไม่ผ่าน = ERR-AUTH-005 (ลิงก์เสีย/ใช้แล้ว — ข้อความเดียวกัน) */
export interface EstablishRecoverySessionResult {
  readonly ok: boolean;
  readonly code?: ErrorCode;
}

/** ip จาก headers ของ server action (แบบเดียวกับ clientIpFrom — rate-limit.ts) */
function actionIp(headersList: Awaited<ReturnType<typeof headers>>): string {
  const forwarded = headersList.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first.length > 0) return first;
  }
  const realIp = headersList.get("x-real-ip");
  if (realIp !== null && realIp.trim().length > 0) return realIp.trim();
  return "unknown";
}

export async function establishRecoverySession(
  payload: { access_token: string; refresh_token: string },
): Promise<EstablishRecoverySessionResult> {
  const parsed = recoverySchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, code: "ERR-VAL-001" };
  }
  // checkRateLimit เป็น pure (ไม่ throw แบบ enforceRateLimit) — ต้องตรวจผลลัพธ์เอง:
  // เกิน = ปฏิเสธก่อนแตะ setSession/GoTrue (ห้ามแค่ "นับแล้วปล่อยผ่าน")
  // · คีย์รอง = IP เดียวกับคีย์หลัก: rule ของ AUTH นับ bucket รองเสมอ — ส่ง null
  //   จะกลายเป็น bucket เดียว `g:AUTH:email:` รวมทุก IP (10/นาทีต่อ instance ทั้ง
  //   ระบบ = ยิงเต็ม bucket ปิด flow ตั้งรหัสของผู้ใช้อื่นได้ — DoS ข้ามผู้ใช้)
  const ip = actionIp(await headers());
  const limit = checkRateLimit("AUTH", { ip, secondary: ip });
  if (!limit.allowed) {
    return { ok: false, code: "ERR-RATE-001" };
  }
  const supabase = await createSupabaseSsrClient();
  const { error } = await supabase.auth.setSession({
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token,
  });
  if (error !== null) {
    return { ok: false, code: "ERR-AUTH-005" };
  }
  return { ok: true };
}

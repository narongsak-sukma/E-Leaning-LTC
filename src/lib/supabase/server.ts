/**
 * service-role client (bypass RLS) — SDS §5.2 / API-SPEC §1.2
 *
 * ใช้ได้เฉพาะ:
 * (a) background job เฉพาะกิจ (export worker, email worker, auto-submit scheduler;
 *     งาน purge retention ใช้ purge_role แยก — DD §4.6)
 * (b) เรียก SECURITY DEFINER server functions + audit append
 * ห้ามใช้แทน user JWT ใน CRUD ทั่วไป (RLS ไม่คุม service_role) —
 * ทุกจุดที่ใช้ต้องระบุเหตุผล + จำกัด scope ของ query ให้แคบ + audit ทุกครั้ง
 *
 * **guard**: `import "server-only"` — ถ้าถูก import จาก Client Component บิลด์จะพังทันที
 */
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getConfig } from "../config";

/**
 * สร้าง service-role client — เรียกเฉพาะจุดที่ระบุเหตุผลไว้ชัดเจน (ดูหัวไฟล์)
 * persistSession: false — ไม่มี session ของผู้ใช้ (machine-to-machine)
 */
export function createSupabaseServiceRoleClient() {
  const { supabaseUrl, supabaseServiceRoleKey } = getConfig();
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * ssr — cookie-based Supabase client factory (@supabase/ssr) สำหรับ Next 15 (Wave C-0)
 *
 * - **server-only เท่านั้น** — browser คุยกับ Next BFF เท่านั้น และ frontend ไม่ถือ
 *   Supabase key ใด ๆ (SDS §5.1 + API-SPEC §1.2) จึงไม่มี createBrowserClient ในไฟล์นี้
 *   (import เข้า Client Component บิลด์จะพังทันทีด้วย `import "server-only"`)
 * - ผูก cookie ของ Next 15 ด้วย `await cookies()` (API แบบ async): อ่าน session จาก
 *   cookie httpOnly ของ @supabase/ssr และเขียนกลับเมื่อ token refresh — cookie flags
 *   (httpOnly + Secure + SameSite=Lax) จัดการโดย @supabase/ssr (SDS §5.1)
 * - client ต้องสร้างใหม่ต่อการเรียกแต่ละครั้ง (ห้ามแชร์ข้าม request — เอกสารของ @supabase/ssr)
 * - ค่า url/key อ่านจาก config (src/lib/config.ts) เท่านั้น — ห้าม hardcode
 */
import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getConfig } from "../config";
import { hardenedCookieOptions } from "./cookies";

/**
 * สร้าง Supabase user-JWT client ผูกกับ cookie ของ request ปัจจุบัน
 * ใช้ได้ใน Server Component / Server Action / Route Handler —
 * `setAll` เขียน cookie กลับได้จริงใน Server Action / Route Handler
 * (Server Component แบบ read-only จะกลืน error ไว้ — session refresh ทำที่ middleware)
 *
 * cookie flags ผ่าน hardenedCookieOptions เสมอ — library ตั้ง default httpOnly:false
 * (dist/utils/constants.js) ซึ่งขัด SDS §5.1 เราบังคับ httpOnly+sameSite=lax เองทุกจุด
 */
export async function createSupabaseSsrClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, hardenedCookieOptions(options));
          }
        } catch {
          // Next 15 อนุญาตให้ set cookie เฉพาะ Server Action / Route Handler —
          // ถ้าเรนเดอร์ Server Component ที่ set ไม่ได้ ให้ข้าม (ไม่พังการเรนเดอร์);
          // refresh จริงทำที่ middleware (session refresh — SDS §5.1)
        }
      },
    },
  });
}

/**
 * Supabase client สำหรับ "path หลัก" — user JWT ผ่าน cookie httpOnly (SDS §5.2 user-first)
 *
 * - ใช้ฝั่ง server เท่านั้น (Server Components / Route Handlers) — browser คุยกับ Next BFF
 *   เท่านั้น (SDS §5.1) และ frontend ไม่ถือ Supabase key ใด ๆ (API-SPEC §1.2)
 * - session = cookie httpOnly + Secure + SameSite=Lax ผ่าน @supabase/ssr (SDS §5.1)
 */
import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getConfig } from "../config";

/** สร้าง client ต่อ request — session ผูกกับ cookie ของ @supabase/ssr */
export async function createSupabaseUserClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Component set cookie ไม่ได้ — session refresh ทำที่ middleware (Wave C)
        }
      },
    },
  });
}

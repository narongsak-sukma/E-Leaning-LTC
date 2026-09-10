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
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
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

/**
 * ตัวแปร buffered ของ SSR client — การเขียน cookie ทั้งหมด (เช่น การลบ session cookie
 * ระหว่าง signOut) ถูกเก็บใน memory ก่อน และลง cookieStore จริงเฉพาะเมื่อเรียก commit()
 *
 * gate r5: SDK เคลียร์ cookie ทันทีที่ signOut ถูกเรียก แม้การ revoke ฝั่ง auth server
 * จะล้ม (5xx/network) — ถ้าปล่อยตามกัน ผู้ใช้กด logout ซ้ำจะเจอ "ไม่มี session" (204)
 * ทั้งที่ refresh token ยังไม่ถูกเพิกถอน — logout route จึงต้อง commit เฉพาะเมื่อ
 * การเพิกถอนสำเร็จ หรือ auth server ยืนยันเองว่าไม่มี session จริง
 */
export interface BufferedSsrClient {
  readonly client: SupabaseClient;
  /** ยืนยันการเขียน cookie ที่ค้างอยู่ทั้งหมดลง request ปัจจุบัน */
  commit(): void;
}

/** ใช้ใน Route Handler ที่ "ปฏิบัติการแล้วค่อยเขียน cookie" — ปัจจุบันคือ logout (Wave F: logout-all) */
export async function createSupabaseSsrClientBuffered(): Promise<BufferedSsrClient> {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  const pending = new Map<string, { value: string; options: CookieOptions | undefined }>();

  /** @supabase/ssr ลบ cookie ด้วยการเขียนค่าว่าง + maxAge: 0 (dist/main/cookies.js) */
  const isDeletion = (entry: { value: string; options: CookieOptions | undefined }): boolean =>
    entry.value === "" || entry.options?.maxAge === 0;

  const client = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      // gate r6: อ่านแบบ "merge" — cookie เดิม + pending writes/deletions ซ้อนกัน
      // ไม่งั้นหลัง refresh ที่เปลี่ยนจำนวน chunks อ่านได้เฉพาะ chunk set เก่า ทำให้
      // signOut ลบไม่ครบ แล้ว commit เขียน token เก่ากลับเครื่องทั้งที่ revoke แล้ว
      getAll: () => {
        const merged = new Map<string, string>();
        for (const { name, value } of cookieStore.getAll()) {
          merged.set(name, value);
        }
        for (const [name, entry] of pending) {
          if (isDeletion(entry)) {
            merged.delete(name);
          } else {
            merged.set(name, entry.value);
          }
        }
        return [...merged].map(([name, value]) => ({ name, value }));
      },
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          pending.set(name, { value, options });
        }
      },
    },
  });
  return {
    client,
    commit: () => {
      for (const [name, { value, options }] of pending) {
        cookieStore.set(name, value, hardenedCookieOptions(options));
      }
      pending.clear();
    },
  };
}

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
import { authCookieBaseName, selectPublishableAuthCookies } from "./auth-errors";

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
  const base = authCookieBaseName(supabaseUrl);
  const isAuthCookieName = (name: string): boolean =>
    name === base || name.startsWith(`${base}.`);
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        // gate r13 M1: เส้น query/RPC (.from/.rpc → _getSessionToken → getSession
        // ภายใน SDK) หมุน refresh และลบ session ได้เหมือนเส้น auth ตรง — client นี้
        // ไม่เคยเห็น error ของ refresh (query กลืนเป็น error ของ PostgREST) จึงใช้
        // นโยบายกลางแบบ conservative: rotation เผยแพร่เสมอ (ไม่ทิ้ง token ใหม่
        // กลางอากาศ) · การลบตระกูล auth ที่ไม่มี rotation มาในชุดเดียวกัน = ไม่เผยแพร่
        // (gateway 401 ไร้ code / 429 / user_banned ต้องไม่ล้าง credential ที่ยัง
        // มีชีวิต — codex r13 พิสูจน์ด้วย handler จริง) — การเก็บกวาดเมื่อตายจริงเป็น
        // ของ middleware/getUser/logout ที่เห็น error ตาม allowlist เท่านั้น
        const publish = selectPublishableAuthCookies(
          cookiesToSet,
          false,
          isAuthCookieName,
        );
        try {
          for (const { name, value, options } of publish) {
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
  /**
   * commit แบบมีนโยบาย (gate r12 M1) — เผยแพร่ "การเขียน" (rotation) เสมอ แต่
   * "การลบ" เผยแพร่เฉพาะเมื่อ session ตายจริง (deathConfirmed ตาม allowlist ของ
   * auth-errors) **หรือ** เป็นการเก็บกวาด chunk เก่าที่มาพร้อม rotation —
   * ใช้หลังการเรียก auth ของ SDK เสร็จแล้วผ่านคำตอบ error เข้ามา
   * (เช่น getUser ของ session.ts): ไม่ใช้ commit() เพราะอันนั้นเผยแพร่ทุกอย่าง
   * เหมาะกับ route ที่ตัดสิน verdict ด้วยตัวเองแล้วเท่านั้น (logout)
   */
  commitAuthWrites(deathConfirmed: boolean): void;
  /**
   * เก็บคำสั่ง "ลบ cookie session ทั้งชุด" ลง buffer — ใช้เมื่อ session ตายแน่นอน
   * แล้วเท่านั้น (revoke สำเร็จ หรือ auth server ปฏิเสธชัด ๆ) โดยไม่พึ่ง SDK
   * signOut ที่กลืน error ได้ (gate r7): ลบชื่อ base + ทุก chunk .N ทั้งจาก jar จริง
   * และจากที่ SDK เพิ่งเขียนลง buffer (gate r8) — ครบทุกชื่อแม้ refresh ระหว่าง
   * request เดียวกันจะเปลี่ยน base เดี่ยว ↔ หลาย chunk
   */
  clearAuthCookies(): void;
  /**
   * true เมื่อ buffer มี "การเขียน session ใหม่" (rotation จาก getSession/
   * refreshSession ของ SDK) ที่ยังไม่ commit — ผู้เรียกใช้ต้อง commit ก่อนตอบ
   * ล้มเหลว ไม่งั้น refresh token ที่เพิ่งออกใหม่ถูกทิ้งกลางอากาศ (gate r8)
   */
  hasPendingAuthWrite(): boolean;
}

/** ใช้ใน Route Handler ที่ "ปฏิบัติการแล้วค่อยเขียน cookie" — ปัจจุบันคือ logout (Wave F: logout-all) */
export async function createSupabaseSsrClientBuffered(): Promise<BufferedSsrClient> {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  const pending = new Map<string, { value: string; options: CookieOptions | undefined }>();
  // ชื่อ cookie ตามสูตรเดียวกับ supabase-js: sb-<hostname.split(".")[0]>-auth-token
  const base = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  const isAuthCookieName = (name: string): boolean =>
    name === base || name.startsWith(`${base}.`);

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
    // นโยบายเดียวกับ middleware (selectPublishableAuthCookies) — gate r12 M1:
    // handler เรียก SDK ซ้ำหลัง middleware รักษา credential ไว้แล้ว (เช่น getUser
    // ของ requireUser) ต้องไม่ล้าง cookie ที่ยังมีชีวิตกลับ browser เพราะ refresh
    // โดน 401 ไร้ code ของ gateway/429/user_banned
    commitAuthWrites: (deathConfirmed: boolean) => {
      // exactOptionalPropertyTypes: ห้ามส่ง options: undefined ตรง ๆ — แปลงเป็น
      // รูปที่ไม่มี key (เหมือนที่ middleware ทำกับ pending ของตัวเอง)
      const entries = [...pending].map(([name, entry]) =>
        entry.options === undefined
          ? { name, value: entry.value }
          : { name, value: entry.value, options: entry.options },
      );
      const publish = selectPublishableAuthCookies(
        entries,
        deathConfirmed,
        isAuthCookieName,
      );
      for (const { name, value, options } of publish) {
        cookieStore.set(name, value, hardenedCookieOptions(options));
      }
      pending.clear();
    },
    clearAuthCookies: () => {
      // gate r8: ชื่อ chunk ใหม่อาจมีอยู่แค่ใน buffer (pending) — refresh ภายใน
      // request เดียวกันเปลี่ยน base เดี่ยว → หลาย chunk ได้ (applyServerStorage
      // ของ @supabase/ssr เขียน chunk ใหม่ผ่าน setAll ของเรา) ถ้าวนเฉพาะ jar จริง
      // จะไม่เห็นชื่อเหล่านั้น แล้ว commit เขียน token ที่ยังมีชีวิตกลับ browser
      // ทั้งที่ logout ตอบ 204 — จึงลบจาก union ของ jar + pending (มี base เสมอ)
      // โดยการ set ชื่อเดียวกันซ้ำ "ทับ" pending write เดิมของชื่อนั้น
      const names = new Set<string>([base]);
      for (const { name } of cookieStore.getAll()) {
        names.add(name);
      }
      for (const name of pending.keys()) {
        names.add(name);
      }
      for (const name of names) {
        if (isAuthCookieName(name)) {
          pending.set(name, { value: "", options: { maxAge: 0 } });
        }
      }
    },
    hasPendingAuthWrite: () => {
      // rotation ของ SDK (getSession หมดอายุ → refresh ภายใน / refreshSession)
      // เกิดผ่าน applyServerStorage เป็น "การเขียน" เสมอ — การลบอย่างเดียวไม่นับ
      for (const [name, entry] of pending) {
        if (isAuthCookieName(name) && !isDeletion(entry)) {
          return true;
        }
      }
      return false;
    },
  };
}

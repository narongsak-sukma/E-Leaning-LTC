/**
 * session — รากฐาน session/authorization ฝั่ง server (Wave C-0 — D25-O4)
 *
 * - **ทุก request ตรวจ session ฝั่ง server เสมอ** (SDS §5.5) — ใช้ `getUser()` ของ Supabase
 *   ที่ validate JWT กับ Auth server (ไม่เชื่อ cookie ล้วนหรือ client state ใด ๆ)
 * - **MFA fail-closed (D25-O4)**: บทบาทที่บังคับ MFA (RBAC-DESIGN §1.1 คอลัมน์ MFA +
 *   §4.2 แถว "MFA บังคับกับใคร") ที่ session ยังไม่ถึง aal2 → ปฏิเสธทันทีด้วย
 *   ERR-AUTH-004 (403) — session นั้นยังเป็น "enrollment-only" (RBAC §4.2)
 *   และ citizen/lawyer ไม่อยู่ในชุดบังคับ (MFA optional — RBAC §1.1)
 * - อ่านบทบาทผ่าน RPC `my_roles()` ด้วย user JWT (helper canonical ชุดเดียวกับ RLS — RBAC §3.1)
 * - code/ข้อความ error อ้างทะเบียนเดียวของ src/lib/errors.ts (API-SPEC §2)
 */
import "server-only";
import { AppError } from "../errors";
import { requiresMfa, type AalLevel } from "../rbac";
import { createSupabaseSsrClient, createSupabaseSsrClientBuffered } from "../supabase/ssr";
import { isDefinitiveAuthError } from "../supabase/auth-errors";

/** ระดับ assurance + ชุดบทบาทบังคับ MFA อยู่ที่ rbac.ts (แหล่งเดียว) — re-export ให้ผู้ใช้เดิมของ session.ts */
export { MFA_REQUIRED_ROLES, requiresMfa } from "../rbac";
export type { AalLevel } from "../rbac";

/** ผู้ใช้ที่พิสูจน์ตัวตนแล้ว — อ้างด้วย userId เท่านั้น (ห้าม log PII — SDS §6.2) */
export interface AuthUser {
  readonly userId: string;
  readonly aal: AalLevel;
}

/** ผลลัพธ์ของ requireMfaForRoles() — caller ใช้ต่อได้โดยไม่ต้องอ่านซ้ำ */
export interface SessionContext {
  readonly user: AuthUser;
  readonly roles: readonly string[];
}

/**
 * อ่านผู้ใช้ปัจจุบันจาก session (cookie) ฝั่ง server
 * - คืน null = ไม่มี session ที่ใช้ได้: ไม่มีเลย / token หมดอายุ / **บัญชีถูกปิดหรือลบ**
 *   (ตรวจ profiles.is_active + deleted_at ทุกครั้ง — SDS §5.5; trigger สร้างแถว profiles
 *   ให้ผู้ใช้ใหม่เสมอ แถวหาย = สถานะไม่สอดคล้อง → ถือว่าไม่มี session — fail-closed)
 * - aal: อ่านจาก mfa.getAuthenticatorAssuranceLevel() — ถ้าอ่านไม่ได้ → โยน ERR-SYS-001
 *   (fail-closed: ไม่เดาค่า assurance เอง)
 */
export async function getUser(): Promise<AuthUser | null> {
  // gate r12 M1: ใช้ client แบบ buffered + commit ตามนโยบาย — middleware รักษา
  // credential ที่ยังมีชีวิตไว้แล้ว (r11) แต่ถ้าให้ SDK เขียน cookie ตรง ๆ ที่นี่
  // การเรียก auth ซ้ำของ handler จะล้าง cookie กลับ browser เอง (SDK
  // _removeSession ทันทีที่ refresh โดนปฏิเสธ non-retryable รวม 401 ไร้ code
  // ของชั้น gateway) — เผยแพร่ rotation เสมอ / การลบเฉพาะเมื่อยืนยันตายจริง
  // (allowlist เดียวกับ middleware และ logout route)
  const { client: supabase, commitAuthWrites } = await createSupabaseSsrClientBuffered();
  const { data, error } = await supabase.auth.getUser();
  commitAuthWrites(error !== null && isDefinitiveAuthError(error));
  if (error || !data.user) {
    return null;
  }
  const { data: aalData, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError) {
    throw new AppError("ERR-SYS-001");
  }
  // สถานะบัญชี (SDS §5.5): ปิดใช้งาน/ลบแล้ว = session นั้นใช้ไม่ได้ทันที แม้ JWT ยังไม่หมดอายุ
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_active, deleted_at")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) {
    throw new AppError("ERR-SYS-001"); // อ่านสถานะไม่ได้ = ไม่ปล่อยผ่าน (fail-closed)
  }
  if (profile === null || profile.is_active !== true || profile.deleted_at !== null) {
    return null;
  }
  return { userId: data.user.id, aal: aalData?.currentLevel === "aal2" ? "aal2" : "aal1" };
}

/**
 * บังคับใช้ session — ไม่มี session ที่พิสูจน์ได้ → โยน ERR-AUTH-001 (401)
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getUser();
  if (!user) {
    throw new AppError("ERR-AUTH-001");
  }
  return user;
}

/**
 * อ่านบทบาทของผู้ใช้ปัจจุบันผ่าน RPC `my_roles()` (migrations/0002_helpers.sql —
 * security definer, grant ให้ authenticated) ด้วย user JWT —
 * RPC ล้มเหลว = โยน ERR-SYS-001 (fail-closed: อ่านบทบาทไม่ได้ = ไม่อนุญาตต่อ)
 */
export async function getMyRoles(): Promise<readonly string[]> {
  const supabase = await createSupabaseSsrClient();
  const { data, error } = await supabase.rpc("my_roles");
  if (error) {
    throw new AppError("ERR-SYS-001");
  }
  return Array.isArray(data) ? data : [];
}

/**
 * **MFA fail-closed (หัวใจของ lane นี้ — D25-O4)**: บังคับ session + ตรวจ MFA ตามบทบาท
 *
 * 1) ไม่มี session → ERR-AUTH-001 (401)
 * 2) บทบาทอยู่ในชุดบังคับ MFA (instructor / staff:* ทุกตัว / super_admin) แต่ aal ≠ aal2
 *    → ERR-AUTH-004 (403) — ยังไม่มี MFA enrollment UI (Wave F) แต่ช่องเข้าถึงปิดตั้งแต่วันนี้
 * 3) ผู้เรียน (citizen/lawyer) ผ่านตลอดโดยไม่ถูกบังคับ
 */
export async function requireMfaForRoles(): Promise<SessionContext> {
  const user = await requireUser();
  const roles = await getMyRoles();
  if (requiresMfa(roles) && user.aal !== "aal2") {
    throw new AppError("ERR-AUTH-004");
  }
  return { user, roles };
}

/** path default หลัง login/register สำเร็จ (หน้าแรก — หน้า /courses ยังไม่มีจริงใน Phase 0) */
export const DEFAULT_POST_LOGIN_PATH = "/";

/**
 * กัน open redirect — ยอมรับเฉพาะ path ภายในที่เริ่มด้วย "/" เท่านั้น
 * (แผน Wave C §4 และความเสี่ยง OWASP unvalidated redirect):
 * - ไม่ยอมรับค่าว่าง / ไม่ใช่ string / ยาวเกิน 512
 * - ปฏิเสธ protocol-relative (`//...`, `/\...`) และ**อักขระควบคุมทุกตัว** (C0/C1)
 *   — WHATWG URL parser ตัด tab/LF/CR ออกจาก input ก่อน parse เช่น `/\t/evil.example`
 *   กลายเป็น `//evil.example` = protocol-relative ข้าม origin (จับได้ที่ชั้นนี้เท่านั้น
 *   จึงต้องปฏิเสธก่อน ไม่ใช่แค่ CR/LF/NUL)
 * ทุกกรณีที่ไม่ผ่าน = คืน path default (ไม่ throw)
 */
export function resolveSafeNextPath(raw: FormDataEntryValue | null | undefined): string {
  if (typeof raw !== "string") {
    return DEFAULT_POST_LOGIN_PATH;
  }
  // อักขระควบคุมทั้งช่วง C0 (0x00–0x1F) + DEL (0x7F) + C1 (0x80–0x9F) — ตรวจบนค่าดิบ "ก่อน" trim
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) {
    return DEFAULT_POST_LOGIN_PATH;
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) {
    return DEFAULT_POST_LOGIN_PATH;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return DEFAULT_POST_LOGIN_PATH;
  }
  return value;
}

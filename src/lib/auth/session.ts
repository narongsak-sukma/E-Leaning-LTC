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
import type { Role } from "../rbac";
import { createSupabaseSsrClient } from "../supabase/ssr";

/** ระดับ assurance ของ session (Supabase MFA) */
export type AalLevel = "aal1" | "aal2";

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
 * ชุดบทบาทที่บังคับ MFA — ยึด RBAC-DESIGN §1.1 (คอลัมน์ "MFA" ที่ระบุ "บังคับ") และ
 * §4.2 ("instructor / staff ทุกระดับ / super_admin (TOTP)") · SRS AUTH-007
 * (citizen/lawyer ไม่บังคับ — MFA optional, สมัครได้)
 */
export const MFA_REQUIRED_ROLES: readonly Role[] = [
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
  "super_admin",
] as const;

/** pure — ชุดบทบาทมีบทบาทที่บังคับ MFA อย่างน้อย 1 ตัว → ต้องมี aal2 (union — RBAC §1.2-3) */
export function requiresMfa(roles: readonly string[]): boolean {
  return roles.some((role) => (MFA_REQUIRED_ROLES as readonly string[]).includes(role));
}

/**
 * อ่านผู้ใช้ปัจจุบันจาก session (cookie) ฝั่ง server
 * - คืน null = ไม่มี session ที่พิสูจน์ได้ (หมดอายุ/ไม่ได้ login)
 * - aal: อ่านจาก mfa.getAuthenticatorAssuranceLevel() — ถ้าอ่านไม่ได้ → โยน ERR-SYS-001
 *   (fail-closed: ไม่เดาค่า assurance เอง)
 */
export async function getUser(): Promise<AuthUser | null> {
  const supabase = await createSupabaseSsrClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  const { data: aalData, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError) {
    throw new AppError("ERR-SYS-001");
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
 * - ปฏิเสธ protocol-relative (`//...`, `/\...`) และอักขระควบคุม (CR/LF/NUL)
 * ทุกกรณีที่ไม่ผ่าน = คืน path default (ไม่ throw)
 */
export function resolveSafeNextPath(raw: FormDataEntryValue | null | undefined): string {
  if (typeof raw !== "string") {
    return DEFAULT_POST_LOGIN_PATH;
  }
  // ตรวจอักขระควบคุมบนค่าดิบ "ก่อน" trim (trim ตัด CR/LF ที่ขอบทิ้งได้)
  if (/[\r\n\0]/.test(raw)) {
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

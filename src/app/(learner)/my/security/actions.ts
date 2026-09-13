"use server";

/**
 * actions — Server Actions ของหน้า /my/security (Wave F · D-f-1)
 *
 * - startEnrollAction — เริ่มผูก TOTP บน session จริง (aal1 ใช้ได้ — บทบาทบังคับ MFA
 *   ต้องถึงหน้านี้ได้ด้วย session aal1) → เก็บ {factorId, secret, otpauthUri} ใน cookie
 *   ชั่วคราว path-scoped → พาไปหน้า setup
 * - confirmEnrollAction — ตรวจรหัส 6 หลัก (challenge+verify — GoTrue หมุน refresh token
 *   และ SDK persist ลง cookie ให้เองผ่าน ssr.ts) → ออกโค้ดสำรอง 8 โค้ด → RPC replace → done
 * - disableMfaAction — บทบาทบังคับ MFA ห้ามปิด · ต้อง recent-MFA ≤ 15 นาที · unenroll
 *   ทุก factor verified + RPC invalidate (audit โดย DB RPC)
 * - regenerateBackupCodesAction — ต้อง recent-MFA · ชุดใหม่ → RPC replace → done
 * - finishBackupCodesAction — ผู้ใช้กดยืนยันว่าบันทึกโค้ดแล้ว → ล้าง cookie แสดงครั้งเดียว
 *
 * ห้าม log token/secret ใด ๆ (D24) · ห้ามเขียน migrations (lane นี้)
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { unstable_rethrow } from "next/navigation";

import {
  BACKUP_CODE_COUNT,
  assertMfaDisableAllowed,
  challengeAndVerifyTotp,
  firstVerifiedTotpFactor,
  generateBackupCodes,
  sessionHasRecentMfa,
} from "@/lib/auth/mfa";
import { getUser, getMyRoles } from "@/lib/auth/session";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";

/** cookie ชั่วคราวเก็บข้อมูล setup ของ enroll (httpOnly · path=/my/security/enroll/setup · 10 นาที) */
const ENROLL_STASH_COOKIE = "ltc_mfa_enroll";

/** cookie ชั่วคราวเก็บโค้ดสำรองชุดใหม่สำหรับหน้าแสดงครั้งเดียว (path=/my/security/enroll/done · 2 นาที) */
const CODES_STASH_COOKIE = "ltc_mfa_codes";

/** status ที่ action ส่งกลับหน้า index ได้ (allowlist — page ต้องแปลงเป็นข้อความไทยครบทุกค่า) */
export type SecurityStatus =
  | "disabled"
  | "blocked"
  | "need-mfa"
  | "already"
  | "enroll-failed"
  | "codes-failed"
  | "disable-failed"
  | "need-enroll";

/** ข้อมูล setup ของ enroll ที่เก็บใน cookie ชั่วคราว (secret/uri จาก GoTrue — ใช้ต่อที่หน้า setup) */
interface EnrollStash {
  readonly factorId: string;
  readonly secret: string;
  readonly otpauthUri: string;
}

/** แกะ stash ของ enroll — fail-closed เมื่อค่าเพี้ยน/ไม่ครบ */
function parseEnrollStash(raw: string): EnrollStash | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const factorId = record["factorId"];
  const secret = record["secret"];
  const otpauthUri = record["otpauthUri"];
  if (
    typeof factorId !== "string" ||
    factorId === "" ||
    typeof secret !== "string" ||
    secret === "" ||
    typeof otpauthUri !== "string" ||
    otpauthUri === "" ||
    !otpauthUri.startsWith("otpauth://")
  ) {
    return null;
  }
  return { factorId, secret, otpauthUri };
}

/** URL กลับหน้า index พร้อม status (allowlist) */
function securityUrl(status: SecurityStatus): string {
  return `/my/security?status=${encodeURIComponent(status)}`;
}

/** URL กลับหน้า setup พร้อม status */
function setupUrl(status: "invalid"): string {
  return `/my/security/enroll/setup?status=${status}`;
}

/**
 * เริ่มผูก TOTP — enroll บน session จริง (ผู้ใช้ยัง aal1 ก็เรียกได้ตามดีไซน์) เก็บข้อมูล
 * setup ใน cookie ชั่วคราว แล้วพาไปหน้า setup
 */
export async function startEnrollAction(): Promise<void> {
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const supabase = await createSupabaseSsrClient();
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  if (firstVerifiedTotpFactor(factorsData?.all ?? []) !== null) {
    redirect(securityUrl("already"));
  }
  const enroll = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "ltc-totp",
  });
  const factorId = enroll.data?.id;
  const secret = enroll.data?.totp?.secret;
  const otpauthUri = enroll.data?.totp?.uri;
  if (
    enroll.error !== null ||
    typeof factorId !== "string" ||
    typeof secret !== "string" ||
    typeof otpauthUri !== "string"
  ) {
    // เช็ด unverified factor ค้างของ flow นี้ (กัน GoTrue ปฏิเสธ enroll ซ้ำเมื่อเกินจำนวน) —
    // best-effort เท่านั้น ไม่ทำให้ error หลักเพี้ยน
    await cleanupUnverifiedFactors(supabase);
    redirect(securityUrl("enroll-failed"));
  }
  const store = await cookies();
  store.set(
    ENROLL_STASH_COOKIE,
    JSON.stringify({ factorId, secret, otpauthUri }),
    {
      httpOnly: true,
      sameSite: "lax",
      path: "/my/security/enroll/setup",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    },
  );
  redirect("/my/security/enroll/setup");
}

/** เช็ด unverified TOTP factor ค้างของ flow นี้ (friendly_name = ltc-totp) — best-effort */
async function cleanupUnverifiedFactors(supabase: Awaited<ReturnType<typeof createSupabaseSsrClient>>): Promise<void> {
  try {
    const { data } = await supabase.auth.mfa.listFactors();
    for (const factor of data?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status !== "verified" && factor.friendly_name === "ltc-totp") {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * ยืนยันการผูก TOTP — ตรวจรหัส 6 หลักกับ factor จาก stash (ไม่เชื่อ factorId จาก
 * formData — ป้องกันยืนยัน factor อื่น) ผ่านแล้วออกโค้ดสำรอง 8 โค้ด ผ่าน RPC replace
 * (audit AUTH_MFA_BACKUPS_REGENERATED โดย DB) แล้วพาไปหน้าแสดงครั้งเดียว
 */
export async function confirmEnrollAction(formData: FormData): Promise<void> {
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const store = await cookies();
  const stash = parseEnrollStash(store.get(ENROLL_STASH_COOKIE)?.value ?? "");
  const rawCode = formData.get("code");
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (stash === null) {
    redirect("/my/security/enroll");
  }
  if (!/^\d{6}$/.test(code)) {
    redirect(setupUrl("invalid"));
  }
  // factorId จาก stash เท่านั้น — ไม่เชื่อ formData (กันยืนยัน factor อื่น)
  const supabase = await createSupabaseSsrClient();
  const verified = await challengeAndVerifyTotp(supabase, stash.factorId, () => code);
  if (verified === null) {
    redirect(setupUrl("invalid"));
  }
  // GoTrue หมุน refresh token ตอน verify — SDK persist ลง cookie เองผ่าน ssr.ts
  // (session ตอนนี้เป็น aal2 แล้ว)
  const { codes, hashes } = generateBackupCodes(BACKUP_CODE_COUNT);
  const replace = await supabase.rpc("mfa_backup_codes_replace", { p_hashes: [...hashes] });
  if (replace.error !== null) {
    redirect(securityUrl("codes-failed"));
  }
  store.set(
    CODES_STASH_COOKIE,
    JSON.stringify([...codes]),
    {
      httpOnly: true,
      sameSite: "lax",
      path: "/my/security/enroll/done",
      maxAge: 120,
      secure: process.env.NODE_ENV === "production",
    },
  );
  // ล้าง stash ของ setup — path ต้องตรงกับตอน set (path=/my/security/enroll/setup)
  store.set(ENROLL_STASH_COOKIE, "", { path: "/my/security/enroll/setup", maxAge: 0 });
  redirect("/my/security/enroll/done");
}

/**
 * ปิดใช้งาน MFA — guard ตามลำดับ: บทบาทบังคับ MFA ห้ามปิด (ERR-RBAC-001 → blocked)
 * → recent-MFA ≤ 15 นาที (need-mfa) → unenroll ทุก factor TOTP verified + RPC invalidate
 */
export async function disableMfaAction(): Promise<void> {
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const supabase = await createSupabaseSsrClient();
  try {
    assertMfaDisableAllowed(await getMyRoles());
  } catch (error) {
    unstable_rethrow(error); // NEXT_REDIRECT ผ่านออกก่อน — ที่เหลือคือ AppError
    redirect(securityUrl("blocked"));
  }
  if (!(await sessionHasRecentMfa(supabase))) {
    redirect(securityUrl("need-mfa"));
  }
  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError !== null || factorsData === null) {
    redirect(securityUrl("disable-failed"));
  }
  let unenrolledAny = false;
  for (const factor of factorsData.all) {
    if (factor.factor_type === "totp" && factor.status === "verified") {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (error !== null) {
        redirect(securityUrl("disable-failed"));
      }
      unenrolledAny = true;
    }
  }
  if (!unenrolledAny) {
    redirect(securityUrl("need-enroll"));
  }
  const invalidate = await supabase.rpc("mfa_backup_codes_invalidate");
  if (invalidate.error !== null) {
    redirect(securityUrl("disable-failed"));
  }
  redirect(securityUrl("disabled"));
}

/**
 * สร้างโค้ดสำรองชุดใหม่ — ต้อง recent-MFA ≤ 15 นาที (เงื่อนไขเดียวกับ disable) ·
 * ชุดเก่า invalid ทันทีที่ RPC replace สำเร็จ (atomic replace ฝั่ง DB) · แสดงครั้งเดียว
 */
export async function regenerateBackupCodesAction(): Promise<void> {
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const supabase = await createSupabaseSsrClient();
  if (!(await sessionHasRecentMfa(supabase))) {
    redirect(securityUrl("need-mfa"));
  }
  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  const factor =
    factorsError === null && factorsData !== null
      ? firstVerifiedTotpFactor(factorsData.all)
      : null;
  if (factor === null) {
    redirect(securityUrl("need-enroll"));
  }
  const { codes, hashes } = generateBackupCodes(BACKUP_CODE_COUNT);
  const replace = await supabase.rpc("mfa_backup_codes_replace", { p_hashes: [...hashes] });
  if (replace.error !== null) {
    // RPC ล้ม = ชุดเก่ายังใช้ได้ (atomic replace ฝั่ง DB — ไม่มีช่วงไร้โค้ด)
    redirect(securityUrl("codes-failed"));
  }
  const store = await cookies();
  store.set(
    CODES_STASH_COOKIE,
    JSON.stringify([...codes]),
    {
      httpOnly: true,
      sameSite: "lax",
      path: "/my/security/enroll/done",
      maxAge: 120,
      secure: process.env.NODE_ENV === "production",
    },
  );
  redirect("/my/security/enroll/done");
}

/**
 * ผู้ใช้กดยืนยันว่าบันทึกโค้ดแล้ว — ล้าง cookie แสดงครั้งเดียว แล้วกลับหน้า security
 */
export async function finishBackupCodesAction(): Promise<void> {
  const store = await cookies();
  store.set(CODES_STASH_COOKIE, "", { path: "/my/security/enroll/done", maxAge: 0 });
  redirect("/my/security");
}

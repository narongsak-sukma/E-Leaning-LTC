/**
 * /my/security — ศูนย์ความปลอดภัยของบัญชี (Wave F · D-f-1)
 *
 * - RSC — gate ด้วย getUser() (GoTrue-validated) ไม่มี session → /login
 * - แสดงสถานะ factor TOTP + โค้ดสำรอง (metadata ล้วนจาก RPC status) · ฟอร์ม
 *   regenerate/disable — บทบาทบังคับ MFA ไม่เห็นปุ่มปิด (เห็นคำอธิบายไทยแทน)
 * - enroll ทำผ่าน /my/security/enroll — หน้านี้ reachable ที่ aal1 เพื่อให้บทบาท
 *   บังคับ MFA เข้ามาผูกครั้งแรกได้
 * - ลิงก์เปลี่ยนอีเมลเป็น <a> ล้วนตามสัญญาของ brief (F-2 เป็นเจ้าของ /my/security/email)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppError } from "@/lib/errors";
import {
  MFA_RECENT_WINDOW_SEC,
  firstVerifiedTotpFactor,
  sessionHasRecentMfa,
  } from "@/lib/auth/mfa";
import { getUser, getMyRoles } from "@/lib/auth/session";
import { PASSWORD_CHANGE_MESSAGES } from "@/lib/auth/password-change";
import { requiresMfa } from "@/lib/rbac";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { disableMfaAction, regenerateBackupCodesAction } from "./actions";
import { changePasswordAction } from "./password/actions";
import { LogoutAllButton } from "./password/logout-all-button";

/** status ทั้งหมดของหน้า (MFA เดิม + ชุด password-* ของ AUTH-005) — allowlist เดียว */
type SecurityPageStatus = (typeof SECURITY_STATUSES)[number];

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ความปลอดภัยของบัญชี — ระบบฝึกอบรมออนไลน์",
  description: "จัดการรหัสผ่าน การยืนยันตัวตนสองชั้น (MFA) และโค้ดสำรองของบัญชีคุณ",
};

interface MySecurityPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** allowlist ของ status จาก action (Export type จาก actions.ts — ไม่รับค่าอื่นจาก query)
 *  · เพิ่มชุด password-* ของ AUTH-005 (Wave G P1) — ค่าตรง PASSWORD_STATUS_BY_FAILURE
 *    ของ ./password/actions.ts (แหล่งเดียวกับ lib) */
const SECURITY_STATUSES = [
  "disabled",
  "blocked",
  "need-mfa",
  "already",
  "enroll-failed",
  "codes-failed",
  "disable-failed",
  "need-enroll",
  "password-changed",
  "password-wrong-current",
  "password-policy",
  "password-same",
  "password-confirm",
  "password-rate-limited",
  "password-failed",
] as const;

const STATUS_MESSAGES: Record<(typeof SECURITY_STATUSES)[number], string> = {
  disabled: "ปิดใช้งานการยืนยันตัวตนสองชั้น (MFA) เรียบร้อยแล้ว",
  blocked: "บทบาทของคุณต้องใช้การยืนยันตัวตนสองชั้น (MFA) จึงปิดใช้งานไม่ได้",
  "need-mfa":
    "การกระทำนี้ต้องยืนยันตัวตนสองชั้นภายใน 15 นาทีล่าสุด กรุณาออกจากระบบและเข้าสู่ระบบใหม่ แล้วลองอีกครั้ง",
  already: "คุณเปิดใช้งานการยืนยันตัวตนสองชั้น (MFA) อยู่แล้ว",
  "enroll-failed": "ไม่สามารถเริ่มการผูกแอปยืนยันตัวตนได้ กรุณาลองใหม่",
  "codes-failed": "ออกโค้ดสำรองไม่สำเร็จ ชุดเก่ายังใช้ได้ — กรุณาลองสร้างชุดใหม่อีกครั้ง",
  "disable-failed": "ปิดใช้งาน MFA ไม่สำเร็จ กรุณาลองใหม่",
  "need-enroll": "ยังไม่มีการยืนยันตัวตนสองชั้นที่ใช้งานอยู่",
  "password-changed": PASSWORD_CHANGE_MESSAGES.changed,
  "password-wrong-current": PASSWORD_CHANGE_MESSAGES.wrong_current,
  "password-policy": PASSWORD_CHANGE_MESSAGES.password_policy,
  "password-same": PASSWORD_CHANGE_MESSAGES.same_password,
  "password-confirm": PASSWORD_CHANGE_MESSAGES.confirm_mismatch,
  "password-rate-limited": PASSWORD_CHANGE_MESSAGES.rate_limited,
  "password-failed": PASSWORD_CHANGE_MESSAGES.system,
};

/** status ของโค้ดสำรองจาก RPC `mfa_backup_codes_status` (metadata ล้วน — ไม่มีโค้ดเด็ดขาด) */
interface BackupStatus {
  readonly generated: boolean;
  readonly unused: number;
  readonly total: number;
  readonly lastGeneratedAt: string | null;
}

/** แปลงผล RPC เป็นรูปที่หน้าใช้ — fail-closed (ค่าเพี้ยน = ถือว่าไม่มีข้อมูล) */
function parseBackupStatus(value: unknown): BackupStatus | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const unused = record["unused"];
  const total = record["total"];
  if (typeof record["generated"] !== "boolean" || typeof unused !== "number" || typeof total !== "number") {
    return null;
  }
  const lastGeneratedAt = record["lastGeneratedAt"];
  if (lastGeneratedAt !== null && typeof lastGeneratedAt !== "string") {
    return null;
  }
  return {
    generated: record["generated"],
    unused,
    total,
    lastGeneratedAt: typeof lastGeneratedAt === "string" ? lastGeneratedAt : null,
  };
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

export default async function MySecurityPage({ searchParams }: MySecurityPageProps) {
  const params = await searchParams;
  const rawStatus = firstParam(params.status);
  const status: SecurityPageStatus | null =
    rawStatus !== null && (SECURITY_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as SecurityPageStatus)
      : null;

  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const roles = await getMyRoles();
  const mandatory = requiresMfa(roles);
  const supabase = await createSupabaseSsrClient();
  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError !== null) {
    throw new AppError("ERR-SYS-001");
  }
  const factor = firstVerifiedTotpFactor(factorsData?.all ?? []);
  const recentMfa = await sessionHasRecentMfa(supabase);
  const statusRes = await supabase.rpc("mfa_backup_codes_status");
  const backups = statusRes.error === null ? parseBackupStatus(statusRes.data) : null;

  const statusTone =
    status === "disabled" || status === "password-changed"
      ? "success"
      : status === null || status === "already"
        ? "info"
        : "danger";
  const statusToneClass = {
    success: "border-success-200 bg-success-50 text-success-700",
    info: "border-mist-300 bg-mist-50 text-ink-700",
    danger: "border-danger-200 bg-danger-50 text-danger-700",
  }[statusTone];

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">ความปลอดภัยของบัญชี</h1>
      <p className="mt-1 text-sm text-ink-600">
        จัดการรหัสผ่าน การยืนยันตัวตนสองชั้น (MFA) โค้ดสำรอง และเซสชันของท่าน
      </p>

      {status !== null ? (
        <p
          role="status"
          className={`mt-5 rounded-[10px] border-[1.5px] px-4 py-3 text-sm ${statusToneClass}`}
        >
          {STATUS_MESSAGES[status]}
        </p>
      ) : null}

      <section className="mt-6 rounded-[14px] border-[1.5px] border-mist-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold text-ink-900">การยืนยันตัวตนสองชั้น (MFA)</h2>
          {factor !== null ? (
            <span className="rounded-full border border-success-200 bg-success-50 px-3 py-1 text-xs font-semibold text-success-700">
              เปิดใช้งาน
            </span>
          ) : (
            <span className="rounded-full border border-mist-300 bg-mist-50 px-3 py-1 text-xs font-semibold text-ink-600">
              ยังไม่เปิดใช้งาน
            </span>
          )}
        </div>
        {factor !== null ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-ink-600">
              บัญชีของท่านผูกกับแอปยืนยันตัวตน (TOTP) เรียบร้อย
            </p>
            <p className="text-sm text-ink-700">
              โค้ดสำรอง:{" "}
              {backups === null
                ? "อ่านสถานะไม่ได้"
                : backups.generated
                  ? `เหลือใช้ได้ ${backups.unused} จาก ${backups.total} โค้ด`
                  : "ยังไม่ได้สร้าง"}
            </p>
            <p className="text-sm text-ink-700">
              การยืนยันล่าสุด:{" "}
              {recentMfa
                ? `ผ่าน MFA ภายใน ${MFA_RECENT_WINDOW_SEC / 60} นาทีล่าสุด (ดำเนินการได้)`
                : "ไม่อยู่ในหน้าต่าง 15 นาที — ต้องเข้าสู่ระบบใหม่ก่อนปิด MFA / สร้างโค้ดใหม่"}
            </p>
            <div className="flex flex-wrap gap-3">
              <form action={regenerateBackupCodesAction}>
                <button
                  type="submit"
                  className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700"
                >
                  สร้างโค้ดสำรองชุดใหม่
                </button>
              </form>
              {!mandatory ? (
                <form action={disableMfaAction}>
                  <button
                    type="submit"
                    className="rounded-[10px] border-[1.5px] border-danger-300 bg-white px-[18px] py-2.5 font-heading font-semibold text-danger-700 hover:bg-danger-50"
                  >
                    ปิดใช้งาน MFA
                  </button>
                </form>
              ) : (
                <p className="rounded-[10px] border-[1.5px] border-mist-300 bg-mist-50 px-4 py-3 text-sm text-ink-600">
                  บทบาทของคุณต้องใช้การยืนยันตัวตนสองชั้น (MFA) จึงปิดใช้งาน MFA ไม่ได้
                </p>
              )}
            </div>
            <p className="text-xs text-ink-500">
              การสร้างโค้ดชุดใหม่จะทำให้โค้ดชุดเก่าใช้ไม่ได้ทันที · การปิด MFA และการสร้างโค้ดชุดใหม่
              ต้องมีการยืนยันสองชั้นภายใน 15 นาทีล่าสุด
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-ink-600">
              เพิ่มชั้นความปลอดภัย — ผูกแอปยืนยันตัวตน (TOTP) กับบัญชีของท่าน
            </p>
            <a
              href="/my/security/enroll"
              className="inline-block rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700"
            >
              เริ่มการผูกแอปยืนยันตัวตน
            </a>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-[14px] border-[1.5px] border-mist-200 bg-white p-6">
        <h2 className="font-heading text-lg font-bold text-ink-900">รหัสผ่าน</h2>
        <div className="mt-4 space-y-4">
          <p className="text-sm text-ink-600">
            ตั้งรหัสผ่านใหม่ (อย่างน้อย 12 ตัวอักษร) — ระบบจะถามรหัสผ่านปัจจุบันเพื่อยืนยันตัวตนก่อนเปลี่ยนทุกครั้ง
          </p>
          <form action={changePasswordAction} className="space-y-4">
            <div>
              <label htmlFor="current-password" className="mb-1.5 block font-heading text-sm font-semibold text-ink-900">
                รหัสผ่านปัจจุบัน <span className="text-danger-600" aria-hidden="true">*</span>
                <span className="sr-only">(จำเป็น)</span>
              </label>
              <input
                id="current-password"
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="new-password" className="mb-1.5 block font-heading text-sm font-semibold text-ink-900">
                รหัสผ่านใหม่ <span className="text-danger-600" aria-hidden="true">*</span>
                <span className="sr-only">(จำเป็น)</span>
              </label>
              <input
                id="new-password"
                name="newPassword"
                type="password"
                required
                autoComplete="new-password"
                placeholder="อย่างน้อย 12 ตัวอักษร"
                className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className="mb-1.5 block font-heading text-sm font-semibold text-ink-900">
                ยืนยันรหัสผ่านใหม่ <span className="text-danger-600" aria-hidden="true">*</span>
                <span className="sr-only">(จำเป็น)</span>
              </label>
              <input
                id="confirm-password"
                name="confirmPassword"
                type="password"
                required
                autoComplete="new-password"
                placeholder="อย่างน้อย 12 ตัวอักษร"
                className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700"
            >
              เปลี่ยนรหัสผ่าน
            </button>
          </form>
        </div>
      </section>

      <section className="mt-6 rounded-[14px] border-[1.5px] border-mist-200 bg-white p-6">
        <h2 className="font-heading text-lg font-bold text-ink-900">เซสชัน</h2>
        <div className="mt-4 space-y-4">
          <p className="text-sm text-ink-600">
            ใช้เมื่อสงสัยว่ามีผู้อื่นเข้าใช้บัญชีของท่าน — ระบบจะยกเลิกการเข้าสู่ระบบทุกเครื่องรวมถึงเครื่องนี้
          </p>
          <LogoutAllButton />
        </div>
      </section>

      <p className="mt-6 text-sm text-ink-600">
        ต้องการเปลี่ยนอีเมล?{" "}
        <a href="/my/security/email" className="font-semibold text-brand-700 hover:underline">
          เปลี่ยนอีเมล
        </a>
      </p>
    </div>
  );
}


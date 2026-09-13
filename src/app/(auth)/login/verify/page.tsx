/**
 * /login/verify — ขั้นที่ 2 ของ login สองขั้น (Wave F · D-f-1)
 *
 * - แสดงฟอร์มยืนยันเมื่อมี cookie ชั่วคราว (`ltc_mfa_pending`) เท่านั้น — ไม่มี =
 *   การ์ด "หมดเวลา" (การเข้าสู่ระบบยังไม่สมบูรณ์ ห้ามออก session ใด ๆ)
 * - รับทั้งรหัส TOTP 6 หลัก และโค้ดสำรอง `xxxx-xxxx` (ช่องเดียว — แยกเส้นทางที่ action)
 * - state จาก query string ผ่าน allowlist เท่านั้น — ข้อความไทย fixed copy
 *   (ไม่รับข้อความจาก query string เด็ดขาด)
 */
import { cookies } from "next/headers";

import { MFA_PENDING_COOKIE } from "@/lib/auth/mfa";
import { resolveSafeNextPath } from "@/lib/auth/session";
import { verifyMfaStepTwoAction } from "../../mfa-actions";

export const dynamic = "force-dynamic";

interface VerifyPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** allowlist ของ state ที่ยอมแสดง (ไม่รับค่าอื่นจาก query string) */
const VERIFY_STATES = ["invalid", "expired"] as const;
type VerifyState = (typeof VERIFY_STATES)[number];

/** ข้อความไทยของแต่ละ state (fixed copy) */
const VERIFY_STATE_MESSAGES: Record<VerifyState, string> = {
  invalid: "รหัสยืนยันไม่ถูกต้อง กรุณาตรวจสอบและลองอีกครั้ง",
  expired: "การเข้าสู่ระบบหมดเวลา กรุณาเข้าสู่ระบบอีกครั้ง",
};

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

const inputClass =
  "w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none";

const labelClass = "mb-1.5 block font-heading text-sm font-semibold text-ink-900";

export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const params = await searchParams;
  const next = resolveSafeNextPath(firstParam(params.next));
  const rawState = firstParam(params.state);
  const state: VerifyState | null =
    rawState !== null && (VERIFY_STATES as readonly string[]).includes(rawState)
      ? (rawState as VerifyState)
      : null;

  const store = await cookies();
  const hasPending = (store.get(MFA_PENDING_COOKIE)?.value ?? "") !== "";

  // ไม่มี pending cookie = การเข้าสู่ระบบยังไม่เริ่ม/หมดเวลา — การ์ดแนะนำกลับไป /login
  if (!hasPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-mist-50 px-4 py-10">
        <div className="w-full max-w-md rounded-[14px] bg-white p-6 shadow-card sm:p-8">
          <p className="text-center text-sm text-ink-500">
            ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
          </p>
          <h1 className="mt-1 text-center font-heading text-2xl font-bold text-brand-900">
            การยืนยันตัวตนสองชั้น
          </h1>
          <p
            role="alert"
            className="mt-5 rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
          >
            {VERIFY_STATE_MESSAGES.expired}
          </p>
          <a
            href={`/login?next=${encodeURIComponent(next)}`}
            className="mt-6 block rounded-[10px] bg-brand-600 px-[18px] py-2.5 text-center font-heading font-semibold text-white shadow-card hover:bg-brand-700"
          >
            กลับไปหน้าเข้าสู่ระบบ
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-mist-50 px-4 py-10">
      <div className="w-full max-w-md rounded-[14px] bg-white p-6 shadow-card sm:p-8">
        <p className="text-center text-sm text-ink-500">
          ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
        </p>
        <h1 className="mt-1 text-center font-heading text-2xl font-bold text-brand-900">
          การยืนยันตัวตนสองชั้น
        </h1>
        <p className="mt-2 text-center text-sm text-ink-600">
          กรอกรหัส 6 หลักจากแอปยืนยันตัวตน หรือรหัสสำรอง (เช่น abcd-ef23)
        </p>
        {state !== null ? (
          <p
            role="alert"
            className="mt-5 rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
          >
            {VERIFY_STATE_MESSAGES[state]}
          </p>
        ) : null}
        <form action={verifyMfaStepTwoAction} className="mt-6 space-y-4">
          <input type="hidden" name="next" value={next} />
          <div>
            <label htmlFor="code" className={labelClass}>
              รหัสยืนยัน <span className="text-danger-600" aria-hidden="true">*</span>
              <span className="sr-only">(จำเป็น)</span>
            </label>
            <input
              id="code"
              name="code"
              type="text"
              required
              inputMode="text"
              autoComplete="one-time-code"
              placeholder="หกหลัก หรือ xxxx-xxxx"
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700"
          >
            ยืนยันตัวตน
          </button>
        </form>
      </div>
    </main>
  );
}

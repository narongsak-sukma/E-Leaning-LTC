/**
 * /my/security/email — คำขอเปลี่ยนอีเมลของตนเอง (Thai-first · Wave F · D-f-2)
 *
 * - ฟอร์ม 2 ช่อง (อีเมลใหม่ + รหัสผ่านปัจจุบัน) — action อยู่ที่ ./actions.ts
 *   (ลำดับ rate → zod → re-auth → guard MFA → updateUser → audit ใน lib เดียว)
 * - ผลลัพธ์กลับมาทาง query string: notice=sent หอื error=<code ทะเบียน> —
 *   หน้า allowlist เอง แสดงการ์ดไทยจาก EMAIL_CHANGE_MESSAGES (แหล่งเดียวกับ lib)
 * - gate session ฝั่งหน้าด้วย (index /my/security เป็นหน้าของ worker F-1)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  EMAIL_CHANGE_ERROR_CODES,
  EMAIL_CHANGE_MESSAGES,
  type EmailChangeFailure,
} from "@/lib/auth/email-change";
import { getUser } from "@/lib/auth/session";
import { requestEmailChangeAction } from "./actions";

/** invert ของ EMAIL_CHANGE_ERROR_CODES: code ใน query → failure (allowlist) */
const ERROR_PARAMS = Object.fromEntries(
  Object.entries(EMAIL_CHANGE_ERROR_CODES).map(([failure, code]) => [code, failure]),
) as Readonly<Record<string, EmailChangeFailure>>;

/** ป้ายข้อความไทยของหน้า (fixed copy — ไม่รับจาก query string) */
const LABEL = {
  title: "เปลี่ยนอีเมล",
  intro:
    "ตั้งค่าอีเมลใหม่เพื่อใช้เข้าสู่ระบบครั้งถัดไป — ระบบจะส่งลิงก์ยืนยันไปที่อีเมลใหม่ อีเมลเดิมยังใช้ได้จนกว่าจะยืนยัน",
  email: "อีเมลใหม่",
  password: "รหัสผ่านปัจจุบัน",
  submit: "ส่งคำขอเปลี่ยนอีเมล",
} as const;

const inputClass =
  "w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none";

const labelClass = "mb-1.5 block font-heading text-sm font-semibold text-ink-900";

interface EmailPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const metadata: Metadata = {
  title: "เปลี่ยนอีเมล — ระบบฝึกอบรมออนไลน์",
  description: "ขอเปลี่ยนอีเมลสำหรับเข้าสู่ระบบของท่าน (ยืนยันทางอีเมลใหม่ก่อนมีผล)",
};

export default async function MyEmailChangePage({ searchParams }: EmailPageProps) {
  const params = await searchParams;
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=" + encodeURIComponent("/my/security/email"));
  }

  const notice = firstParam(params.notice) === "sent" ? "sent" : null;
  const rawError = firstParam(params.error);
  const failure = rawError !== null ? ERROR_PARAMS[rawError] ?? null : null;

  const alertTone =
    "rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700";
  const sentTone =
    "rounded-[10px] border-[1.5px] border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700";

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="font-heading text-2xl font-bold text-ink-900">{LABEL.title}</h1>
      <p className="mt-1 text-sm text-ink-600">{LABEL.intro}</p>
      {notice !== null ? (
        <p id="email-notice" role="status" className={`mt-5 ${sentTone}`}>
          {EMAIL_CHANGE_MESSAGES.sent}
        </p>
      ) : null}
      {failure !== null ? (
        <p id="email-alert" role="alert" className={`mt-5 ${alertTone}`}>
          {EMAIL_CHANGE_MESSAGES[failure]}
        </p>
      ) : null}
      <form action={requestEmailChangeAction} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className={labelClass}>
            {LABEL.email} <span className="text-danger-600" aria-hidden="true">*</span>
            <span className="sr-only">(จำเป็น)</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            placeholder="name@example.com"
            className={inputClass}
            aria-describedby={failure !== null ? "email-alert" : undefined}
          />
        </div>
        <div>
          <label htmlFor="password" className={labelClass}>
            {LABEL.password} <span className="text-danger-600" aria-hidden="true">*</span>
            <span className="sr-only">(จำเป็น)</span>
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700"
        >
          {LABEL.submit}
        </button>
      </form>
    </div>
  );
}

/**
 * /forgot-password — หน้าลืมรหัสผ่าน (AUTH-004 · Wave G P1 · D72)
 *
 * - Server Component — ส่งข้อความคงที่ (PASSWORD_RESET_REQUEST_MESSAGE) จาก lib
 *   เข้า client component เป็น prop (lib เป็น server-only — client ห้าม import
 *   เข้า bundle) — client แสดงข้อความนี้หลังส่งฟอร์ม "เสมอ" ไม่ว่าอีเมลมีในระบบ
 *   หรือไม่ (anti-enumeration — สัญญา D72)
 * - ลิงก์กลับ /login ตามสัญญา · ข้อความไทย inline ตามแบบหน้า login
 */
import type { Metadata } from "next";
import Link from "next/link";

import { PASSWORD_RESET_REQUEST_MESSAGE } from "@/lib/auth/password-reset";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = {
  title: "ลืมรหัสผ่าน — สภาทนายความแห่งประเทศไทย",
  description: "ขอลิงก์ตั้งรหัสผ่านใหม่สำหรับระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-mist-50 px-4 py-10">
      <div className="w-full max-w-md rounded-[14px] bg-white p-6 shadow-card sm:p-8">
        <p className="text-center text-sm text-ink-500">
          ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
        </p>
        <h1 className="mt-1 text-center font-heading text-2xl font-bold text-brand-900">
          ลืมรหัสผ่าน
        </h1>
        <p className="mt-3 text-center text-sm text-ink-600">
          กรอกอีเมลที่ลงทะเบียนไว้ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้
        </p>
        <ForgotPasswordForm fixedMessage={PASSWORD_RESET_REQUEST_MESSAGE} />
        <p className="mt-6 text-center text-sm text-ink-600">
          <Link href="/login" className="font-semibold text-brand-700 hover:underline">
            กลับไปหน้าเข้าสู่ระบบ
          </Link>
        </p>
      </div>
    </main>
  );
}

/**
 * /reset-password — หน้าตั้งรหัสผ่านใหม่ (AUTH-004 · Wave G P1 · D72)
 *
 * - จุดหมายของลิงก์ recovery จากอีเมล (redirect_to ที่ route request ส่งให้ GoTrue)
 * - Server Component เปล่า ๆ — การจำแนก fragment + ฟอร์มทั้งหมดอยู่ใน client
 *   component (fragment ไม่เดินทางถึง server)
 * - noindex — หน้า token ไม่ควรถูกจัดทำดัชนี
 */
import type { Metadata } from "next";

import { ResetPasswordClient } from "./reset-password-client";

export const metadata: Metadata = {
  title: "ตั้งรหัสผ่านใหม่ — สภาทนายความแห่งประเทศไทย",
  description: "ตั้งรหัสผ่านใหม่จากลิงก์ในอีเมลของระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-mist-50 px-4 py-10">
      <div className="w-full max-w-md rounded-[14px] bg-white p-6 shadow-card sm:p-8">
        <p className="text-center text-sm text-ink-500">
          ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
        </p>
        <h1 className="mt-1 text-center font-heading text-2xl font-bold text-brand-900">
          ตั้งรหัสผ่านใหม่
        </h1>
        <ResetPasswordClient />
      </div>
    </main>
  );
}

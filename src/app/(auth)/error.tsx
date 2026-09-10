"use client";

/**
 * Error boundary ของ route group (auth) — PB-4 (DS §5.2 + §9: ข้อความไทยที่ผู้ใช้เข้าใจและบอกทางแก้)
 * ครอบ หน้าเข้าสู่ระบบ/สมัครสมาชิก — กลุ่ม (auth) ไม่มี layout ของตัวเอง จึงเรนเดอร์ใต้ root layout
 * หลักการ no-leak: ห้ามแสดง error.message / stack / digest บนหน้าจอ (SDS — ไม่เปิดเผยรายละเอียด error)
 */
import { useEffect } from "react";

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // บันทึก log ไว้ในเบราว์เซอร์ของผู้ใช้เพื่อตรวจสอบภายหลัง — ไม่แสดงต่อผู้ใช้
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="flex min-h-[60vh] items-center justify-center px-4 py-16">
      <div
        role="alert"
        className="w-full max-w-xl rounded-[14px] border border-mist-200 bg-white p-10 text-center shadow-card"
      >
        <svg
          aria-hidden="true"
          className="mx-auto h-12 w-12 text-danger-600"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        <h1 className="mt-4 font-heading text-2xl font-bold text-ink-900">เกิดข้อผิดพลาด</h1>
        <p className="mt-2 text-base leading-relaxed text-ink-700">
          เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
        >
          ลองใหม่
        </button>
        <p className="mt-6 text-sm leading-relaxed text-ink-500">
          หากลองใหม่แล้วยังไม่สำเร็จ ติดต่อสภาทนายความแห่งประเทศไทย โทร 0 2351 1128
          (จันทร์–ศุกร์ 8:30–16:30 น.)
        </p>
      </div>
    </section>
  );
}

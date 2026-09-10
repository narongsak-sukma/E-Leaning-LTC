/**
 * EnrollButton — ปุ่มลงทะเบียนเรียนของผู้เรียนบนหน้ารายละเอียดหลักสูตร (PB-12 · D-0)
 *
 * - ผู้เรียนที่ login แล้วและยังไม่มี enrollment: POST /api/v1/courses/{id}/enroll
 *   (fetch same-origin — CSRF ตรวจที่ middleware เอง) 201 ใหม่ / 200 ซ้ำ idempotent
 *   (DCR-3) แล้วพาไปหน้าเรียน /courses/{id}/learn
 * - error เป็น code จากทะเบียน src/lib/errors ผ่าน envelope ของ BFF — แสดงข้อความไทย
 *   ตามที่ server ตอบ (AUTH-001 มีลิงก์ไปหน้าเข้าสู่ระบบ) · ห้าม log PII
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError, enrollCourse } from "@/lib/fixtures/learning";

/** ข้อผิดพลาดที่โชว์บนหน้า — ข้อความไทยจาก envelope ของ BFF + code จากทะเบียน */
interface EnrollError {
  readonly code: string;
  readonly message: string;
}

/** ข้อความใต้ปุ่มระหว่างรอ — role="status" ให้ screen reader รับรู้ (DS §3.3) */
const SUBMITTING_TEXT = "กำลังลงทะเบียน...";

export function EnrollButton({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<EnrollError | null>(null);

  const handleEnroll = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await enrollCourse(courseId);
      // 201/200 สำเร็จ → พาไปหน้าเรียน (บทที่ค้าง/บทแรก — LRN-009)
      router.push(`/courses/${encodeURIComponent(courseId)}/learn`);
    } catch (caught: unknown) {
      if (caught instanceof ApiError) {
        setError({ code: caught.code, message: caught.message });
      } else {
        setError({ code: "ERR-SYS-001", message: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่" });
        // code อ้างทะเบียน src/lib/errors — ไม่คิด code ใหม่ (D13-F12)
      }
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void handleEnroll();
        }}
        disabled={isSubmitting}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-brand-600 px-[26px] py-3.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
      >
        ลงทะเบียนเรียน
      </button>
      <p aria-live="polite" role="status" className="mt-2 min-h-5 text-center text-xs text-ink-500">
        {isSubmitting ? SUBMITTING_TEXT : ""}
      </p>
      {error !== null ? (
        <div
          role="alert"
          className="mt-2 rounded-[10px] border border-danger-200 bg-danger-50 px-4 py-3 text-sm"
        >
          <p className="font-medium text-danger-700">{error.message}</p>
          <p className="mt-1 text-xs text-danger-600">รหัสข้อผิดพลาด: {error.code}</p>
          {error.code === "ERR-AUTH-001" ? (
            <Link
              className="mt-2 inline-flex font-semibold text-brand-700 hover:text-brand-800 hover:underline"
              href={`/login?next=${encodeURIComponent(`/courses/${courseId}`)}`}
            >
              ไปหน้าเข้าสู่ระบบ
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

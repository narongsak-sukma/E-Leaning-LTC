"use client";

/**
 * ส่วน client ของ /email-change/callback — หน้าผลลัพธ์หลังคลิกลิงก์ยืนยันการเปลี่ยน
 * อีเมล (Wave F · D-f-2 · หน้า public — ไม่ต้อง session · ย้ายมาจาก page.tsx
 * ในรอบแก้ gate r2 G2 เพื่อให้ page เป็น server shell ที่ force-dynamic ได้)
 *
 * **ทำไมเป็น client component**: GoTrue v2.164.0 ตอบ verify ด้วย 303 → redirect_to
 * โดยแนบสถานะใน URL **fragment** เท่านั้น (probe จริง 2026-09-13):
 *   - ลิงก์จากอีเมลใหม่ (ขั้น 1 ของ 2): `#message=Confirmation+link+accepted.+Please+proceed+to+confirm+link+sent+to+the+other+email`
 *   - ลิงก์จากอีเมลเดิม (ขั้น 2 ของ 2): `#access_token=…&refresh_token=…&type=email_change`
 *     (GoTrue แถม session ใหม่ใน fragment — เราไม่อ่านค่า ไม่ render ไม่ log เด็ดขาด)
 *   - ลิงก์เสีย/หมดอายุ/ถูกใช้แล้ว: `#error=access_denied&error_code=403&error_description=…`
 * fragment ไม่เดินทางถึง server จึงต้องตัดสินฝั่ง client ที่เดียว — server ไม่เห็น
 * อะไรเลย (จึงไม่ echo ข้อความ upstream กลับด้วย — กัน reflected content)
 *
 * การตัดสิน (allowlist ปิด): error/error_code → การ์ดล้มเหลว · message ที่รู้จัก
 * ("sent to the other email") → การ์ดขั้น 1 · access_token/message อื่น → การ์ดสำเร็จ ·
 * ไม่มี fragment (เปิดตรง/ไม่มี JS) → การ์ด generic "ไม่พบผลการยืนยัน"
 */
import { useEffect, useState } from "react";
import Link from "next/link";

const VIEW = {
  newLink: {
    title: "ระบบรับลิงก์ยืนยันจากอีเมลใหม่แล้ว",
    tone: "border-success-200 bg-success-50 text-success-700",
    message:
      "ระบบส่งลิงก์ยืนยันฉบับที่สองไปที่อีเมลเดิมของท่านแล้ว กรุณาเปิดกล่องจดหมายของอีเมลเดิมแล้วคลิกลิงก์เพื่อยืนยันการเปลี่ยนอีเมลให้สมบูรณ์",
  },
  confirmed: {
    title: "ยืนยันอีเมลใหม่สำเร็จ",
    tone: "border-success-200 bg-success-50 text-success-700",
    message:
      "เปลี่ยนอีเมลสำหรับเข้าสู่ระบบสำเร็จแล้ว ตั้งแต่บัดนี้ให้ใช้อีเมลใหม่เข้าสู่ระบบ (อีเมลเดิมใช้เข้าสู่ระบบไม่ได้อีกต่อไป)",
  },
  failed: {
    title: "ยืนยันการเปลี่ยนอีเมลไม่สำเร็จ",
    tone: "border-danger-200 bg-danger-50 text-danger-700",
    message:
      "ลิงก์ยืนยันไม่ถูกต้อง ถูกใช้ไปแล้ว หรือหมดอายุ กรุณาเข้าสู่ระบบแล้วยื่นคำขอเปลี่ยนอีเมลใหม่อีกครั้ง",
  },
  unknown: {
    title: "ไม่พบผลการยืนยัน",
    tone: "border-amber-200 bg-amber-50 text-amber-900",
    message:
      "ไม่พบข้อมูลผลการยืนยันในลิงก์ กรุณาเปิดลิงก์จากอีเมลยืนยันอีกครั้ง (ถ้าเปิดจากอีเมลแล้ว ให้ลองเปิดลิงก์เดิมในเบราว์เซอร์เดิมอีกครั้ง)",
  },
} as const;

type CardState = keyof typeof VIEW;

/** ข้อความ step-1 ของ GoTrue (fragment `message=`) — ตัวแรกที่ต้องแยกจาก error */
const GT_MESSAGE_NEW_LINK = "sent to the other email";

function classifyHash(hash: string): CardState {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  if (params.has("error") || params.has("error_code")) return "failed";
  const message = params.get("message") ?? "";
  if (message.includes(GT_MESSAGE_NEW_LINK)) return "newLink";
  if (params.has("access_token") || message.length > 0) return "confirmed";
  return "unknown";
}

export function EmailChangeCallbackClient() {
  const [state, setState] = useState<CardState>("unknown");
  useEffect(() => {
    setState(classifyHash(window.location.hash));
    // gate r1 F9: fragment ของ GoTrue บรรจุ access/refresh token (ขั้น 2 ของ 2) —
    // ตัดสินเสร็จแล้วตัด fragment ออกจาก URL ทันที (history.replaceState ไม่เพิ่ม
    // รายการประวัติ) ไม่ให้ค้างใน address bar/ปุ่มย้อนหลัง/คัดลอกลิงก์ต่อ —
    // idempotent เมื่อ effect รันซ้ำ (React strict mode)
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const view = VIEW[state];

  return (
    <>
      {/* React 19 hoist — หน้าผล transient ของลิงก์อีเมล ไม่ควรถูก index */}
      <meta name="robots" content="noindex" />
      <div className="mx-auto max-w-2xl px-4 py-12 sm:py-16">
      <header className="mb-6 text-center">
        <h1 className="font-heading text-2xl font-bold text-ink-900 sm:text-3xl">
          ยืนยันการเปลี่ยนอีเมล
        </h1>
        <p className="mt-2 text-sm leading-tight text-ink-500 sm:text-base">
          สภาทนายความแห่งประเทศไทย — ระบบฝึกอบรมและสอบออนไลน์
        </p>
      </header>

      <section
        role="status"
        aria-live="polite"
        className={`rounded-xl border px-6 py-8 text-center ${view.tone}`}
      >
        <h2 className="text-lg font-semibold sm:text-xl">{view.title}</h2>
        <p className="mt-3 text-sm leading-relaxed sm:text-base">{view.message}</p>
      </section>

      <p className="mt-8 text-center text-sm">
        <Link className="text-brand-700 hover:underline" href="/login">
          ไปหน้าเข้าสู่ระบบ
        </Link>
        <span className="mx-2 text-ink-300">|</span>
        <Link className="text-brand-700 hover:underline" href="/">
          กลับหน้าแรก
        </Link>
      </p>
      </div>
    </>
  );
}

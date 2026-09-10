import Link from "next/link";

/**
 * แผงแจ้งสถานะข้อมูลหลังบ้าน — ใช้ร่วมกันทุกหน้า admin เมื่อดึงข้อมูลจาก BFF ไม่สำเร็จ
 * (C-8 Phase 1) — ข้อความไทยสุภาพ 2 กรณี:
 * - "server"  : BFF/เครือข่ายขัดข้องหรือข้อมูลผิดรูป — ให้ลองใหม่ภายหลัง
 * - "forbidden": สิทธิ์หมดอายุ/ไม่มีสิทธิ์ — ชวนเข้าสู่ระบบใหม่ (ไม่ตำหนิผู้ใช้)
 */

const SERVER_MESSAGES = {
  title: "ขออภัย ติดต่อระบบหลังบ้านไม่ได้ในขณะนี้",
  hint: "อาจเป็นการขัดข้องชั่วคราว โปรดลองอีกครั้งในอีกสักครู่ หากยังไม่หายให้แจ้งผู้ดูแลระบบ",
};

const FORBIDDEN_MESSAGES = {
  title: "ไม่มีสิทธิ์เข้าถึงข้อมูลส่วนนี้",
  hint: "สิทธิ์การใช้งานอาจหมดอายุ หรือบัญชีของท่านไม่ได้รับอนุญาตให้ดูข้อมูลหลังบ้าน",
};

export function AdminDataState({
  kind,
  retryHref,
}: {
  kind: "server" | "forbidden";
  /** ลิงก์ "ลองอีกครั้ง" — ปกติคือ path เดิม (สร้าง request ใหม่) */
  retryHref: string;
}) {
  const text = kind === "forbidden" ? FORBIDDEN_MESSAGES : SERVER_MESSAGES;
  return (
    <div
      role="alert"
      className="rounded-[14px] border border-mist-200 bg-white p-10 text-center shadow-card"
    >
      <p className="font-heading text-base font-semibold text-ink-900">{text.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-500">{text.hint}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={retryHref}
          className="rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          ลองอีกครั้ง
  </Link>
        <Link
          href="/login"
          className="rounded-[10px] border border-mist-300 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-ink-600 hover:bg-mist-50"
        >
          ไปหน้าเข้าสู่ระบบ
        </Link>
        <span className="sr-only">
          ระบบยังคงจำกัดสิทธิ์ตามบทบาทของท่านเสมอ (RBAC — API-SPECIFICATION §3.8)
        </span>
      </div>
  </div>
  );
}

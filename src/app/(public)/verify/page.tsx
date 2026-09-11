/**
 * หน้าตรวจสอบประกาศนียบัตร (สาธารณะ) — /verify (Wave D-6)
 *
 * - หน้าเข้า (landing) ของเมนู "ตรวจสอบประกาศนียบัตร" (Public Shell มีลิงก์นี้อยู่แล้ว
 *   — layout.tsx NAV_ITEMS) — กรอกรหัสแล้วระบบพาไป /verify/<code> ซึ่งตรวจและแสดงผล
 * - สาธารณะ — ไม่ต้องเข้าสู่ระบบ · ข้อความไทยทั้งหมด
 */
import type { Metadata } from "next";
import Link from "next/link";

import { VerifyPanel } from "@/components/certificate/verify-panel";

export const metadata: Metadata = {
  title: "ตรวจสอบประกาศนียบัตร — สภาทนายความแห่งประเทศไทย",
  description:
    "ตรวจสอบความถูกต้องของประกาศนียบัตรฝึกอบรมของสภาทนายความแห่งประเทศไทย ด้วยเลขที่ใบ (LTC-ปี-ลำดับ) หรือรหัสจาก QR Code หลังใบ — ไม่ต้องเข้าสู่ระบบ",
};

export default function VerifyLandingPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <nav aria-label="เส้นทาง" className="text-sm text-ink-500">
        <ol className="flex items-center gap-1.5">
          <li>
            <Link className="hover:text-brand-700 hover:underline" href="/">
              หน้าแรก
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="font-medium text-ink-700">
            ตรวจสอบประกาศนียบัตร
          </li>
        </ol>
      </nav>

      <header className="mt-4 mb-6">
        <h1 className="font-heading text-2xl font-bold text-ink-900 sm:text-3xl">
          ตรวจสอบประกาศนียบัตร
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500 sm:text-base">
          บุคคลทั่วไปสามารถตรวจสอบความถูกต้องของประกาศนียบัตรที่ออกโดยสภาทนายความแห่งประเทศไทย
          ด้วยเลขที่ใบ หรือรหัสจาก QR Code — ไม่ต้องเข้าสู่ระบบ
        </p>
      </header>

      <VerifyPanel initialCode={null} />
    </div>
  );
}

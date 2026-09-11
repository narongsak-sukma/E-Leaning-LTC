/**
 * หน้าตรวจสอบประกาศนียบัตร ลิงก์ตรง /verify/<code> (Wave D-6)
 *
 * - รองรับลิงก์จาก QR (verify_code — D10) — server component อ่าน params แล้วส่งเป็น
 *   initialCode ให้ VerifyPanel ตรวจทันทีเมื่อ hydrate
 * - {code} decode อย่างปลอดภัย: รูป % แปลก ๆ ใน path → ใช้ค่าดิบตามที่ Next ให้มา
 *   (BFF normalizeCode ตัด/trim เอง — ไม่เดา, ไม่ throw ออกนอกหน้า)
 * - สาธารณะ — ไม่ต้องเข้าสู่ระบบ · ข้อความไทยทั้งหมด
 */
import type { Metadata } from "next";
import Link from "next/link";

import { VerifyPanel } from "@/components/certificate/verify-panel";

export const metadata: Metadata = {
  title: "ตรวจสอบประกาศนียบัตร — สภาทนายความแห่งประเทศไทย",
  description:
    "ผลการตรวจสอบประกาศนียบัตรฝึกอบรมของสภาทนายความแห่งประเทศไทย — แสดงเฉพาะ 4 ฟิลด์ตามนโยบายความเป็นส่วนตัว (ไม่แสดงชื่อผู้ถือ)",
};

/** path segment → รหัสที่ใช้ค้น — decode ได้ = ใช้ค่า decode · decode ไม่ได้ = ค่าดิบ */
function decodeCodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function VerifyCodePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
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
          <li>
            <Link className="hover:text-brand-700 hover:underline" href="/verify">
              ตรวจสอบประกาศนียบัตร
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="font-medium text-ink-700">
            ผลการตรวจสอบ
          </li>
</ol>
      </nav>

      <header className="mt-4 mb-6">
        <h1 className="font-heading text-2xl font-bold text-ink-900 sm:text-3xl">
          ตรวจสอบประกาศนียบัตร
        </h1>
        <p className="mt-2 text-sm leading-tight text-ink-500 sm:text-base">
          ผลการตรวจสอบประกาศนียบัตรจากรหัสที่ระบุ — ระบบแสดงเฉพาะข้อมูลจำเพาะของใบ ไม่แสดงชื่อผู้ถือ
        </p>
      </header>

      <VerifyPanel initialCode={decodeCodeSegment(code)} />
    </div>
  );
}

/**
 * หน้า "ประกาศนียบัตรของฉัน" (/my/certificates) — Wave D-6
 *
 * - RSC โหลดผ่าน certificates.server.ts (GET /api/v1/me/certificates — cookie forward
 *   ตามแบบ learning.server.ts) แล้วส่งเป็น props ให้ MyCertificatesView
 * - สถานะหน้า: ยังไม่เข้าสู่ระบบ / ระบบขัดข้อง (fail-closed ภาษาไทย) / ว่าง / พร้อมแสดง
 * - ปุ่มดาวน์โหลด PDF + ลิงก์เข้าหน้าตรวจสาธารณะ /verify/<cert_no> ต่อใบ (อยู่ใน view)
 */
import type { Metadata } from "next";

import { MyCertificatesView } from "@/components/certificate/my-certificates-view";
import { loadMyCertificatesPageData } from "@/lib/fixtures/certificates.server";

export const metadata: Metadata = {
  title: "ประกาศนียบัตรของฉัน — ระบบฝึกอบรมออนไลน์",
  description: "ประกาศนียบัตรฝึกอบรมของท่าน พร้อมดาวน์โหลด PDF และลิงก์ตรวจสอบสาธารณะ",
};

export default async function MyCertificatesPage() {
  const data = await loadMyCertificatesPageData();
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">ประกาศนียบัตรของฉัน</h1>
      <p className="mt-1 text-sm text-ink-600">
        ประกาศนียบัตรฝึกอบรมที่สภาทนายความแห่งประเทศไทยออกให้ท่าน
        สามารถดาวน์โหลด PDF หรือส่งลิงก์ให้บุคคลทั่วไปตรวจสอบได้
      </p>
      <MyCertificatesView data={data} />
    </div>
  );
}

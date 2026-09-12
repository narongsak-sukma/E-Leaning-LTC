/**
 * หน้า "โปรไฟล์ของฉัน" (/my/profile) — Wave E Phase 5 · IDENT-001 · lane E
 *
 * - RSC shell — โครงหน้า (h1 + คำอธิบายไทย) · ฟอร์มโหลด/บันทึกฝั่ง client ผ่าน
 *   ProfileForm (GET/PATCH /api/v1/me — เขต self-edit ตาม D-p5-13)
 * - BFF ยังไม่ deploy = แผง error ไทยจาก ProfileForm (ไม่ crash ไม่แสดง stack)
 */
import type { Metadata } from "next";

import { ProfileForm } from "@/components/learner/profile/profile-form";

export const metadata: Metadata = {
  title: "โปรไฟล์ของฉัน — ระบบฝึกอบรมออนไลน์",
  description:
    "ดูและแก้ไขข้อมูลโปรไฟล์ของท่าน — ชื่อที่ใช้แสดง เบอร์โทรศัพท์ และภาษาที่ใช้แสดงผล",
};

export default function MyProfilePage() {
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">โปรไฟล์ของฉัน</h1>
      <p className="mt-1 text-sm text-ink-600">
        ดูและแก้ไขข้อมูลติดต่อของท่านได้ด้วยตัวเอง — ชื่อ-นามสกุลตามทะเบียนเป็นข้อมูลนิติบุคคล
        ต้องขอแก้ไขผ่านเจ้าหน้าที่เท่านั้น
      </p>
      <ProfileForm />
    </div>
  );
}
